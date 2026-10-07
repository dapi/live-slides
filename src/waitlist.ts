import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config";

export interface WaitlistEntry {
  at: string;
  name: string;
  email: string;
  note: string;
  ip: string;
}

/** What the public form may send; everything else is dropped. */
const LIMITS = { name: 80, email: 120, note: 500 } as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PER_HOUR = 5;

/**
 * Early-access requests from the public page. Kept as one JSON line per request in the data
 * directory, so a redeploy or restart loses nothing and the list is readable without the app.
 */
export class Waitlist {
  private entries: WaitlistEntry[] = [];
  private recent = new Map<string, number[]>(); // submissions per address, for a soft limit
  private readonly file = join(config.dataDir, "waitlist.jsonl");

  static async open(): Promise<Waitlist> {
    const list = new Waitlist();
    const file = Bun.file(list.file);
    if (await file.exists()) {
      list.entries = (await file.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as WaitlistEntry);
    }
    return list;
  }

  get count(): number {
    return this.entries.length;
  }

  list(): WaitlistEntry[] {
    return [...this.entries].reverse();
  }

  /** Validates a submission and records it; the message is meant for the person at the form. */
  async add(input: Record<string, unknown>, ip: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const field = (key: keyof typeof LIMITS) => String(input[key] ?? "").replace(/\s+/g, " ").trim().slice(0, LIMITS[key]);
    if (String(input.website ?? "").trim()) return { ok: true }; // a honeypot field only bots fill in
    const entry = { at: new Date().toISOString(), name: field("name"), email: field("email").toLowerCase(), note: field("note"), ip };
    if (!entry.name) return { ok: false, error: "Напишите, как вас зовут." };
    if (!EMAIL.test(entry.email)) return { ok: false, error: "Проверьте адрес почты: на него придёт письмо о доступе." };

    const now = Date.now();
    const times = (this.recent.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (times.length >= PER_HOUR) return { ok: false, error: "С этого адреса уже отправлено несколько заявок. Попробуйте через час." };
    this.recent.set(ip, [...times, now]);

    await mkdir(config.dataDir, { recursive: true });
    await appendFile(this.file, JSON.stringify(entry) + "\n");
    this.entries.push(entry);
    console.log(`Заявка на ранний доступ: ${entry.email}`);
    return { ok: true };
  }
}
