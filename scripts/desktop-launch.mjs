#!/usr/bin/env node
/**
 * Double-click friendly local desktop entry point.
 * It prepares the user's private configuration/data area, then delegates to
 * the existing local server launcher. No network service or real channel is
 * contacted by the preparation steps.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useProjectRuntime, projectRoot } from './runtime.mjs';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const skipPort = args.includes('--skip-port');
const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function runNpm(npmArgs, options = {}) {
  const result = spawnSync(command, npmArgs, { cwd: projectRoot, stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function fail(message) {
  console.error(`\n${message}\n`);
  process.exitCode = 1;
}

try {
  await useProjectRuntime(import.meta.url);
  if (args.includes('--help')) {
    console.log('用法：双击启动系统.command（Mac）或启动系统.cmd（Windows）。');
    console.log('首次启动会打开配置向导；完成后会自动执行自检、迁移并打开本机页面。');
    console.log('诊断模式：node scripts/desktop-launch.mjs --check [--skip-port]');
    process.exit(0);
  }
  if (!existsSync(join(projectRoot, 'node_modules'))) throw new Error('尚未安装依赖，请先在本目录执行 npm ci。');
  if (!existsSync(join(projectRoot, '.env'))) {
    console.log('检测到首次启动，正在打开配置向导。密钥输入不会写入命令行或输出。');
    if (runNpm(['run', 'setup:local']) !== 0) throw new Error('配置向导未完成，应用尚未启动。');
  }
  const checkArgs = ['run', 'config:check', '--', ...(skipPort || checkOnly ? ['--skip-port'] : [])];
  const checkStatus = runNpm(checkArgs);
  if (checkStatus !== 0) {
    if (checkOnly) process.exit(checkStatus);
    throw new Error('配置自检未通过。请重新执行 npm run setup:local，修复配置后再启动。');
  }
  if (checkOnly) process.exit(0);
  if (!existsSync(join(projectRoot, 'dist', 'server.mjs'))) {
    console.log('检测到尚未构建，正在准备本地应用。');
    if (runNpm(['run', 'build']) !== 0) throw new Error('构建未完成，应用尚未启动。');
  }
  if (runNpm(['run', 'db:migrate']) !== 0) throw new Error('数据库初始化未完成，应用尚未启动。');
  const launcher = fileURLToPath(new URL('./launch.mjs', import.meta.url));
  const child = spawnSync(process.execPath, [launcher], { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
  process.exitCode = child.status ?? 1;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
