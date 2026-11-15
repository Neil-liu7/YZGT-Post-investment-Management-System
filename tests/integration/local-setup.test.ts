import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, quoteEnvValue } from '../../scripts/local-config';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function runSetup(args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
  const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return execFileSync(process.execPath, [tsx, 'scripts/setup.ts', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...extraEnv } });
}

describe('first-run local configuration wizard', () => {
  it('round-trips quoted values containing quotes and backslashes', () => {
    const value = 'pa"ss\\word';
    expect(parseEnv(`SMTP_PASS=${quoteEnvValue(value)}\n`).SMTP_PASS).toBe(value);
  });

  it('writes an isolated mock configuration atomically and backs up the prior file', () => {
    const root = mkdtempSync(join(tmpdir(), 'yzgt-setup-')); roots.push(root);
    const template = join(root, 'template.env'), envFile = join(root, '.env'), backup = join(root, 'config-backups');
    writeFileSync(template, ['# kept comment', 'LLM_MODE=mock', 'OUTBOUND_MODE=mock', 'SCHEDULER_ENABLED=false', 'UNKNOWN_DEPLOYMENT_FLAG=kept', ''].join('\n'));
    const args = [
      '--non-interactive', `--template=${template}`, `--config-file=${envFile}`, `--backup-dir=${backup}`,
      `--set=PORT=18765`, `--set=DATABASE_FILE=${join(root, 'var', 'app.sqlite')}`,
      `--set=STORAGE_DIR=${join(root, 'storage')}`, `--set=BACKUP_DIR=${join(root, 'backups')}`,
    ];
    const first = JSON.parse(runSetup(args, process.cwd()));
    expect(first.status).toBe('configured');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(envFile, 'utf8')).toContain('# kept comment');
    expect(readFileSync(envFile, 'utf8')).toContain('UNKNOWN_DEPLOYMENT_FLAG=kept');
    expect(readFileSync(envFile, 'utf8')).toContain('PORT=18765');

    const second = JSON.parse(runSetup(args, process.cwd()));
    expect(second.status).toBe('configured');
    expect(second.backup).toContain('config-backups');
    expect(readdirSync(backup).length).toBe(1);
    expect(statSync(second.backup).mode & 0o777).toBe(0o600);
  });

  it('does not accept secrets on the command line or create a partial file', () => {
    const root = mkdtempSync(join(tmpdir(), 'yzgt-setup-secret-')); roots.push(root);
    const template = join(root, 'template.env'), envFile = join(root, '.env');
    mkdirSync(root, { recursive: true }); writeFileSync(template, 'LLM_MODE=mock\nOUTBOUND_MODE=mock\n');
    let error: { status?: number; stdout?: string; stderr?: string } = {};
    try { runSetup(['--non-interactive', `--template=${template}`, `--config-file=${envFile}`, '--set=LLM_API_KEY=secret-test-key'], process.cwd()); }
    catch (caught) { error = caught as { status?: number; stdout?: string; stderr?: string }; }
    expect(error.status).toBe(1);
    expect(error.stdout ?? '').not.toContain('secret-test-key');
    expect(error.stderr ?? '').not.toContain('secret-test-key');
    expect(existsSync(envFile)).toBe(false);
  });

  it('accepts secret values only through SETUP_* environment variables', () => {
    const root = mkdtempSync(join(tmpdir(), 'yzgt-setup-env-')); roots.push(root);
    const template = join(root, 'template.env'), envFile = join(root, '.env');
    writeFileSync(template, 'LLM_MODE=mock\nOUTBOUND_MODE=mock\n');
    const output = runSetup(['--non-interactive', `--template=${template}`, `--config-file=${envFile}`], process.cwd(), { SETUP_LLM_API_KEY: 'secret-env-key' });
    expect(output).not.toContain('secret-env-key');
    expect(readFileSync(envFile, 'utf8')).toContain('LLM_API_KEY=secret-env-key');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });
});
