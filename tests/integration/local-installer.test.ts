import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const run = (script: string, args: string[]) => execFileSync(process.execPath, [script, ...args], { cwd: process.cwd(), encoding: 'utf8' });

describe('portable local installation package', () => {
  it('creates a clean manifest without local data, dependencies or credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'yzgt-local-package-')); roots.push(root);
    const output = join(root, '亦庄 安装包');
    const result = JSON.parse(run('scripts/package-local.mjs', [`--out=${output}`]));
    expect(result.status).toBe('passed');
    const marker = JSON.parse(readFileSync(join(output, '.local-package.json'), 'utf8'));
    expect(marker.format).toBe('yzgt-local-package');
    expect(marker.files).toContain('dist/server.mjs');
    expect(marker.files).toContain('apps/web/dist/index.html');
    expect(marker.files).not.toContain('.env');
    expect(marker.files.some((file: string) => /(^|\/)(var|storage|backups|node_modules)(\/|$)/.test(file))).toBe(false);
    expect(existsSync(join(output, '.env'))).toBe(false);
    expect(existsSync(join(output, '本地安装说明.txt'))).toBe(true);
    expect(() => run('scripts/package-local.mjs', [`--out=${output}`])).toThrow(/非空/);
  });

  it('installs to a new Chinese path with a private empty environment and no database', () => {
    const root = mkdtempSync(join(tmpdir(), 'yzgt-local-install-')); roots.push(root);
    const source = join(root, 'package'), target = join(root, '安装 数据 目录');
    execFileSync(process.execPath, ['scripts/package-local.mjs', `--out=${source}`], { cwd: process.cwd(), stdio: 'ignore' });
    const result = JSON.parse(run('scripts/install-local.mjs', [`--from=${source}`, `--to=${target}`, '--skip-install']));
    expect(result.status).toBe('passed');
    expect(statSync(join(target, '.env')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(target, '.env'), 'utf8')).toBe(readFileSync('.env.example', 'utf8'));
    expect(existsSync(join(target, 'var'))).toBe(true);
    expect(existsSync(join(target, 'storage'))).toBe(true);
    expect(existsSync(join(target, 'backups'))).toBe(true);
    expect(existsSync(join(target, 'var', 'app.sqlite'))).toBe(false);
    expect(readdirSync(target)).not.toContain('node_modules');
  });
});
