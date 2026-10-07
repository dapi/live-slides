import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { config, type SttEngineName } from "./config";
import { DIAGRAMS, Director, type Slide, type StepMetric } from "./director";
import { SiteSearch } from "./site-search";
import { Sources } from "./sources";
import { ElevenLabsStt } from "./stt/elevenlabs";
import type { SttEngine, SttEvents } from "./stt/types";
import { WhisperStt, whisperAvailable } from "./stt/whisper";

type Stage = { state: string; detail?: string };

export interface Status {
  stt: Stage & { engine: SttEngineName; engines: SttEngineName[] };
  slides: Stage & { model: string };
  sources: Stage & { scopes: string[]; found?: number };
  /** Last measured delay from speech to a changed slide. */
  speechToSlideMs?: number;
  /** The director's current guess about what the speaker says next. */
  next?: string;
}

export type Broadcast = (message: Record<string, unknown>) => void;

const sources = new Sources();
const site = new SiteSearch();
/** Where material is looked up, as shown on the page. */
const places = [...(sources.enabled ? config.sources.scopes : []), ...(site.enabled ? [new URL(config.site.searchUrl).hostname] : [])];

function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function deckMarkdown(slides: Slide[]): string {
  const column = (c?: { title: string; items: string[] }) => (c ? [`**${c.title}**`, ...c.items.map((item) => `- ${item}`), ""] : []);
  return slides.map((slide) => [
    `## ${slide.title}`,
    "",
    slide.subtitle ?? "",
    slide.value ? `**${slide.value}** — ${slide.caption ?? ""}` : "",
    slide.quote ? `> ${slide.quote}${slide.attribution ? `\n> — ${slide.attribution}` : ""}` : "",
    ...(DIAGRAMS.includes(slide.layout)
      ? [`Схема (${slide.layout}): ${(slide.bullets ?? []).map((node) => `${node}${slide.predicted.includes(node) ? " (прогноз)" : ""}`).join(slide.layout === "layers" ? " / " : " → ")}${slide.layout === "cycle" ? " → …" : ""}`]
      : (slide.bullets ?? []).map((bullet) => `- ${bullet}${slide.predicted.includes(bullet) ? " _(прогноз, ещё не прозвучало)_" : ""}`)),
    ...column(slide.left),
    ...column(slide.right),
    slide.sources.length ? `\nИсточники: ${slide.sources.map((s) => `${s.title} (${s.url ?? s.ref})`).join("; ")}` : "",
  ].filter((line) => line !== "").join("\n")).join("\n\n---\n\n") + "\n";
}

/** One talk: its recognizer, transcript, deck and files on disk. */
const RESUME_WITHIN_MS = 12 * 60 * 60 * 1000;

export class Session {
  readonly id: string;
  readonly dir: string;
  readonly transcript: { id: number; text: string; at: string }[] = [];
  listening = false;
  status: Status;
  private engine: SttEngine | null = null;
  private director: Director;
  private dirReady: Promise<unknown> | null = null;

  constructor(private broadcast: Broadcast, id = stamp(new Date())) {
    this.id = id;
    this.dir = join(config.dataDir, "sessions", id);
    const engines: SttEngineName[] = whisperAvailable() ? ["elevenlabs", "whisper"] : ["elevenlabs"];
    this.status = {
      stt: { state: "idle", engine: engines.includes(config.stt.engine) ? config.stt.engine : "elevenlabs", engines },
      slides: { state: "idle", model: config.llm.model },
      sources: { state: places.length ? "idle" : "off", scopes: places },
    };
    this.director = new Director([sources, site], {
      onSlide: (slide, action, index) => {
        this.broadcast({ type: "slide", slide, action, index });
        void this.saveDeck();
      },
      onNext: (next) => {
        this.status.next = next || undefined;
      },
      onStage: (stage, detail) => {
        this.status.slides = { ...this.status.slides, state: stage === "error" ? "error" : stage === "idle" ? "idle" : "working", detail };
        if (stage === "sources") this.status.sources = { ...this.status.sources, state: "working", detail: undefined };
        this.pushStatus();
      },
      onSources: (found, error) => {
        this.status.sources = { ...this.status.sources, state: error ? "error" : "idle", detail: error, found };
        this.pushStatus();
      },
      onMetric: (metric: StepMetric) => {
        if (metric.action === "new" || metric.action === "update") this.status.speechToSlideMs = metric.speechToSlideMs;
        this.pushStatus();
        void this.append("metrics.jsonl", metric);
      },
    });
  }

  get slides(): Slide[] {
    return this.director.slides;
  }

  /**
   * After a restart, the deck of the latest recent session comes back on screen instead of an
   * empty stage; its files keep growing under the same session id.
   */
  static async resumeLatest(broadcast: Broadcast): Promise<Session> {
    const root = join(config.dataDir, "sessions");
    const ids = await readdir(root).catch(() => [] as string[]);
    for (const id of ids.sort().reverse()) {
      const deckFile = Bun.file(join(root, id, "deck.json"));
      const age = Date.now() - (await stat(join(root, id, "deck.json")).catch(() => null))?.mtimeMs!;
      if (!(await deckFile.exists()) || !(age < RESUME_WITHIN_MS)) continue;
      try {
        const { slides } = (await deckFile.json()) as { slides: Slide[] };
        const session = new Session(broadcast, id);
        const lines = (await Bun.file(join(root, id, "transcript.jsonl")).text().catch(() => "")).trim().split("\n").filter(Boolean);
        session.transcript.push(...lines.map((line) => JSON.parse(line)));
        session.director.load(slides, session.transcript.slice(-20).map((entry) => entry.text).join(" "));
        return session;
      } catch {
        break;
      }
    }
    return new Session(broadcast);
  }

  snapshot() {
    return {
      type: "state",
      session: this.id,
      listening: this.listening,
      slides: this.slides,
      transcript: this.transcript.slice(-30),
      status: this.status,
    };
  }

  private pushStatus(): void {
    this.broadcast({ type: "status", status: this.status });
  }

  async start(requested: SttEngineName = this.status.stt.engine): Promise<void> {
    if (this.listening) return;
    const engineName = this.status.stt.engines.includes(requested) ? requested : this.status.stt.engine;
    const events: SttEvents = {
      onPartial: (text) => {
        this.broadcast({ type: "partial", text });
        this.director.partialText(text);
      },
      onFinal: (text) => {
        const entry = { id: this.transcript.length + 1, text, at: new Date().toISOString() };
        this.transcript.push(entry);
        this.broadcast({ type: "final", ...entry });
        void this.append("transcript.jsonl", entry);
        this.director.finalText(text);
      },
      onState: (state, detail) => {
        this.status.stt = { ...this.status.stt, state, detail };
        this.pushStatus();
      },
    };
    this.engine = engineName === "whisper" ? new WhisperStt(events) : new ElevenLabsStt(events);
    this.status.stt = { ...this.status.stt, state: "connecting", detail: undefined, engine: engineName };
    this.listening = true;
    this.broadcast({ type: "listening", on: true });
    try {
      await this.engine.start();
    } catch (error) {
      this.listening = false;
      this.engine = null;
      this.broadcast({ type: "listening", on: false });
      this.status.stt = { ...this.status.stt, state: "error", detail: this.status.stt.detail ?? (error as Error).message };
      this.pushStatus();
    }
  }

  audio(pcm: Uint8Array): void {
    if (this.listening) this.engine?.push(pcm);
  }

  async stop(): Promise<void> {
    if (!this.listening) return;
    this.listening = false;
    this.broadcast({ type: "listening", on: false });
    await this.engine?.stop();
    this.engine = null;
    this.broadcast({ type: "partial", text: "" });
    this.director.flush();
  }

  newSlide(): void {
    this.director.force();
  }

  private ensureDir(): Promise<unknown> {
    return (this.dirReady ??= mkdir(this.dir, { recursive: true }));
  }

  private async append(file: string, record: unknown): Promise<void> {
    await this.ensureDir();
    await appendFile(join(this.dir, file), JSON.stringify(record) + "\n");
  }

  private async saveDeck(): Promise<void> {
    await this.ensureDir();
    await Bun.write(join(this.dir, "deck.json"), JSON.stringify({ session: this.id, slides: this.slides }, null, 2));
    await Bun.write(join(this.dir, "deck.md"), deckMarkdown(this.slides));
  }
}
