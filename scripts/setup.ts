import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve } from 'node:path';
import { atomicWriteEnv, backupEnv, checkConfiguration, parseEnv, renderEnv, secretKeys, supportedKeys, type LocalEnv } from './local-config';

type Args = { interactive: boolean; check: boolean; envFile: string; template: string; backupRoot: string; sets: Record<string, string>; errors: string[] };
const known = new Set<string>(supportedKeys);

function argsOf(argv: string[]): Args {
  const result: Args = { interactive: process.stdin.isTTY && process.stdout.isTTY, check: false, envFile: '.env', template: '.env.example', backupRoot: resolve('var', 'config-backups'), sets: {}, errors: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--non-interactive') result.interactive = false;
    else if (arg === '--check') result.check = true;
    // `--env-file` is reserved by recent Node runtimes, so the public CLI uses
    // `--config-file`; keep the former as a compatibility alias for callers
    // that pass it after an explicit `--` delimiter.
    else if (arg.startsWith('--config-file=')) result.envFile = arg.slice(14);
    else if (arg === '--config-file' && argv[index + 1]) result.envFile = argv[++index];
    else if (arg.startsWith('--env-file=')) result.envFile = arg.slice(11);
    else if (arg === '--env-file' && argv[index + 1]) result.envFile = argv[++index];
    else if (arg.startsWith('--template=')) result.template = arg.slice(11);
    else if (arg === '--template' && argv[index + 1]) result.template = argv[++index];
    else if (arg.startsWith('--backup-dir=')) result.backupRoot = arg.slice(13);
    else if (arg === '--backup-dir' && argv[index + 1]) result.backupRoot = argv[++index];
    else if (arg.startsWith('--set=')) {
      const pair = arg.slice(6), separator = pair.indexOf('=');
      if (separator <= 0) result.errors.push('SET_ARGUMENT_INVALID');
      else { const key = pair.slice(0, separator).toUpperCase(); if (!known.has(key)) result.errors.push(`UNKNOWN_KEY:${key}`); else if (secretKeys.has(key)) result.errors.push('SECRET_ARGUMENT_FORBIDDEN'); else result.sets[key] = pair.slice(separator + 1); }
    } else if (arg.startsWith('--') && arg.includes('=')) {
      const separator = arg.indexOf('='), key = arg.slice(2, separator).replaceAll('-', '_').toUpperCase();
      if (!known.has(key)) result.errors.push(`UNKNOWN_KEY:${key}`); else if (secretKeys.has(key)) result.errors.push('SECRET_ARGUMENT_FORBIDDEN'); else result.sets[key] = arg.slice(separator + 1);
    } else if (arg.startsWith('--')) result.errors.push(`UNKNOWN_ARGUMENT:${arg}`);
  }
  for (const key of known) { const value = process.env[`SETUP_${key}`]; if (value !== undefined) result.sets[key] = value; }
  return result;
}

async function hidden(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  if (!input.isTTY || !output.isTTY || !input.setRawMode) return rl.question(`${prompt}（输入不会显示在屏幕上时请使用SETUP_*环境变量）：`);
  output.write(prompt); input.setRawMode(true); input.resume(); let value = '';
  return await new Promise<string>((resolve, reject) => {
    const onData = (chunk: Buffer) => { for (const character of chunk.toString('utf8')) { if (character === '\u0003') { cleanup(); reject(new Error('SETUP_CANCELLED')); return; } if (character === '\r' || character === '\n') { cleanup(); output.write('\n'); resolve(value); return; } if (character === '\u007f') value = value.slice(0, -1); else value += character; } };
    const cleanup = () => { input.setRawMode?.(false); input.pause(); input.off('data', onData); };
    input.on('data', onData);
  });
}

async function interactiveValues(values: LocalEnv): Promise<LocalEnv> {
  const rl = createInterface({ input, output });
  const result = { ...values };
  const ask = async (key: string, label: string, fallback = result[key] ?? '') => { const value = await rl.question(`${label}${fallback ? `（当前：${secretKeys.has(key) ? '已配置' : fallback}，回车保留）` : ''}：`); if (value.trim()) result[key] = value.trim(); };
  try {
    await ask('LLM_MODE', '模型模式（mock/live）', result.LLM_MODE || 'mock');
    if (result.LLM_MODE === 'live') { await ask('LLM_PROVIDER', '模型服务（glm/openai_compatible）', result.LLM_PROVIDER || 'glm'); await ask('LLM_MODEL', '模型名称'); await ask('LLM_BASE_URL', '模型接口地址'); const key = await hidden(rl, `模型 API Key${result.LLM_API_KEY || result.GLM_API_KEY ? '（已配置，回车保留）' : ''}：`); if (key.trim()) result.LLM_API_KEY = key.trim(); result.ALLOW_EXTERNAL_MODEL = 'true'; }
    await ask('OUTBOUND_MODE', '通知模式（mock/live）', result.OUTBOUND_MODE || 'mock');
    if (result.OUTBOUND_MODE === 'live') { await ask('SMTP_HOST', 'SMTP服务器'); await ask('SMTP_PORT', 'SMTP端口', result.SMTP_PORT || '465'); await ask('SMTP_SECURE', 'SMTP使用TLS（true/false）', result.SMTP_SECURE || 'true'); await ask('SMTP_USER', 'SMTP账号'); const pass = await hidden(rl, `SMTP密码${result.SMTP_PASS ? '（已配置，回车保留）' : ''}：`); if (pass.trim()) result.SMTP_PASS = pass.trim(); await ask('SMTP_FROM', 'SMTP发件地址'); await ask('MAIL_TO', '邮件收件地址'); await ask('FEISHU_WEBHOOK_URL', '飞书机器人Webhook'); await ask('FEISHU_KEYWORD', '飞书关键词', result.FEISHU_KEYWORD || '投后提醒'); }
    await ask('SCHEDULER_ENABLED', '自动提醒总开关（true/false）', result.SCHEDULER_ENABLED || 'false');
    await ask('BACKUP_SCHEDULE_ENABLED', '定时备份总开关（true/false）', result.BACKUP_SCHEDULE_ENABLED || 'false');
    if (result.BACKUP_SCHEDULE_ENABLED === 'true') { await ask('BACKUP_INTERVAL_HOURS', '备份间隔（小时）', result.BACKUP_INTERVAL_HOURS || '24'); await ask('BACKUP_RETENTION', '备份保留份数', result.BACKUP_RETENTION || '7'); }
    await ask('SUPERVISOR_LOG_MAX_BYTES', '日志轮换大小（字节）', result.SUPERVISOR_LOG_MAX_BYTES || '10485760');
    await ask('SUPERVISOR_LOG_RETENTION', '日志保留份数', result.SUPERVISOR_LOG_RETENTION || '5');
  } finally { rl.close(); }
  return result;
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (args.errors.length) { console.error(JSON.stringify({ status: 'failed', code: args.errors[0], codes: args.errors }, null, 2)); process.exitCode = 1; return; }
  if (!existsSync(args.template) && !existsSync(args.envFile)) { console.error(JSON.stringify({ status: 'failed', code: 'TEMPLATE_NOT_FOUND', message: '找不到.env.example模板。' })); process.exitCode = 1; return; }
  const existing = existsSync(args.envFile) ? parseEnv(readFileSync(args.envFile, 'utf8')) : {};
  if (args.check) { const result = checkConfiguration(existing, { checkNode: true }); console.log(JSON.stringify({ status: result.ok ? 'passed' : 'failed', configuration: result.public, checks: result.checks }, null, 2)); if (!result.ok) process.exitCode = 1; return; }
  const template = existsSync(args.envFile) ? readFileSync(args.envFile, 'utf8') : readFileSync(args.template, 'utf8');
  let values: LocalEnv = { ...(existsSync(args.template) ? parseEnv(readFileSync(args.template, 'utf8')) : {}), ...existing, ...args.sets };
  if (args.interactive) values = await interactiveValues(values);
  const backup = backupEnv(args.envFile, args.backupRoot); atomicWriteEnv(args.envFile, renderEnv(template, values));
  const result = checkConfiguration(values, { checkNode: true });
  console.log(JSON.stringify({ status: result.ok ? 'configured' : 'needs_review', env_file: resolve(args.envFile), backup, configuration: result.public, checks: result.checks }, null, 2));
  if (!result.ok) process.exitCode = 2;
}
main().catch(error => { console.error(JSON.stringify({ status: 'failed', code: 'SETUP_FAILED', message: error instanceof Error ? error.message : '配置向导失败。' })); process.exitCode = 1; });
