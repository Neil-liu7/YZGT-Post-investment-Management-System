import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import * as outbound from '../../packages/integrations/src/outbound.ts';

const hookA = 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-a';
const hookB = 'https://open.feishu.cn/open-apis/bot/v2/hook/synthetic-b';
const key = (hook: string) => 'feishu:' + createHash('sha256').update(JSON.stringify(hook)).digest('hex');
const card = { channel: 'feishu', mode: 'live', recipient_key: key(hookA), content: { subject: '合成测试', body: '仅用于内存测试' } };
const smtp = { SMTP_HOST: 'smtp.example.invalid', SMTP_PORT: 587, SMTP_SECURE: false, SMTP_USER: 'synthetic-user', SMTP_PASS: 'synthetic-not-a-password' };
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real network forbidden by test trap')); });
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('outbound transport safety', () => {
  it('rejects a changed Feishu target before invoking even an injected transport', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ code: 0 }) }));
    const result = await outbound.sendOutbound(card, { OUTBOUND_MODE: 'live', FEISHU_WEBHOOK_URL: hookB, fetcher });
    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(result.error).toContain('接收目标'); expect(result.error).not.toContain(hookB);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses truthy non-function test overrides instead of bypassing the test guard', async () => {
    const result = await outbound.sendOutbound(card, { OUTBOUND_MODE: 'live', FEISHU_WEBHOOK_URL: hookA, fetcher: true });
    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect(result.error).toContain('自动测试');
  });

  it('rejects redirects and retains an abort signal in the Feishu request', async () => {
    const fetcher = vi.fn(async (_url: string, options: any) => {
      expect(options.redirect).toBe('error');
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, json: async () => ({ code: 0 }) };
    });
    const result = await outbound.sendOutbound(card, { OUTBOUND_MODE: 'live', FEISHU_WEBHOOK_URL: hookA, fetcher });
    expect(result.status).toBe('succeeded'); expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    new DOMException('synthetic secret timeout', 'TimeoutError'),
    Object.assign(new Error('synthetic secret reset'), { code: 'ECONNRESET' }),
    new SyntaxError('synthetic secret response'),
  ])('keeps uncertain Feishu delivery unknown and redacts transport details', async error => {
    const result = await outbound.sendOutbound(card, { OUTBOUND_MODE: 'live', FEISHU_WEBHOOK_URL: hookA, fetcher: async () => ({ ok: true, json: async () => { throw error; } }) });
    expect(result.status).toBe('unknown'); expect(result.error).not.toContain('synthetic secret');
  });

  it('requires STARTTLS when SMTP implicit TLS is disabled, preserving certificate checks', () => {
    const options = (outbound as any).smtpTransportOptions(smtp);
    expect(options).toMatchObject({ secure: false, requireTLS: true, tls: { rejectUnauthorized: true }, port: 587 });
    expect((outbound as any).smtpTransportOptions({ ...smtp, SMTP_PORT: 465, SMTP_SECURE: true })).toMatchObject({ secure: true, tls: { rejectUnauthorized: true } });
  });

  it.each([{ SMTP_PORT: 'not-a-port' }, { SMTP_PORT: 0 }, { SMTP_PORT: 65536 }, { SMTP_SECURE: 'invalid' }, { SMTP_PASS: '' }])('rejects permanent SMTP configuration errors without opening a connection: %j', changes => {
    expect(() => outbound.smtpTransportOptions({ ...smtp, ...changes })).toThrow(/SMTP/);
  });

  it('classifies Nodemailer connection loss after DATA conservatively without retrying or exposing details', () => {
    const error = Object.assign(new Error('Connection closed unexpectedly synthetic secret'), { code: 'ECONNECTION', command: 'CONN' });
    const result = (outbound as any).classifySmtpError(error);
    expect(result.status).toBe('unknown'); expect(result.retryable).not.toBe(true); expect(result.error).not.toContain('synthetic secret');
  });

  it('distinguishes failed DNS lookup and TLS configuration rejection from unknown delivery', () => {
    expect((outbound as any).classifySmtpError({ code: 'EDNS' })).toMatchObject({ status: 'failed', retryable: true });
    expect((outbound as any).classifySmtpError({ code: 'ETLS' })).toMatchObject({ status: 'failed', retryable: false });
  });

  it('never opens SMTP during automated tests even when a Feishu test override is supplied', async () => {
    const factory = vi.spyOn(nodemailer, 'createTransport').mockImplementation(() => { throw new Error('SMTP connection forbidden'); });
    const result = await outbound.sendOutbound({ channel: 'email', mode: 'live', recipient_key: 'synthetic', recipients: ['test@example.invalid'], content: { subject: '合成', body: '合成' } }, { ...smtp, SMTP_FROM: 'sender@example.invalid', OUTBOUND_MODE: 'live', fetcher: async () => ({}) });
    expect(result).toMatchObject({ status: 'failed', retryable: false }); expect(factory).not.toHaveBeenCalled();
  });
});
