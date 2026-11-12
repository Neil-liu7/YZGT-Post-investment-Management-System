import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { candidateSchema, resolveModelConfig, getModelStatus } from '../packages/integrations/src/index.ts';
import { deadlineRuleSchema, jointCandidateSchema, eventCandidateSchema } from '../packages/contracts/src/index.ts';
import { createVerificationFinalizer, redactSecrets, verificationReportStatus, type VerificationFinalState } from './verification-support';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
process.chdir(projectRoot);
loadEnv({ path: join(projectRoot, '.env') });
const args = process.argv.slice(2);
const live = args.includes('--live');
const fixturePath = 'tests/fixtures/agreement.txt';
const approvedFixtureSha256 = '4c6ad986e42644093ad2a2d0321d620680a520b3810c5f603bc816675e2951a1';
const reportPath = live ? 'docs/真实AI联调.json' : 'docs/模型配置检查.json';
const started = new Date();
const settings = { ...process.env, ...(live ? { LLM_MODE: 'live', ALLOW_EXTERNAL_MODEL: 'true' } : {}) };
const modelConfig = resolveModelConfig(settings);
const modelStatus = getModelStatus(settings);
const report: Record<string, any> = {
  status: 'not_run', recorded_at: started.toISOString(), scope: 'synthetic_only',
  provider: modelStatus.provider, model: modelStatus.model, host: modelStatus.host,
  fixture: { path: fixturePath, sha256: approvedFixtureSha256 }, candidate_count: 0,
  configured: modelConfig.configured, requested_live: live, usage: {}, response_metadata: [],
  checks: {}, coverage: {}, model_rule_types: {}, unresolved_count: 0, manual_rules_applied: [],
  completed_steps: [], notifications: 'mock', user_database_used: false,
};
let child: ChildProcess | undefined;
let temporary: string | undefined;
const sleep = (milliseconds: number) => new Promise(done => setTimeout(done, milliseconds));
class VerificationError extends Error { constructor(public code: string, text: string) { super(text); } }
function verify(value: unknown, code: string, text: string): asserts value { if (!value) throw new VerificationError(code, text); }
function safeCode(value: unknown, fallback: string) { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : fallback; }
function safeUsage(value: any) {
  const usage: Record<string, number> = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'reasoning_tokens']) {
    if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) usage[key] = value[key];
  }
  if (Number.isSafeInteger(value?.completion_tokens_details?.reasoning_tokens)) usage.reasoning_tokens = value.completion_tokens_details.reasoning_tokens;
  return usage;
}
function metadata(run: any) {
  report.provider = run.provider ?? modelConfig.provider;
  report.model = run.model ?? modelConfig.model;
  report.prompt_version = safeCode(run.prompt_version, 'unavailable');
  report.usage = safeUsage(run.usage);
  report.response_metadata = (Array.isArray(run.response_metadata) ? run.response_metadata : []).map((item: any) => ({
    ...(Number.isSafeInteger(item.chunk_index) ? { chunk_index: item.chunk_index } : {}),
    ...(item.request_id ? { request_id: safeCode(item.request_id, 'unavailable') } : {}),
    ...(item.response_id ? { response_id: safeCode(item.response_id, 'unavailable') } : {}),
    ...(item.model ? { model: safeCode(item.model, 'unavailable') } : {}), usage: safeUsage(item.usage),
  }));
}
function saveReport(state: VerificationFinalState) {
  report.recorded_at = new Date().toISOString();
  report.elapsed_ms = Date.now() - started.getTime();
  report.status = verificationReportStatus(report.status, state);
  const text = JSON.stringify(redactSecrets(report, [modelConfig.apiKey]), null, 2);
  writeFileSync(reportPath, text + '\n');
  console.log(text);
}
async function api(base: string, path: string, method = 'GET', body?: any, key?: string) {
  verify(!finalizer.cancelled, 'VERIFICATION_CANCELLED', '本次模型验证已取消。');
  const multipart = body instanceof FormData;
  let response: Response;
  try { response = await fetch(base + '/api/v1' + path, { method, headers: { ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body ? multipart ? body : JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); }
  catch { throw new VerificationError('LOCAL_API_UNREACHABLE', '隔离本机服务请求失败或超时。'); }
  let result: any;
  try { result = await response.json(); } catch { throw new VerificationError('LOCAL_API_INVALID_RESPONSE', '隔离本机服务未返回有效响应。'); }
  if (!response.ok) throw new VerificationError(safeCode(result.error?.code, 'LOCAL_API_FAILED'), `隔离本机业务接口返回 HTTP ${response.status}，详情按稳定错误码核对。`);
  return result.data;
}
async function start() {
  const port = await new Promise<number>((done, reject) => {
    const probe = createServer(); probe.once('error', () => reject(new VerificationError('LOCAL_PORT_UNAVAILABLE', '无法分配本机隔离验证端口。')));
    probe.listen(0, '127.0.0.1', () => { const address = probe.address(); if (!address || typeof address === 'string') { probe.close(); reject(new VerificationError('LOCAL_PORT_UNAVAILABLE', '无法分配本机隔离验证端口。')); return; } probe.close(() => done(address.port)); });
  });
  verify(!finalizer.cancelled, 'VERIFICATION_CANCELLED', '本次模型验证已取消。');
  temporary = mkdtempSync(join(tmpdir(), 'yzgt-live-synthetic-'));
  const bypass = [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
  const env = { ...process.env, NODE_ENV: 'production', LLM_MODE: 'live', ALLOW_EXTERNAL_MODEL: 'true', OUTBOUND_MODE: 'mock', SCHEDULER_ENABLED: 'false',
    PORT: String(port), DATABASE_FILE: join(temporary, 'app.sqlite'), STORAGE_DIR: join(temporary, 'storage'), BACKUP_DIR: join(temporary, 'backups'),
    SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', FEISHU_WEBHOOK_URL: '', MAIL_TO: '', NO_PROXY: bypass, no_proxy: bypass };
  child = spawn(process.execPath, ['scripts/start.mjs'], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  let spawnFailed = false; child.once('error', () => { spawnFailed = true; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt++) {
    verify(!finalizer.cancelled, 'VERIFICATION_CANCELLED', '本次模型验证已取消。');
    verify(!spawnFailed && child.exitCode === null, 'LOCAL_START_FAILED', '隔离生产服务未能启动，请先检查构建和本机 Node 环境。');
    try {
      const response = await fetch(base + '/health', { signal: AbortSignal.timeout(500) });
      if (response.ok) {
        const health = (await response.json()).data;
        verify(health.llm_mode === 'live' && health.outbound_mode === 'mock', 'ISOLATION_FAILED', '隔离服务的模型或通知模式不符合验证约定。');
        return base;
      }
    } catch (error) { if (error instanceof VerificationError) throw error; }
    await sleep(100);
  }
  throw new VerificationError('LOCAL_START_TIMEOUT', '隔离生产服务启动超时，请检查本机运行环境。');
}
async function stop() {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const target = child;
    await new Promise<void>((done, reject) => { const timer = setTimeout(() => { target.kill('SIGKILL'); reject(new VerificationError('CLEANUP_TIMEOUT', '隔离验证进程未能按时停止。')); }, 5000); target.once('close', () => { clearTimeout(timer); done(); }); target.kill('SIGTERM'); });
  }
  if (temporary && resolve(temporary).startsWith(resolve(tmpdir()) + sep)) rmSync(temporary, { recursive: true, force: true });
}

function coverageOf(candidates: any[], clauses: { text: string }[]) {
  const fields = (candidate: any) => [`${candidate.action ?? ''} ${candidate.deliverable ?? ''}`, candidate.title ?? '', candidate.description ?? ''];
  const from = (index: number, action: RegExp, opposite?: RegExp) => candidates.find(candidate => candidate.clause_index === index && fields(candidate).some(text => action.test(text) && (!opposite || !opposite.test(text))));
  const found = { fixed: from(0, /实缴/), months: from(1, /(提交|交付|提供).*登记|登记.*材料/), workdays: from(2, /(提供|交付|提交).*凭证/), application: from(3, /(提交|递交).*申请/, /(提供|交付).*文件/), files: from(3, /(提供|交付).*文件/, /(提交|递交).*申请/), quarter: from(4, /报送.*(财务|报表)/) };
  // A null rule remains a human-review case; it is never counted as model-generated structured time.
  const offsetsMatch = (rule: any, amount: number, unit: string) => rule?.offsets?.length === 1 && rule.offsets[0].amount === amount && rule.offsets[0].unit === unit;
  const structured = (candidate: any, kind: string, amount?: number, unit?: string): boolean | null => {
    if (!candidate?.rule) return null;
    if (candidate.rule.kind !== kind) return false;
    if (kind === 'fixed') return candidate.rule.date === '2029-12-31';
    if (kind === 'recurring' && candidate.rule.frequency !== 'quarter') return false;
    return offsetsMatch(candidate.rule, amount!, unit!);
  };
  const check = (candidate: any, temporal: RegExp, kind: string, amount?: number, unit?: string) => {
    const original = candidate?.rule?.original_expression;
    const supported = Boolean(candidate && (temporal.test(candidate.source_text) || (original && clauses[candidate.clause_index]?.text.includes(original) && temporal.test(original))));
    const matches = structured(candidate, kind, amount, unit);
    return { passed: Boolean(candidate) && supported && matches !== false, candidate_present: Boolean(candidate), source_temporal_supported: supported, model_rule_type: candidate?.rule?.kind ?? null, model_structured_time_matches: matches, requires_manual_rule: matches === null };
  };
  const application = check(found.application, /签署后10日/, 'relative', 10, 'calendar_day');
  const files = check(found.files, /交割后20日/, 'relative', 20, 'calendar_day');
  const distinct = Boolean(found.application && found.files && found.application.id !== found.files.id);
  report.coverage = {
    fixed_date: check(found.fixed, /2029年12月31日/, 'fixed'),
    signing_three_months: check(found.months, /签署后3个月/, 'relative', 3, 'calendar_month'),
    receipt_five_workdays: check(found.workdays, /收到款项后5个工作日/, 'relative', 5, 'business_day'),
    same_clause_two_actions: { passed: distinct && application.passed && files.passed, distinct_candidates: distinct, submit_application: application, provide_files: files },
    quarterly_reporting: check(found.quarter, /每季度结束后30日内/, 'recurring', 30, 'calendar_day'),
  };
  report.model_rule_types = candidates.reduce((counts, candidate) => { const kind = candidate.rule?.kind ?? 'null'; counts[kind] = (counts[kind] ?? 0) + 1; return counts; }, {} as Record<string, number>);
  report.unresolved_count = candidates.reduce((count, candidate) => count + (Array.isArray(candidate.unresolved_items) ? candidate.unresolved_items.length : 0), 0);
  report.coverage_interpretation = '核验动作拆分、真实原文期限依据和已输出结构化期限的一致性；null规则保留人工补齐，不作为模型正确生成期限。';
  return { found, passed: Object.values(report.coverage).every((check: any) => check.passed) };
}

async function verifyLive(source: string) {
  verify(process.env.NODE_ENV !== 'test', 'TEST_OUTBOUND_BLOCKED', '测试环境禁止进行真实模型验证。');
  verify(modelConfig.ready, 'MODEL_CONFIG_INVALID', '模型配置不完整或无效，请根据配置检查结果补齐。');
  verify(existsSync('dist/server.mjs'), 'BUILD_REQUIRED', '请先运行 npm run build，真实联调使用隔离生产构建。');
  const base = await start();
  report.completed_steps.push('isolated_production_service');
  const project = await api(base, '/projects', 'POST', { name: '真实模型合成验证项目', company: '合成测试公司', notes: '仅项目自带合成协议，真实渠道保持关闭' }, 'live-fixture-project');
  const upload = new FormData(); upload.append('file', new Blob([source], { type: 'text/plain' }), 'agreement.txt');
  const document = await api(base, `/projects/${project.id}/documents`, 'POST', upload, 'live-fixture-upload');
  verify(document.state === 'parsed', 'FIXTURE_PARSE_FAILED', '固定合成协议未成功解析。');
  const parsedDocument = await api(base, `/documents/${document.id}`);
  verify(parsedDocument.clauses.length === 5, 'FIXTURE_PARSE_CHANGED', '固定合成协议的原文分段与预期不符。');
  console.log('仅提交项目自带合成协议，正在等待真实模型提取。');
  let run = await api(base, `/documents/${document.id}/extractions`, 'POST', {}, 'live-fixture-extraction');
  const began = Date.now(), budget = Math.max(60000, modelConfig.timeoutMs * 3 + 60000);
  let announced = 0;
  while (['queued', 'running'].includes(run.state)) {
    verify(Date.now() - began < budget, 'MODEL_POLL_TIMEOUT', '真实模型提取超过配置超时和重试预算。');
    await sleep(1000); run = await api(base, `/extractions/${run.id}`);
    const elapsed = Math.floor((Date.now() - began) / 1000);
    if (elapsed >= announced + 10) { console.log(`真实模型提取已等待 ${elapsed} 秒，当前状态：${safeCode(run.state, 'unknown')}。`); announced = elapsed; }
  }
  metadata(run); report.extraction_state = run.state;
  verify(run.mode === 'live' && run.state === 'succeeded', safeCode(run.error_code, run.state === 'partial' ? 'MODEL_PARTIAL' : 'MODEL_FAILED'), '真实模型提取未完整成功，请按批次错误码及响应标识核查。');
  verify(run.provider === modelConfig.provider && run.model === modelConfig.model && report.response_metadata.length > 0 && report.usage.total_tokens > 0, 'LIVE_PROVENANCE_MISSING', '批次缺少真实模型来源或用量证据，不能将模拟结果记为真实联调成功。');
  const candidates: any[] = run.candidates ?? [];
  report.candidate_count = candidates.length;
  report.candidate_summary = candidates.map(candidate => ({ source_clause: candidate.clause_index + 1, title: String(candidate.title ?? '').slice(0, 100), action: String(candidate.action ?? '').slice(0, 120), deliverable: String(candidate.deliverable ?? '').slice(0, 100), model_rule_type: candidate.rule?.kind ?? null, unresolved_count: candidate.unresolved_items?.length ?? 0 }));
  const sourceValid = candidates.length > 0 && candidates.every(candidate => {
    const parsed = (run.joint_extraction ? jointCandidateSchema.strip() : candidateSchema).safeParse(candidate);
    const clause = parsedDocument.clauses[candidate.clause_index];
    return parsed.success && clause && clause.text.includes(candidate.source_text) && JSON.stringify(candidate.locator) === JSON.stringify(clause.locator);
  });
  const reviewRequired = candidates.every(candidate => candidate.review_state === 'draft' && !candidate.obligation_id && (!candidate.rule || candidate.rule.confirmation_status === 'needs_review'));
  const eventCandidates: any[] = run.event_candidates ?? [];
  const eventSourcesValid = (!run.joint_extraction || ['signing', 'investment', 'closing'].every(type => eventCandidates.some(event => event.event_type === type))) && eventCandidates.every(event => {
    const parsed = eventCandidateSchema.strip().safeParse({ ...event, key: event.candidate_key ?? event.key });
    const clause = parsedDocument.clauses[event.clause_index];
    return parsed.success && clause?.text.includes(event.source_text) && JSON.stringify(event.locator) === JSON.stringify(clause.locator) && event.occurred_on === null && event.review_state === 'draft' && !event.event_id;
  });
  const emptyBeforeReview = (await api(base, `/projects/${project.id}/obligations`)).total === 0 && (await api(base, `/projects/${project.id}/tasks`)).total === 0 && (await api(base, `/projects/${project.id}/events`)).total === 0;
  report.joint_extraction = Boolean(run.joint_extraction); report.event_candidate_count = eventCandidates.length;
  report.checks = { source_and_schema: sourceValid, event_source_and_unknown_dates: eventSourcesValid, human_review_required: reviewRequired, no_automatic_obligations: emptyBeforeReview };
  verify(sourceValid && eventSourcesValid && reviewRequired && emptyBeforeReview, 'CANDIDATE_CONTRACT_FAILED', '候选原文、结构或人工确认边界不符合预期。');
  report.completed_steps.push('live_candidates_validated_before_review');
  const { found, passed } = coverageOf(candidates, parsedDocument.clauses);
  report.coverage_status = passed ? 'passed' : 'coverage_failed';
  verify(passed, 'COVERAGE_FAILED', '真实候选未覆盖全部合成业务场景，请调整提取后再验证。');

  const event = async (name: string, date: string) => api(base, `/projects/${project.id}/events`, 'POST', { name, occurred_on: date, event_type: 'synthetic' });
  const signing = await event('合成签署', '2026-08-07'), receipt = await event('合成收款', '2026-11-06'), closing = await event('合成交割', '2026-11-01');
  const calendar = await api(base, '/calendars/import-preview', 'POST', { name: '合成周末日历', region: 'SYNTHETIC', start_on: '2026-01-01', end_on: '2027-12-31', source: '仅排除周末的已确认合成测试日历，不作为真实节假日日历', overrides: {} });
  await api(base, `/calendars/${calendar.id}/confirm`, 'POST', { version: calendar.version });
  const convention = { end_day_adjustment: 'none', month_end: 'clamp', calendar_id: null, calendar_version: null };
  const relative = (eventId: string, amount: number, unit: string, work = false) => ({ kind: 'relative', anchor: { type: 'event', event_id: eventId }, offsets: [{ amount, unit, include_start_day: false }], convention: work ? { ...convention, calendar_id: calendar.id, calendar_version: calendar.calendar_version } : convention });
  const fixtures = [
    { candidate: found.fixed, rule: { kind: 'fixed', date: '2029-12-31', convention }, dates: ['2029-12-31'] },
    { candidate: found.months, rule: relative(signing.id, 3, 'calendar_month'), dates: ['2026-11-07'] },
    { candidate: found.workdays, rule: relative(receipt.id, 5, 'business_day', true), dates: ['2026-11-13'] },
    { candidate: found.application, rule: relative(signing.id, 10, 'calendar_day'), dates: ['2026-08-17'] },
    { candidate: found.files, rule: relative(closing.id, 20, 'calendar_day'), dates: ['2026-11-21'] },
    { candidate: found.quarter, rule: { kind: 'recurring', frequency: 'quarter', first_period_start: '2026-07-01', last_period_end: '2026-12-31', anchor: 'period_end', offsets: [{ amount: 30, unit: 'calendar_day', include_start_day: false }], convention }, dates: ['2026-10-30', '2027-01-30'] },
  ];
  verify(new Set(fixtures.map(item => item.candidate.id)).size === 6, 'COVERAGE_OVERLAP', '合成审核场景未映射到六条独立候选。');
  report.manual_rules_applied = fixtures.map((item, index) => ({ scenario: ['fixed_date', 'signing_three_months', 'receipt_five_workdays', 'submit_application', 'provide_files', 'quarterly_reporting'][index], model_rule_type: item.candidate.rule?.kind ?? null, confirmed_rule_type: item.rule.kind, expected_due_on: item.dates }));
  report.manual_confirmation_scope = '仅按项目确定性合成样例补齐事件、日历和首期；这些日期验证证明人工审核闭环，不等于模型独立生成了正确截止日。';
  for (const item of fixtures) {
    const rule = deadlineRuleSchema.parse({ schema_version: 1, confirmation_status: 'confirmed', original_expression: item.candidate.source_text, ...item.rule });
    await api(base, `/draft-obligations/${item.candidate.id}`, 'PATCH', { version: item.candidate.version, rule, owner_label: '合成审核人' });
  }
  const confirmation = { draft_ids: fixtures.map(item => item.candidate.id) };
  const confirmed = await api(base, `/extractions/${run.id}/confirm`, 'POST', confirmation, 'live-fixture-confirm');
  verify(confirmed.created.length === 6, 'CONFIRMATION_FAILED', '经合成审核确认后，正式义务数量不符合预期。');
  const repeated = await api(base, `/extractions/${run.id}/confirm`, 'POST', confirmation);
  const obligations = await api(base, `/projects/${project.id}/obligations?page_size=100`), tasks = await api(base, `/projects/${project.id}/tasks?page_size=100`);
  verify(repeated.created.length === 0 && repeated.skipped.length === 6 && obligations.total === 6 && tasks.total === 7, 'CONFIRMATION_DUPLICATED', '重复确认产生了非预期的义务或事项数量。');
  for (const item of fixtures) {
    const obligation = obligations.items.find((entry: any) => entry.draft_id === item.candidate.id);
    const dates = tasks.items.filter((task: any) => task.obligation_id === obligation?.id).map((task: any) => task.effective_due_on).sort();
    verify(JSON.stringify(dates) === JSON.stringify([...item.dates].sort()), 'DEADLINE_MISMATCH', '合成人工确认规则的执行事项日期与确定性样例不符。');
  }
  report.checks.confirmation_idempotent = true; report.checks.fixture_deadlines = true;
  report.confirmed_obligations = obligations.total; report.execution_tasks = tasks.total;
  report.completed_steps.push('synthetic_review_and_deadlines_confirmed', 'repeated_confirmation_deduplicated');
  if (!finalizer.cancelled) report.status = 'live_passed';
}

const finalizer = createVerificationFinalizer({
  cleanup: stop,
  save: saveReport,
  onCancel: signal => {
    report.status = 'cancelled'; report.reason = 'USER_CANCELLED'; report.error_code = 'VERIFICATION_CANCELLED';
    report.error = `联调验证已取消（${signal}），隔离服务和临时数据正在清理。`;
  },
  onCleanupError: () => {
    if (!finalizer.cancelled) report.status = 'failed';
    report.cleanup = 'failed'; report.error_code = 'CLEANUP_FAILED'; report.error = '隔离验证进程或临时目录未能完整清理。'; process.exitCode = 1;
  },
});

try {
  verify(args.every(argument => argument === '--live'), 'INVALID_ARGUMENT', '仅支持 --live 参数，不能指定其他文件或数据库。');
  const source = readFileSync(fixturePath, 'utf8').replace(/\r\n?/g, '\n');
  report.fixture.sha256 = createHash('sha256').update(source).digest('hex');
  verify(report.fixture.sha256 === approvedFixtureSha256, 'FIXTURE_CHANGED', '固定合成协议内容已改变，请复核本次授权范围。');
  report.fixture.bytes = Buffer.byteLength(source);
  if (!live) {
    report.reason = modelConfig.apiKey ? 'CONFIGURATION_CHECK_ONLY' : 'API_KEY_NOT_CONFIGURED';
    report.configuration_issues = modelConfig.issues;
    console.log('仅检查本地模型配置；未使用网络。真实合成联调需显式添加 --live。');
  } else if (!modelConfig.apiKey) {
    report.reason = 'API_KEY_NOT_CONFIGURED';
    console.log('尚未配置模型 API Key，本次未发出请求。'); process.exitCode = 1;
  } else {
    const url = new URL(modelConfig.baseUrl);
    verify(modelConfig.provider === 'openai_compatible' && url.origin === 'https://api.deepseek.com' && modelConfig.endpoint === 'https://api.deepseek.com/chat/completions' && !url.username && !url.password, 'PROVIDER_SCOPE_MISMATCH', '本次合成数据外发范围限于已授权的标准 DeepSeek HTTPS 接口。');
    await verifyLive(source);
  }
} catch (error) {
  if (!finalizer.cancelled) {
    report.status = 'failed';
    report.error_code = error instanceof VerificationError ? error.code : 'LOCAL_VERIFICATION_FAILED';
    report.error = error instanceof VerificationError ? error.message : '本机联调校验发生异常，请检查运行环境和模型配置。';
    process.exitCode = 1;
  }
} finally {
  await finalizer.finish();
}
