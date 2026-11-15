import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const readArgument = flag => args.find(value => value.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const fromArgument = readArgument('--from');
const toArgument = readArgument('--to');
const skipInstall = args.includes('--skip-install');
if (!fromArgument || !toArgument) throw new Error('用法：node scripts/install-local.mjs --from=<本地安装包> --to=<新的安装目录> [--skip-install]');
const from = resolve(fromArgument), to = resolve(toArgument);
const markerPath = join(from, '.local-package.json');
if (!existsSync(markerPath)) throw new Error('来源不是有效的本地安装包：缺少 .local-package.json。');
const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
if (marker.format !== 'yzgt-local-package' || marker.format_version !== 1) throw new Error('本地安装包版本不受支持。');
if (existsSync(to) && (statSync(to).isDirectory() ? readdirSync(to).length > 0 : true)) throw new Error('安装目标必须是不存在或空目录，避免覆盖其他本地数据。');
const targetRelativeToSource = relative(from, to);
if (targetRelativeToSource === '' || (!targetRelativeToSource.startsWith('..') && !isAbsolute(targetRelativeToSource))) throw new Error('安装目标不能位于安装包目录内，避免递归复制。');
mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true, filter: path => !/(^|[\\/])(var|storage|backups|node_modules)([\\/]|$)|(^|[\\/])\.env$/.test(path.replace(from, '')) });
for (const name of ['var', 'storage', 'backups']) mkdirSync(join(to, name), { recursive: true });
const env = join(to, '.env');
if (!existsSync(env)) { cpSync(join(to, '.env.example'), env); chmodSync(env, 0o600); }
if (process.versions.node.split('.')[0] !== '22') console.warn(`当前Node.js为${process.versions.node}；建议使用${marker.node_version}，原生SQLite依赖可能需要重新安装。`);
let install = { skipped: skipInstall };
if (!skipInstall) {
  const result = spawnSync(process.execPath, ['scripts/setup-local.mjs', '--install-only'], { cwd: to, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('依赖安装失败，请先切换到项目Node版本后重试。');
  install = { skipped: false, status: result.status };
}
console.log(JSON.stringify({ status: 'passed', source: from, target: to, env_mode: '0600 from .env.example', install }, null, 2));
