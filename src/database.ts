import { SQL } from "bun";
import { config, secret } from "./config";

export interface User { id: string; subject: string; display_name: string }
export interface Project { id: string; owner_id: string; name: string; personal_source: boolean }

export class Database {
  constructor(readonly sql: SQL) {}

  static async open(): Promise<Database> {
    const url = new URL(await secret("DATABASE_URL", config.knowledge.databasePassEntry));
    // The canonical name resolves inside the cluster; a local checkout may use the LAN IP.
    if (process.env.DATABASE_HOST) url.hostname = process.env.DATABASE_HOST;
    const db = new Database(new SQL(url.toString(), { max: 5, connectionTimeout: 5, idleTimeout: 30 }));
    const [role] = await db.sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    if (role.rolsuper || role.rolbypassrls) throw new Error("Database role must enforce row security");
    return db;
  }

  /** Tenant identity is transaction-local, so it cannot leak through a pooled connection. */
  as<T>(userId: string, work: (tx: SQL) => Promise<T>): Promise<T> {
    return this.sql.begin(async tx => {
      await tx`SELECT set_config('app.user_id', ${userId}, true)`;
      return work(tx as SQL);
    }) as Promise<T>;
  }

  async user(subject: string, displayName: string): Promise<User> {
    const [user] = await this.sql`INSERT INTO app_users(subject, display_name) VALUES (${subject}, ${displayName})
      ON CONFLICT(subject) DO UPDATE SET subject = excluded.subject RETURNING id, subject, display_name`;
    return user;
  }

  async project(userId: string, id: string): Promise<Project | null> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    return this.as(userId, async tx => (await tx`SELECT * FROM projects WHERE id = ${id} AND owner_id = ${userId}`)[0] ?? null);
  }
}
