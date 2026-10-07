import { expect, test } from 'bun:test';
import { directorPrompt, prompts, speechTerms } from '../src/prompts';

test('shipped prompts load from the prompts directory', () => {
  expect(prompts.director).toContain('режиссёр живых слайдов');
  expect(prompts.paths).toContain('"paths"');
  expect(prompts.speechTerms).not.toContain('Claude'); // neutral, not the author's own vocabulary
});

test('a presentation overrides its prompts and an empty field means the shipped one', () => {
  expect(directorPrompt()).toBe(prompts.director);
  expect(directorPrompt({ director_prompt: '  ', talk_brief: '' })).toBe(prompts.director);
  expect(directorPrompt({ talk_brief: 'Доклад для врачей' })).toBe(`${prompts.director}\n\nО выступлении, от докладчика:\nДоклад для врачей`);
  expect(directorPrompt({ director_prompt: 'Своя инструкция', talk_brief: 'Коротко' })).toBe('Своя инструкция\n\nО выступлении, от докладчика:\nКоротко');
  expect(speechTerms({ speech_terms: '' })).toBe(prompts.speechTerms);
  expect(speechTerms({ speech_terms: 'Rocketwash, Диадок' })).toBe('Rocketwash, Диадок');
});

test('the session sends the talk prompt of its project to the model', async () => {
  const { Session } = await import('../src/session');
  const { config } = await import('../src/config');
  const { join } = await import('node:path');
  const { rm } = await import('node:fs/promises');
  const systems: string[] = [];
  const mock = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    systems.push((await request.json()).messages[0].content);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ action: 'new', slide: { layout: 'statement', title: 'Тема' }, next: '', sources: [] }) } }] });
  } });
  const previous = { baseUrl: config.llm.baseUrl, model: config.llm.model };
  config.llm.baseUrl = `http://127.0.0.1:${mock.port}`; config.llm.model = 'synthetic-model';
  const root = join(config.dataDir, 'test-prompts-' + crypto.randomUUID());
  try {
    const slide = Promise.withResolvers<void>();
    const session = new Session(message => { if (message.type === 'slide') slide.resolve(); }, undefined,
      { sources: [], places: [], root, talk: { director_prompt: '', talk_brief: 'Доклад для врачей', speech_terms: '' } });
    session['director'].finalText('Сегодня поговорим о профилактике.');
    await Promise.race([slide.promise, Bun.sleep(4000).then(() => { throw new Error('Slide was not generated'); })]);
    expect(systems[0]).toBe(`${prompts.director}\n\nО выступлении, от докладчика:\nДоклад для врачей`);
    await Bun.sleep(100); // the session is still writing its metrics file
  } finally { Object.assign(config.llm, previous); mock.stop(true); await rm(root, { recursive: true, force: true }); }
});
