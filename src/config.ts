import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

function expand(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export type SttEngineName = "elevenlabs" | "whisper";

export function createConfig(env: NodeJS.ProcessEnv = process.env) {
  const origin = env.APP_ORIGIN ?? `http://127.0.0.1:${env.PORT ?? 4747}`;
  return {
    root,
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 4747),
    dataDir: expand(env.DATA_DIR ?? join(root, "data")),
    // Prompt texts for the director and the recognizer; another directory replaces them all.
    promptsDir: expand(env.PROMPTS_DIR ?? join(root, "prompts")),
    language: env.SPEECH_LANGUAGE ?? "ru",
    auth: {
      origin,
      // Verify the actual Corp cookie, never a user header supplied by the browser.
      corpVerifyUrl: env.CORP_VERIFY_URL,
      corpLoginUrl: env.CORP_LOGIN_URL ?? "",
      corpOwnerUser: env.CORP_OWNER_USER ?? "",
      ownerSubject: env.PERSONAL_SOURCE_SUBJECT ?? "",
      ownerName: env.PERSONAL_SOURCE_NAME ?? "Владелец",
    },
    public: {
      siteUrl: (env.PUBLIC_SITE_URL ?? origin).replace(/\/$/, ""),
      authorName: env.PUBLIC_AUTHOR_NAME ?? "",
      authorUrl: env.PUBLIC_AUTHOR_URL ?? "",
      // The author's mark on the demo slide, light and dark versions; empty hides it.
      authorLogoUrl: env.PUBLIC_AUTHOR_LOGO_URL ?? "",
      authorLogoDarkUrl: env.PUBLIC_AUTHOR_LOGO_DARK_URL ?? env.PUBLIC_AUTHOR_LOGO_URL ?? "",
      introVideoUrl: env.PUBLIC_INTRO_VIDEO_URL ?? "",
      introPosterUrl: env.PUBLIC_INTRO_POSTER_URL ?? "",
    },
    // Early-access requests go to the Sales CRM (Twenty) under the shared intake contract;
    // without an address or a key they stay in the database only.
    crm: {
      url: (env.TWENTY_API_URL ?? "").replace(/\/$/, ""),
      keyEnv: "TWENTY_API_KEY",
      keyPassEntry: env.TWENTY_API_KEY_PASS_ENTRY,
      sourceSystem: env.CRM_SOURCE_SYSTEM ?? "live-slides",
      productTier: env.CRM_PRODUCT_TIER ?? "LIVE-SLIDES-EARLY-ACCESS",
    },
    knowledge: {
      databasePassEntry: env.DATABASE_PASS_ENTRY,
      embeddingUrl: (env.EMBEDDING_BASE_URL ?? env.LLM_BASE_URL ?? "http://127.0.0.1:4000/v1").replace(/\/$/, ""),
      embeddingModel: env.EMBEDDING_MODEL ?? "",
      embeddingKeyPassEntry: env.EMBEDDING_KEY_PASS_ENTRY,
      dimensions: 1024,
      tikaUrl: env.TIKA_URL,
      maxUploadBytes: 20 * 1024 * 1024,
      maxUserBytes: 200 * 1024 * 1024,
      maxTextChars: 1_000_000,
    },

    stt: {
      engine: (env.STT_ENGINE ?? "elevenlabs") as SttEngineName,
      elevenlabs: {
        keyEnv: "ELEVENLABS_API_KEY",
        passEntry: env.ELEVENLABS_PASS_ENTRY,
        endpoint: env.ELEVENLABS_STT_URL ?? "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
        model: env.ELEVENLABS_STT_MODEL ?? "scribe_v2_realtime",
        // Where ElevenLabs is not reachable directly, the connection can leave in two ways.
        // 1. Resolve its address through this DNS-over-HTTPS URL. A Control D endpoint whose
        //    profile redirects the domain answers with a Control D proxy. Tried first.
        dohUrl: env.ELEVENLABS_DOH_URL,
        // 2. Go through a proxy: socks5://host:port or http://host:port. Used when 1 is unset.
        proxy: env.ELEVENLABS_PROXY,
        // Pause that closes a phrase. Shorter means faster slides, more fragmented phrases.
        silenceSecs: Number(env.ELEVENLABS_SILENCE_SECS ?? 0.7),
      },
      whisper: {
        bin: env.WHISPER_SERVER_BIN ?? "whisper-server",
        model: expand(env.WHISPER_MODEL ?? "~/.cache/live-slides/models/ggml-large-v3-turbo.bin"),
        threads: Number(env.WHISPER_THREADS ?? 6),
      },
    },

    llm: {
      baseUrl: (env.LLM_BASE_URL ?? "http://127.0.0.1:4000/v1").replace(/\/$/, ""),
      model: env.LLM_MODEL ?? "",
      apiKey: env.LLM_API_KEY ?? "",
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

    // Public search of the site: published pages only, each with a public address.
    site: {
      enabled: (env.SITE_SEARCH ?? (env.SITE_SEARCH_URL ? "on" : "off")) !== "off",
      searchUrl: env.SITE_SEARCH_URL ?? "",
      perRun: Number(env.SITE_SEARCH_PER_RUN ?? 2),
      timeoutMs: Number(env.SITE_SEARCH_TIMEOUT_MS ?? 2500),
    },

    sources: {
      enabled: (env.SOURCES ?? (env.OPENVIKING_URL ? "on" : "off")) !== "off",
      url: (env.OPENVIKING_URL ?? "").replace(/\/$/, ""),
      account: env.OPENVIKING_ACCOUNT ?? "default",
      user: env.OPENVIKING_USER ?? "",
      keyEnv: "OPENVIKING_API_KEY",
      passEntry: env.OPENVIKING_PASS_ENTRY,
      rootUri: env.OPENVIKING_ROOT_URI ?? "",
      metadataMarker: env.SOURCE_METADATA_MARKER ?? "source-metadata",
      // Slides are shown to an audience. No repository is searched until explicitly listed.
      scopes: list(env.SOURCE_SCOPES, []),
      // Raw chat digests hold other people's messages; they are not material for a public slide.
      exclude: new RegExp(env.SOURCE_EXCLUDE ?? "/digests/raw/"),
      minScore: Number(env.SOURCE_MIN_SCORE ?? 0.38),
      perRun: Number(env.SOURCES_PER_RUN ?? 3),
      // Searches run ahead of the slide step, so a slow one still helps the next step.
      timeoutMs: Number(env.SOURCE_TIMEOUT_MS ?? 5000),
    },
  };
}
export const config = createConfig();

/** Environment first, then the named `pass` entry. The value is never logged. */
export async function secret(envName: string, passEntry?: string): Promise<string> {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  if (!passEntry) throw new Error(`Configure ${envName} or its pass entry`);
  const proc = Bun.spawn(["pass", "show", passEntry], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`pass entry is not readable: ${passEntry}`);
  const value = out.split("\n")[0].trim();
  if (!value) throw new Error(`pass entry is empty: ${passEntry}`);
  return value;
}
