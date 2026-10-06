import { config } from "./config";
import type { SearchResult, SourceHit } from "./sources";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const decode = (html: string) =>
  html.replace(/<[^>]+>/g, "").replace(/&(#39|[a-z]+);/g, (whole, name) => ENTITIES[name] ?? whole).replace(/\s+/g, " ").trim();

/**
 * The public search of pismenny.ru: hybrid text and vector search over everything published
 * on the site. Without an owner session it returns public pages only, so every hit is safe
 * to show and comes with a public address.
 */
export class SiteSearch {
  private inFlight: Promise<SearchResult> | null = null;

  get enabled(): boolean {
    return config.site.enabled;
  }

  /** One request at a time; a call made meanwhile shares it. The site allows 60 a minute. */
  search(query: string): Promise<SearchResult> {
    return (this.inFlight ??= this.find(query).finally(() => (this.inFlight = null)));
  }

  private async find(query: string): Promise<SearchResult> {
    const started = performance.now();
    const done = (hits: SourceHit[], error?: string): SearchResult => ({ hits, error, ms: Math.round(performance.now() - started) });
    // The site accepts up to 200 characters: keep the latest words, whole.
    const q = query.trim().slice(-200).replace(/^\S*\s/, "");
    if (!this.enabled || q.length < 12) return done([]);
    try {
      const url = new URL(config.site.searchUrl);
      url.searchParams.set("q", q);
      url.searchParams.set("public", "1");
      const response = await fetch(url, { signal: AbortSignal.timeout(config.site.timeoutMs) });
      if (!response.ok) throw new Error(`Поиск сайта: HTTP ${response.status}`);
      const html = await response.text();
      const hits: SourceHit[] = [];
      for (const card of html.matchAll(/<li class="search-result">(.*?)<\/li>/gs)) {
        const href = card[1].match(/class="search-result-link" href="([^"]+)"/)?.[1];
        const title = card[1].match(/class="search-result-title">(.*?)<\/strong>/s)?.[1];
        if (!href || !title) continue;
        const kind = decode(card[1].match(/class="search-result-kind">(.*?)<\/span>/s)?.[1] ?? "");
        const summary = decode(card[1].match(/class="search-result-summary">(.*?)<\/span>/s)?.[1] ?? "");
        const address = new URL(decode(href), url).toString();
        hits.push({
          uri: address,
          score: 1 / (hits.length + 1), // the site ranks; it does not expose scores
          title: decode(title),
          ref: address,
          url: address,
          repository: url.hostname,
          excerpt: [kind && `${kind}, опубликовано на ${url.hostname}.`, summary].filter(Boolean).join(" "),
        });
        if (hits.length === config.site.perRun) break;
      }
      return done(hits);
    } catch (error) {
      const timedOut = (error as Error).name === "TimeoutError";
      return done([], timedOut ? `Поиск сайта не уложился в ${config.site.timeoutMs} мс` : (error as Error).message);
    }
  }
}
