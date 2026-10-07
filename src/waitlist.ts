import { join } from "node:path";
import { rename } from "node:fs/promises";
import { config } from "./config";
import { Crm } from "./crm";
import type { Database } from "./database";

export interface WaitlistEntry {
  id: string;
  at: string;
  name: string;
  email: string;
  note: string;
  ip: string;
  crm: string;
}

/** What the public form may send; everything else is dropped. */
const LIMITS = { name: 80, email: 120, note: 500 } as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PER_HOUR = 5;
const RETRY_EVERY_MS = 5 * 60_000;
const MAX_ATTEMPTS = 20;

/**
 * Early-access requests from the public page. Each is a row in the database and, once
 * delivered, an intake lead in the Sales CRM; a request the CRM did not take is retried
 * on a timer, so a CRM outage never loses a request and never shows the visitor an error.
 */
export class Waitlist {
  private recent = new Map<string, number[]>(); // submissions per address, for a soft limit
  private crm = new Crm();
  private delivering = false;

  private constructor(private db: Database) {}

  static async open(db: Database): Promise<Waitlist> {
    const list = new Waitlist(db);
    await list.importLegacyFile();
    void list.deliverPending();
    setInterval(() => void list.deliverPending(), RETRY_EVERY_MS).unref();
    return list;
  }

  /** Requests written to waitlist.jsonl by earlier versions move into the table once. */
  private async importLegacyFile(): Promise<void> {
    const path = join(config.dataDir, "waitlist.jsonl");
    const file = Bun.file(path);
    if (!(await file.exists())) return;
    const lines = (await file.text()).split("\n").filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line) as { at: string; name: string; email: string; note?: string; ip?: string };
      await this.db.sql`INSERT INTO waitlist_requests(created_at, name, email, note, ip)
        SELECT ${entry.at}::timestamptz, ${entry.name}, ${entry.email}, ${entry.note ?? ""}, ${entry.ip ?? ""}
        WHERE NOT EXISTS (SELECT 1 FROM waitlist_requests WHERE email = ${entry.email} AND created_at = ${entry.at}::timestamptz)`;
    }
    await rename(path, `${path}.imported`);
    console.log(`Заявки из waitlist.jsonl перенесены в базу: ${lines.length}`);
  }

  async count(): Promise<number> {
    const [row] = await this.db.sql`SELECT count(*)::int AS n FROM waitlist_requests`;
    return row.n;
  }

  async list(): Promise<WaitlistEntry[]> {
    const rows = await this.db.sql`SELECT id, created_at, name, email, note, ip, crm_status FROM waitlist_requests ORDER BY created_at DESC`;
    return rows.map((row: any) => ({ id: row.id, at: row.created_at.toISOString(), name: row.name, email: row.email, note: row.note, ip: row.ip, crm: row.crm_status }));
  }

  /** Validates a submission and records it; the message is meant for the person at the form. */
  async add(input: Record<string, unknown>, ip: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const field = (key: keyof typeof LIMITS) => String(input[key] ?? "").replace(/\s+/g, " ").trim().slice(0, LIMITS[key]);
    if (String(input.website ?? "").trim()) return { ok: true }; // a honeypot field only bots fill in
    const entry = { name: field("name"), email: field("email").toLowerCase(), note: field("note"), ip };
    if (!entry.name) return { ok: false, error: "Напишите, как вас зовут." };
    if (!EMAIL.test(entry.email)) return { ok: false, error: "Проверьте адрес почты: на него придёт письмо о доступе." };

    const now = Date.now();
    const times = (this.recent.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (times.length >= PER_HOUR) return { ok: false, error: "С этого адреса уже отправлено несколько заявок. Попробуйте через час." };
    this.recent.set(ip, [...times, now]);

    await this.db.sql`INSERT INTO waitlist_requests(name, email, note, ip, crm_status)
      VALUES (${entry.name}, ${entry.email}, ${entry.note}, ${entry.ip}, ${this.crm.enabled ? "pending" : "off"})`;
    console.log(`Заявка на ранний доступ: ${entry.email}`);
    void this.deliverPending();
    return { ok: true };
  }

  /** Hands every undelivered request to the CRM, one at a time; failures wait for the next pass. */
  async deliverPending(): Promise<void> {
    if (this.delivering || !this.crm.enabled) return;
    this.delivering = true;
    try {
      const rows = await this.db.sql`SELECT id, created_at, name, email, note FROM waitlist_requests
        WHERE crm_status IN ('pending', 'failed') AND crm_attempts < ${MAX_ATTEMPTS} ORDER BY created_at`;
      for (const row of rows as any[]) {
        const outcome = await this.crm.deliver({ id: row.id, createdAt: row.created_at, name: row.name, email: row.email, note: row.note });
        await this.db.sql`UPDATE waitlist_requests SET crm_status = ${outcome.status}, crm_attempts = crm_attempts + 1,
          crm_delivered_at = ${outcome.status === "delivered" || outcome.status === "duplicate" ? new Date() : null},
          crm_error = ${outcome.status === "failed" ? outcome.error : null} WHERE id = ${row.id}`;
        if (outcome.status === "failed") {
          console.error(`CRM не приняла заявку ${row.id}: ${outcome.error}`);
          break; // the rest would fail the same way; the timer tries again later
        }
      }
    } finally {
      this.delivering = false;
    }
  }
}
