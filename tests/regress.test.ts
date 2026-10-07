import { describe, expect, test } from 'bun:test';
import { judge, loadFixtures, replay, report, titleMatches } from '../scripts/regress';
import type { Slide } from '../src/director';

const slide = (title: string, extra: Partial<Slide> = {}): Slide => ({ id: 1, layout: 'bullets', title, bullets: [], predicted: [], sources: [], ...extra } as Slide);

test('titles compare by meaning, not by letter', () => {
  expect(titleMatches('Как проходит обычный доклад', ['Как обычно проходит доклад'])).toBe(true);
  expect(titleMatches('Память агентов', ['Память агента: векторный поиск'])).toBe(false);
  expect(titleMatches('Память агентов: векторная база', ['Память агента: векторный поиск'])).toBe(true);
  expect(titleMatches('Цена ошибки', ['Кому нужны слайды'])).toBe(false);
  expect(titleMatches('Слайды нужны зрителям, не докладчику', ['Слайды под речь докладчика'])).toBe(false);
});

test('the judge sees missing slides, wrong order, cut titles and leftover forecasts', () => {
  const fixture = { name: 't', phrases: [], expect: { slides: [{ title: ['Проблема'] }, { title: ['Решение'], minPoints: 2 }], maxSlides: 3 } };
  expect(judge(fixture, [slide('Проблема'), slide('Решение', { bullets: ['а', 'б'] })])).toEqual([]);
  expect(judge(fixture, [slide('Решение', { bullets: ['а', 'б'] }), slide('Проблема')])).toEqual(['нет слайда «Решение»']);
  expect(judge(fixture, [slide('Проблема'), slide('Решение', { bullets: ['а'] })])).toEqual(['«Решение»: 1 пунктов, нужно не меньше 2']);
  expect(judge(fixture, [slide('Проблема работы с'), slide('Решение', { bullets: ['а', 'б'], predicted: ['б'] })]))
    .toEqual(['заголовок оборван: «Проблема работы с»', '«Решение»: прогноз не снят после конца речи']);
});

// The real run needs the model: REGRESS=1 bun test tests/regress.test.ts
const suite = process.env.REGRESS ? describe : describe.skip;
suite('recorded talks against the model', () => {
  test('every fixture produces the expected deck', async () => {
    const outcomes = [];
    for (const fixture of await loadFixtures()) {
      const outcome = await replay(fixture);
      console.log(report(outcome));
      outcomes.push(outcome);
    }
    expect(outcomes.filter((o) => !o.ok).map((o) => `${o.name}: ${o.problems.join('; ')}`)).toEqual([]);
  }, 600_000);
});
