// Replays recorded talks through the slide director against the real model and checks the deck
// against what the author expects: the regression run for the director's prompt and the model.
//
//   bun run regress                       # every fixture in fixtures/talks, real time
//   REGRESS_SPEED=3 bun run regress intro # faster replay, fixtures whose name contains "intro"
//   REGRESS=1 bun test tests/regress.test.ts
//
// A fixture holds phrases with the seconds they started and closed, optional excerpts from the
// speaker's own material, and the expected slides in order: a few acceptable titles each (one is
// enough to match), optionally a layout, a minimum of points and words the slide must mention.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../src/config";
import { Director, type Slide, type Source, type StepMetric } from "../src/director";
import type { SearchResult, SourceHit } from "../src/sources";

export interface Fixture {
  name: string;
  source?: string;
  phrases: { start: number; end: number; text: string }[];
  excerpts?: { title: string; text: string }[];
  expect: { slides: ExpectedSlide[]; maxSlides?: number };
}
export interface ExpectedSlide { title: string[]; layout?: string[]; minPoints?: number; mentions?: string[] }

export interface Outcome {
  name: string;
  ok: boolean;
  problems: string[];
  slides: Slide[];
  metrics: StepMetric[];
  seconds: number;
}

const FIXTURES = join(config.root, "fixtures", "talks");
/** A title must not stop on one of these: the model cut a thought short. */
const DANGLING = new Set("с в на о об про и к для от по за из у при без до над под через как что или а но".split(" "));

/** The speaker's material as a source: excerpts ranked by shared words with the query. */
class FixtureSource implements Source {
  readonly enabled = true;
  constructor(private excerpts: { title: string; text: string }[]) {}
  async search(query: string): Promise<SearchResult> {
    const wanted = stems(query);
    const hits: SourceHit[] = this.excerpts
      .map((excerpt, i) => ({ excerpt, i, score: [...stems(excerpt.text)].filter((stem) => wanted.has(stem)).length }))
      .filter((item) => item.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(({ excerpt, i, score }) => ({ uri: `fixture://${i}`, ref: `fixture://${i}`, repository: "fixture", title: excerpt.title, excerpt: excerpt.text, score }));
    return { hits, ms: 0 };
  }
}

/** Word stems for a loose comparison: lower case, five letters, words of four letters or more. */
function stems(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/ё/g, "е").match(/[a-zа-я0-9]{4,}/g)?.map((word) => word.slice(0, 5)) ?? []);
}

/** Does a produced title say the same thing as one of the acceptable ones? Nearly all stems must coincide. */
export function titleMatches(produced: string, acceptable: string[]): boolean {
  const have = stems(produced);
  return acceptable.some((wanted) => {
    const need = [...stems(wanted)];
    const shared = need.filter((stem) => have.has(stem)).length;
    return need.length > 0 && shared / need.length >= (need.length <= 2 ? 1 : 0.75);
  });
}

function points(slide: Slide): string[] {
  return [...(slide.bullets ?? []), ...(slide.left?.items ?? []), ...(slide.right?.items ?? [])];
}

/** Checks a deck against the expectation; every expected slide must appear, in order. */
export function judge(fixture: Fixture, slides: Slide[]): string[] {
  const problems: string[] = [];
  let from = 0;
  for (const expected of fixture.expect.slides) {
    const index = slides.findIndex((slide, i) => i >= from && titleMatches(slide.title, expected.title));
    if (index < 0) { problems.push(`нет слайда «${expected.title[0]}»`); continue; }
    const slide = slides[index];
    from = index + 1;
    if (expected.layout && !expected.layout.includes(slide.layout)) problems.push(`«${slide.title}»: макет ${slide.layout}, ожидался ${expected.layout.join("/")}`);
    if (expected.minPoints && points(slide).length < expected.minPoints) problems.push(`«${slide.title}»: ${points(slide).length} пунктов, нужно не меньше ${expected.minPoints}`);
    for (const word of expected.mentions ?? []) {
      const text = [slide.title, slide.subtitle, slide.quote, slide.value, slide.caption, ...points(slide)].join(" ").toLowerCase();
      if (!text.includes(word.toLowerCase())) problems.push(`«${slide.title}»: не упомянуто «${word}»`);
    }
  }
  if (fixture.expect.maxSlides && slides.length > fixture.expect.maxSlides) problems.push(`${slides.length} слайдов, больше ${fixture.expect.maxSlides}`);
  for (const slide of slides) {
    const last = slide.title.trim().split(/\s+/).at(-1)?.toLowerCase().replace(/ё/g, "е") ?? "";
    if (DANGLING.has(last)) problems.push(`заголовок оборван: «${slide.title}»`);
    if (!slide.title.trim()) problems.push(`слайд ${slide.id} без заголовка`);
    if (slide.predicted.length) problems.push(`«${slide.title}»: прогноз не снят после конца речи`);
  }
  return problems;
}

/**
 * Plays the talk into a director the way the recognizer would: growing partial text while a
 * phrase is spoken, the closed phrase at its end. Waits for the deck to settle at the end.
 */
export async function replay(fixture: Fixture, speed = Number(process.env.REGRESS_SPEED ?? 1)): Promise<Outcome> {
  const slides: Slide[] = [];
  const metrics: StepMetric[] = [];
  let busy = false;
  let lastEvent = performance.now();
  const touch = () => { lastEvent = performance.now(); };
  const director = new Director(fixture.excerpts?.length ? [new FixtureSource(fixture.excerpts)] : [], {
    onSlide: touch, onPaths: () => {}, onNext: () => {}, onSources: () => {},
    onStage: (stage, detail) => { busy = stage === "sources" || stage === "llm"; touch(); if (stage === "error") console.error("  ошибка:", detail); },
    onMetric: (metric) => { metrics.push(metric); touch(); },
  });
  const started = performance.now();
  const pause = (seconds: number) => Bun.sleep(Math.max(0, seconds * 1000) / speed);
  let clock = 0;
  for (const phrase of fixture.phrases) {
    await pause(phrase.start - clock);
    const words = phrase.text.split(/\s+/);
    const step = (phrase.end - phrase.start) / words.length;
    for (let i = 1; i < words.length; i++) {
      director.partialText(words.slice(0, i).join(" "));
      await pause(step);
    }
    await pause(step);
    director.finalText(phrase.text);
    clock = phrase.end;
  }
  director.flush();
  // Settled: no step running and nothing happened for a while (a scheduled step fires within 200 ms).
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    await Bun.sleep(100);
    if (!busy && performance.now() - lastEvent > 1500) break;
  }
  slides.push(...director.slides);
  const problems = judge(fixture, slides);
  return { name: fixture.name, ok: problems.length === 0, problems, slides, metrics, seconds: Math.round((performance.now() - started) / 100) / 10 };
}

export async function loadFixtures(filter = ""): Promise<Fixture[]> {
  const names = (await readdir(FIXTURES)).filter((name) => name.endsWith(".json") && name.includes(filter)).sort();
  return Promise.all(names.map((name) => Bun.file(join(FIXTURES, name)).json() as Promise<Fixture>));
}

export function report(outcome: Outcome): string {
  const llm = outcome.metrics.filter((m) => m.action !== "error").map((m) => m.llmMs);
  const median = llm.length ? llm.sort((a, b) => a - b)[Math.floor(llm.length / 2)] : 0;
  const lines = [
    `${outcome.ok ? "✓" : "✗"} ${outcome.name} — ${outcome.slides.length} слайдов, ${outcome.metrics.length} шагов, модель ${median} мс медиана, ${outcome.seconds} с`,
    ...outcome.slides.map((slide) => `    [${slide.layout}] ${slide.title}${points(slide).length ? " — " + points(slide).join(" · ") : ""}`),
    ...outcome.problems.map((problem) => `    ! ${problem}`),
  ];
  return lines.join("\n");
}

if (import.meta.main) {
  if (!config.llm.model) throw new Error("Настройте LLM_MODEL");
  const fixtures = await loadFixtures(process.argv[2] ?? "");
  if (!fixtures.length) throw new Error("Нет эталонов в fixtures/talks");
  console.log(`Модель ${config.llm.model}, промпт ${config.promptsDir}, эталонов: ${fixtures.length}`);
  let failed = 0;
  for (const fixture of fixtures) {
    const outcome = await replay(fixture);
    console.log(report(outcome));
    if (!outcome.ok) failed++;
  }
  console.log(failed ? `Не прошло: ${failed} из ${fixtures.length}` : "Все эталоны прошли");
  process.exit(failed ? 1 : 0);
}
