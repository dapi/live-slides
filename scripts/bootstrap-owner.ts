import { Database } from '../src/database';
const db = await Database.open();
const owner = await db.user('corp:owner', 'Владелец');
await db.as(owner.id, async tx => {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${owner.id}, 0))`;
  await tx`INSERT INTO projects(owner_id, name, personal_source)
    SELECT ${owner.id}, 'Моя база знаний', true WHERE NOT EXISTS (SELECT 1 FROM projects WHERE owner_id = ${owner.id})`;
});
await db.sql.close();
console.log('Проект владельца готов. Личные материалы не копировались.');
