import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), installOnly = args.includes('--install-only');
const root = resolve(fileURLToPath(new URL('..', import.meta.url))), envPath = join(root, '.env'), examplePath = join(root, '.env.example');
if (!existsSync(envPath)) { if (!existsSync(examplePath)) throw new Error('缺少 .env.example，无法创建本地配置。'); writeFileSync(envPath, readFileSync(examplePath)); chmodSync(envPath, 0o600); }
else chmodSync(envPath, 0o600);
if (installOnly) {
  execFileSync(process.env.npm_execpath || 'npm', ['ci', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
  process.exit(0);
}
const node = process.versions.node.split('.').map(Number);
const nodeReady = node[0] > 22 || (node[0] === 22 && (node[1] > 22 || (node[1] === 22 && node[2] >= 2)));
const required = ['var', 'storage', 'backups'];
const { mkdirSync } = await import('node:fs'); for (const dir of required) mkdirSync(resolve(root, dir), { recursive: true });
console.log(JSON.stringify({ status: 'ready', node: process.versions.node, node_required: '>=22.22.2', node_ready: nodeReady, env: envPath, env_permissions: '0600', next: ['npm run config:check', 'npm run db:migrate', 'npm run build', 'npm start'] }, null, 2));
if (!nodeReady) process.exitCode = 1;
