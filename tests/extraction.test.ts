import { expect, test } from 'bun:test';
import { extractDocument } from '../src/documents';

const fixtures = Bun.env.DOCUMENT_TEST_FIXTURES;
const suite = fixtures ? test : test.skip;
suite('real PDF text layer and Russian OCR', async () => {
  const text = await extractDocument('text.pdf', new Uint8Array(await Bun.file(fixtures + '/text.pdf').arrayBuffer()));
  expect(text).toContain('Alpha project knowledge');
  const scan = await extractDocument('scan.pdf', new Uint8Array(await Bun.file(fixtures + '/scan.pdf').arrayBuffer()));
  expect(scan.toLowerCase()).toContain('проект');
  expect(scan.toLowerCase()).toContain('знаний');
}, 120000);
suite('real Word DOCX via Tika', async () => {
  const text = await extractDocument('office.docx', new Uint8Array(await Bun.file(fixtures + '/office.docx').arrayBuffer()));
  expect(text).toContain('Project document from Word');
}, 60000);
suite('real legacy Word DOC via antiword', async () => {
  const text = await extractDocument('legacy.doc', new Uint8Array(await Bun.file(fixtures + '/legacy.doc').arrayBuffer()));
  expect(text.length).toBeGreaterThan(40);
}, 60000);
