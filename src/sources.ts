import { config, secret } from "./config";

export interface SourceHit {
  uri: string;
  score: number;
  /** Human-readable document name: the article's own title when it has one. */
  title: string;
  /** Canonical origin, e.g. repo://owner/materials/path.md. */
  ref: string;
  repository: string;
  excerpt: string;
}

export interface SearchResult {
  hits: SourceHit[];
  ms: number;
  /** Set when retrieval failed or timed out; slides are then built from speech alone. */
  error?: string;
}

const EXCERPT_CHARS = 1400;
const STALE_SEARCH_MS = 1500;
const SOURCE_COMMENT = /<!--\s*source-metadata\s+(\{.*?\})\s*-->/s;
const COPY_NOTICE = /^Поисковая копия документа\..*$/m;

/** Retrieval from the shared OpenViking index of Danil's repositories. */
export class Sources {
  private key: Promise<string> | null = null;
  private fragments = new Map<string, Promise<string>>();
  private running: { started: number; done: boolean; result: Promise<SearchResult> }[] = [];

  get enabled(): boolean {
    return config.sources.enabled && config.sources.scopes.length > 0;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
    this.key ??= secret(config.sources.keyEnv, config.sources.passEntry);
    this.key.catch(() => (this.key = null));
    const response = await fetch(config.sources.url + path, {
      method,
      signal,
      headers: {
        "X-API-Key": await this.key,
        "X-OpenViking-Account": config.sources.account,
        "X-OpenViking-User": config.sources.user,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`OpenViking HTTP ${response.status}`);
    return (await response.json()).result;
  }

  private read(uri: string, signal: AbortSignal): Promise<string> {
    let cached = this.fragments.get(uri);
    if (!cached) {
      cached = this.request("GET", `/api/v1/content/read?uri=${encodeURIComponent(uri)}`, undefined, signal).then(String);
      this.fragments.set(uri, cached);
      cached.catch(() => this.fragments.delete(uri));
    }
    return cached;
  }

  /**
   * The index answers in under a second most of the time, but single queries stall for many
   * seconds. So a call shares a search that has just started (it covers about the same stretch
   * of speech), and starts a second one beside a search that is already late. Never more than two.
   */
  search(query: string): Promise<SearchResult> {
    const now = performance.now();
    this.running = this.running.filter((search) => !search.done);
    const newest = this.running.at(-1);
    if (newest && (now - newest.started < STALE_SEARCH_MS || this.running.length >= 2)) return newest.result;
    const search = { started: now, done: false, result: this.find(query) };
    void search.result.finally(() => (search.done = true));
    this.running.push(search);
    return search.result;
  }

  private async find(query: string): Promise<SearchResult> {
    const started = performance.now();
    const done = (hits: SourceHit[], error?: string): SearchResult => ({ hits, error, ms: Math.round(performance.now() - started) });
    if (!this.enabled || query.trim().length < 12) return done([]);

    const signal = AbortSignal.timeout(config.sources.timeoutMs);
    try {
      // A single query over the shared root, narrowed here to the allowed repositories.
      // Fragments of other repositories are never read and never reach the model.
      const scopes = config.sources.scopes.map((scope) => `${config.sources.rootUri}/${scope}/`);
      const result = await this.request("POST", "/api/v1/search/find", {
        query,
        target_uri: scopes.length === 1 ? scopes[0].slice(0, -1) : config.sources.rootUri,
        context_type: ["resource"],
        level: [2],
        limit: scopes.length === 1 ? 8 : 40,
        score_threshold: 0,
      }, signal);
      const found = ((result?.resources ?? []) as { uri: string; score: number }[]).filter((item) => scopes.some((scope) => item.uri.startsWith(scope)));
      // Best fragment per document, strongest documents first.
      const best = new Map<string, { uri: string; score: number }>();
      for (const item of found) {
        if (item.score < config.sources.minScore) continue;
        const doc = item.uri.replace(/\/part-\d+\.md$/, "");
        if (!best.has(doc) || best.get(doc)!.score < item.score) best.set(doc, item);
      }
      // Read a few spare candidates: some are dropped by the exclusion rule.
      const top = [...best.values()].sort((a, b) => b.score - a.score).slice(0, config.sources.perRun * 2);
      const hits = await Promise.all(top.map(async ({ uri, score }) => this.toHit(uri, score, await this.read(uri, signal), query, signal)));
      return done(hits.filter((hit) => !config.sources.exclude.test(hit.ref)).slice(0, config.sources.perRun));
    } catch (error) {
      const timedOut = (error as Error).name === "TimeoutError";
      return done([], timedOut ? `Поиск не уложился в ${config.sources.timeoutMs} мс` : (error as Error).message);
    }
  }

  private async toHit(uri: string, score: number, raw: string, query: string, signal: AbortSignal): Promise<SourceHit> {
    let meta: { source?: string; repository?: string } = {};
    try {
      meta = JSON.parse(raw.match(SOURCE_COMMENT)?.[1] ?? "{}");
    } catch {}
    const ref = meta.source ?? uri;
    return {
      uri,
      score,
      ref,
      repository: meta.repository ?? "",
      title: await this.title(uri, ref, signal),
      excerpt: bestWindow(body(raw), query),
    };
  }

  /** Every fragment starts with the file name; the document's own title is in its first fragment. */
  private async title(uri: string, ref: string, signal: AbortSignal): Promise<string> {
    const fileName = (ref.split("/").pop() ?? ref).replace(/\.(md|txt)$/, "");
    try {
      const first = body(await this.read(uri.replace(/part-\d+\.md$/, "part-0001.md"), signal));
      const own = first.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? first.match(/^#\s+(.+)$/m)?.[1];
      return own?.trim().slice(0, 120) || fileName;
    } catch {
      return fileName;
    }
  }
}

/** Fragment text without the search-copy wrapper: file-name heading, notice and origin comment. */
function body(raw: string): string {
  return raw.replace(SOURCE_COMMENT, "").replace(/^#\s+.+\n/, "").replace(COPY_NOTICE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** The part of a fragment that shares the most word stems with the query. */
function bestWindow(text: string, query: string): string {
  if (text.length <= EXCERPT_CHARS) return text;
  const stems = [...new Set(query.toLowerCase().match(/[а-яёa-z0-9]{4,}/g) ?? [])].map((word) => word.slice(0, 5));
  const lower = text.toLowerCase();
  let best = 0;
  let bestScore = -1;
  for (let start = 0; start < text.length - EXCERPT_CHARS / 2; start += 350) {
    const window = lower.slice(start, start + EXCERPT_CHARS);
    const score = stems.reduce((sum, stem) => sum + (window.includes(stem) ? 1 : 0), 0);
    if (score > bestScore) {
      best = start;
      bestScore = score;
    }
  }
  const cut = best === 0 ? 0 : text.indexOf(" ", best) + 1;
  return (cut > 0 ? "…" : "") + text.slice(cut, cut + EXCERPT_CHARS).trim();
}
