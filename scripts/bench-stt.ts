// Measures how far streaming recognizers lag behind the voice, and how many words they get wrong.
// Usage: bun scripts/bench-stt.ts talk.wav reference.txt [engine ...]
// The WAV must be 16 kHz mono 16-bit. Word times come from local Whisper on the same file.
import { $ } from "bun";
import { config, secret } from "../src/config";

const [wavPath, referencePath, ...chosen] = process.argv.slice(2);
if (!wavPath || !referencePath) throw new Error("Usage: bun scripts/bench-stt.ts talk.wav reference.txt [engine ...]");

interface Mark { at: number; text: string; final: boolean }
type Run = (pcm: Uint8Array, mark: (m: Omit<Mark, "at">) => void, started: () => void) => Promise<void>;

const CHUNK_MS = 100;
const words = (text: string) => text.toLowerCase().replaceAll("ё", "е").match(/[\p{L}\p{N}]+/gu) ?? [];

async function stream(pcm: Uint8Array, bytesPerMs: number, send: (chunk: Uint8Array) => void): Promise<void> {
  const size = bytesPerMs * CHUNK_MS;
  const begun = performance.now();
  for (let offset = 0, i = 0; offset < pcm.length; offset += size, i++) {
    send(pcm.subarray(offset, offset + size));
    await Bun.sleep(Math.max(0, begun + (i + 1) * CHUNK_MS - performance.now())); // no drift
  }
  const silence = new Uint8Array(size);
  for (let i = 0; i < 25; i++) {
    send(silence);
    await Bun.sleep(CHUNK_MS);
  }
}

const elevenlabs: Run = async (pcm, mark, started) => {
  const key = await secret(config.stt.elevenlabs.keyEnv, config.stt.elevenlabs.passEntry);
  const query = new URLSearchParams({ model_id: "scribe_v2_realtime", language_code: "ru", audio_format: "pcm_16000", commit_strategy: "vad", vad_silence_threshold_secs: "0.7" });
  const ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${query}`, { headers: { "xi-api-key": key } } as any);
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.message_type === "partial_transcript") mark({ text: message.text, final: false });
    if (message.message_type === "committed_transcript") mark({ text: message.text, final: true });
  };
  await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
  started();
  await stream(pcm, 32, (chunk) => ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: Buffer.from(chunk).toString("base64"), commit: false, sample_rate: 16000 })));
  await Bun.sleep(1500);
  ws.close();
};

function openai(model: string, delay?: string): Run {
  return async (pcm16k, mark, started) => {
    const key = await secret("OPENAI_API_KEY", "openai-key");
    // The Realtime API takes 24 kHz PCM.
    void pcm16k;
    const pcm = new Uint8Array(await $`ffmpeg -loglevel error -i ${wavPath} -f s16le -ar 24000 -ac 1 pipe:1`.quiet().arrayBuffer());
    const ws = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", { headers: { Authorization: `Bearer ${key}` } } as any);
    const open: Record<string, string> = {};
    let failed: string | null = null;
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "conversation.item.input_audio_transcription.delta") {
        open[message.item_id] = (open[message.item_id] ?? "") + message.delta;
        mark({ text: open[message.item_id], final: false });
      } else if (message.type === "conversation.item.input_audio_transcription.completed") {
        delete open[message.item_id];
        mark({ text: message.transcript, final: true });
      } else if (message.type === "error") {
        failed = message.error?.message ?? JSON.stringify(message);
      }
    };
    await new Promise((resolve, reject) => ((ws.onopen = resolve), (ws.onerror = reject)));
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "transcription",
        audio: { input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model, ...(delay ? { delay, languages: ["ru"] } : { language: "ru" }) },
          turn_detection: null, // these models stream one continuous text; phrases are closed by commit
        } },
      },
    }));
    await Bun.sleep(600);
    if (failed) throw new Error(failed);
    started();
    await stream(pcm, 48, (chunk) => ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.from(chunk).toString("base64") })));
    ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    await Bun.sleep(3000);
    ws.close();
    if (failed) throw new Error(failed);
  };
}

const engines: Record<string, Run> = {
  "elevenlabs-scribe-v2-realtime": elevenlabs,
  "openai-gpt-live-transcribe-minimal": openai("gpt-live-transcribe", "minimal"),
  "openai-gpt-live-transcribe-low": openai("gpt-live-transcribe", "low"),
  "openai-gpt-realtime-whisper": openai("gpt-realtime-whisper"),
};

function editDistance(a: string[], b: string[]): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
const seconds = (ms: number) => (ms / 1000).toFixed(2).replace(".", ",");

// Reference: when each word ends in the audio.
const timed = await $`whisper-cli -m ${config.stt.whisper.model} -l ru -ml 1 -sow -f ${wavPath}`.quiet().text();
const wordEnds = [...timed.matchAll(/-->\s*(\d+):(\d+):(\d+)\.(\d+)\]\s+(\S.*)$/gm)]
  .filter((m) => words(m[5]).length > 0)
  .map((m) => ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4]);
const reference = words((await Bun.file(referencePath).text()).replace(/\[\[.*?\]\]/g, " "));
const pcm = new Uint8Array(await Bun.file(wavPath).arrayBuffer()).subarray(44);
console.log(`Запись ${(pcm.length / 32000).toFixed(1)} с, слов в эталоне ${reference.length}, размечено по времени ${wordEnds.length}`);

for (const name of chosen.length ? chosen : Object.keys(engines)) {
  const marks: Mark[] = [];
  let t0 = 0;
  try {
    await Promise.race([
      engines[name](pcm, (m) => t0 && marks.push({ ...m, at: performance.now() - t0 }), () => (t0 = performance.now())),
      Bun.sleep(pcm.length / 32 + 30000).then(() => { throw new Error("сервис не завершил прогон вовремя"); }),
    ]);
  } catch (error) {
    console.log(`\n${name}: ошибка — ${(error as Error).message}`);
    continue;
  }
  // A word's lag: when it first showed up on screen minus when it was finished being spoken.
  const lags: number[] = [];
  const finalLags: number[] = [];
  let done = 0; // words in closed phrases
  let seen = 0;
  for (const m of marks) {
    const total = done + words(m.text).length;
    for (let n = seen; n < Math.min(total, wordEnds.length); n++) lags.push(m.at - wordEnds[n]);
    seen = Math.max(seen, total);
    if (m.final) {
      done += words(m.text).length;
      if (done <= wordEnds.length && done > 0) finalLags.push(m.at - wordEnds[done - 1]);
    }
  }
  const heard = words(marks.filter((m) => m.final).map((m) => m.text).join(" "));
  lags.sort((a, b) => a - b);
  const first = marks[0];
  console.log(`\n${name}`);
  console.log(`  отставание слова от голоса: медиана ${seconds(percentile(lags, 0.5))} с, 90% слов быстрее ${seconds(percentile(lags, 0.9))} с`);
  console.log(`  первое слово на экране через ${first ? seconds(first.at - wordEnds[0]) : "—"} с после произнесения; обновлений ${marks.length}`);
  console.log(`  фраза закрывается через ${finalLags.length ? seconds(finalLags.reduce((a, b) => a + b, 0) / finalLags.length) : "—"} с после последнего слова`);
  console.log(`  ошибок в словах: ${editDistance(reference, heard)} из ${reference.length} (${((editDistance(reference, heard) / reference.length) * 100).toFixed(1)}%)`);
}
process.exit(0);
