import { join } from 'node:path';

export function bumpVersion(version: string, kind: string): string {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Требуется релизная версия MAJOR.MINOR.PATCH без ведущих нулей');
  const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
  if (![major, minor, patch].every(Number.isSafeInteger)) throw new Error('Слишком большое число версии');
  const parts = kind === 'patch' ? [major, minor, patch + 1]
    : kind === 'minor' ? [major, minor + 1, 0]
    : kind === 'major' ? [major + 1, 0, 0] : null;
  if (!parts) throw new Error('Используйте patch, minor или major');
  if (!parts.every(Number.isSafeInteger)) throw new Error('Слишком большое число версии');
  return parts.join('.');
}

export function prepareBump(version: string, changelog: string, kind: string, date: string) {
  const next = bumpVersion(version, kind);
  const section = changelog.match(/^## \[Unreleased\]\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m);
  if (!section?.[1]?.trim()) throw new Error('Сначала опишите изменения в CHANGELOG.md под [Unreleased]');
  if (changelog.includes(`## [${next}]`)) throw new Error('Эта версия уже есть в CHANGELOG.md');
  return { version: next, changelog: changelog.replace(section[0], `## [Unreleased]\n\n## [${next}] — ${date}\n\n${section[1].trim()}\n\n`) };
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..');
  const file = Bun.file(join(root, 'package.json'));
  const manifest = await file.json();
  const changes = await Bun.file(join(root, 'CHANGELOG.md')).text();
  const next = prepareBump(manifest.version, changes, Bun.argv[2] ?? '', new Date().toISOString().slice(0, 10));
  if (Bun.argv.includes('--dry-run')) console.log(`${manifest.version} → ${next.version}`);
  else {
    await Bun.write(file, JSON.stringify({ ...manifest, version: next.version }, null, 2) + '\n');
    await Bun.write(join(root, 'CHANGELOG.md'), next.changelog);
    console.log(`Версия ${next.version}. Проверьте diff и зафиксируйте изменения перед выпуском.`);
  }
}
