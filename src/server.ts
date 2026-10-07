import { json } from './http';
import { join, normalize } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { config, secret } from './config';
import { Auth, canUsePersonal, sameOrigin } from './auth';
import { Database, type Project, type User } from './database';
import { InputError } from './documents';
import { Knowledge } from './knowledge';
import { ProjectApi } from './project-api';
import { deckMarkdown, Session, type SessionContext } from './session';
import { Sources } from './sources';
import { SiteSearch } from './site-search';
import { Waitlist } from './waitlist';

const PUBLIC = join(config.root, 'public');
const PAGES: Record<string, string> = { '/': 'landing.html', '/app': 'index.html', '/app/': 'index.html', '/login': 'login.html' };
const db = await Database.open();
await db.sql`SELECT id FROM projects LIMIT 0`;
await db.sql`SELECT has_pending_documents, username FROM app_users LIMIT 0`;
const auth = new Auth(db);
const knowledge = new Knowledge(db);
const api = new ProjectApi(db, knowledge, changeProject);
const waitlist = await Waitlist.open();
if (config.llm.keyPassEntry && !process.env.LLM_API_KEY) config.llm.apiKey = await secret('LLM_API_KEY', config.llm.keyPassEntry);

type SocketData = { user: User; project: Project; room: Room; request: Request; checkedAt: number; expiresAt: number; timer?: ReturnType<typeof setInterval> };
type Room = { key: string; session: Session; context: SessionContext; mic: ServerWebSocket<SocketData> | null; sockets: Set<ServerWebSocket<SocketData>>; busy: boolean };
const rooms = new Map<string, Promise<Room>>();

async function changeProject(user: User, project: Project, update: () => Promise<Project>): Promise<Project> {
  const key = `${user.id}:${project.id}`;
  const pending = rooms.get(key);
  const room = pending ? await pending : null;
  if (room?.busy || room?.session.listening) throw new InputError('Остановите запись в других вкладках перед изменением настроек', 409);
  if (room) room.busy = true;
  try {
    const saved = await update();
    // Reopen the saved deck with the new source set; never reset the presentation.
    if (room) {
      await room.session.stop();
      rooms.delete(key);
      for (const socket of room.sockets) socket.close(4002, 'Настройки презентации изменены');
    }
    return saved;
  } finally { if (room) room.busy = false; }
}

async function roomFor(user: User, project: Project): Promise<Room> {
  const key = `${user.id}:${project.id}`;
  let pending = rooms.get(key);
  if (!pending) {
    pending = (async () => {
      const personal = project.personal_source && canUsePersonal(user);
      const context: SessionContext = {
        root: join(config.dataDir, 'users', user.id, 'projects', project.id, 'sessions'),
        resumeWithinMs: Infinity,
        sources: [knowledge.source(user.id, project.id), ...(personal ? [new Sources(), new SiteSearch()] : [])],
        places: ['Документы презентации', ...(personal ? config.sources.scopes : [])],
      };
      const room = { key, context, mic: null, busy: false, sockets: new Set() } as Room;
      room.session = await Session.resumeLatest(message => broadcast(room, message), context);
      await room.session.activate();
      return room;
    })();
    rooms.set(key, pending);
    pending.catch(() => rooms.delete(key));
  }
  return pending;
}
function snapshot(room: Room, user: User) {
  return { ...room.session.snapshot(), waitlist: canUsePersonal(user) ? waitlist.count : 0 };
}
function broadcast(room: Room, message: Record<string, unknown>) {
  for (const ws of room.sockets) {
    if (Date.now() > ws.data.expiresAt) ws.close(4001, 'Войдите заново');
    else ws.send(JSON.stringify(message));
  }
}
const loginLimits = new Map<string, { at: number; count: number }>();
function loginAllowed(peer: string): boolean {
  const now = Date.now();
  for (const [key, value] of loginLimits) if (value.at + 15 * 60_000 < now) loginLimits.delete(key);
  const value = loginLimits.get(peer) ?? { at: now, count: 0 };
  loginLimits.set(peer, value);
  return ++value.count <= 20;
}

export const server = Bun.serve<SocketData>({
  hostname: config.host, port: config.port, maxRequestBodySize: config.knowledge.maxUploadBytes + 65536,
  async fetch(request, server) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/auth/corp' && request.method === 'GET') return await auth.corpLogin(request);
      if (url.pathname === '/api/auth/options' && request.method === 'GET') return json({ corpAvailable: !!config.auth.corpVerifyUrl });
      if (url.pathname === '/healthz') return new Response('ok');
      if (url.pathname === '/waitlist' && request.method === 'POST') return joinWaitlist(request, server.requestIP(request)?.address ?? '');
      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        if (!sameOrigin(request)) throw new InputError('Недопустимый источник запроса', 403);
        const peer = server.requestIP(request)?.address ?? '';
        // Behind ingress use its overwritten real visitor address, only for rate limiting.
        if (!loginAllowed(peer + ':' + (request.headers.get('x-real-ip') ?? ''))) throw new InputError('Слишком много попыток. Повторите через 15 минут', 429);
        const { username, password } = await request.json();
        if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 128) throw new InputError('Неверный логин или пароль', 401);
        return await auth.login(username, password);
      }
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        if (!sameOrigin(request)) throw new InputError('Недопустимый источник запроса', 403);
        const result = await auth.logout(request);
        for (const pending of rooms.values()) {
          const room = await pending;
          for (const ws of room.sockets) if (ws.data.request.headers.get('cookie') === request.headers.get('cookie')) ws.close(4001, 'Войдите заново');
        }
        return result;
      }
      const privatePath = url.pathname.startsWith('/api/') || url.pathname === '/ws' || url.pathname === '/app' || url.pathname.startsWith('/app/');
      if (privatePath) {
        if (request.method !== 'GET' && !sameOrigin(request)) throw new InputError('Недопустимый источник запроса', 403);
        const user = await auth.resolve(request);
        if (!user) return url.pathname.startsWith('/app') ? Response.redirect(new URL('/login', config.auth.origin), 303) : json({ error: 'Войдите в аккаунт' }, { status: 401 });
        if (url.pathname === '/api/profile') {
          if (request.method === 'GET') return json(await auth.profile(user));
          if (request.method === 'PATCH') return await auth.updateProfile(user, await request.json());
          return new Response('Method not allowed', { status: 405 });
        }
        if (url.pathname === '/api/auth/password' && request.method === 'POST') {
          if (!loginAllowed('password:' + user.id)) throw new InputError('Слишком много попыток. Повторите через 15 минут', 429);
          const response = await auth.changePassword(user, await request.json());
          for (const pending of rooms.values()) {
            const room = await pending;
            for (const ws of room.sockets) if (ws.data.user.id === user.id) ws.close(4001, 'Пароль изменён. Войдите заново');
          }
          return response;
        }
        if (url.pathname === '/api/waitlist') {
          if (!canUsePersonal(user)) throw new InputError('Недоступно', 403);
          return json(waitlist.list());
        }
        const result = await api.handle(request, user);
        if (result) return result;
        if (url.pathname === '/ws' || url.pathname === '/api/deck.md' || url.pathname === '/api/health') {
          const project = await db.project(user.id, url.searchParams.get('project') ?? '');
          if (!project) throw new InputError('Выберите свою презентацию', 404);
          const room = await roomFor(user, project);
          if (url.pathname === '/ws') {
            if (!sameOrigin(request)) throw new InputError('Недопустимый источник запроса', 403);
            return server.upgrade(request, { data: { user, project, room, request, checkedAt: Date.now(), expiresAt: Date.now() + 12 * 60 * 60_000 } }) ? undefined : new Response('WebSocket expected', { status: 400 });
          }
          if (url.pathname === '/api/health') return json({ ok: true, session: room.session.id, listening: room.session.listening });
          return new Response(deckMarkdown(room.session.slides), { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="slides-${room.session.id}.md"` } });
        }
        if (url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
      }
      const path = normalize(join(PUBLIC, PAGES[url.pathname] ?? url.pathname));
      if (!path.startsWith(PUBLIC + '/')) return new Response('Not found', { status: 404 });
      const file = Bun.file(path);
      // Pages and scripts change with every release; media and icons may sit in a cache for a day.
      const cache = /\.(mp4|jpg|png|svg)$/.test(path) ? 'public, max-age=86400' : 'no-store';
      return await file.exists() ? new Response(file, { headers: { 'Cache-Control': cache } }) : new Response('Not found', { status: 404 });
    } catch (error) {
      if (error instanceof InputError) return json({ error: error.message }, { status: error.status });
      if (error instanceof SyntaxError) return json({ error: 'Некорректный запрос' }, { status: 400 });
      console.error('Запрос не выполнен');
      return json({ error: 'Сервис временно недоступен' }, { status: 503 });
    }
  },
  websocket: {
    maxPayloadLength: 65536,
    open(ws) {
      ws.data.room.sockets.add(ws);
      ws.send(JSON.stringify(snapshot(ws.data.room, ws.data.user)));
      // View-only tabs must also lose access when their login expires or is revoked.
      ws.data.timer = setInterval(async () => {
        const current = await auth.resolve(ws.data.request).catch(() => null);
        if (current?.id !== ws.data.user.id || Date.now() > ws.data.expiresAt) ws.close(4001, 'Войдите заново');
      }, 60_000);
    },
    async message(ws, message) {
      const { room } = ws.data;
      if (Date.now() > ws.data.expiresAt) { ws.close(4001, 'Войдите заново'); return; }
      if (Date.now() - ws.data.checkedAt > 60_000) {
        ws.data.checkedAt = Date.now();
        const current = await auth.resolve(ws.data.request).catch(() => null);
        if (current?.id !== ws.data.user.id) { ws.close(4001, 'Войдите заново'); return; }
      }
      if (typeof message !== 'string') { if (ws === room.mic) room.session.audio(message); return; }
      let command: { type?: string; engine?: string; on?: boolean };
      try { command = JSON.parse(message); } catch { return; }
      if (room.busy) return;
      room.busy = true;
      try {
        switch (command.type) {
          case 'start':
            if (room.session.listening) break;
            room.mic = ws;
            await room.session.start(command.engine === 'whisper' || command.engine === 'elevenlabs' ? command.engine : undefined);
            break;
          case 'stop':
            if (room.mic !== ws) break;
            room.mic = null; await room.session.stop(); break;
          case 'new-slide': room.session.newSlide(); break;
          case 'variants': room.session.setVariants(command.on === true); break;
          case 'reset':
            if (room.mic && room.mic !== ws) break;
            room.mic = null; await room.session.stop();
            room.session = new Session(message => broadcast(room, message), undefined, room.context);
            await room.session.activate();
            broadcast(room, snapshot(room, ws.data.user)); break;
        }
      } finally { room.busy = false; }
    },
    close(ws) {
      clearInterval(ws.data.timer);
      const room = ws.data.room;
      room.sockets.delete(ws);
      if (ws === room.mic) { room.mic = null; void room.session.stop(); }
      if (!room.sockets.size) {
        // Drop caches and in-memory speech when the last tab leaves; disk is tenant-scoped.
        const pending = rooms.get(room.key);
        void pending?.then(current => { if (current === room && !room.sockets.size && rooms.get(room.key) === pending) rooms.delete(room.key); });
      }
    },
  },
});

async function joinWaitlist(request: Request, peer: string): Promise<Response> {
  const type = request.headers.get('content-type') ?? '';
  let input: Record<string, unknown>;
  try { input = type.includes('json') ? await request.json() : Object.fromEntries((await request.formData()).entries()); }
  catch { return json({ ok: false, error: 'Форма пришла пустой. Попробуйте ещё раз.' }, { status: 400 }); }
  const result = await waitlist.add(input, request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || peer);
  if (!type.includes('json')) return Response.redirect(new URL(result.ok ? '/#sent' : '/#error=' + encodeURIComponent(result.error), config.auth.origin), 303);
  return json(result, { status: result.ok ? 200 : 400 });
}
knowledge.start();
console.log(`Живые слайды: http://${server.hostname}:${server.port}`);
