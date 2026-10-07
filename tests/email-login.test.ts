import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Auth, COOKIE } from '../src/auth';
import { config } from '../src/config';
import { Database, type User } from '../src/database';
import { Mail } from '../src/mail';

/** A bare SMTP server: enough of the dialogue for nodemailer to hand over one letter. */
function fakeSmtp(onMessage: (raw: string) => void) {
  return Bun.listen<{ data: boolean; buffer: string; message: string }>({
    hostname: '127.0.0.1', port: 0,
    socket: {
      open(socket) { socket.data = { data: false, buffer: '', message: '' }; socket.write('220 fake ESMTP\r\n'); },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        for (;;) {
          const end = socket.data.buffer.indexOf('\r\n');
          if (end < 0) break;
          const line = socket.data.buffer.slice(0, end);
          socket.data.buffer = socket.data.buffer.slice(end + 2);
          if (socket.data.data) {
            if (line === '.') { socket.data.data = false; onMessage(socket.data.message); socket.data.message = ''; socket.write('250 OK\r\n'); }
            else socket.data.message += line + '\n';
            continue;
          }
          const verb = line.split(' ')[0].toUpperCase();
          if (verb === 'EHLO' || verb === 'HELO') socket.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (verb === 'AUTH') socket.write('235 OK\r\n');
          else if (verb === 'DATA') { socket.data.data = true; socket.write('354 go\r\n'); }
          else if (verb === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
          else socket.write('250 OK\r\n');
        }
      },
    },
  });
}

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite('sign-in by a one-time code sent by e-mail', () => {
  let db: Database, user: User, auth: Auth;
  const letters: string[] = [];
  let smtp: ReturnType<typeof fakeSmtp>;
  const previous = { ...config.mail };
  beforeAll(async () => {
    db = await Database.open();
    user = await db.user('local:code-' + crypto.randomUUID(), 'Сергей');
    await db.sql`UPDATE app_users SET email = ${'Code.Test@example.org'} WHERE id = ${user.id}`;
    smtp = fakeSmtp(raw => letters.push(raw));
    Object.assign(config.mail, { smtpUrl: `smtp://sender%40example.org@127.0.0.1:${smtp.port}`, from: 'Живые слайды <sender@example.org>', passwordPassEntry: undefined });
    process.env.SMTP_PASSWORD = 'test-password';
    auth = new Auth(db, new Mail());
  });
  afterAll(async () => {
    Object.assign(config.mail, previous); delete process.env.SMTP_PASSWORD;
    smtp.stop(true);
    await db.sql`DELETE FROM app_users WHERE id = ${user.id}`;
    await db.sql.close();
  });

  test('a known address gets a letter, an unknown one gets the same answer and no letter', async () => {
    expect(auth.emailAvailable).toBe(true);
    expect((await auth.requestCode({ email: 'nobody@example.org' })).status).toBe(200);
    expect(letters).toHaveLength(0);
    expect((await auth.requestCode({ email: 'code.test@example.org' })).status).toBe(200);
    await expect(auth.requestCode({ email: 'code.test@example.org' })).rejects.toMatchObject({ status: 429 });
  });

  test('a wrong code is refused, the right one opens a session once', async () => {
    const [row] = await db.sql`SELECT code_hash FROM login_codes WHERE user_id = ${user.id}`;
    expect(row).toBeDefined();
    await expect(auth.loginByCode({ email: 'code.test@example.org', code: '000000' })).rejects.toMatchObject({ status: 401 });
    expect(letters).toHaveLength(1);
    expect(letters[0]).toContain('To: code.test@example.org');
    // nodemailer sends a Cyrillic body as base64 after a blank line.
    const body = Buffer.from(letters[0].split('\n\n').slice(1).join('').replace(/\s/g, ''), 'base64').toString('utf8');
    expect(body).toContain('Сергей, ваш код для входа');
    const code = /: (\d{6})/.exec(body)?.[1] ?? '';
    expect(code).toHaveLength(6);
    const response = await auth.loginByCode({ email: 'Code.Test@example.org', code: code.slice(0, 3) + ' ' + code.slice(3) });
    expect(response.headers.get('set-cookie')).toContain(COOKIE + '=');
    const token = response.headers.get('set-cookie')!.match(/=([a-f0-9]{64})/)![1];
    expect((await auth.resolve(new Request('http://test/', { headers: { cookie: `${COOKIE}=${token}` } })))?.id).toBe(user.id);
    await expect(auth.loginByCode({ email: 'code.test@example.org', code })).rejects.toMatchObject({ status: 401 });
  });
});
