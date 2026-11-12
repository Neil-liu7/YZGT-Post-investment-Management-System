import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export async function useProjectRuntime(script, nodeArgs = []) {
  process.chdir(projectRoot);
  const version = readFileSync(join(projectRoot, '.node-version'), 'utf8').trim();
  const candidates = [
    join(process.env.NVM_DIR || join(homedir(), '.nvm'), 'versions', 'node', `v${version}`, 'bin', 'node'),
    ...(process.env.NVM_HOME ? [join(process.env.NVM_HOME, `v${version}`, 'node.exe')] : []),
  ];
  const executable = candidates.find(path => existsSync(path));
  if (executable && realpathSync(executable) !== realpathSync(process.execPath)) {
    const child = spawn(executable, [...nodeArgs, fileURLToPath(script), ...process.argv.slice(2)], {
      cwd: projectRoot, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, PATH: `${dirname(executable)}${delimiter}${process.env.PATH || ''}` },
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
    let failed = false;
    child.once('error', error => { failed = true; console.error(`无法启动项目 Node.js：${error.message}`); });
    const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    // A gracefully stopped service exits 0 itself; cancelled verification commands must keep their non-zero status.
    process.exit(failed ? 1 : typeof result.code === 'number' ? result.code : result.signal && constants.signals[result.signal] ? 128 + constants.signals[result.signal] : 1);
  }
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && (minor < 22 || (minor === 22 && patch < 2)))) {
    throw new Error(`请安装并使用 Node.js ${version}，然后运行 npm ci。`);
  }
}

export async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => reject(new Error(error.code === 'EADDRINUSE'
      ? `端口 ${port} 已被占用，请修改端口配置；不会终止其他程序。`
      : `无法使用端口 ${port}：${error.message}`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

export async function waitForHealth(child, port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: globalThis.AbortSignal.timeout(500) });
      if (response.ok && (await response.json()).data?.status === 'ok'
        && child.exitCode === null && child.signalCode === null) return true;
    } catch { /* The child may still be opening its database and HTTP listener. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}
