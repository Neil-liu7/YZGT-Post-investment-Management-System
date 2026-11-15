import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import Database from 'better-sqlite3';
import { checkConfiguration, parseEnv } from './local-config';

export type PortState = 'available' | 'in_use' | 'unknown';
export type InspectOptions = {
  checkPaths?: boolean;
  checkPort?: boolean;
  portInUse?: boolean;
  portState?: PortState;
  checkSqlite?: boolean;
};
export type ConfigCheck = { code: string; state: 'ok' | 'warn' | 'error'; message: string };

function pathFor(values: Record<string, string>, key: string, fallback: string) {
  return resolve(values[key] || fallback);
}

function channelHasInput(values: Record<string, string>, channel: 'email' | 'feishu') {
  if (channel === 'email') return ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'MAIL_TO'].some(key => Boolean(values[key]?.trim()));
  return Boolean(values.FEISHU_WEBHOOK_URL?.trim());
}

/**
 * Probe the local listening port without connecting to the configured service.
 * This only binds a temporary TCP server on localhost, and never performs an
 * outbound model, SMTP, or Feishu request.
 */
export async function probePort(port: number, host = '127.0.0.1'): Promise<PortState> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'unknown';
  return await new Promise<PortState>(resolveState => {
    const server = net.createServer();
    const finish = (state: PortState) => {
      server.removeAllListeners();
      try { server.close(); } catch { /* already closed */ }
      resolveState(state);
    };
    server.once('error', () => finish('in_use'));
    server.listen({ host, port }, () => finish('available'));
  });
}

function sqliteCheck(): ConfigCheck {
  try {
    const db = new Database(':memory:');
    const row = db.prepare('select sqlite_version() as version').get() as { version?: unknown };
    db.close();
    return { code: 'SQLITE_DRIVER_READY', state: typeof row?.version === 'string' ? 'ok' : 'error', message: typeof row?.version === 'string' ? 'SQLite 驱动可用。' : 'SQLite 驱动未返回版本。' };
  } catch {
    return { code: 'SQLITE_DRIVER_NOT_READY', state: 'error', message: 'SQLite 驱动不可用，请重新安装依赖。' };
  }
}

function redactModel(value: unknown, values: Record<string, string>) {
  const text = typeof value === 'string' ? value : '';
  const secrets = [values.LLM_API_KEY, values.GLM_API_KEY, values.SMTP_PASS, values.FEISHU_WEBHOOK_URL].filter(Boolean);
  return secrets.some(secret => text.includes(secret)) ? '已配置（已隐藏）' : text;
}

/** Public, secret-free self-check. It never opens model, SMTP, or webhook connections. */
export function inspectConfiguration(values: Record<string, string>, options: InspectOptions = {}) {
  const result = checkConfiguration(values, { checkNode: true });
  const checks: ConfigCheck[] = [];
  const add = (code: string, state: ConfigCheck['state'], message: string) => checks.push({ code, state, message });
  const port = Number(values.PORT || 8765), limit = Number(values.MAX_UPLOAD_BYTES || 20971520);
  if (!Number.isInteger(port) || port < 1 || port > 65535) add('PORT_INVALID', 'error', '端口必须是1至65535的整数。'); else add('PORT_VALID', 'ok', '端口配置有效。');
  if (!Number.isSafeInteger(limit) || limit <= 0) add('UPLOAD_LIMIT_INVALID', 'error', '上传上限必须是正整数。'); else add('UPLOAD_LIMIT_VALID', 'ok', '上传上限有效。');

  // Preserve base validator failures (mode, scheduler, path and runtime checks)
  // in the concise report instead of hiding them behind channel summaries.
  const handled = new Set(['PORT_VALID', 'UPLOAD_LIMIT_VALID', 'MODEL_READY', 'MODEL_NOT_READY', 'MODEL_READY_MOCK', 'SMTP_READY', 'SMTP_READY_NOT_READY', 'SMTP_READY_MOCK', 'FEISHU_READY', 'FEISHU_READY_NOT_READY', 'FEISHU_READY_MOCK', 'NO_LIVE_CHANNEL', 'SCHEDULER_REQUIRES_LIVE']);
  for (const check of result.checks) if (!handled.has(check.code)) add(check.code, check.ok ? 'ok' : 'error', check.message);

  const modelCheck = result.checks.find(check => check.code === 'MODEL_READY' || check.code === 'MODEL_NOT_READY');
  const modelReady = result.public.llm_mode === 'mock' || Boolean(modelCheck?.ok);
  const model = { provider: result.public.llm_provider, model: redactModel(result.public.llm_model, values), ready: modelReady, mode: result.public.llm_mode };
  if (result.public.llm_mode === 'live' && !modelReady) add('MODEL_LIVE_NOT_READY', 'error', '真实模型配置未就绪。'); else add('MODEL_READY', 'ok', result.public.llm_mode === 'mock' ? '模拟模型可用。' : '真实模型配置有效。');

  const email = result.checks.find(check => check.code === 'SMTP_READY' || check.code === 'SMTP_READY_MOCK');
  const feishu = result.checks.find(check => check.code === 'FEISHU_READY' || check.code === 'FEISHU_READY_MOCK');
  const outbound = result.public.outbound_mode as string;
  const oneLiveChannel = Boolean(email?.ok || feishu?.ok);
  if (outbound === 'live' && !email?.ok) add('EMAIL_LIVE_NOT_READY', oneLiveChannel ? 'warn' : 'error', '真实邮件配置未就绪。'); else add('EMAIL_READY', 'ok', outbound === 'mock' ? '邮件模拟模式可用。' : '邮件配置有效。');
  if (outbound === 'live' && !feishu?.ok) add('FEISHU_LIVE_NOT_READY', oneLiveChannel ? 'warn' : 'error', '真实飞书配置未就绪。'); else add('FEISHU_READY', 'ok', outbound === 'mock' ? '飞书模拟模式可用。' : '飞书配置有效。');
  if (outbound === 'live' && !oneLiveChannel) add('NO_LIVE_CHANNEL', 'error', '至少需要配置一个真实通知渠道。');
  if (result.public.scheduler_enabled && outbound !== 'live') add('SCHEDULER_REQUIRES_LIVE', 'error', '自动提醒需要真实通知模式。');
  if (result.public.llm_mode === 'live' && !modelReady && ['LLM_API_KEY', 'GLM_API_KEY', 'LLM_MODEL', 'GLM_MODEL', 'LLM_BASE_URL', 'GLM_BASE_URL'].some(key => values[key]?.trim())) add('MODEL_CONFIG_INVALID', 'error', '真实模型配置存在格式问题，请检查模型地址、名称和密钥。');
  if (outbound === 'live') {
    if (!email?.ok && channelHasInput(values, 'email')) add('EMAIL_CONFIG_INVALID', 'error', '邮件配置存在格式问题，请检查 SMTP 参数和地址。');
    if (!feishu?.ok && channelHasInput(values, 'feishu')) add('FEISHU_CONFIG_INVALID', 'error', '飞书配置存在格式问题，请检查机器人地址和关键词。');
  }

  if (options.portInUse) add('PORT_IN_USE', 'warn', `端口 ${port} 已被当前服务占用；如果是检查运行中的服务，可忽略。`);
  else if (options.portState === 'in_use') add('PORT_IN_USE', 'warn', `端口 ${port} 已被占用；若不是当前服务，请更改 PORT。`);
  else if (options.portState === 'available') add('PORT_AVAILABLE', 'ok', `端口 ${port} 可用。`);
  else if (options.checkPort !== false) add('PORT_NOT_CHECKED', 'warn', '端口占用状态未检查。');

  if (options.checkPaths !== false) {
    const paths = [
      ['DATABASE_DIR_WRITABLE', dirname(pathFor(values, 'DATABASE_FILE', 'var/app.sqlite'))],
      ['STORAGE_DIR_WRITABLE', pathFor(values, 'STORAGE_DIR', 'storage')],
      ['BACKUP_DIR_WRITABLE', pathFor(values, 'BACKUP_DIR', 'backups')],
    ] as const;
    for (const [code, path] of paths) {
      try { if (!statSync(path).isDirectory()) throw new Error('not_directory'); accessSync(path, constants.W_OK); add(code, 'ok', `${path} 可写。`); }
      catch { add(code, 'error', `${path} 不可写或不是目录。`); }
    }
  }
  if (options.checkSqlite !== false) checks.push(sqliteCheck());

  const hasInvalid = checks.some(check => check.state === 'error' && !['MODEL_LIVE_NOT_READY', 'EMAIL_LIVE_NOT_READY', 'FEISHU_LIVE_NOT_READY', 'NO_LIVE_CHANNEL', 'SCHEDULER_REQUIRES_LIVE'].includes(check.code));
  const hasGap = checks.some(check => check.state === 'error' && !hasInvalid);
  return {
    status: hasInvalid ? 'invalid' : hasGap ? 'needs_configuration' : 'ready', checks,
    modes: { llm: result.public.llm_mode, outbound, scheduler: Boolean(result.public.scheduler_enabled) },
    model, notifications: [
      { channel: 'email', configured: Boolean(email?.ok) },
      { channel: 'feishu', configured: Boolean(feishu?.ok) },
    ],
    public: { port, max_upload_bytes: limit, secret_presence: result.public.secrets },
  };
}

function cliArgs(argv: string[]) {
  const configFileArgument = argv.find(argument => argument.startsWith('--config-file='));
  const legacyEnvFileArgument = argv.find(argument => argument.startsWith('--env-file='));
  return {
    envFile: configFileArgument?.slice('--config-file='.length) ?? legacyEnvFileArgument?.slice('--env-file='.length) ?? '.env',
    json: argv.includes('--json'), skipPort: argv.includes('--skip-port'), running: argv.includes('--running'),
  };
}

async function main() {
  const args = cliArgs(process.argv.slice(2));
  const values = existsSync(args.envFile) ? parseEnv(readFileSync(args.envFile, 'utf8')) : {};
  const port = Number(values.PORT || 8765);
  const portState = args.skipPort ? 'unknown' : await probePort(port);
  const result = inspectConfiguration(values, { portState, portInUse: args.running && portState === 'in_use', checkPort: !args.skipPort });
  const output = { ...result, status: result.status === 'ready' ? 'passed' : 'failed', env_file: resolve(args.envFile) };
  if (args.json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`配置自检：${result.status === 'ready' ? '通过' : result.status === 'needs_configuration' ? '需要补齐配置' : '存在错误'}`);
    for (const check of result.checks) console.log(`${check.state === 'ok' ? '✓' : check.state === 'warn' ? '!' : '✗'} ${check.message}`);
    console.log(`模型：${result.modes.llm}；通知：${result.modes.outbound}；自动提醒：${result.modes.scheduler ? '开启' : '关闭'}`);
  }
  if (result.status !== 'ready') process.exitCode = 1;
}

// Keep imports side-effect free for API and Vitest consumers.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { console.error(error instanceof Error ? error.message : '配置自检失败。'); process.exitCode = 1; });
