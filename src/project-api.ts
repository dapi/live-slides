import { json } from './http';
import { config } from './config';
import { canUsePersonal } from './auth';
import { Database, type User } from './database';
import { InputError } from './documents';
import { Knowledge } from './knowledge';

export class ProjectApi {
  constructor(private db: Database, private knowledge: Knowledge) {}
  async handle(request: Request, user: User): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname === '/api/me') return json({ name: user.display_name, localAccount: user.subject.startsWith('local:'), personalSourceAvailable: canUsePersonal(user) && config.sources.enabled });
    if (url.pathname === '/api/projects') {
      if (request.method === 'GET') return json(await this.db.as(user.id, tx => tx`SELECT id, name, personal_source FROM projects WHERE owner_id = ${user.id} ORDER BY created_at`));
      if (request.method === 'POST') {
        const input = await request.json();
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name || name.length > 120) throw new InputError('Название проекта: от 1 до 120 символов');
        const personal = input.personalSource === true;
        if (personal && (!canUsePersonal(user) || !config.sources.enabled)) throw new InputError('Источник недоступен', 403);
        const project = await this.db.as(user.id, async tx => {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${user.id}, 0))`;
          const [count] = await tx`SELECT count(*)::int AS count FROM projects WHERE owner_id = ${user.id}`;
          if (count.count >= 50) throw new InputError('Лимит аккаунта: 50 проектов', 413);
          return (await tx`INSERT INTO projects(owner_id, name, personal_source) VALUES (${user.id}, ${name}, ${personal}) RETURNING id, name, personal_source`)[0];
        });
        return json(project, { status: 201 });
      }
    }
    const route = url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/documents(?:\/([a-f0-9-]{36})\/retry)?$/i);
    if (!route) return null;
    const project = await this.db.project(user.id, route[1]!);
    if (!project) throw new InputError('Проект не найден', 404);
    if (route[2] && request.method === 'POST') {
      const doc = await this.db.as(user.id, async tx => {
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${user.id}, 0))`;
        const [doc] = await tx`UPDATE documents SET status = 'queued', error = NULL, attempts = 0
          WHERE project_id = ${project.id} AND id = ${route[2]!} AND status = 'error' RETURNING id, name, status`;
        if (doc) await tx`UPDATE app_users SET has_pending_documents = true WHERE id = ${user.id}`;
        return doc;
      });
      if (!doc) throw new InputError('Документ не найден или уже обрабатывается', 404);
      return json(doc);
    }
    if (!route[2] && request.method === 'GET') return json(await this.db.as(user.id, tx => tx`
      SELECT id, name, size, status, error, chunk_count FROM documents WHERE project_id = ${project.id} ORDER BY created_at`));
    if (!route[2] && request.method === 'POST') {
      const declared = Number(request.headers.get('content-length'));
      if (declared > config.knowledge.maxUploadBytes + 65536) throw new InputError('Файл должен быть не больше 20 МБ', 413);
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) throw new InputError('Выберите файл');
      return json(await this.knowledge.upload(user, project, file.name, new Uint8Array(await file.arrayBuffer())), { status: 202 });
    }
    return new Response('Method not allowed', { status: 405 });
  }
}
