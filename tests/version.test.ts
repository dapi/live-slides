import { expect, test } from 'bun:test';
import { bumpVersion, prepareBump } from '../scripts/bump-version';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('SemVer bumps reset lower components and reject ambiguous versions', () => {
  expect(bumpVersion('0.9.9', 'patch')).toBe('0.9.10');
  expect(bumpVersion('0.9.9', 'minor')).toBe('0.10.0');
  expect(bumpVersion('0.9.9', 'major')).toBe('1.0.0');
  expect(() => bumpVersion('01.2.3', 'patch')).toThrow();
  expect(() => bumpVersion('1.2', 'minor')).toThrow();
  expect(() => bumpVersion('1.2.3', 'fix')).toThrow();
  expect(() => bumpVersion('1.2.9007199254740991', 'patch')).toThrow();
  expect(() => bumpVersion('1.9007199254740991.0', 'minor')).toThrow();
  expect(() => bumpVersion('9007199254740991.0.0', 'major')).toThrow();
});

test('release CLI publishes a tag once and rejects local and remote version reuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-slides-release-'));
  const root = join(directory, 'app');
  async function run(args: string[], cwd = root) {
    const command = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([
      command.exited, new Response(command.stdout).text(), new Response(command.stderr).text(),
    ]);
    return { code, output: stdout + stderr };
  }
  async function git(...args: string[]) {
    const result = await run(['git', ...args]);
    expect(result.code).toBe(0);
  }
  const release = (mode: string) => run([process.execPath, 'scripts/release.ts', mode]);
  try {
    await Bun.write(join(root, 'package.json'), '{"version":"0.1.0"}\n');
    await Bun.write(join(root, 'CHANGELOG.md'), '## [0.1.0]\n\nInitial release\n');
    for (const script of ['release.ts', 'bump-version.ts']) {
      await Bun.write(join(root, 'scripts', script), Bun.file(join(import.meta.dir, '..', 'scripts', script)));
    }
    expect((await run(['git', 'init', '--bare', join(directory, 'remote.git')], directory)).code).toBe(0);
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Release test');
    await git('config', 'user.email', 'release@example.invalid');
    await git('add', '.');
    await git('commit', '-m', 'Initial release');
    await git('remote', 'add', 'origin', join(directory, 'remote.git'));
    expect((await release('check')).code).toBe(0);
    await Bun.write(join(root, 'package.json'), '{"version":"0.1.1"}\n');
    expect((await release('check')).output).toContain('Зафиксируйте package.json');
    await git('restore', 'package.json');
    // Simulate a tag created just before a failed push, then safely resume.
    await git('tag', '-a', 'v0.1.0', '-m', 'Initial release');
    expect((await release('tag')).code).toBe(0);
    expect((await release('tag')).output).toContain('Уже опубликован');
    await Bun.write(join(root, 'change.txt'), 'Different application code');
    await git('add', 'change.txt');
    await git('commit', '-m', 'Changed code without a version bump');
    expect((await release('check')).output).toContain('Номер уже принадлежит другому коммиту');
    await git('tag', '-d', 'v0.1.0');
    expect((await release('check')).output).toContain('Удалённый тег уже занят другим коммитом');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('a release requires notes and preserves previous changelog entries', () => {
  const old = '## [0.1.0] — 2026-10-07\n\nInitial release\n';
  const next = prepareBump('0.1.0', '# Changes\n\n## [Unreleased]\n\n- Fixed recording\n\n' + old, 'patch', '2026-10-08');
  expect(next.version).toBe('0.1.1');
  expect(next.changelog).toContain('## [Unreleased]\n\n## [0.1.1] — 2026-10-08');
  expect(next.changelog).toContain('- Fixed recording');
  expect(next.changelog).toContain(old);
  expect(() => prepareBump('0.1.0', '## [Unreleased]\n\n' + old, 'patch', '2026-10-08')).toThrow();
  expect(() => prepareBump('0.1.0', '## [Unreleased]\n\n- Fix\n\n## [0.1.1]\n\nAlready released', 'patch', '2026-10-08')).toThrow();
});
