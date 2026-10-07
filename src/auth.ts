import { json } from './http';
import { createHash, randomBytes } from "node:crypto";
import type { Database, User } from "./database";
import { config } from "./config";

export const COOKIE = "live_slides_session";
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const AGE = 12 * 60 * 60;
export class Auth {
  constructor(private db: Database) {}

  async resolve(request: Request): Promise<User | null> {
    const cookies = request.headers.get('cookie') ?? '';
    const token = cookies.split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const [user] = await this.db.sql`SELECT u.id, u.subject, u.display_name FROM app_logins l
        JOIN app_users u ON u.id = l.user_id WHERE token_hash = ${hash(token)} AND expires_at > now()`;
      if (user) return user;
    }
    if (!config.auth.corpVerifyUrl || !cookies) return null;
    // Fixed operator-configured endpoint; credentials cannot be redirected to another host.
    const response = await fetch(config.auth.corpVerifyUrl, {
      headers: { cookie: cookies }, redirect: 'error', signal: AbortSignal.timeout(2500),
    }).catch(() => null);
    if (response?.ok && response.headers.get('x-auth-request-user') === 'danil') {
      return this.db.user('corp:owner', 'Владелец');
    }
    return null;
  }

  async login(username: string, password: string): Promise<Response> {
    const [user] = await this.db.sql`SELECT * FROM app_users WHERE subject = ${'local:' + username.toLowerCase()}`;
    // A dummy hash prevents a cheap timing oracle for accounts which do not exist.
    const valid = await Bun.password.verify(password, user?.password_hash ?? DUMMY_HASH).catch(() => false);
    if (!valid || !user) return json({ error: 'Неверный логин или пароль' }, { status: 401 });
    const token = randomBytes(32).toString('hex');
    await this.db.sql`DELETE FROM app_logins WHERE expires_at < now()`;
    await this.db.sql`INSERT INTO app_logins(token_hash, user_id, expires_at)
      VALUES (${hash(token)}, ${user.id}, now() + interval '12 hours')`;
    return json({ ok: true }, { headers: { 'Set-Cookie': this.cookie(token, AGE) } });
  }

  async logout(request: Request): Promise<Response> {
    const token = (request.headers.get('cookie') ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    if (token) await this.db.sql`DELETE FROM app_logins WHERE token_hash = ${hash(token)}`;
    return json({ ok: true }, { headers: { 'Set-Cookie': this.cookie('', 0) } });
  }

  private cookie(token: string, age: number): string {
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${config.auth.origin.startsWith('https:') ? '; Secure' : ''}`;
  }
}
// Generated at process start, unrelated to any real account.
const DUMMY_HASH = await Bun.password.hash(randomBytes(32).toString('hex'), { algorithm: 'argon2id' });

export function sameOrigin(request: Request): boolean {
  return request.headers.get('origin') === config.auth.origin;
}
export function canUsePersonal(user: User): boolean {
  // Password accounts can never inherit the private connector, even when named "danil".
  return user.subject === 'corp:owner' && user.subject === config.auth.ownerSubject;
}
