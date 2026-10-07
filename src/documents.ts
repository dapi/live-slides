import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config';

export class InputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const TYPES: Record<string, string> = { txt: 'text/plain', pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
export function validateDocument(name: string, data: Uint8Array): { name: string; type: string; extension: string } {
  const clean = name.replace(/\\/g, '/').split('/').pop()!.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180);
  const extension = clean.split('.').pop()!.toLowerCase();
  if (!TYPES[extension]) throw new InputError('Поддерживаются TXT, PDF, DOC и DOCX');
  if (!data.length || data.length > config.knowledge.maxUploadBytes) throw new InputError('Файл должен быть непустым и не больше 20 МБ', 413);
  const signature = Buffer.from(data.slice(0, 8)).toString('hex');
  if (extension === 'pdf' && !Buffer.from(data.slice(0, 5)).equals(Buffer.from('%PDF-'))) throw new InputError('Файл не является PDF');
  if (extension === 'doc' && signature !== 'd0cf11e0a1b11ae1') throw new InputError('Файл не является DOC');
  if (extension === 'docx' && !signature.startsWith('504b0304')) throw new InputError('Файл не является DOCX');
  return { name: clean, type: TYPES[extension], extension };
}

async function run(args: string[], signal: AbortSignal): Promise<string> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore' });
  const abort = () => proc.kill();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) proc.kill();
  try {
    const text = await limitedText(new Response(proc.stdout), config.knowledge.maxTextChars * 4);
    if (await proc.exited !== 0) throw new InputError('Не удалось распознать документ. Проверьте, что файл не повреждён и не защищён паролем');
    signal.throwIfAborted();
    return text;
  } finally { proc.kill(); signal.removeEventListener('abort', abort); }
}
async function limitedText(response: Response, max: number): Promise<string> {
  const reader = response.body!.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new InputError('Документ слишком большой после распознавания');
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts).toString('utf8');
}

/** Extract without importing into the operator's Paperless archive. Tools run without a shell. */
export async function extractDocument(name: string, bytes: Uint8Array): Promise<string> {
  const { extension, type } = validateDocument(name, bytes);
  const signal = AbortSignal.timeout(5 * 60_000);
  let text: string;
  if (extension === 'txt') {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new InputError('Сохраните TXT в кодировке UTF-8'); }
  } else if (extension === 'docx') {
    if (!config.knowledge.tikaUrl) throw new InputError('Распознавание DOCX временно недоступно', 503);
    const response = await fetch(config.knowledge.tikaUrl.replace(/\/$/, '') + '/tika', {
      method: 'PUT', headers: { 'Content-Type': type, Accept: 'text/plain' },
      body: bytes as BodyInit, redirect: 'error', signal,
    });
    if (!response.ok) throw new InputError('Не удалось распознать DOCX');
    text = await limitedText(response, config.knowledge.maxTextChars * 4);
  } else {
    const dir = await mkdtemp(join(tmpdir(), 'live-slides-'));
    await chmod(dir, 0o700);
    try {
      const file = join(dir, 'input.' + extension);
      await Bun.write(file, bytes);
      await chmod(file, 0o600);
      if (extension === 'doc') text = await run(['antiword', '-m', 'UTF-8.txt', file], signal);
      else {
        const info = await run(['pdfinfo', file], signal);
        const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
        if (!pages || pages > 60) throw new InputError('PDF должен содержать не больше 60 страниц');
        const parts: string[] = [];
        let length = 0;
        for (let page = 1; page <= pages; page++) {
          let content = await run(['pdftotext', '-f', String(page), '-l', String(page), '-layout', file, '-'], signal);
          if (content.trim().length < 40) {
            // OCR only pages without a usable text layer, including scans in mixed PDFs.
            const image = join(dir, 'page');
            await run(['pdftoppm', '-f', String(page), '-l', String(page), '-r', '150', '-scale-to', '2400', '-singlefile', '-png', file, image], signal);
            content = await run(['tesseract', image + '.png', 'stdout', '-l', 'rus+eng', '--psm', '3'], signal);
            await rm(image + '.png', { force: true });
          }
          length += content.length;
          if (length > config.knowledge.maxTextChars) throw new InputError('В документе слишком много текста');
          parts.push(content);
        }
        text = parts.join('\n\n');
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  text = text.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
  if (!text || !/[\p{L}\p{N}]/u.test(text)) throw new InputError('В документе не найден читаемый текст');
  if (text.length > config.knowledge.maxTextChars) throw new InputError('В документе слишком много текста');
  return text;
}

export function chunks(text: string): string[] {
  const result: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 1800, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end);
      if (boundary > start + 900) end = boundary;
    }
    const part = text.slice(start, end).trim();
    if (part) result.push(part);
    if (end === text.length) break;
    start = end - 200;
  }
  return result;
}
