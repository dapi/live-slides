import { json } from './http';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { SQL } from 'bun';
import type { Database, User } from './database';
import { config } from './config';
import { InputError } from './documents';
import type { Mail } from './mail';

export const COOKIE = 'live_slides_session';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const AGE = 12 * 60 * 60;
const CODE_TTL_MINUTES = 10;
const CODE_ATTEMPTS = 5;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export class Auth {
  constructor(private db: Database, private mail?: Mail) {}

  get emailAvailable(): boolean {
    return Boolean(this.mail?.enabled);
  }

  async resolve(request: Request): Promise<User | null> {
    const token = this.token(request);
    if (!token) return null;
    const [user] = await this.db.sql`SELECT u.id, u.subject, u.display_name FROM app_logins l
      JOIN app_users u ON u.id = l.user_id WHERE token_hash = ${hash(token)} AND expires_at > now()`;
    return user ?? null;
  }

  /** Explicit Corp sign-in exchanges a verified identity for an app-owned session. */
  async corpLogin(request: Request): Promise<Response> {
    if (!corpAvailable()) throw new InputError('Этот способ входа недоступен', 404);
    const cookies = request.headers.get('cookie') ?? '';
    const response = cookies ? await fetch(config.auth.corpVerifyUrl!, {
      headers: { cookie: cookies }, redirect: 'error', signal: AbortSignal.timeout(2500),
    }).catch(() => null) : null;
    if (response?.ok && response.headers.get('x-auth-request-user') !== config.auth.corpOwnerUser) return Response.redirect(new URL('/login?error=corp', config.auth.origin), 303);
    if (!response?.ok) {
      const target = new URL(config.auth.corpLoginUrl);
      target.searchParams.set('return_to', config.auth.origin + '/auth/corp');
      return Response.redirect(target, 303);
    }
    const user = await this.db.user(config.auth.ownerSubject, config.auth.ownerName);
    const token = await this.issue(this.db.sql, user.id);
    return new Response(null, { status: 303, headers: { Location: '/app/', 'Set-Cookie': this.cookie(token, AGE), 'Cache-Control': 'no-store' } });
  }

  async login(username: string, password: string): Promise<Response> {
    const [user] = await this.db.sql`SELECT id, password_hash FROM app_users WHERE username = ${username.trim().toLowerCase()}`;
    const valid = await Bun.password.verify(password, user?.password_hash ?? DUMMY_HASH).catch(() => false);
    if (!valid || !user?.password_hash) throw new InputError('Неверный логин или пароль', 401);
    const token = await this.db.sql.begin(async tx => {
      // A concurrent password change cannot leave an old-password login alive.
      const [current] = await tx`SELECT password_hash FROM app_users WHERE id = ${user.id} FOR UPDATE`;
      if (current?.password_hash !== user.password_hash) throw new InputError('Неверный логин или пароль', 401);
      return this.issue(tx as SQL, user.id);
    });
    return json({ ok: true }, { headers: { 'Set-Cookie': this.cookie(token, AGE) } });
  }

  /**
   * Sends a one-time code to an account's e-mail. An unknown address gets the same answer as a
   * known one, so the form reveals no accounts; the code lives ten minutes and five attempts.
   */
  async requestCode(input: unknown): Promise<Response> {
    if (!this.emailAvailable) throw new InputError('Вход по почте недоступен', 404);
    const email = this.email(input);
    const [user] = await this.db.sql`SELECT id, display_name FROM app_users WHERE lower(email) = ${email}`;
    if (user) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await this.db.sql.begin(async tx => {
        // One letter a minute per account: a stranger typing someone's address cannot flood it.
        const [recent] = await tx`SELECT 1 FROM login_codes WHERE user_id = ${user.id} AND created_at > now() - interval '1 minute'`;
        if (recent) throw new InputError('Письмо с кодом уже отправлено. Проверьте почту или подождите минуту', 429);
        await tx`DELETE FROM login_codes WHERE user_id = ${user.id} OR expires_at < now()`;
        await tx`INSERT INTO login_codes(user_id, code_hash, expires_at) VALUES (${user.id}, ${hash(code)}, now() + ${CODE_TTL_MINUTES} * interval '1 minute')`;
      });
      await this.mail!.send(email, `${code} — код для входа в Живые слайды`,
        `${user.display_name}, ваш код для входа в «Живые слайды»: ${code}\n\nОн действует ${CODE_TTL_MINUTES} минут. Если вы не запрашивали вход, просто не отвечайте на это письмо.\n\n${config.auth.origin}/login`);
    }
    return json({ ok: true });
  }

  async loginByCode(input: unknown): Promise<Response> {
    if (!this.emailAvailable) throw new InputError('Вход по почте недоступен', 404);
    const email = this.email(input);
    const code = String((input as { code?: unknown } | null)?.code ?? '').replace(/\D/g, '');
    if (code.length !== 6) throw new InputError('Код — шесть цифр из письма');
    const token = await this.db.sql.begin(async tx => {
      const [row] = await tx`SELECT c.id, c.user_id, c.code_hash, c.attempts FROM login_codes c JOIN app_users u ON u.id = c.user_id
        WHERE lower(u.email) = ${email} AND c.expires_at > now() ORDER BY c.created_at DESC LIMIT 1 FOR UPDATE OF c`;
      if (!row || row.attempts >= CODE_ATTEMPTS) throw new InputError('Код не подошёл или устарел. Запросите новый', 401);
      const expected = Buffer.from(row.code_hash, 'hex');
      const actual = Buffer.from(hash(code), 'hex');
      if (!timingSafeEqual(expected, actual)) {
        await tx`UPDATE login_codes SET attempts = attempts + 1 WHERE id = ${row.id}`;
        throw new InputError('Код не подошёл. Проверьте цифры из письма', 401);
      }
      await tx`DELETE FROM login_codes WHERE user_id = ${row.user_id}`;
      return this.issue(tx as SQL, row.user_id);
    });
    return json({ ok: true }, { headers: { 'Set-Cookie': this.cookie(token, AGE) } });
  }

  private email(input: unknown): string {
    const email = String((input as { email?: unknown } | null)?.email ?? '').trim().toLowerCase();
    if (email.length > 120 || !EMAIL.test(email)) throw new InputError('Проверьте адрес почты');
    return email;
  }

  async profile(user: User) {
    const [profile] = await this.db.sql`SELECT display_name AS name, username, email,
      password_hash IS NOT NULL AS "hasPassword" FROM app_users WHERE id = ${user.id}`;
    return profile;
  }

  async updateProfile(user: User, input: unknown): Promise<Response> {
    const name = (input as { name?: unknown } | null)?.name;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new InputError('Имя: от 1 до 100 символов');
    await this.db.sql`UPDATE app_users SET display_name = ${name.trim()} WHERE id = ${user.id}`;
    return json({ ok: true });
  }

  async changePassword(user: User, input: unknown): Promise<Response> {
    const { currentPassword, newPassword, username } = (input ?? {}) as Record<string, unknown>;
    if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 128) throw new InputError('Новый пароль: от 12 до 128 символов');
    if (typeof username !== 'string' || !/^[a-z0-9][a-z0-9.-]{2,63}$/.test(username.trim().toLowerCase())) throw new InputError('Логин: 3–64 символа, латинские буквы, цифры, точка или дефис');
    if (currentPassword !== undefined && (typeof currentPassword !== 'string' || currentPassword.length > 128)) throw new InputError('Неверный текущий пароль');
    const passwordHash = await Bun.password.hash(newPassword, { algorithm: 'argon2id' });
    try {
      const token = await this.db.sql.begin(async tx => {
        const [current] = await tx`SELECT password_hash FROM app_users WHERE id = ${user.id} FOR UPDATE`;
        if (!current) throw new InputError('Войдите заново', 401);
        if (current.password_hash && !await Bun.password.verify(typeof currentPassword === 'string' ? currentPassword : '', current.password_hash).catch(() => false)) {
          throw new InputError('Неверный текущий пароль');
        }
        await tx`UPDATE app_users SET password_hash = ${passwordHash}, username = ${username.trim().toLowerCase()} WHERE id = ${user.id}`;
        await tx`DELETE FROM app_logins WHERE user_id = ${user.id}`;
        return this.issue(tx as SQL, user.id);
      });
      return json({ ok: true }, { headers: { 'Set-Cookie': this.cookie(token, AGE) } });
    } catch (error) {
      if ((error as { errno?: string }).errno === '23505') throw new InputError('Этот логин уже занят', 409);
      throw error;
    }
  }

  async logout(request: Request): Promise<Response> {
    const token = this.token(request);
    if (token) await this.db.sql`DELETE FROM app_logins WHERE token_hash = ${hash(token)}`;
    return json({ ok: true }, { headers: { 'Set-Cookie': this.cookie('', 0) } });
  }

  private token(request: Request): string | null {
    const value = (request.headers.get('cookie') ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
  }
  private async issue(sql: SQL, userId: string): Promise<string> {
    const token = randomBytes(32).toString('hex');
    await sql`DELETE FROM app_logins WHERE expires_at < now()`;
    await sql`INSERT INTO app_logins(token_hash, user_id, expires_at) VALUES (${hash(token)}, ${userId}, now() + interval '12 hours')`;
    return token;
  }
  private cookie(token: string, age: number): string {
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${config.auth.origin.startsWith('https:') ? '; Secure' : ''}`;
  }
}
const DUMMY_HASH = await Bun.password.hash(randomBytes(32).toString('hex'), { algorithm: 'argon2id' });
export function sameOrigin(request: Request): boolean {
  return request.headers.get('origin') === config.auth.origin;
}
export function canUsePersonal(user: User): boolean {
  // The verified owner's stable identity survives creation of app credentials. A matching
  // display name or username never gives another account access to the private connector.
  return config.auth.ownerSubject.startsWith('corp:') && user.subject === config.auth.ownerSubject;
}
export function corpAvailable(): boolean {
  return !!(config.auth.corpVerifyUrl && config.auth.corpLoginUrl && config.auth.corpOwnerUser
    && config.auth.ownerSubject === `corp:${config.auth.corpOwnerUser}`);
}
