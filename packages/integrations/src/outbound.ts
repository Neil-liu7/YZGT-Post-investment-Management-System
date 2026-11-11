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
export type OutboundResult = { status: 'mock_completed' | 'succeeded' | 'failed' | 'unknown'; retryable?: boolean; error?: string; external_id?: string };
export type OutboundMessage = { channel: string; mode: string; content: { subject: string; body: string; [key: string]: any }; recipient_key: string; recipients?: string[] };
function configured(config: Record<string, any>, key: string): any { return config[key.toLowerCase()] ?? config[key] ?? process.env[key]; }
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export async function sendOutbound(message: OutboundMessage, config: Record<string, any> = {}): Promise<OutboundResult> {
  if (message.mode !== 'live') return { status: 'mock_completed', external_id: `mock:${createHash('sha256').update(JSON.stringify(message.content)).digest('hex').slice(0, 12)}` };
  if (process.env.NODE_ENV === 'test' && !(message.channel === 'feishu' && config.fetcher)) return { status: 'failed', retryable: false, error: '自动测试禁止连接真实通知渠道。' };
  if (configured(config, 'OUTBOUND_MODE') !== 'live') return { status: 'failed', retryable: false, error: '真实发送未启用，请核查服务端配置。' };
  if (/[\r\n]/.test(message.content.subject)) return { status: 'failed', retryable: false, error: '消息主题不能包含换行。' };
  try {
    if (message.channel === 'feishu') {
      const webhook = configured(config, 'FEISHU_WEBHOOK_URL');
      if (!webhook || !/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+$/.test(webhook)) return { status: 'failed', retryable: false, error: '飞书机器人地址未配置或无效。' };
      const keyword = configured(config, 'FEISHU_KEYWORD') || '投后提醒';
      const response = await (config.fetcher ?? fetch)(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000), body: JSON.stringify({ msg_type: 'interactive', card: { header: { title: { tag: 'plain_text', content: `${keyword} · ${message.content.subject}` } }, elements: [{ tag: 'div', text: { tag: 'plain_text', content: message.content.body } }] } }) });
      if (!response.ok) return { status: 'failed', retryable: response.status === 429 || response.status >= 500, error: `飞书明确拒绝请求（HTTP ${response.status}）。` };
      const data: any = await response.json();
      return Number(data.code ?? data.StatusCode ?? -1) === 0 ? { status: 'succeeded' } : { status: 'failed', retryable: false, error: '飞书明确返回发送失败，请检查机器人关键字、签名或权限配置。' };
    }
    if (message.channel !== 'email') return { status: 'failed', retryable: false, error: '不支持的通知渠道。' };
    const host = configured(config, 'SMTP_HOST'), from = configured(config, 'SMTP_FROM');
    const recipients = normalizeRecipients(message.recipients ?? configured(config, 'MAIL_TO') ?? '');
    if (!host || !from || !recipients.length) return { status: 'failed', retryable: false, error: 'SMTP 或邮件接收目标未配置。' };
    const nodemailer = (await import('nodemailer')).default;
    const user = configured(config, 'SMTP_USER'), pass = configured(config, 'SMTP_PASS');
    const transport = nodemailer.createTransport({ host, port: Number(configured(config, 'SMTP_PORT') || 465), secure: String(configured(config, 'SMTP_SECURE') ?? 'true') === 'true', auth: user ? { user, pass } : undefined, tls: { rejectUnauthorized: true }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
    try {
      const result = await transport.sendMail({ from, to: recipients, subject: message.content.subject, text: message.content.body, html: `<div style="white-space:pre-wrap">${escapeHtml(message.content.body)}</div>`, disableFileAccess: true, disableUrlAccess: true });
      if (!result.accepted?.length) return { status: 'failed', retryable: true, error: 'SMTP 未接受收件目标。' };
      if (result.rejected?.length) return { status: 'unknown', error: '部分收件目标已接受，其余目标被拒绝；请人工核查，不能整批自动重发。' };
      return { status: 'succeeded', external_id: result.messageId };
    } finally { transport.close(); }
  } catch (error: any) {
    if (['TimeoutError', 'AbortError', 'SyntaxError', 'TypeError'].includes(error?.name) || ['ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'ECONNABORTED', 'EPIPE'].includes(error?.code)) return { status: 'unknown', error: '发送结果未知（超时或连接中断），请核查后人工处理。' };
    if (['EAUTH', 'EENVELOPE', 'EMESSAGE'].includes(error?.code)) return { status: 'failed', retryable: false, error: '发送配置或收件地址被拒绝，请修正配置。' };
    return { status: 'failed', retryable: true, error: '发送连接失败，可按退避计划重试。' };
  }
}
