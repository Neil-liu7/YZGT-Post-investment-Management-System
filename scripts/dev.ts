import { spawn } from 'node:child_process';
// @ts-expect-error Shared launch helpers are plain JavaScript so they can select Node before loading tsx.
import { requireFreePort, useProjectRuntime, waitForHealth } from './runtime.mjs';
const children: ReturnType<typeof spawn>[] = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill();
}
function run(args: string[]) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.once('error', error => { console.error(error.message); stop(1); });
  child.once('exit', code => { if (!stopping) stop(code ?? 1); });
  return child;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
try {
  await useProjectRuntime(import.meta.url, ['--import', 'tsx']);
  await import('dotenv/config');
  const port = Number(process.env.PORT || 8765);
  await requireFreePort(port);
  await requireFreePort(5173);
  const server = run(['--import', 'tsx', 'apps/server/src/index.ts']);
  if (await waitForHealth(server, port)) {
    if (!stopping) run(['node_modules/vite/bin/vite.js', '--config', 'apps/web/vite.config.ts', '--strictPort']);
  } else if (!stopping) {
    console.error('后端未就绪，请检查端口和数据库');
    stop(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '开发服务启动失败');
  stop(1);
}
