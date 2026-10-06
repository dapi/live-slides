import { homedir } from "node:os";
import { join, resolve } from "node:path";

const env = process.env;
const root = resolve(import.meta.dir, "..");

function expand(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export type SttEngineName = "elevenlabs" | "whisper";

export const config = {
  root,
  host: env.HOST ?? "127.0.0.1",
  port: Number(env.PORT ?? 4747),
  dataDir: expand(env.DATA_DIR ?? join(root, "data")),
  language: env.SPEECH_LANGUAGE ?? "ru",

  stt: {
    engine: (env.STT_ENGINE ?? "elevenlabs") as SttEngineName,
    elevenlabs: {
      keyEnv: "ELEVENLABS_API_KEY",
      passEntry: env.ELEVENLABS_PASS_ENTRY ?? "live-slides/elevenlabs-api-key",
      model: env.ELEVENLABS_STT_MODEL ?? "scribe_v2_realtime",
      // Pause that closes a phrase. Shorter means faster slides, more fragmented phrases.
      silenceSecs: Number(env.ELEVENLABS_SILENCE_SECS ?? 0.7),
    },
    whisper: {
      bin: env.WHISPER_SERVER_BIN ?? "whisper-server",
      model: expand(env.WHISPER_MODEL ?? "~/.cache/live-slides/models/ggml-large-v3-turbo.bin"),
      threads: Number(env.WHISPER_THREADS ?? 6),
      // Terms the recognizer should spell correctly.
      prompt: env.WHISPER_PROMPT ?? "Агентная разработка, ИИ-агенты, LLM, Claude Code, Codex, OpenViking, тимлид, пайплайн.",
    },
  },

  llm: {
    baseUrl: (env.LLM_BASE_URL ?? "http://127.0.0.1:4000/v1").replace(/\/$/, ""),
    model: env.LLM_MODEL ?? "claude-haiku-subscription",
    // The private gateway needs no client key inside the LAN; any non-empty value works.
    // Another endpoint takes its key from LLM_API_KEY or from the pass entry named here.
    apiKey: env.LLM_API_KEY ?? "local",
    keyPassEntry: env.LLM_KEY_PASS_ENTRY,
    // Extra request fields as JSON, e.g. {"reasoning":{"enabled":false}} to keep a model from thinking.
    extraBody: env.LLM_EXTRA_BODY ? (JSON.parse(env.LLM_EXTRA_BODY) as Record<string, unknown>) : {},
    // Some gateway models reject the parameter; LLM_TEMPERATURE=off leaves it out.
    temperature: env.LLM_TEMPERATURE === "off" ? undefined : Number(env.LLM_TEMPERATURE ?? 0.2),
    // Live slides cannot wait. If the model is silent this long, a second identical request
    // races the first; subscription routes occasionally stall for many seconds.
    hedgeMs: Number(env.LLM_HEDGE_MS ?? 4000),
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 12000),
  },

  sources: {
    enabled: (env.SOURCES ?? "on") !== "off",
    url: (env.OPENVIKING_URL ?? "http://127.0.0.1:1933").replace(/\/$/, ""),
    account: env.OPENVIKING_ACCOUNT ?? "default",
    user: env.OPENVIKING_USER ?? "presenter",
    keyEnv: "OPENVIKING_API_KEY",
    passEntry: env.OPENVIKING_PASS_ENTRY ?? "live-slides/openviking-api-key",
    rootUri: env.OPENVIKING_ROOT_URI ?? "viking://user/presenter/resources/materials",
    // Slides are shown to an audience, so the default is limited to editorial and research
    // material. Finance, legal, sales, personal and transcripts stay out unless listed here.
    scopes: list(env.SOURCE_SCOPES, ["materials", "research"]),
    // Raw chat digests hold other people's messages; they are not material for a public slide.
    exclude: new RegExp(env.SOURCE_EXCLUDE ?? "/digests/raw/"),
    minScore: Number(env.SOURCE_MIN_SCORE ?? 0.38),
    perRun: Number(env.SOURCES_PER_RUN ?? 3),
    // Searches run ahead of the slide step, so a slow one still helps the next step.
    timeoutMs: Number(env.SOURCE_TIMEOUT_MS ?? 5000),
  },
};

/** Environment first, then the named `pass` entry. The value is never logged. */
export async function secret(envName: string, passEntry: string): Promise<string> {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  const proc = Bun.spawn(["pass", "show", passEntry], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`pass entry is not readable: ${passEntry}`);
  const value = out.split("\n")[0].trim();
  if (!value) throw new Error(`pass entry is empty: ${passEntry}`);
  return value;
}
