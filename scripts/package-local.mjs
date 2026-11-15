import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const nodeVersion = readFileSync(join(root, '.node-version'), 'utf8').trim();
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const valueArgument = flag => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const outputArgument = args.find(value => value.startsWith('--out='))?.slice('--out='.length) ?? valueArgument('--out');
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const output = resolve(outputArgument || join('var', `亦庄投后管理-本地安装包-${Date.now()}`));

const allow = [
  'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'eslint.config.js',
  'playwright.config.ts', '.node-version', '.env.example', 'README.md', 'AGENTS.md',
  '开发说明.md', '开发实施细则.md', '启动系统.cmd', '启动系统.command',
  'apps', 'packages', 'scripts', 'database', 'dist',
];
const ignored = /(^|[\\/])(node_modules|var|storage|backups|test-results|playwright-report|coverage)([\\/]|$)|(^|[\\/])\.env(?:$|\.)|\.(sqlite|sqlite3|db|db-wal|db-shm|log)$/;
const required = ['package.json', 'package-lock.json', '.node-version', '.env.example', 'scripts/start.mjs', 'scripts/runtime.mjs', 'dist/server.mjs', 'apps/web/dist/index.html'];

function ensureSource() {
  for (const path of required) if (!existsSync(join(root, path))) throw new Error(`缺少发行包所需文件：${path}；请先运行 npm run build。`);
}
function copyTree(name) {
  const source = join(root, name), target = join(output, name);
  if (!existsSync(source)) return [];
  const files = [];
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const sourcePath = join(current, entry.name), packagePath = relative(root, sourcePath);
      if (ignored.test(packagePath)) continue;
      if (entry.isDirectory()) walk(sourcePath);
      else files.push(packagePath);
    }
  };
  walk(source);
  if (!dryRun) cpSync(source, target, { recursive: true, filter: path => !ignored.test(relative(root, path)) });
  return files;
}
function copyFile(name) {
  if (!existsSync(join(root, name))) return false;
  if (!dryRun) { mkdirSync(dirname(join(output, name)), { recursive: true }); cpSync(join(root, name), join(output, name)); }
  return true;
}

ensureSource();
if (!dryRun && existsSync(output) && readdirSync(output).length > 0 && !force) throw new Error(`发行包目录已存在且非空：${output}；请更换--out目录或明确使用--force。`);
if (!dryRun) mkdirSync(output, { recursive: true });
const files = [];
for (const name of allow) {
  if (['apps', 'packages', 'scripts', 'database', 'dist'].includes(name)) files.push(...copyTree(name));
  else if (copyFile(name)) files.push(name);
}
const marker = {
  format: 'yzgt-local-package', format_version: 1, app_version: packageJson.version,
  created_at: new Date().toISOString(), node_version: nodeVersion,
  package_manager: 'npm', install_command: 'npm ci --no-audit --no-fund',
  files: files.sort(), excluded: ['.env', 'var', 'storage', 'backups', 'node_modules', 'logs', 'test-results'],
};
if (!dryRun) {
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, '.local-package.json'), JSON.stringify(marker, null, 2) + '\n');
  writeFileSync(join(output, '本地安装说明.txt'), [
    '亦庄国投投后管理系统 · 本地安装包', '',
    `要求：Node.js ${nodeVersion} 或更高受维护 LTS。`,
    '1. 在本目录执行：node scripts/install-local.mjs --from . --to "../亦庄投后管理数据" --skip-install',
    '2. 进入安装目标目录执行：npm ci --no-audit --no-fund',
    '3. 执行：npm run setup:local；按向导检查并写入本机 .env。',
    '4. 执行：npm start，然后打开 http://127.0.0.1:8765。', '',
    '完成首次配置后，也可以直接双击安装包中的“启动系统.command”（Mac）或“启动系统.cmd”（Windows）。',
    '每台电脑拥有独立数据库、原件和 API 配置；不要复制其他电脑的 .env、var、storage 或 backups。',
  ].join('\n') + '\n');
}
console.log(JSON.stringify({ status: 'passed', dry_run: dryRun, output, node_version: nodeVersion, files: files.length, manifest: dryRun ? marker : '.local-package.json' }, null, 2));
