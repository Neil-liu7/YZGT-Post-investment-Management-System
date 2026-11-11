import { createHash } from 'node:crypto';
import { z } from 'zod';
import { businessToday, daysBetween, isoWeek, reminderStage } from '../../../packages/domain/src/index.ts';
import { normalizeRecipients, recipientKey, sendOutbound, type OutboundResult } from '../../../packages/integrations/src/index.ts';
import { AppError, type Store } from './store.ts';

type Row = Record<string, any>;
type ScanOptions = { recovery?: boolean; force?: boolean; mode?: string; channels?: string[] };
type PreviewOptions = { channel?: string; project_id?: string; task_ids?: string[]; recipients?: string | string[]; mode?: string; purpose?: string };
const recipientInputSchema = z.union([z.string(), z.array(z.string()).max(1000)]);
const previewSchema = z.object({ channel: z.enum(['email', 'feishu']).optional(), project_id: z.string().min(1).optional(), task_ids: z.array(z.string().min(1)).max(10000).optional(), recipients: recipientInputSchema.optional(), mode: z.enum(['mock', 'live']).optional(), purpose: z.enum(['manual', 'test']).optional() });
const sendSchema = z.object({ snapshot_id: z.string().min(1), subject: z.string().min(1).max(500).optional(), body: z.string().max(1000000).optional(), recipients: recipientInputSchema.optional(), allow_stale: z.boolean().optional(), mode: z.enum(['mock', 'live']).optional() });
const terminal = new Set(['succeeded', 'mock_completed', 'unknown']);
const open = new Set(['pending', 'doing']);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clip = (value: unknown, size = 1000) => String(value ?? '').slice(0, size);

export class NotificationService {
  constructor(private store: Store, private config: Row = {}, private clock: () => Date = () => new Date()) {}
  private setting() { return { feishu_enabled: false, mail_enabled: false, lead_days: 30, send_empty: true, policy_revision: 1, ...this.store.get('settings', 'default') }; }
  private env(name: string) { return this.config[name.toLowerCase()] ?? this.config[name] ?? process.env[name]; }
  private mode(request?: string) {
    const configured = this.env('OUTBOUND_MODE') === 'live' ? 'live' : 'mock';
    if (request && !['mock', 'live'].includes(request)) throw new AppError('INVALID_MODE', '发送模式无效。');
    if (request === 'live' && configured !== 'live') throw new AppError('OUTBOUND_DISABLED', '服务端尚未启用真实发送。', 409);
    return request ?? configured;
  }
  private target(channel: string, mode: string, requested?: string | string[]) {
    if (!['email', 'feishu'].includes(channel)) throw new AppError('INVALID_CHANNEL', '通知渠道无效。');
    if (channel === 'feishu') {
      const webhook = this.env('FEISHU_WEBHOOK_URL');
      return { recipient_key: webhook ? `feishu:${hash(webhook)}` : 'mock:feishu', recipients: [] as string[], available: mode === 'mock' || Boolean(webhook), target_label: mode === 'mock' && !webhook ? '模拟飞书群' : '已配置飞书群' };
    }
    const recipients = normalizeRecipients(requested ?? this.env('MAIL_TO') ?? (mode === 'mock' ? 'mock@example.invalid' : ''));
    return { recipient_key: `email:${recipientKey(recipients)}`, recipients, available: recipients.length > 0, target_label: recipients.join(', ') };
  }
  private eligible(task: Row, today: string, projects?: Map<string, Row>) {
    const project = projects?.get(task.project_id) ?? this.store.get('projects', task.project_id);
    return Boolean(project && !project.archived && !project.archived_at && !project.deleted_at && !task.deleted_at && open.has(task.status) && task.effective_due_on && ['calculated', 'manual'].includes(task.deadline_state) && task.activated_on && task.activated_on <= today);
  }
  private snapshotTask(task: Row, stage?: string) {
    const project = this.store.get('projects', task.project_id);
    const obligation = task.obligation_id ? this.store.get('obligations', task.obligation_id) : null;
    const documentId = task.document_id ?? obligation?.document_id;
    const document = documentId ? this.store.get('documents', documentId) : null;
    return { task_id: task.id, task_version: task.version, project_id: task.project_id, project_version: project?.version, project_name: clip(project?.name, 300), title: clip(task.title, 2000), owner_label: clip(task.owner_label || obligation?.owner_label || '未指定', 200), status: task.status, effective_due_on: task.effective_due_on ?? null, deadline_state: task.deadline_state, schedule_revision: task.schedule_revision, stage: stage ?? null, document_name: clip(document?.original_name ?? document?.filename ?? '', 400), clause_number: clip(task.clause_number ?? obligation?.clause_number ?? '', 200) };
  }
  private content(items: Row[], channel: string, scopeName?: string) {
    const today = businessToday(this.clock());
    const subject = channel === 'email' ? '投后管理履约事项汇总' : `${scopeName || items[0]?.project_name || '投后项目'}履约提醒`;
    const body = items.length ? items.map(t => {
      const remaining = t.effective_due_on ? daysBetween(today, t.effective_due_on) : null;
      const due = remaining === null ? '待确定期限' : remaining < 0 ? `逾期 ${-remaining} 天` : `剩余 ${remaining} 天`;
      return `【${t.project_name}】${t.title}\n协议：${t.document_name || '手工或待核对来源'}　条款：${t.clause_number || '未指定'}\n截止：${t.effective_due_on || '待确定'}（${due}）　负责人：${t.owner_label}　状态：${t.status}`;
    }).join('\n\n') : '本周无临期事项。';
    return { subject, body, items, business_date: today };
  }
  private createBatch(reminders: Row[], channel: string, mode: string, target: Row, extras: Row = {}) {
    const items = reminders.map(r => this.snapshotTask(this.store.get('tasks', r.task_id), r.stage));
    const notification = this.store.create('notifications', { channel, mode, purpose: 'automatic', policy_revision: this.setting().policy_revision, status: 'queued', project_id: channel === 'feishu' ? items[0]?.project_id : null, recipient_key: target.recipient_key, recipients: target.recipients, target_label: target.target_label, reminder_ids: reminders.map(r => r.id), content: this.content(items, channel), attempts: 0, lease_until: null, next_attempt_at: null, ...extras });
    for (const reminder of reminders) this.store.update('reminders', reminder.id, reminder.version, { notification_id: notification.id, status: 'queued' });
    return notification;
  }
  private batchChunks(reminders: Row[], channel: string, mode: string, target: Row, extras: Row = {}) {
    const batches: Row[] = []; let chunk: Row[] = []; let size = 0;
    for (const r of reminders) {
      const item = this.snapshotTask(this.store.get('tasks', r.task_id), r.stage);
      const cost = Buffer.byteLength(JSON.stringify(item)) + 400;
      const max = channel === 'feishu' ? 14000 : 180000;
      if (chunk.length && size + cost > max) { batches.push(this.createBatch(chunk, channel, mode, target, extras)); chunk = []; size = 0; }
      chunk.push(r); size += cost;
    }
    if (chunk.length) batches.push(this.createBatch(chunk, channel, mode, target, extras));
    return batches;
  }
  private occurrence(task: Row, channel: string, mode: string, target: Row, stage: string, policy: Row) {
    const business_key = [mode, task.id, task.schedule_revision ?? 1, policy.policy_revision, channel, target.recipient_key, stage].join('|');
    const existing = this.store.all('reminders', { business_key })[0];
    if (existing) return null;
    return this.store.create('reminders', { business_key, task_id: task.id, project_id: task.project_id, schedule_revision: task.schedule_revision ?? 1, policy_revision: policy.policy_revision, channel, mode, recipient_key: target.recipient_key, stage, status: 'pending', notification_id: null });
  }
  private afterMondaySlot(today: string) {
    const day = new Date(`${today}T00:00:00Z`).getUTCDay();
    const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(this.clock());
    return day !== 1 || hhmm >= '09:00';
  }
  scan(options: ScanOptions = {}) {
    options = z.object({ recovery: z.boolean().optional(), force: z.boolean().optional(), mode: z.enum(['mock', 'live']).optional(), channels: z.array(z.enum(['email', 'feishu'])).max(2).optional() }).parse(options);
    // Explicit development scans always use the simulated transport.
    const mode = options.force ? 'mock' : this.mode(options.mode);
    const today = businessToday(this.clock()); const policy = this.setting();
    const created: Row[] = []; const runs: Row[] = [];
    try { this.store.transaction(() => {
      const projects = new Map(this.store.all('projects').map(p => [p.id, p]));
      const tasks = this.store.all('tasks').filter(t => this.eligible(t, today, projects));
      for (const channel of ['feishu', 'email']) {
        if (options.channels && !options.channels.includes(channel)) continue;
        if (!(channel === 'feishu' ? policy.feishu_enabled : policy.mail_enabled)) continue;
        const target = this.target(channel, mode); if (!target.available) continue;
        const week = isoWeek(today);
        if (channel === 'email' && !this.afterMondaySlot(today)) continue;
        const slot = channel === 'feishu' ? `feishu:${today}` : `email:${week}`;
        const scheduled = !options.recovery && !options.force;
        const slot_key = scheduled ? `${mode}|${slot}` : null;
        if (slot_key && this.store.all('scheduler_runs', { slot_key }).length) continue;
        let run = this.store.create('scheduler_runs', { kind: options.recovery ? 'recovery' : options.force ? 'manual_mock' : 'scheduled', channel, mode, slot, slot_key, started_at: this.clock().toISOString(), business_date: today, status: 'running' });
        const newReminders: Row[] = [];
        if (channel === 'feishu') {
          for (const task of tasks) {
            const stage = reminderStage(daysBetween(today, task.effective_due_on), policy.lead_days);
            if (stage) { const r = this.occurrence(task, channel, mode, target, stage, policy); if (r) newReminders.push(r); }
          }
          const groups = new Map<string, Row[]>();
          for (const r of newReminders) groups.set(r.project_id, [...(groups.get(r.project_id) ?? []), r]);
          for (const group of groups.values()) created.push(...this.batchChunks(group, channel, mode, target));
        } else {
          const business_key = [mode, 'all', channel, target.recipient_key, week].join('|');
          if (!this.store.all('digest_runs', { business_key }).length) {
            const members = tasks.filter(t => daysBetween(today, t.effective_due_on) <= 7);
            const digest = this.store.create('digest_runs', { business_key, scope: 'all', channel, recipient_key: target.recipient_key, iso_week: week, mode, task_ids: members.map(t => t.id), status: members.length ? 'sealed' : policy.send_empty ? 'sealed_empty' : 'skipped_empty', sealed_at: this.clock().toISOString() });
            for (const task of members) { const r = this.occurrence(task, channel, mode, target, week, policy); if (r) newReminders.push(r); }
            if (newReminders.length) created.push(...this.batchChunks(newReminders, channel, mode, target, { digest_run_id: digest.id }));
            else if (!members.length && policy.send_empty) created.push(this.createBatch([], channel, mode, target, { digest_run_id: digest.id }));
          }
        }
        run = this.store.update('scheduler_runs', run.id, run.version, { status: 'succeeded', completed_at: this.clock().toISOString(), reminder_count: newReminders.length }); runs.push(run);
      }
    }); } catch (error) {
      // A rolled-back generation must still leave an actual failure record, without claiming its slot.
      this.store.create('scheduler_runs', { kind: options.recovery ? 'recovery' : options.force ? 'manual_mock' : 'scheduled', channel: 'all', mode, slot_key: null, started_at: this.clock().toISOString(), completed_at: this.clock().toISOString(), business_date: today, status: 'failed', error: '提醒扫描失败，请核查接收配置及事项数据。' });
      throw error;
    }
    return { notifications: created, scans: runs, mode, business_date: today };
  }
  async tick(options: { force_enabled?: boolean; recovery?: boolean } = {}) {
    const enabled = this.env('SCHEDULER_ENABLED') === true || this.env('SCHEDULER_ENABLED') === 'true';
    const mockedOverride = options.force_enabled && this.mode() === 'mock';
    if (enabled || mockedOverride) {
      const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(this.clock());
      if (options.recovery || hhmm >= '09:30') this.scan({ recovery: options.recovery });
      else if (hhmm >= '09:00') this.scanMailOnly();
    }
    return this.processQueue();
  }
  private scanMailOnly() {
    // Use a scoped scan so the 09:00 mail slot does not consume the 09:30 Feishu slot.
    return this.scanChannels(['email']);
  }
  private scanChannels(channels: string[]) {
    return this.scan({ channels });
  }
  private invalidation(batch: Row) {
    const today = businessToday(this.clock()), policy = this.setting(); const valid: Row[] = [];
    const target = this.target(batch.channel, batch.mode);
    const channelEnabled = batch.channel === 'feishu' ? policy.feishu_enabled : policy.mail_enabled;
    let changed = !channelEnabled || !target.available || target.recipient_key !== batch.recipient_key || batch.policy_revision !== policy.policy_revision;
    for (const id of batch.reminder_ids ?? []) {
      const r = this.store.get('reminders', id); const task = r ? this.store.get('tasks', r.task_id) : null;
      let okay = Boolean(channelEnabled && r && task && this.eligible(task, today) && (task.schedule_revision ?? 1) === r.schedule_revision && r.policy_revision === policy.policy_revision && target.recipient_key === r.recipient_key && target.available);
      if (okay && batch.channel === 'feishu') okay = reminderStage(daysBetween(today, task.effective_due_on), policy.lead_days) === r.stage && policy.feishu_enabled;
      if (okay && batch.channel === 'email') okay = daysBetween(today, task.effective_due_on) <= 7 && policy.mail_enabled;
      if (!okay) { changed = true; if (r) this.store.update('reminders', r.id, r.version, { status: 'cancelled', notification_id: null, cancel_reason: '发送前重新校验失效' }); }
      else {
        valid.push(r);
        const item = batch.content.items.find((i: Row) => i.task_id === task.id);
        if (!item || item.task_version !== task.version || item.project_version !== this.store.get('projects', task.project_id)?.version) changed = true;
      }
    }
    if (!changed) return false;
    this.store.update('notifications', batch.id, batch.version, { status: 'obsolete', obsolete_reason: '发送前事项或引用版本已变化' });
    const released = valid.map(r => this.store.update('reminders', r.id, r.version, { status: 'pending', notification_id: null }));
    if (released.length) this.batchChunks(released, batch.channel, batch.mode, target, { digest_run_id: batch.digest_run_id, replaces_notification_id: batch.id });
    return true;
  }
  async processQueue() {
    const results: Row[] = [];
    const now = this.clock().toISOString();
    this.store.transaction(() => {
      for (const batch of this.store.all('notifications').filter(n => n.status === 'sending' && n.lease_until <= now)) {
        this.finish(batch, { status: 'unknown', error: '发送进程中断或租约过期，请人工核查。' });
        for (const attempt of this.store.all('attempts', { notification_id: batch.id }).filter(a => a.status === 'sending')) this.store.update('attempts', attempt.id, attempt.version, { status: 'unknown', finished_at: now });
      }
    });
    for (let guard = 0; guard < 1000; guard++) {
      const schedulerEnabled = this.env('SCHEDULER_ENABLED') === true || this.env('SCHEDULER_ENABLED') === 'true';
      const candidate = this.store.all('notifications').find(n => ['queued', 'retry_wait'].includes(n.status) && (!n.next_attempt_at || n.next_attempt_at <= this.clock().toISOString()) && !(n.mode === 'live' && n.purpose === 'automatic' && !schedulerEnabled));
      if (!candidate) break;
      let batch: Row | null = null; let attempt: Row | null = null;
      this.store.transaction(() => {
        const fresh = this.store.get('notifications', candidate.id);
        if (!['queued', 'retry_wait'].includes(fresh.status)) return;
        if (fresh.purpose === 'automatic' && !fresh.manual_resend_authorized && this.invalidation(fresh)) return;
        batch = this.store.update('notifications', fresh.id, fresh.version, { status: 'sending', attempts: (fresh.attempts ?? 0) + 1, lease_until: new Date(this.clock().getTime() + 60000).toISOString() });
        attempt = this.store.create('attempts', { notification_id: fresh.id, attempt_number: batch!.attempts, status: 'sending', started_at: this.clock().toISOString(), mode: fresh.mode });
      });
      if (!batch || !attempt) continue;
      const claimed: Row = batch; const started: Row = attempt;
      let outcome: OutboundResult;
      try { outcome = await (this.config.adapter ?? sendOutbound)(claimed, this.config); }
      catch { outcome = { status: 'unknown', error: '发送适配器中断，结果未知，请人工核查。' }; }
      this.store.transaction(() => {
        const fresh = this.store.get('notifications', claimed.id);
        // A slow worker must not overwrite a lease already resolved as unknown.
        if (fresh.status !== 'sending') return;
        this.store.update('attempts', started.id, started.version, { status: outcome.status, finished_at: this.clock().toISOString(), error: outcome.error ?? null, external_id: outcome.external_id ?? null });
        results.push(this.finish(fresh, outcome));
      });
    }
    return results;
  }
  private finish(batch: Row, result: OutboundResult) {
    const retry = result.status === 'failed' && result.retryable && batch.attempts < 3;
    const status = retry ? 'retry_wait' : result.status;
    const updated = this.store.update('notifications', batch.id, batch.version, { status, lease_until: null, next_attempt_at: retry ? new Date(this.clock().getTime() + (batch.attempts === 1 ? 60000 : 300000)).toISOString() : null, last_error: result.error ?? null, external_id: result.external_id ?? null, completed_at: terminal.has(status) || status === 'failed' ? this.clock().toISOString() : null });
    for (const id of batch.reminder_ids ?? []) {
      const r = this.store.get('reminders', id); if (r) this.store.update('reminders', r.id, r.version, { status });
    }
    return updated;
  }
  preview(options: PreviewOptions = {}) {
    options = previewSchema.parse(options);
    const channel = options.channel ?? 'email', mode = this.mode(options.mode), target = this.target(channel, mode, options.recipients);
    const projects = new Map(this.store.all('projects').map(p => [p.id, p]));
    const tasks = this.store.all('tasks').filter(t => !t.deleted_at && projects.has(t.project_id) && !projects.get(t.project_id)?.archived && !projects.get(t.project_id)?.deleted_at && (!options.project_id || t.project_id === options.project_id) && (!options.task_ids || options.task_ids.includes(t.id)));
    const items = options.purpose === 'test' ? [] : tasks.map(t => this.snapshotTask(t));
    const content = options.purpose === 'test' ? { subject: '投后管理渠道测试', body: '这是一条投后管理系统渠道测试消息。', items: [], business_date: businessToday(this.clock()) } : this.content(items, channel);
    return this.store.create('snapshots', { channel, mode, purpose: options.purpose ?? 'manual', recipient_key: target.recipient_key, recipients: target.recipients, target_label: target.target_label, content, reference_versions: items.map(i => ({ id: i.task_id, version: i.task_version, project_id: i.project_id, project_version: i.project_version })), created_by: 'local_operator' });
  }
  sendSnapshot(options: { snapshot_id: string; subject?: string; body?: string; recipients?: string | string[]; allow_stale?: boolean; mode?: string }) {
    options = sendSchema.parse(options);
    const snapshot = this.store.get('snapshots', options.snapshot_id);
    if (!snapshot) throw new AppError('SNAPSHOT_NOT_FOUND', '预览快照不存在，请先生成预览。', 404);
    const stale = snapshot.reference_versions.some((r: Row) => this.store.get('tasks', r.id)?.version !== r.version || this.store.get('projects', r.project_id)?.version !== r.project_version);
    if (stale && !options.allow_stale) throw new AppError('SNAPSHOT_STALE', '预览后数据已变化，请重新生成预览或明确发送已编辑快照。', 409);
    const mode = this.mode(options.mode ?? snapshot.mode);
    const target = this.target(snapshot.channel, mode, options.recipients ?? snapshot.recipients);
    if (!target.available) throw new AppError('RECIPIENT_NOT_CONFIGURED', '接收目标未配置。');
    const subject = options.subject ?? snapshot.content.subject, body = options.body ?? snapshot.content.body;
    if (typeof subject !== 'string' || !subject.trim() || /[\r\n]/.test(subject) || typeof body !== 'string' || body.length > 1000000) throw new AppError('INVALID_MESSAGE', '消息主题或正文无效。');
    return this.store.transaction(() => {
      const notification = this.store.create('notifications', { channel: snapshot.channel, mode, purpose: snapshot.purpose, snapshot_id: snapshot.id, project_id: null, recipient_key: target.recipient_key, recipients: target.recipients, target_label: target.target_label, content: { ...snapshot.content, subject, body }, status: 'queued', reminder_ids: [], attempts: 0, lease_until: null, next_attempt_at: null, operator: 'local_operator', stale_snapshot_accepted: Boolean(stale && options.allow_stale) });
      this.store.audit('notifications', notification.id, 'manual_send_queued', null, notification, stale ? '用户明确发送已编辑历史快照' : '用户确认预览后入队');
      return notification;
    });
  }
  resolveUnknown(id: string, options: { action: 'mark_succeeded' | 'resend'; reason: string }) {
    options = z.object({ action: z.enum(['mark_succeeded', 'resend']), reason: z.string().trim().min(1).max(2000) }).parse(options);
    if (!options.reason?.trim() || !['mark_succeeded', 'resend'].includes(options.action)) throw new AppError('REASON_REQUIRED', '核查结果未知的通知必须填写原因和处理方式。');
    return this.store.transaction(() => {
      const batch = this.store.get('notifications', id);
      if (!batch) throw new AppError('NOT_FOUND', '通知不存在。', 404);
      if (batch.status !== 'unknown') throw new AppError('INVALID_NOTIFICATION_STATE', '只有结果未知的通知可以执行核查处理。', 409);
      let updated: Row;
      if (options.action === 'mark_succeeded') updated = this.finish(batch, { status: 'succeeded' });
      else updated = this.store.update('notifications', id, batch.version, { status: 'queued', lease_until: null, next_attempt_at: null, manual_resend_authorized: true });
      this.store.audit('notifications', id, 'resolve_unknown', batch, updated, options.reason);
      return updated;
    });
  }
}
