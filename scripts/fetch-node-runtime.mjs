#!/usr/bin/env node
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const version = '22.22.2';
const args = process.argv.slice(2);
const value = flag => args.find(item => item.startsWith(`${flag}=`))?.slice(flag.length + 1);
const platform = value('--platform') || process.platform;
const arch = value('--arch') || (process.arch === 'arm64' ? 'arm64' : 'x64');
const out = resolve(value('--out') || join('desktop', 'runtime'));
const target = platform === 'win32' ? `win-${arch}` : platform === 'darwin' ? `darwin-${arch}` : null;
if (!target) throw new Error(`暂不支持自动下载 ${platform}；请在目标平台执行本脚本。`);
const filename = platform === 'win32' ? `node-v${version}-win-${arch}.zip` : `node-v${version}-darwin-${arch}.tar.gz`;
const url = `https://nodejs.org/dist/v${version}/${filename}`;
const cache = resolve('var', 'native-runtime-cache', filename);
mkdirSync(resolve('var', 'native-runtime-cache'), { recursive: true });
if (!existsSync(cache)) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载 Node 运行时失败：HTTP ${response.status}`);
  writeFileSync(cache, Buffer.from(await response.arrayBuffer()));
}
mkdirSync(out, { recursive: true });
if (platform === 'darwin') {
  const result = spawnSync('tar', ['-xzf', cache, '--strip-components=2', '-C', out, `node-v${version}-darwin-${arch}/bin/node`], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('解压 Node 运行时失败。');
} else {
  const targetDir = join(out, target); mkdirSync(targetDir, { recursive: true });
  const result = spawnSync(process.platform === 'win32' ? 'tar' : 'ditto', process.platform === 'win32' ? ['-xf', cache, '--strip-components=1', '-C', targetDir] : ['-x', '-k', cache, targetDir], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('解压 Windows Node 运行时失败，请在目标平台重试。');
}
console.log(JSON.stringify({ status: 'passed', platform, arch, version, target, output: out, source: url }, null, 2));
