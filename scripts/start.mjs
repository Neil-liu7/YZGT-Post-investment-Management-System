import { existsSync } from 'node:fs';
import { useProjectRuntime } from './runtime.mjs';
try {
  await useProjectRuntime(import.meta.url);
  if (!existsSync('dist/server.mjs')) throw new Error('尚未构建。请依次执行 npm ci、npm run db:migrate、npm run build');
  await import('../dist/server.mjs');
} catch (error) {
  console.error(error.code === 'ERR_DLOPEN_FAILED'
    ? 'Node.js 与原生依赖版本不一致，请使用 .node-version 指定的版本后运行 npm ci。'
    : error.message);
  process.exitCode = 1;
}
