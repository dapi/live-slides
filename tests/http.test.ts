import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from '../src/database';
import { config } from '../src/config';

const suite = process.env.DATABASE_URL && process.env.TEST_APP_PORT && process.env.TEST_MOCK_PORT ? describe : describe.skip;
suite('HTTP and WebSocket tenant boundary', () => {
  let db: Database, process: ReturnType<typeof Bun.spawn>, mock: ReturnType<typeof Bun.serve>;
  let cookieA: string, cookieB: string, a: string, b: string;
  const origin = `http://127.0.0.1:${Bun.env.TEST_APP_PORT}`;
  const mockOrigin = `http://127.0.0.1:${Bun.env.TEST_MOCK_PORT}`;
  const suffix = crypto.randomUUID();
  const credentials = crypto.randomUUID();
  const createdUsers: string[] = [];
  const sockets: WebSocket[] = [];
  const request = async (path: string, cookie = '', method = 'GET', body?: unknown) => fetch(origin + path, {
    method, headers: { Origin: origin, Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  async function socket(project: string, cookie: string) {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws?project=' + project, { headers: { Cookie: cookie, Origin: origin } });
    sockets.push(ws);
    const state = await new Promise<any>((resolve, reject) => { ws.onmessage = event => resolve(JSON.parse(String(event.data))); ws.onerror = reject; });
    return { ws, state };
  }
  beforeAll(async () => {
    db = await Database.open();
    mock = Bun.serve({ hostname: '127.0.0.1', port: Number(Bun.env.TEST_MOCK_PORT), fetch(req) {
      if (new URL(req.url).pathname === '/auth/verify') return new Response('', { status: req.headers.get('cookie') === 'synthetic-corp=verified' ? 204 : 401,
        headers: { 'x-auth-request-user': 'danil' } });
      return Response.json({ data: [] });
    } });
    for (const login of ['alice', 'bob']) {
      const hash = await Bun.password.hash(credentials, { algorithm: 'argon2id' });
      const [user] = await db.sql`INSERT INTO app_users(subject, display_name, password_hash) VALUES (${'local:' + login + '-' + suffix}, ${login}, ${hash}) RETURNING id`;
      createdUsers.push(user.id);
    }
    process = Bun.spawn(['bun', 'src/server.ts'], { env: { ...Bun.env, PORT: Bun.env.TEST_APP_PORT, APP_ORIGIN: origin,
      CORP_VERIFY_URL: mockOrigin + '/auth/verify', LLM_BASE_URL: mockOrigin, OPENVIKING_URL: mockOrigin, EMBEDDING_BASE_URL: mockOrigin,
      DATA_DIR: config.dataDir + '/http-tests-' + suffix }, stdout: 'ignore', stderr: 'ignore' });
    for (let i = 0; i < 100; i++) {
      if (await fetch(origin + '/healthz').then(r => r.ok).catch(() => false)) break;
      await Bun.sleep(50);
    }
    const ca = await request('/api/auth/login', '', 'POST', { username: 'alice-' + suffix, password: credentials });
    const cb = await request('/api/auth/login', '', 'POST', { username: 'bob-' + suffix, password: credentials });
    expect(ca.status).toBe(200); expect(cb.status).toBe(200);
    cookieA = ca.headers.get('set-cookie')!.split(';')[0]!; cookieB = cb.headers.get('set-cookie')!.split(';')[0]!;
    a = (await (await request('/api/projects', cookieA, 'POST', { name: 'Alice private project' })).json()).id;
    b = (await (await request('/api/projects', cookieB, 'POST', { name: 'Bob private project' })).json()).id;
  }, 15000);
  afterAll(async () => {
    for (const ws of sockets) ws.close();
    process.kill(); await process.exited; mock.stop(true);
    for (const id of createdUsers) {
      await db.as(id, tx => tx`DELETE FROM projects WHERE owner_id = ${id}`);
      await db.sql`DELETE FROM app_users WHERE id = ${id}`;
    }
    const { rm } = await import('node:fs/promises');
    await rm(config.dataDir + '/http-tests-' + suffix, { recursive: true, force: true });
    await db.sql.close();
  });
  test('authentication, CSRF, forged user headers, foreign project APIs', async () => {
    expect((await request('/api/projects')).status).toBe(401);
    expect((await fetch(origin + '/api/projects', { headers: { 'x-auth-request-user': 'danil' } })).status).toBe(401);
    expect((await fetch(origin + '/api/projects', { method: 'POST', headers: { Cookie: cookieA, Origin: 'https://attacker.test' } })).status).toBe(403);
    expect((await request('/api/projects/' + a + '/documents', cookieB)).status).toBe(404);
    expect((await request('/api/deck.md?project=' + a, cookieB)).status).toBe(404);
    expect((await request('/api/health?project=' + a, cookieB)).status).toBe(404);
    expect((await request('/ws?project=' + a, cookieB)).status).toBe(404);
    expect((await request('/ws?project=' + a)).status).toBe(401);
    expect((await request('/api/waitlist', cookieB)).status).toBe(403);
    const list = await (await request('/api/projects', cookieB)).json();
    expect(list.map((p: any) => p.id)).toEqual([b]);
  });
  test('project settings stay tenant-scoped and reject private connector changes', async () => {
    expect((await request('/api/projects/' + a, cookieB, 'PATCH', { name: 'forged', personalSource: false })).status).toBe(404);
    expect((await request('/api/projects/' + a, cookieA, 'PATCH', { name: 'private', personalSource: true })).status).toBe(403);
    expect((await request('/api/projects/' + a, cookieA, 'PATCH', { name: ' ', personalSource: false })).status).toBe(400);
    const sa = await socket(a, cookieA);
    const closed = new Promise<number>(resolve => { sa.ws.onclose = event => resolve(event.code); });
    const saved = await request('/api/projects/' + a, cookieA, 'PATCH', { name: 'Renamed project', personalSource: false });
    expect(saved.status).toBe(200); expect((await saved.json()).name).toBe('Renamed project');
    expect(await closed).toBe(4002);
    const reopened = await socket(a, cookieA);
    expect(reopened.state.session).toBe(sa.state.session);
    reopened.ws.close();
    const list = await (await request('/api/projects', cookieA)).json();
    expect(list[0].document_count).toBe(0); expect(list[0].ready_count).toBe(0);
  });
  test('private connector requires verified Corp cookie, never a password account', async () => {
    expect((await request('/api/projects', cookieA, 'POST', { name: 'private connector', personalSource: true })).status).toBe(403);
    const me = await (await request('/api/me', 'synthetic-corp=verified')).json();
    expect(me.personalSourceAvailable).toBe(true);
    const created = await request('/api/projects', 'synthetic-corp=verified', 'POST', { name: 'Corp owner project', personalSource: true });
    expect(created.status).toBe(201);
    const project = await created.json();
    expect((await request('/api/projects/' + project.id + '/documents', cookieA)).status).toBe(404);
    const ownerSocket = await socket(project.id, 'synthetic-corp=verified');
    expect(ownerSocket.state.status.sources.scopes.length).toBeGreaterThan(1);
    const closed = new Promise<number>(resolve => { ownerSocket.ws.onclose = event => resolve(event.code); });
    expect((await request('/api/projects/' + project.id, 'synthetic-corp=verified', 'PATCH', { name: 'Owner project', personalSource: false })).status).toBe(200);
    expect(await closed).toBe(4002);
    const updated = await socket(project.id, 'synthetic-corp=verified');
    expect(updated.state.status.sources.scopes).toEqual(['Документы презентации']);
    expect(updated.state.session).toBe(ownerSocket.state.session);
    updated.ws.close();
    const [owner] = await db.sql`SELECT id FROM app_users WHERE subject = 'corp:owner'`;
    await db.as(owner.id, tx => tx`DELETE FROM projects WHERE id = ${project.id}`);
  });
  test('WebSocket rooms never broadcast to other accounts', async () => {
    const sa = await socket(a, cookieA), sb = await socket(b, cookieB);
    expect(sa.state.session).not.toBe(sb.state.session);
    expect(sa.state.status.sources.scopes).toEqual(['Документы презентации']);
    expect(sb.state.slides).toHaveLength(0); expect(sb.state.transcript).toHaveLength(0);
    const receivedB: unknown[] = []; sb.ws.onmessage = event => receivedB.push(event.data);
    const changed = new Promise<any>(resolve => { sa.ws.onmessage = event => resolve(JSON.parse(String(event.data))); });
    sa.ws.send(JSON.stringify({ type: 'variants', on: true }));
    expect((await changed).status.variants).toBe(true);
    await Bun.sleep(100); expect(receivedB).toHaveLength(0);
    const reset = new Promise<any>(resolve => { sa.ws.onmessage = event => resolve(JSON.parse(String(event.data))); });
    sa.ws.send(JSON.stringify({ type: 'reset' }));
    expect((await reset).session).not.toBe(sa.state.session);
    await Bun.sleep(100); expect(receivedB).toHaveLength(0);
    sa.ws.close(); sb.ws.close();
  });
  test('logout closes existing sockets and invalidates the cookie', async () => {
    const connected = await socket(a, cookieA);
    const closed = new Promise<number>(resolve => { connected.ws.onclose = event => resolve(event.code); });
    expect((await request('/api/auth/logout', cookieA, 'POST')).status).toBe(200);
    expect(await closed).toBe(4001);
    expect((await request('/api/projects', cookieA)).status).toBe(401);
  });
});
