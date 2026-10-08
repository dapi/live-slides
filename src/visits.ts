import { createHash, randomBytes } from "node:crypto";
import type { Database } from "./database";

export interface VisitStats {
  /** Last days, newest first: how many distinct visitors and page loads. */
  days: { day: string; visitors: number; hits: number }[];
  total: { visitors: number; hits: number };
  /** Where visitors came from, by the host of their first referrer; '' means typed or hidden. */
  referrers: { host: string; visitors: number }[];
}

const BOT = /bot|crawl|spider|preview|fetch|curl|wget|python|headless|lighthouse|facebookexternalhit|telegram|whatsapp|skype|slack/i;
const DAYS = 30;

/**
 * Counts visits to the public page without storing anything about the visitor: the row key
 * is a hash of the day's secret salt, the address and the browser, so the same person on the
 * same day counts once, and nothing links the days or recovers the address.
 */
export class Visits {
  private salts = new Map<string, string>();

  constructor(private db: Database) {}

  /** Records a page load; errors are logged, never shown, and the page is served regardless. */
  record(request: Request, peer: string): void {
    const agent = request.headers.get("user-agent") ?? "";
    if (!agent || BOT.test(agent)) return;
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || peer;
    const referrer = referrerHost(request.headers.get("referer"), new URL(request.url).host);
    void this.store(ip, agent, referrer).catch(() => console.error("Визит не записан"));
  }

  private async store(ip: string, agent: string, referrer: string): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const salt = await this.salt(day);
    const visitor = createHash("sha256").update(`${salt}\n${ip}\n${agent}`).digest("hex");
    await this.db.sql`INSERT INTO page_visits(day, visitor, referrer) VALUES (${day}, ${visitor}, ${referrer})
      ON CONFLICT (day, visitor) DO UPDATE SET hits = page_visits.hits + 1`;
  }

  private async salt(day: string): Promise<string> {
    const known = this.salts.get(day);
    if (known) return known;
    const [row] = await this.db.sql`INSERT INTO visit_days(day, salt) VALUES (${day}, ${randomBytes(16).toString("hex")})
      ON CONFLICT (day) DO UPDATE SET salt = visit_days.salt RETURNING salt`;
    this.salts.clear();
    this.salts.set(day, row.salt);
    return row.salt;
  }

  async stats(): Promise<VisitStats> {
    const days = await this.db.sql`SELECT day::text, count(*)::int AS visitors, sum(hits)::int AS hits FROM page_visits
      WHERE day > current_date - ${DAYS} GROUP BY day ORDER BY day DESC`;
    const [total] = await this.db.sql`SELECT count(*)::int AS visitors, coalesce(sum(hits), 0)::int AS hits FROM page_visits`;
    const referrers = await this.db.sql`SELECT referrer AS host, count(*)::int AS visitors FROM page_visits
      WHERE day > current_date - ${DAYS} GROUP BY referrer ORDER BY visitors DESC, referrer LIMIT 20`;
    return { days: days.map((row: any) => ({ day: row.day, visitors: row.visitors, hits: row.hits })), total: { visitors: total.visitors, hits: total.hits },
      referrers: referrers.map((row: any) => ({ host: row.host, visitors: row.visitors })) };
  }

  /** Visitors over the last week, for the owner's glance in the app. */
  async week(): Promise<number> {
    const [row] = await this.db.sql`SELECT count(*)::int AS n FROM page_visits WHERE day > current_date - 7`;
    return row.n;
  }
}

/** The referrer's host, or '' for none and for the site itself. */
export function referrerHost(referrer: string | null, own: string): string {
  if (!referrer) return "";
  try {
    const host = new URL(referrer).host.toLowerCase();
    return host === own.toLowerCase() ? "" : host.slice(0, 120);
  } catch {
    return "";
  }
}
