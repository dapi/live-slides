import { createHash } from 'node:crypto';
import { config, secret } from './config';
import { Database, type Project, type User } from './database';
import { chunks, extractDocument, InputError, validateDocument } from './documents';
import type { SearchResult } from './sources';

export type Embeddings = (texts: string[], signal?: AbortSignal) => Promise<number[][]>;
export const embed: Embeddings = async (texts, signal = AbortSignal.timeout(30_000)) => {
  if (!config.knowledge.embeddingModel) throw new Error('Configure EMBEDDING_MODEL');
  const key = config.knowledge.embeddingKeyPassEntry
    ? await secret('EMBEDDING_API_KEY', config.knowledge.embeddingKeyPassEntry)
    : process.env.EMBEDDING_API_KEY ?? config.llm.apiKey;
  const response = await fetch(config.knowledge.embeddingUrl + '/embeddings', {
    method: 'POST', signal, redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: config.knowledge.embeddingModel, input: texts, dimensions: config.knowledge.dimensions }),
  });
  if (!response.ok) throw new Error('Embedding service unavailable');
  const result = await response.json() as { data: { index: number; embedding: number[] }[] };
  const sorted = result.data?.sort((a, b) => a.index - b.index);
  if (sorted?.length !== texts.length || sorted.some((item, index) => item.index !== index || !validVector(item.embedding))) throw new Error('Invalid embeddings');
  return sorted.map(item => item.embedding);
};
export function validVector(vector: number[]): boolean {
  return Array.isArray(vector) && vector.length === config.knowledge.dimensions && vector.every(Number.isFinite) && vector.some(v => v !== 0);
}
function literal(vector: number[]): string {
  if (!validVector(vector)) throw new Error('Invalid embedding');
  return '[' + vector.join(',') + ']';
}

export class Knowledge {
  private stopping = false;
  private worker?: Promise<void>;
  constructor(readonly db: Database, readonly embeddings: Embeddings = embed,
    readonly extract = extractDocument) {}

  async upload(user: User, project: Project, name: string, bytes: Uint8Array) {
    const file = validateDocument(name, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    return this.db.as(user.id, async tx => {
      // Serialize admission per user so simultaneous uploads cannot defeat the quota.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${user.id}, 0))`;
      const [duplicate] = await tx`SELECT id, name, status FROM documents WHERE project_id = ${project.id} AND sha256 = ${sha}`;
      if (duplicate) return duplicate;
      const [usage] = await tx`SELECT coalesce(sum(size), 0)::int AS bytes, count(*)::int AS count FROM documents WHERE owner_id = ${user.id}`;
      if (usage.bytes + bytes.length > config.knowledge.maxUserBytes || usage.count >= 200) throw new InputError('Лимит аккаунта: 200 документов и 200 МБ', 413);
      const [doc] = await tx`INSERT INTO documents(project_id, owner_id, name, media_type, original, size, sha256)
        VALUES (${project.id}, ${user.id}, ${file.name}, ${file.type}, ${Buffer.from(bytes)}, ${bytes.length}, ${sha}) RETURNING id, name, status`;
      await tx`UPDATE app_users SET has_pending_documents = true WHERE id = ${user.id}`;
      return doc;
    });
  }

  async processNext(userId: string): Promise<boolean> {
    const job = await this.db.as(userId, async tx => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
      const [doc] = await tx`SELECT id FROM documents WHERE owner_id = ${userId} AND
        (status = 'queued' OR (status = 'processing' AND lease_until < now()))
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`;
      if (!doc) {
        await tx`UPDATE app_users SET has_pending_documents = EXISTS (
          SELECT 1 FROM documents WHERE owner_id = ${userId} AND status IN ('queued', 'processing')) WHERE id = ${userId}`;
        return null;
      }
      return (await tx`UPDATE documents SET status = 'processing', attempts = attempts + 1, error = NULL,
        lease_until = now() + interval '15 minutes' WHERE id = ${doc.id} RETURNING *`)[0];
    });
    if (!job) return false;
    try {
      if (job.attempts > 3) throw new InputError('Обработка прерывалась несколько раз. Попробуйте повторить');
      const text = await this.extract(job.name, new Uint8Array(job.original));
      const parts = chunks(text);
      const vectors: number[][] = [];
      const deadline = AbortSignal.timeout(6 * 60_000);
      for (let i = 0; i < parts.length; i += 16) vectors.push(...await this.embeddings(parts.slice(i, i + 16), AbortSignal.any([deadline, AbortSignal.timeout(30_000)])));
      if (vectors.length !== parts.length) throw new Error('Invalid embeddings');
      await this.db.as(userId, async tx => {
        // The attempt fence prevents an expired worker from replacing a newer attempt.
        const [current] = await tx`SELECT attempts, status FROM documents WHERE id = ${job.id} FOR UPDATE`;
        if (!current || current.attempts !== job.attempts || current.status !== 'processing') return;
        await tx`DELETE FROM document_chunks WHERE document_id = ${job.id}`;
        for (let i = 0; i < parts.length; i++) {
          await tx`INSERT INTO document_chunks(document_id, project_id, owner_id, ordinal, text, embedding, embedding_model)
            VALUES (${job.id}, ${job.project_id}, ${userId}, ${i}, ${parts[i]}, ${literal(vectors[i]!)}::vector, ${config.knowledge.embeddingModel})`;
        }
        await tx`UPDATE documents SET status = 'ready', chunk_count = ${parts.length}, lease_until = NULL WHERE id = ${job.id}`;
      });
    } catch (error) {
      // Do not return extractor output, private URLs, database errors or service credentials.
      const detail = error instanceof InputError ? error.message : 'Сервис обработки временно недоступен. Повторите обработку';
      await this.db.as(userId, async tx => {
        await tx`UPDATE documents SET status = 'error', error = ${detail}, lease_until = NULL
          WHERE id = ${job.id} AND attempts = ${job.attempts} AND status = 'processing'`;
      });
    }
    return true;
  }

  start(): void {
    this.worker = (async () => {
      while (!this.stopping) {
        try {
          // Only identities, no document content, are read outside the tenant transaction.
          const users = await this.db.sql`SELECT id FROM app_users WHERE has_pending_documents ORDER BY created_at`;
          for (const user of users) { if (this.stopping) break; await this.processNext(user.id); }
        } catch { console.error('Обработчик документов временно недоступен'); }
        await Bun.sleep(1000);
      }
    })();
  }
  async stop(): Promise<void> { this.stopping = true; await this.worker; }

  source(userId: string, projectId: string) {
    return {
      enabled: true,
      search: async (query: string): Promise<SearchResult> => {
        const started = performance.now();
        try {
          const hasDocuments = await this.db.as(userId, async tx => (await tx`SELECT 1 FROM document_chunks WHERE owner_id = ${userId} AND project_id = ${projectId} LIMIT 1`).length > 0);
          if (!hasDocuments) return { hits: [], ms: Math.round(performance.now() - started) };
          const [vector] = await this.embeddings([query], AbortSignal.timeout(2500));
          const hits = await this.db.as(userId, async tx => {
            const rows = await tx`SELECT c.document_id, c.ordinal, c.text, d.name, 1 - (c.embedding <=> ${literal(vector!)}::vector) AS score
              FROM document_chunks c JOIN documents d ON d.id = c.document_id
              WHERE c.owner_id = ${userId} AND c.project_id = ${projectId} AND d.status = 'ready'
                AND c.embedding_model = ${config.knowledge.embeddingModel}
              ORDER BY c.embedding <=> ${literal(vector!)}::vector LIMIT 4`;
            return rows.filter((row: any) => row.score >= 0.25).map((row: any) => ({
              uri: `project://${projectId}/${row.document_id}/${row.ordinal}`, ref: `project://${projectId}/${row.document_id}`,
              title: row.name, repository: 'project', excerpt: row.text, score: row.score,
            }));
          });
          return { hits, ms: Math.round(performance.now() - started) };
        } catch { return { hits: [], ms: Math.round(performance.now() - started), error: 'Поиск по документам временно недоступен' }; }
      },
    };
  }
}
