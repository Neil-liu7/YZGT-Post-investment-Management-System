import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { requireFreePort, useProjectRuntime, waitForHealth } from './runtime.mjs';

try {
  await useProjectRuntime(import.meta.url);
  if (!existsSync('node_modules')) throw new Error('请先运行 npm ci');
  await import('dotenv/config');
  const port = Number(process.env.PORT || 8765);
  await requireFreePort(port);
  const child = spawn(process.execPath, ['scripts/start.mjs'], { stdio: 'inherit', windowsHide: true });
  const exited = new Promise(resolve => child.once('close', resolve));
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; child.kill(signal); });
  const ready = await waitForHealth(child, port);
  if (!ready) {
    if (!stopping) console.error('启动未就绪，请检查服务日志和 PORT 配置');
    child.kill();
    await exited;
    process.exitCode = stopping ? 0 : 1;
  } else {
    const url = `http://127.0.0.1:${port}`;
    const opener = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { windowsHide: true })
      : spawn('open', [url], { stdio: 'ignore' });
    opener.once('error', () => console.error(`无法自动打开浏览器，请手动访问 ${url}`));
    opener.once('exit', code => { if (code) console.error(`无法自动打开浏览器，请手动访问 ${url}`); });
    const code = await exited;
    process.exitCode = stopping ? 0 : typeof code === 'number' ? code : 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
