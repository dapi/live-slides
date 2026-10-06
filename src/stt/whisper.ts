import { createServer } from "node:net";
import { existsSync } from "node:fs";
import type { Subprocess } from "bun";
import { config } from "../config";
import type { SttEngine, SttEvents } from "./types";

const FRAME_BYTES = 3200; // 100 ms of 16 kHz 16-bit mono
const START_FRAMES = 2; // loud frames that open a phrase
const END_SILENCE_FRAMES = 7; // 700 ms of silence closes it
const PREROLL_FRAMES = 3;
const MAX_PHRASE_FRAMES = 200; // 20 s: cut even without a pause
const PARTIAL_EVERY_FRAMES = 10;
const MIN_RMS = 350;

// Whisper invents these on near-silent audio.
const HALLUCINATION = /^(субтитры|редактор субтитров|продолжение следует|спасибо за просмотр|подписывайтесь|dimatorzok)/i;

let server: { proc: Subprocess; port: number } | null = null;
let starting: Promise<number> | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** One warm whisper-server per process; the model stays loaded between sessions. */
async function ensureServer(): Promise<number> {
  if (server && server.proc.exitCode === null) return server.port;
  starting ??= (async () => {
    const { bin, model, threads } = config.stt.whisper;
    if (!existsSync(model)) throw new Error(`Нет модели Whisper: ${model}. Запустите scripts/download-model.sh`);
    const port = await freePort();
    const proc = Bun.spawn(
      [bin, "-m", model, "-l", config.language, "-t", String(threads), "--host", "127.0.0.1", "--port", String(port)],
      { stdout: "ignore", stderr: "ignore" },
    );
    for (let attempt = 0; attempt < 120; attempt++) {
      if (proc.exitCode !== null) throw new Error("whisper-server завершился при запуске");
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
        server = { proc, port };
        return port;
      } catch {
        await Bun.sleep(250);
      }
    }
    proc.kill();
    throw new Error("whisper-server не ответил за 30 секунд");
  })().finally(() => {
    starting = null;
  });
  return starting;
}

process.on("exit", () => server?.proc.kill());

function wav(pcm: Uint8Array): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, value: string) => [...value].forEach((ch, i) => header.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  header.setUint32(4, 36 + pcm.length, true);
  text(8, "WAVEfmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, 16000, true);
  header.setUint32(28, 32000, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, "data");
  header.setUint32(40, pcm.length, true);
  return new Blob([header.buffer, pcm as Uint8Array<ArrayBuffer>], { type: "audio/wav" });
}

function rms(frame: Uint8Array): number {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let sum = 0;
  for (let i = 0; i < frame.byteLength; i += 2) {
    const sample = view.getInt16(i, true);
    sum += sample * sample;
  }
  return Math.sqrt(sum / (frame.byteLength / 2));
}

/**
 * Local whisper.cpp: nothing leaves the machine. Whisper is not a streaming model, so the
 * phrase in progress is re-recognized about once a second and finalized on a pause.
 */
export class WhisperStt implements SttEngine {
  readonly name = "whisper";
  private active = false;
  /** Audio that arrives while the model is still loading. */
  private backlog: Uint8Array[] | null = null;
  private port = 0;
  private carry = new Uint8Array(0);
  private preroll: Uint8Array[] = [];
  private phrase: Uint8Array[] = [];
  private speaking = false;
  private loud = 0;
  private silent = 0;
  private sincePartial = 0;
  private noise = MIN_RMS / 3;
  private busy = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private events: SttEvents) {}

  async start(): Promise<void> {
    this.events.onState("connecting", "загружается модель");
    this.backlog = [];
    try {
      this.port = await ensureServer();
    } catch (error) {
      this.backlog = null;
      this.events.onState("error", (error as Error).message);
      throw error;
    }
    this.active = true;
    this.events.onState("ready");
    const early = this.backlog;
    this.backlog = null;
    for (const chunk of early) this.push(chunk);
  }

  push(pcm: Uint8Array): void {
    if (this.backlog) {
      this.backlog.push(pcm.slice());
      return;
    }
    if (!this.active) return;
    const data = new Uint8Array(this.carry.length + pcm.length);
    data.set(this.carry);
    data.set(pcm, this.carry.length);
    let offset = 0;
    for (; offset + FRAME_BYTES <= data.length; offset += FRAME_BYTES) {
      this.frame(data.slice(offset, offset + FRAME_BYTES));
    }
    this.carry = data.slice(offset);
  }

  private frame(frame: Uint8Array): void {
    const level = rms(frame);
    const isLoud = level > Math.max(MIN_RMS, this.noise * 3);
    if (!isLoud) this.noise = this.noise * 0.95 + level * 0.05;

    if (!this.speaking) {
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES + START_FRAMES) this.preroll.shift();
      this.loud = isLoud ? this.loud + 1 : 0;
      if (this.loud >= START_FRAMES) {
        this.speaking = true;
        this.phrase = this.preroll;
        this.preroll = [];
        this.loud = 0;
        this.silent = 0;
        this.sincePartial = 0;
      }
      return;
    }

    this.phrase.push(frame);
    this.silent = isLoud ? 0 : this.silent + 1;
    this.sincePartial++;
    if (this.silent >= END_SILENCE_FRAMES || this.phrase.length >= MAX_PHRASE_FRAMES) {
      this.finalize();
    } else if (this.sincePartial >= PARTIAL_EVERY_FRAMES && !this.busy) {
      this.sincePartial = 0;
      const snapshot = this.join(this.phrase);
      this.enqueue(async () => {
        const text = await this.transcribe(snapshot);
        if (text && this.speaking) this.events.onPartial(text);
      });
    }
  }

  private finalize(): void {
    const audio = this.join(this.phrase);
    this.phrase = [];
    this.speaking = false;
    this.silent = 0;
    this.enqueue(async () => {
      const text = await this.transcribe(audio);
      if (text) this.events.onFinal(text);
    });
  }

  private join(frames: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(frames.length * FRAME_BYTES);
    frames.forEach((frame, i) => out.set(frame, i * FRAME_BYTES));
    return out;
  }

  /** Requests run one at a time and in order, so phrases never overtake each other. */
  private enqueue(job: () => Promise<void>): void {
    this.busy = true;
    this.queue = this.queue
      .then(job)
      .catch((error) => this.events.onState("error", `Whisper: ${(error as Error).message}`))
      .finally(() => {
        this.busy = false;
      });
  }

  private async transcribe(pcm: Uint8Array): Promise<string> {
    const form = new FormData();
    form.append("file", wav(pcm), "phrase.wav");
    form.append("temperature", "0");
    form.append("response_format", "json");
    form.append("language", config.language);
    form.append("prompt", config.stt.whisper.prompt);
    const response = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { text?: string };
    const text = (body.text ?? "").replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ").replace(/\s+/g, " ").trim();
    return HALLUCINATION.test(text) ? "" : text;
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    if (this.speaking && this.phrase.length > 5) this.finalize();
    this.speaking = false;
    this.phrase = [];
    this.preroll = [];
    this.carry = new Uint8Array(0);
    await this.queue;
    this.events.onState("idle");
  }
}
