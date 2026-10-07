// Creates an account that signs in by a one-time code sent to its e-mail; no password is set.
// Usage: bun scripts/invite-user.ts <login> <name> <email>
import { Database } from '../src/database';
const [name, displayName, email] = Bun.argv.slice(2);
if (!name || !/^[a-z0-9][a-z0-9.-]{2,63}$/.test(name) || !displayName || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
  throw new Error('Usage: bun scripts/invite-user.ts <login> <name> <email>');
}
const db = await Database.open();
await db.sql`INSERT INTO app_users(subject, display_name, username, email) VALUES (${'local:' + name}, ${displayName}, ${name}, ${email.trim().toLowerCase()})`;
await db.sql.close();
console.log(`Аккаунт ${name} создан. Вход по коду на ${email.trim().toLowerCase()}; пароль можно задать в профиле.`);
