import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateOpening, openingMaterials, OpeningSlides } from '../src/opening-slide';
import { config } from '../src/config';
import { Database, type Project, type User } from '../src/database';
import { Knowledge } from '../src/knowledge';
import { ProjectApi } from '../src/project-api';
import { Session } from '../src/session';
import type { Slide } from '../src/director';
import { rm } from 'node:fs/promises';

function slide(title = 'Экономия воды'): Slide {
  return { id: 1, origin: 'documents', title, layout: 'bullets', bullets: ['Устраняйте протечки'],
    predicted: [], sources: [], revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

test('opening generation constrains model output and never trusts fabricated source URLs', async () => {
  let sent: any;
  const mock = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    sent = await req.json();
    return Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Вода', bullets: ['Тезис', null],
      sources: [1, 1, 9, 'https://example.org'], url: 'https://example.org/private' }) } }] });
  } });
  const previous = { ...config.llm };
  try {
    config.llm.baseUrl = `http://127.0.0.1:${mock.port}`;
    const result = await generateOpening([{ name: 'Отчёт', ref: 'project://a/doc', text: 'Экономия 10 литров' }], 'Только один тезис');
    expect(sent.messages[0].content).toContain('Только один тезис');
    expect(sent.messages[1].content).toContain('Экономия 10 литров');
    expect(result.bullets).toEqual(['Тезис']);
    expect(result.sources).toEqual([{ title: 'Отчёт', ref: 'project://a/doc' }]);
    expect(result.predicted).toEqual([]);
    expect(result.origin).toBe('documents');
  } finally { Object.assign(config.llm, previous); mock.stop(true); }
});

test('document excerpts are bounded and keep project-scoped references', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ document_id: String(i % 20), name: `Документ ${i % 20}`, text: 'x'.repeat(3000) }));
  const result = openingMaterials(rows, 'project-a');
  expect(result).toHaveLength(20);
  expect(result.reduce((n, item) => n + item.text.length, 0)).toBeLessThanOrEqual(24000);
  expect(result.every(item => item.ref.startsWith('project://project-a/'))).toBe(true);
});

test('prepared slide persists and cannot replace a deck or a started talk', async () => {
  const root = `/tmp/live-slides-opening-test-${crypto.randomUUID()}`;
  const context = { root, sources: [], places: [], resumeWithinMs: Infinity };
  try {
    const session = new Session(() => {}, undefined, context);
    await session.seedOpening(slide());
    await session.activate();
    await session.seedOpening(slide('Другой'));
    expect(session.slides[0]?.title).toBe('Экономия воды');
    const resumed = await Session.resumeLatest(() => {}, context);
    expect(resumed.slides[0]?.title).toBe('Экономия воды');
    expect(resumed.transcript).toHaveLength(0);
    const live = new Session(() => {}, undefined, context);
    live.listening = true;
    await live.seedOpening(slide());
    expect(live.slides).toHaveLength(0);
    live.listening = false;
    live.transcript.push({ id: 1, text: 'Речь', at: new Date().toISOString() });
    await live.seedOpening(slide());
    expect(live.slides).toHaveLength(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite('durable opening jobs with PostgreSQL RLS', () => {
  let db: Database, a: User, b: User, project: Project, other: Project, knowledge: Knowledge;
  const users: User[] = [];
  beforeAll(async () => {
    db = await Database.open();
    a = await db.user('local:opening-a-' + crypto.randomUUID(), 'A');
    b = await db.user('local:opening-b-' + crypto.randomUUID(), 'B'); users.push(a, b);
    const create = (u: User) => db.as(u.id, async tx => (await tx`INSERT INTO projects(owner_id,name) VALUES (${u.id}, 'Opening test') RETURNING *`)[0]);
    project = await create(a); other = await create(b);
    knowledge = new Knowledge(db, async texts => texts.map(() => [1, ...Array(1023).fill(0)]));
  });
  afterAll(async () => {
    if (!db) return;
    for (const user of users) { await db.as(user.id, tx => tx`DELETE FROM projects WHERE owner_id = ${user.id}`); await db.sql`DELETE FROM app_users WHERE id = ${user.id}`; }
    await db.sql.close();
  }, 30000);
  const due = () => db.as(a.id, tx => tx`UPDATE projects SET opening_due = now() - interval '1 second' WHERE id = ${project.id}`);
  test('waits for the whole upload and processing batch; reads only its own materials', async () => {
    await knowledge.upload(a, project, 'water.txt', new TextEncoder().encode('Устранение протечки экономит воду.'));
    await knowledge.upload(b, other, 'secret.txt', new TextEncoder().encode('PRIVATE OTHER TENANT'));
    let calls = 0;
    const jobs = new OpeningSlides(db, async materials => { calls++; expect(materials.map(m => m.text).join()).not.toContain('PRIVATE'); return slide(); });
    await due(); expect(await jobs.processNext(a.id)).toBe(false);
    await knowledge.processNext(a.id); await due();
    await db.as(a.id, tx => tx`UPDATE projects SET opening_upload_until = now() + interval '5 minutes' WHERE id = ${project.id}`);
    expect(await jobs.processNext(a.id)).toBe(false);
    await db.as(a.id, tx => tx`UPDATE projects SET opening_upload_until = NULL WHERE id = ${project.id}`);
    expect(await jobs.processNext(a.id)).toBe(true);
    expect(calls).toBe(1);
    expect((await db.project(a.id, project.id))?.opening_status).toBe('ready');
    expect(await db.as(b.id, tx => tx`SELECT opening_slide FROM projects WHERE id = ${project.id}`)).toHaveLength(0);
    expect((await db.project(a.id, project.id))?.opening_slide?.title).toBe('Экономия воды');
  }, 30000);
  test('stale generation cannot overwrite a newer prompt; errors can be retried', async () => {
    const api = new ProjectApi(db, knowledge);
    const req = (action: string, prompt = '') => new Request(`http://localhost/api/projects/${project.id}/opening`, {
      method: 'POST', body: JSON.stringify({ action, prompt }), headers: { 'Content-Type': 'application/json' },
    });
    await expect(api.handle(new Request(`http://localhost/api/projects/${project.id}/opening`), b)).rejects.toThrow('Презентация не найдена');
    await expect(api.handle(req('generate', 'x'.repeat(12001)), a)).rejects.toThrow('12000');
    await api.handle(req('generate', 'Первая инструкция'), a);
    const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<Slide>();
    const jobs = new OpeningSlides(db, async (_materials, prompt) => { expect(prompt).toBe('Первая инструкция'); entered.resolve(); return finish.promise; });
    const pending = jobs.processNext(a.id); await entered.promise;
    await api.handle(req('generate', 'Новая инструкция'), a);
    finish.resolve(slide('Устаревший результат')); await pending;
    const current = await db.project(a.id, project.id);
    expect(current?.opening_status).toBe('queued');
    expect(current?.opening_slide?.title).not.toBe('Устаревший результат');
    const broken = new OpeningSlides(db, async () => { throw new Error('private provider detail'); });
    await broken.processNext(a.id);
    expect((await db.project(a.id, project.id))?.opening_error).not.toContain('private provider');
    expect((await db.project(a.id, project.id))?.opening_status).toBe('error');
    await api.handle(req('generate', ''), a);
    await new OpeningSlides(db, async (_materials, prompt) => { expect(prompt).toBe(''); return slide('Повтор'); }).processNext(a.id);
    expect((await db.project(a.id, project.id))?.opening_slide?.title).toBe('Повтор');
    await db.as(a.id, tx => tx`UPDATE projects SET opening_status = 'working', opening_lease_until = now() - interval '1 second' WHERE id = ${project.id}`);
    await new OpeningSlides(db, async () => slide('После перезапуска')).processNext(a.id);
    expect((await db.project(a.id, project.id))?.opening_slide?.title).toBe('После перезапуска');
  }, 30000);
});
