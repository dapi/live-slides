import { config, secret } from "../config";
import type { SttEngine, SttEvents } from "./types";

const ENDPOINT = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const MAX_BUFFERED_CHUNKS = 100; // ~10 s of audio kept while the socket (re)connects

/** ElevenLabs Scribe realtime: true streaming recognition, phrases close on pauses. */
export class ElevenLabsStt implements SttEngine {
  readonly name = "elevenlabs";
  private ws: WebSocket | null = null;
  private active = false;
  private pending: Uint8Array[] = [];
  private retries = 0;

  constructor(private events: SttEvents) {}

  async start(): Promise<void> {
    this.active = true;
    this.retries = 0;
    await this.connect();
  }

  private async connect(): Promise<void> {
    this.events.onState("connecting");
    let key: string;
    try {
      key = await secret(config.stt.elevenlabs.keyEnv, config.stt.elevenlabs.passEntry);
    } catch (error) {
      this.active = false;
      this.events.onState("error", "Ключ ElevenLabs не читается из pass");
      throw error;
    }
    const query = new URLSearchParams({
      model_id: config.stt.elevenlabs.model,
      language_code: config.language,
      audio_format: "pcm_16000",
      commit_strategy: "vad",
      vad_silence_threshold_secs: String(config.stt.elevenlabs.silenceSecs),
    });
    // Bun accepts headers on client WebSockets; the key never reaches the browser.
    const ws = new WebSocket(`${ENDPOINT}?${query}`, { headers: { "xi-api-key": key } } as any);
    this.ws = ws;

    ws.onopen = () => {
      for (const chunk of this.pending) this.send(chunk);
      this.pending = [];
    };
    ws.onmessage = (event) => {
      let message: any;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      switch (message.message_type) {
        case "session_started":
          this.retries = 0;
          this.events.onState("ready");
          break;
        case "partial_transcript":
          if (message.text) this.events.onPartial(String(message.text).replace(/^\.\.\./, "").trim());
          break;
        case "committed_transcript":
          if (message.text?.trim()) this.events.onFinal(message.text.trim());
          break;
        case "committed_transcript_with_timestamps":
          break;
        default:
          if (/error|exceeded|limit/.test(message.message_type ?? "")) {
            this.events.onState("error", `ElevenLabs: ${message.message_type}${message.error ? ` — ${message.error}` : ""}`);
          }
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.active) return;
      if (this.retries >= 5) {
        this.active = false;
        this.events.onState("error", "Соединение с ElevenLabs не восстанавливается");
        return;
      }
      const delay = Math.min(500 * 2 ** this.retries++, 8000);
      this.events.onState("connecting", "Переподключение к ElevenLabs");
      setTimeout(() => this.active && this.connect().catch(() => {}), delay);
    };
    ws.onerror = () => {};
  }

  private send(pcm: Uint8Array): void {
    this.ws!.send(JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"),
      commit: false,
      sample_rate: 16000,
    }));
  }

  push(pcm: Uint8Array): void {
    if (!this.active) return;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send(pcm);
    } else {
      this.pending.push(pcm.slice());
      if (this.pending.length > MAX_BUFFERED_CHUNKS) this.pending.shift();
    }
  }

  async stop(): Promise<void> {
    if (!this.active && !this.ws) return;
    this.active = false;
    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      // Close the phrase in progress so its text is not lost, then give the reply a moment.
      ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: 16000 }));
      await Bun.sleep(700);
    }
    this.ws = null;
    ws?.close();
    this.pending = [];
    this.events.onState("idle");
  }
}
