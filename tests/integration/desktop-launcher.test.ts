import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const script = 'scripts/desktop-launch.mjs';
const projectNode = join(homedir(), '.nvm', 'versions', 'node', 'v22.22.2', 'bin', 'node');
const node = existsSync(projectNode) ? projectNode : process.execPath;
const projectEnv = existsSync(projectNode)
  ? { ...process.env, PATH: `${dirname(projectNode)}${delimiter}${process.env.PATH || ''}` }
  : process.env;

describe('double-click desktop launcher', () => {
  it('prints a first-run guide without touching data', () => {
    const output = execFileSync(node, [script, '--help'], { encoding: 'utf8', env: projectEnv });
    expect(output).toContain('首次启动会打开配置向导');
    expect(output).toContain('诊断模式');
  });

  it('runs configuration diagnostics without starting a second service', () => {
    const output = execFileSync(node, [script, '--check', '--skip-port'], { encoding: 'utf8', env: projectEnv });
    expect(output).toContain('env_file');
    expect(output).not.toContain('npm start');
  });
});
