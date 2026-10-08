import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from '../src/database';
import { Visits, referrerHost } from '../src/visits';

test('the referrer keeps only a foreign host', () => {
  expect(referrerHost(null, 'live-slides.test')).toBe('');
  expect(referrerHost('https://live-slides.test/app/', 'live-slides.test')).toBe('');
  expect(referrerHost('https://t.me/s/channel', 'live-slides.test')).toBe('t.me');
  expect(referrerHost('not a url', 'live-slides.test')).toBe('');
});

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite('visits of the public page', () => {
  let db: Database, visits: Visits;
  const load = (agent: string, ip: string, referer?: string) =>
    new Request('https://live-slides.test/', { headers: { 'user-agent': agent, 'x-forwarded-for': ip, ...(referer ? { referer } : {}) } });
  beforeAll(async () => {
    db = await Database.open();
    await db.sql`DELETE FROM page_visits`;
    visits = new Visits(db);
  });
  afterAll(async () => {
    await db.sql`DELETE FROM page_visits`;
    await db.sql.close();
  });

  test('a visitor counts once a day however many loads; bots do not count', async () => {
    visits.record(load('Mozilla/5.0 Safari', '10.0.0.1', 'https://t.me/s/channel'), '');
    visits.record(load('Mozilla/5.0 Safari', '10.0.0.1'), '');
    visits.record(load('Mozilla/5.0 Firefox', '10.0.0.2'), '');
    visits.record(load('TelegramBot (like TwitterBot)', '10.0.0.3'), '');
    visits.record(load('', '10.0.0.4'), '');
    await Bun.sleep(300);
    const stats = await visits.stats();
    expect(stats.total).toEqual({ visitors: 2, hits: 3 });
    expect(stats.days).toHaveLength(1);
    expect(stats.referrers).toEqual([{ host: '', visitors: 1 }, { host: 't.me', visitors: 1 }]);
    expect(await visits.week()).toBe(2);
    // The stored key reveals neither the address nor the browser.
    const rows = await db.sql`SELECT visitor FROM page_visits`;
    for (const row of rows) expect(row.visitor).toMatch(/^[a-f0-9]{64}$/);
  });

  test('the same visitor is recognised after a restart: the day salt is kept', async () => {
    const again = new Visits(db);
    again.record(load('Mozilla/5.0 Safari', '10.0.0.1'), '');
    await Bun.sleep(300);
    expect((await again.stats()).total).toEqual({ visitors: 2, hits: 4 });
  });
});
