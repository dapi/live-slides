import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database, type User, type Project } from '../src/database';
import { Knowledge, validVector } from '../src/knowledge';
import { chunks, extractDocument, validateDocument } from '../src/documents';
import { canUsePersonal, Auth, sameOrigin } from '../src/auth';
import { ProjectApi } from '../src/project-api';
import { Session } from '../src/session';
import { config } from '../src/config';
import { join } from 'node:path';
import { Director, type Slide } from '../src/director';
import { rm } from 'node:fs/promises';

const vector = (text: string) => { const value = Array(1024).fill(0); value[text.includes('secret') ? 1 : 0] = 1; return value; };
const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite('PostgreSQL isolation and durable document pipeline', () => {
  let db: Database, knowledge: Knowledge, a: User, b: User, p1: Project, p2: Project, other: Project;
  beforeAll(async () => {
    db = await Database.open();
    const suffix = crypto.randomUUID();
    a = await db.user('local:a-' + suffix, 'Alice'); b = await db.user('local:b-' + suffix, 'Bob');
    knowledge = new Knowledge(db, async texts => texts.map(vector));
    const create = (user: User, name: string) => db.as(user.id, async tx => (await tx`INSERT INTO projects(owner_id, name) VALUES (${user.id}, ${name}) RETURNING *`)[0]);
    p1 = await create(a, 'A1'); p2 = await create(a, 'A2'); other = await create(b, 'B1');
  });
  afterAll(async () => {
    for (const user of [a, b]) {
      await db.as(user.id, tx => tx`DELETE FROM projects WHERE owner_id = ${user.id}`);
      await db.sql`DELETE FROM app_users WHERE id = ${user.id}`;
    }
    await db.sql.close();
  });
  test('TXT upload survives a worker restart and is usable only in its project', async () => {
    const doc = await knowledge.upload(a, p1, 'first.txt', new TextEncoder().encode('ordinary project knowledge'));
    const restarted = new Knowledge(db, async texts => texts.map(vector));
    expect(await restarted.processNext(a.id)).toBe(true);
    const hits = await restarted.source(a.id, p1.id).search('ordinary project');
    expect(hits.hits[0]?.title).toBe('first.txt');
    expect(hits.hits[0]?.excerpt).toContain('ordinary project knowledge');
    expect((await restarted.source(a.id, p2.id).search('ordinary project')).hits).toHaveLength(0);
    expect((await restarted.source(b.id, p1.id).search('ordinary project')).hits).toHaveLength(0);
    const [saved] = await db.as(a.id, tx => tx`SELECT status, chunk_count FROM documents WHERE id = ${doc.id}`);
    expect(saved.status).toBe('ready'); expect(saved.chunk_count).toBe(1);
  });
  test('RLS protects a query which forgot the owner filter and a forged insert', async () => {
    const visible = await db.as(b.id, tx => tx`SELECT * FROM document_chunks`);
    expect(visible).toHaveLength(0);
    expect(await db.sql`SELECT * FROM documents`).toHaveLength(0);
    await expect(db.as(b.id, tx => tx`INSERT INTO projects(owner_id, name) VALUES (${a.id}, 'forged')`)).rejects.toThrow();
    expect(await db.project(b.id, p1.id)).toBeNull();
  });
  test('duplicate uploads do not create another job', async () => {
    const same = await knowledge.upload(a, p1, 'renamed.txt', new TextEncoder().encode('ordinary project knowledge'));
    expect(same.status).toBe('ready');
    const [count] = await db.as(a.id, tx => tx`SELECT count(*)::int AS n FROM documents WHERE project_id = ${p1.id}`);
    expect(count.n).toBe(1);
  });
  test('the director uses uploaded excerpts and cites the project document', async () => {
    let prompt = '';
    const mock = Bun.serve({ hostname: '127.0.0.1', port: Number(Bun.env.TEST_MOCK_PORT), async fetch(request) {
      const body = await request.json();
      prompt = body.messages[1].content;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'new',
        slide: { layout: 'bullets', title: 'Документы проекта', bullets: [{ text: 'ordinary project knowledge', said: true }] },
        next: '', sources: [1] }) } }] });
    } });
    const previous = config.llm.baseUrl;
    config.llm.baseUrl = `http://127.0.0.1:${mock.port}`;
    try {
      const ready = Promise.withResolvers<Slide>();
      const director = new Director([knowledge.source(a.id, p1.id)], {
        onSlide: slide => ready.resolve(slide), onNext: () => {}, onPaths: () => {}, onStage: () => {}, onSources: () => {}, onMetric: () => {},
      });
      director.finalText('Сегодня расскажу про ordinary project knowledge из документа проекта.');
      const slide = await Promise.race([ready.promise, Bun.sleep(4000).then(() => { throw new Error('Slide was not generated'); })]);
      expect(prompt).toContain('ordinary project knowledge');
      expect(slide.sources[0]?.title).toBe('first.txt');
      expect(slide.sources[0]?.ref).toStartWith(`project://${p1.id}/`);
    } finally { config.llm.baseUrl = previous; mock.stop(true); }
  });
  test('failed indexing publishes no partial chunks and can be retried', async () => {
    const doc = await knowledge.upload(a, p2, 'retry.txt', new TextEncoder().encode('retry knowledge'));
    const broken = new Knowledge(db, async () => { throw new Error('private-service-url and credential must not leak'); });
    await broken.processNext(a.id);
    const [failed] = await db.as(a.id, tx => tx`SELECT status, error FROM documents WHERE id = ${doc.id}`);
    expect(failed.status).toBe('error'); expect(failed.error).not.toContain('private-service');
    expect(await db.as(a.id, tx => tx`SELECT * FROM document_chunks WHERE document_id = ${doc.id}`)).toHaveLength(0);
    const api = new ProjectApi(db, knowledge);
    expect((await api.handle(new Request('http://test/api/projects/' + p2.id + '/documents/' + doc.id + '/retry', { method: 'POST' }), a))?.status).toBe(200);
    await knowledge.processNext(a.id);
    expect((await knowledge.source(a.id, p2.id).search('retry knowledge')).hits).toHaveLength(1);
  });
  test('expired processing lease is recovered', async () => {
    const doc = await knowledge.upload(b, other, 'secret.txt', new TextEncoder().encode('secret belongs to another person'));
    await db.as(b.id, tx => tx`UPDATE documents SET status = 'processing', attempts = 1, lease_until = now() - interval '1 minute' WHERE id = ${doc.id}`);
    await knowledge.processNext(b.id);
    expect((await knowledge.source(b.id, other.id).search('secret')).hits[0]?.excerpt).toContain('another person');
    expect((await knowledge.source(a.id, other.id).search('secret')).hits).toHaveLength(0);
  });
  test('project API rejects foreign documents and private connector for a password account', async () => {
    const api = new ProjectApi(db, knowledge);
    await expect(api.handle(new Request('http://test/api/projects/' + p1.id + '/documents'), b)).rejects.toMatchObject({ status: 404 });
    await expect(api.handle(new Request('http://test/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'forged connector', personalSource: true }) }), a)).rejects.toMatchObject({ status: 403 });
    await expect(db.as(a.id, tx => tx`INSERT INTO projects(owner_id, name, personal_source) VALUES (${a.id}, 'forged connector', true)`)).rejects.toThrow();
    expect(canUsePersonal({ ...a, subject: 'local:owner' })).toBe(false);
    const data = await (await api.handle(new Request('http://test/api/me'), a))!.json();
    expect(data.personalSourceAvailable).toBe(false);
    expect(JSON.stringify(data)).not.toContain(config.sources.url);
  });
  test('forged identity header is not authentication', async () => {
    expect(await new Auth(db).resolve(new Request('http://test/api/me', { headers: { 'x-auth-request-user': 'danil' } }))).toBeNull();
    expect(sameOrigin(new Request(config.auth.origin + '/api/projects', { headers: { Origin: 'https://attacker.test' } }))).toBe(false);
  });
  test('tenant-scoped session resume never loads another project deck', async () => {
    const root = join(config.dataDir, 'isolation-test-' + crypto.randomUUID());
    const shared = { sources: [], places: [] };
    const first = new Session(() => {}, 'sample', { ...shared, root: join(root, 'first') });
    await Bun.write(join(first.dir, 'deck.json'), JSON.stringify({ slides: [{ id: 1, title: 'private first project', sources: [], predicted: [], bullets: [], layout: 'bullets' }] }));
    const second = await Session.resumeLatest(() => {}, { ...shared, root: join(root, 'second') });
    expect(second.slides).toHaveLength(0);
    const resumed = await Session.resumeLatest(() => {}, { ...shared, root: join(root, 'first') });
    expect(resumed.slides[0]?.title).toBe('private first project');
    await rm(root, { recursive: true, force: true });
  });
});

describe('document validation', () => {
  test('format, empty files, invalid UTF-8, path-safe names', async () => {
    expect(() => validateDocument('bad.pdf', new TextEncoder().encode('not PDF'))).toThrow();
    expect(() => validateDocument('bad.exe', new Uint8Array([1]))).toThrow();
    expect(() => validateDocument('empty.txt', new Uint8Array())).toThrow();
    expect(validateDocument('../../test.txt', new TextEncoder().encode('valid')).name).toBe('test.txt');
    await expect(extractDocument('bad.txt', new Uint8Array([255]))).rejects.toThrow('UTF-8');
    expect(await extractDocument('utf8.txt', new TextEncoder().encode('Привет, мир'))).toBe('Привет, мир');
  });
  test('overlapping chunks cover long material without losing the end', () => {
    const text = 'start\n' + 'слово '.repeat(1000) + '\nunique end';
    const parts = chunks(text);
    expect(parts.length).toBeGreaterThan(1); expect(parts.at(-1)).toContain('unique end');
    expect(parts[1]).toContain(parts[0]!.slice(-180).trim());
    expect(validVector(Array(1024).fill(0))).toBe(false);
  });
});
