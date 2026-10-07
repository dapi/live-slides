import { Database } from "../src/database";
const db = await Database.open();
await db.sql.begin(async tx => {
  await tx`SELECT pg_advisory_xact_lock(710072026)`;
  await tx.unsafe(await Bun.file(new URL('../migrations/001-projects.sql', import.meta.url)).text());
});
await db.sql.close();
console.log('Схема проектов и документов готова.');
