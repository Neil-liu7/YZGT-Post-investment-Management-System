import { createHash } from 'node:crypto';
import { IntegrationError } from './documents.ts';
export function normalizeRecipients(input: string | string[] = []): string[] {
  const values = Array.isArray(input) ? input : input.split(/[,;；，]/);
  const result: string[] = []; const seen = new Set<string>();
  for (const value of values) {
    const email = value.trim(); if (!email) continue;
    if (/[\r\n]/.test(value) || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) throw new IntegrationError('INVALID_RECIPIENT', '收件地址无效，请填写用逗号分隔的邮箱地址。');
    const key = email.toLowerCase(); if (!seen.has(key)) { seen.add(key); result.push(email); }
  }
  return result;
}
export function recipientKey(recipients: string[]): string { return createHash('sha256').update(recipients.map(r => r.toLowerCase()).sort().join(',')).digest('hex'); }
export function feishuRecipientKey(webhook: string): string { return `feishu:${createHash('sha256').update(JSON.stringify(webhook)).digest('hex')}`; }
export type OutboundResult = { status: 'mock_completed' | 'succeeded' | 'failed' | 'unknown'; retryable?: boolean; error?: string; error_code?: string; external_id?: string };
export type OutboundMessage = { channel: string; mode: string; content: { subject: string; body: string; [key: string]: any }; recipient_key: string; recipients?: string[] };
function configured(config: Record<string, any>, key: string): any { return config[key.toLowerCase()] ?? config[key] ?? process.env[key]; }
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function smtpTransportOptions(config: Record<string, any> = {}) {
  const host = configured(config, 'SMTP_HOST');
  const portValue = configured(config, 'SMTP_PORT');
  const port = portValue === undefined || portValue === '' ? 465 : Number(portValue);
  const secureValue = configured(config, 'SMTP_SECURE');
  if (typeof host !== 'string' || !host.trim() || /\s/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new IntegrationError('SMTP_CONFIG_INVALID', 'SMTP 主机或端口配置无效。', 503);
  if (![undefined, '', true, false, 'true', 'false'].includes(secureValue)) throw new IntegrationError('SMTP_CONFIG_INVALID', 'SMTP TLS 配置必须为 true 或 false。', 503);
  const secure = secureValue === undefined || secureValue === '' || secureValue === true || secureValue === 'true';
  const user = configured(config, 'SMTP_USER'), pass = configured(config, 'SMTP_PASS');
  if (user && !pass) throw new IntegrationError('SMTP_CONFIG_INVALID', 'SMTP 认证密码尚未配置。', 503);
  return { host, port, secure, requireTLS: !secure, auth: user ? { user, pass } : undefined, tls: { rejectUnauthorized: true }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 };
}
export function classifySmtpError(error: any): OutboundResult {
  if (['SMTP_CONFIG_INVALID', 'ETLS', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error?.code)) return { status: 'failed', retryable: false, error_code: 'SMTP_CONFIGURATION_REJECTED', error: 'SMTP 配置、TLS 证书或收件地址被拒绝，请修正配置。' };
  if (['EAUTH', 'EENVELOPE', 'EMESSAGE'].includes(error?.code)) {
    const reply = Number(error.responseCode), temporary = Number.isInteger(reply) && reply >= 400 && reply < 500;
    return temporary
      ? { status: 'failed', retryable: true, error_code: 'SMTP_TEMPORARY_REJECTION', error: 'SMTP 明确暂时拒绝请求，将按退避计划重试。' }
      : { status: 'failed', retryable: false, error_code: 'SMTP_CONFIGURATION_REJECTED', error: 'SMTP 配置、TLS 证书或收件地址被拒绝，请修正配置。' };
  }
  // Nodemailer uses ECONNECTION/CONN both before and after DATA; it does not expose a reliable delivery phase.
  if (error?.code === 'ECONNECTION' && ['EHLO', 'HELO', 'STARTTLS'].includes(error?.command)) return { status: 'failed', retryable: Number(error.responseCode) >= 400 && Number(error.responseCode) < 500, error_code: 'SMTP_NEGOTIATION_FAILED', error: 'SMTP 连接协商失败，请核查 TLS 和服务端配置。' };
  if (['EDNS', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error?.code) || (error?.code === 'ESOCKET' && error?.syscall === 'connect')) return { status: 'failed', retryable: true, error_code: 'SMTP_CONNECTION_FAILED', error: 'SMTP 尚未建立连接，可按退避计划重试。' };
  return { status: 'unknown', error_code: 'DELIVERY_UNKNOWN', error: 'SMTP 发送结果未知（超时或连接中断），请核查后人工处理。' };
}
export async function sendOutbound(message: OutboundMessage, config: Record<string, any> = {}): Promise<OutboundResult> {
  if (message.mode !== 'live') return { status: 'mock_completed', external_id: `mock:${createHash('sha256').update(JSON.stringify(message.content)).digest('hex').slice(0, 12)}` };
  if (process.env.NODE_ENV === 'test' && !(message.channel === 'feishu' && typeof config.fetcher === 'function')) return { status: 'failed', retryable: false, error: '自动测试禁止连接真实通知渠道。' };
  if (configured(config, 'OUTBOUND_MODE') !== 'live') return { status: 'failed', retryable: false, error: '真实发送未启用，请核查服务端配置。' };
  if (/[\r\n]/.test(message.content.subject)) return { status: 'failed', retryable: false, error: '消息主题不能包含换行。' };
  try {
    if (message.channel === 'feishu') {
      const webhook = configured(config, 'FEISHU_WEBHOOK_URL');
      if (!webhook || !/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+$/.test(webhook)) return { status: 'failed', retryable: false, error: '飞书机器人地址未配置或无效。' };
      if (message.recipient_key !== feishuRecipientKey(webhook)) return { status: 'failed', retryable: false, error_code: 'RECIPIENT_CHANGED', error: '飞书接收目标已变化，请重新预览后发送。' };
      const keyword = configured(config, 'FEISHU_KEYWORD') || '投后提醒';
      const response = await (config.fetcher ?? fetch)(webhook, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000), body: JSON.stringify({ msg_type: 'interactive', card: { header: { title: { tag: 'plain_text', content: `${keyword} · ${message.content.subject}` } }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: message.content.body } }] } }) });
      if (!response.ok) return { status: 'failed', retryable: response.status === 429 || response.status >= 500, error: `飞书明确拒绝请求（HTTP ${response.status}）。` };
      const data: any = await response.json();
      return Number(data.code ?? data.StatusCode ?? -1) === 0 ? { status: 'succeeded' } : { status: 'failed', retryable: false, error: '飞书明确返回发送失败，请检查机器人关键字、签名或权限配置。' };
    }
    if (message.channel !== 'email') return { status: 'failed', retryable: false, error: '不支持的通知渠道。' };
    const host = configured(config, 'SMTP_HOST'), from = configured(config, 'SMTP_FROM');
    const recipients = normalizeRecipients(message.recipients ?? configured(config, 'MAIL_TO') ?? '');
    if (!host || !from || !recipients.length) return { status: 'failed', retryable: false, error: 'SMTP 或邮件接收目标未配置。' };
    const nodemailer = (await import('nodemailer')).default;
    const transport = nodemailer.createTransport(smtpTransportOptions(config));
    try {
      const result = await transport.sendMail({ from, to: recipients, subject: message.content.subject, text: message.content.body, html: `<div style="white-space:pre-wrap">${escapeHtml(message.content.body)}</div>`, disableFileAccess: true, disableUrlAccess: true });
      if (!result.accepted?.length) return { status: 'failed', retryable: true, error: 'SMTP 未接受收件目标。' };
      if (result.rejected?.length) return { status: 'unknown', error: '部分收件目标已接受，其余目标被拒绝；请人工核查，不能整批自动重发。' };
      return { status: 'succeeded', external_id: result.messageId };
    } finally { transport.close(); }
  } catch (error: any) {
    if (message.channel === 'email') return classifySmtpError(error);
    if (['TimeoutError', 'AbortError', 'SyntaxError', 'TypeError'].includes(error?.name) || ['ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'ECONNABORTED', 'EPIPE'].includes(error?.code)) return { status: 'unknown', error: '发送结果未知（超时或连接中断），请核查后人工处理。' };
    if (['EAUTH', 'EENVELOPE', 'EMESSAGE'].includes(error?.code)) return { status: 'failed', retryable: false, error: '发送配置或收件地址被拒绝，请修正配置。' };
    return { status: 'failed', retryable: true, error: '发送连接失败，可按退避计划重试。' };
  }
}
