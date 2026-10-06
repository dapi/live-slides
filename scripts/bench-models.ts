// Replays one hard step of the slide director against several models: latency and judgement.
// Usage: bun scripts/bench-models.ts [model ...]
// Another OpenAI-compatible endpoint: LLM_BASE_URL=... LLM_API_KEY=... bun scripts/bench-models.ts <ids>
//
// The step: the speaker announced "three approaches" and named two. One excerpt is his article on
// exactly this (it gives the third approach), the other is about a neighbouring topic and is a trap.
import { config } from "../src/config";
import { SYSTEM_PROMPT } from "../src/director";

const models = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["claude-haiku-subscription", "claude-sonnet-subscription", "claude-opus-subscription", "openrouter-auto"];
const RUNS = 3;

const user = `<previous_slides>
1. Почему одного файла недостаточно
</previous_slides>

<current_slide>
{"layout":"bullets","title":"Три подхода к организации знаний","bullets":[{"text":"Файловая оркестрация","said":false},{"text":"Проверка переходов","said":false}]}
</current_slide>

<covered_speech>
Давайте поговорим о том, почему одного файла с инструкциями агенту недостаточно. Когда проект живёт долго, в нём накапливаются решения, договорённости и исключения. В один файл это не помещается. Что с этим делать? Есть три подхода.
</covered_speech>

<new_speech>
Первый — хранить знания в структурированных файлах рядом с кодом. Второй — подключить векторный поиск по документации. …
</new_speech>

<excerpts>
[1] Оркестрация агентов: три уровня
Мы пробовали три уровня оркестрации. Файловая оркестрация: агент читает документ задачи и сам двигает её по этапам. Проверка переходов: отдельный скрипт не даёт перейти к следующему этапу без артефактов. Runtime-оркестратор: внешний процесс следит за событиями файловой системы и запускает агентов.

[2] База знаний для ИИ: файлы, векторный поиск и синхронизация
Знания проекта можно держать тремя способами. Файлы в репозитории рядом с кодом — дёшево и прозрачно, но требуют ручной поддержки. Векторный поиск находит нужное по смыслу, но требует индексации. Синхронизация с внешними системами — трекером, вики — снимает ручной перенос, но добавляет точку отказа.
</excerpts>`;

interface Point { text: string; said: boolean }

/** Five checks of judgement; each is worth one point. */
function score(decision: any): { total: number; failed: string[] } {
  const points: Point[] = (decision?.slide?.bullets ?? []).map((b: any) => (typeof b === "string" ? { text: b, said: true } : { text: String(b?.text ?? ""), said: b?.said !== false }));
  const said = points.filter((p) => p.said).map((p) => p.text.toLowerCase());
  const ahead = points.filter((p) => !p.said).map((p) => p.text.toLowerCase());
  const checks: [string, boolean][] = [
    ["оба названных подхода отмечены сказанными", said.some((t) => t.includes("файл")) && said.some((t) => t.includes("вектор"))],
    ["третий подход предсказан по статье", ahead.some((t) => t.includes("синхрон"))],
    ["ловушка из соседней темы убрана", !points.some((p) => /оркестр|переход/i.test(p.text))],
    ["несказанное не отмечено сказанным", !said.some((t) => t.includes("синхрон"))],
    ["источник указан верно", JSON.stringify(decision?.sources ?? []) === "[2]"],
  ];
  return { total: checks.filter(([, ok]) => ok).length, failed: checks.filter(([, ok]) => !ok).map(([name]) => name) };
}

async function once(model: string) {
  const started = performance.now();
  try {
    const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST",
      signal: AbortSignal.timeout(25000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({ model, max_tokens: 700, temperature: config.llm.temperature, ...config.llm.extraBody, messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: user }] }),
    });
    const ms = Math.round(performance.now() - started);
    if (!response.ok) return { ms, error: `HTTP ${response.status}: ${(await response.text()).slice(0, 120)}` };
    const text = String(((await response.json()) as any).choices?.[0]?.message?.content ?? "");
    try {
      return { ms, decision: JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) };
    } catch {
      return { ms, error: `не JSON: ${text.slice(0, 80)}` };
    }
  } catch (error) {
    return { ms: Math.round(performance.now() - started), error: (error as Error).name === "TimeoutError" ? "нет ответа за 25 с" : (error as Error).message };
  }
}

for (const model of models) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await once(model));
  const times = runs.map((run) => run.ms).sort((a, b) => a - b);
  const good = runs.filter((run) => "decision" in run) as { decision: any }[];
  const errors = runs.filter((run) => "error" in run) as { error: string }[];
  const scores = good.map((run) => score(run.decision));
  console.log(`\n${model}: медиана ${times[1]} мс (${times.join(" / ")}), суждение ${scores.map((s) => s.total).join(" / ") || "—"} из 5, ошибок ${errors.length}/${RUNS}`);
  if (good[0]) {
    const { action, slide } = good[0].decision;
    console.log(`  ${action} [${slide?.layout ?? "-"}] ${slide?.title ?? ""}`);
    for (const line of slide?.bullets ?? []) console.log(`    ${line?.said === false ? "◌" : "·"} ${line?.text ?? line}`);
    const failed = [...new Set(scores.flatMap((s) => s.failed))];
    if (failed.length) console.log(`  не прошло: ${failed.join("; ")}`);
  }
  if (errors[0]) console.log(`  ${errors[0].error}`);
}
process.exit(0);
