import { join } from 'node:path';
import { bumpVersion } from './bump-version';

const root = join(import.meta.dir, '..');
const registry = process.env.APP_IMAGE_REPOSITORY;
async function capture(command: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const process = Bun.spawn(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}
async function git(...args: string[]): Promise<string> {
  const result = await capture(['git', ...args]);
  if (!result.ok) throw new Error(`Не удалось выполнить git ${args[0]}`);
  return result.stdout;
}
const mode = Bun.argv[2] ?? 'check';
if (!['check', 'tag', 'build'].includes(mode)) throw new Error('Используйте check, tag или build');
const manifest = JSON.parse(await git('show', 'HEAD:package.json'));
bumpVersion(manifest.version, 'patch'); // Validate the release version using the same rules.
const version: string = manifest.version;
const tag = `v${version}`;
const revision = await git('rev-parse', 'HEAD');
if (!['main', 'master'].includes(await git('branch', '--show-current'))) throw new Error('Выпускайте из канонической main/master');
if (!(await capture(['git', 'diff', '--exit-code', 'HEAD', '--', 'package.json', 'CHANGELOG.md'])).ok) throw new Error('Зафиксируйте package.json и CHANGELOG.md перед выпуском');
if (!(await git('show', 'HEAD:CHANGELOG.md')).includes(`## [${version}]`)) throw new Error('Нет записи текущего релиза в CHANGELOG.md');
const local = (await capture(['git', 'rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`]));
if (local.ok && local.stdout !== revision) throw new Error('Номер уже принадлежит другому коммиту. Повысьте версию');
const remote = await git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
const remoteCommit = remote.split('\n').find(line => line.endsWith(`refs/tags/${tag}^{}`))?.split(/\s/)[0]
  ?? remote.split('\n').find(line => line.endsWith(`refs/tags/${tag}`))?.split(/\s/)[0];
if (remoteCommit && remoteCommit !== revision) throw new Error('Удалённый тег уже занят другим коммитом. Повысьте версию');
if (mode === 'check') { console.log(`${tag} · ${revision}`); process.exit(0); }
if (mode === 'tag') {
  if (remoteCommit) {
    if (!local.ok) await git('fetch', 'origin', `refs/tags/${tag}:refs/tags/${tag}`);
    console.log(`Уже опубликован ${tag} · ${revision}`);
    process.exit(0);
  }
  if (!local.ok) await git('tag', '-a', tag, '-m', `Живые слайды ${tag}`);
  await git('push', 'origin', `refs/tags/${tag}`);
  console.log(`Опубликован ${tag} · ${revision}`);
  process.exit(0);
}
if (!local.ok || remoteCommit !== revision) throw new Error('Сначала опубликуйте тег через bun run release:tag');
if (!registry || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(registry) || registry.split('/').at(-1)?.includes(':')) throw new Error('Задайте APP_IMAGE_REPOSITORY без тега и credentials');
const image = `${registry}:${version}`;
const existing = await capture(['docker', 'buildx', 'imagetools', 'inspect', image]);
if (existing.ok) throw new Error('Образ этой версии уже опубликован. Используйте его для деплоя; для другого кода повысьте версию');
if (!/manifest unknown|not found|no such manifest/i.test(existing.stderr)) throw new Error('Не удалось подтвердить отсутствие образа в registry; сборка остановлена');
// Export only the reviewed tag and allowlisted app files. No data/, credentials, or
// unrelated uncommitted workspace changes can reach the remote builder.
const archive = Bun.spawn(['git', 'archive', '--format=tar', revision, 'Dockerfile', '.dockerignore', 'package.json', 'bun.lock', 'src', 'public', 'migrations', 'prompts', 'scripts/migrate.ts', 'scripts/create-user.ts', 'scripts/invite-user.ts'], { cwd: root, stdout: 'pipe', stderr: 'ignore' });
const build = Bun.spawn(['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--push', '--build-arg', `APP_VERSION=${version}`, '--build-arg', `APP_REVISION=${revision}`, '-t', image, '-'], { cwd: root, stdin: archive.stdout, stdout: 'inherit', stderr: 'inherit' });
const [archived, built] = await Promise.all([archive.exited, build.exited]);
if (archived !== 0 || built !== 0) throw new Error('Сборка или публикация не завершены');
console.log(`Образ ${image} опубликован. Разверните тег ${version} через канонический infrastructure runbook вашего окружения.`);
