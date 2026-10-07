import { Database } from '../src/database';
import { secret } from '../src/config';
const [name, displayName, passEntry] = Bun.argv.slice(2);
if (!name || !/^[a-z0-9][a-z0-9.-]{2,63}$/.test(name) || !displayName || !passEntry) {
  throw new Error('Usage: bun scripts/create-user.ts <login> <name> <pass-entry>');
}
const password = await secret('NEW_USER_PASSWORD', passEntry);
if (password.length < 12 || password.length > 128) throw new Error('Password must have 12–128 characters');
const db = await Database.open();
const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });
await db.sql`INSERT INTO app_users(subject, display_name, password_hash) VALUES (${'local:' + name}, ${displayName}, ${passwordHash})`;
await db.sql.close();
console.log('Аккаунт создан. Существующие аккаунты и пароли не изменены.');
