import { readdir } from "node:fs/promises";
import { Database } from "../src/database";
const db = await Database.open();
await db.sql.begin(async tx => {
  await tx`SELECT pg_advisory_xact_lock(710072026)`;
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    await tx.unsafe(await Bun.file(new URL(name, directory)).text());
  }
});
await db.sql.close();
console.log('Схема проектов и документов готова.');
