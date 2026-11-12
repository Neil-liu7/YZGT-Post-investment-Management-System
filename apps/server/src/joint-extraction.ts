import { createHash } from 'node:crypto';
import { z } from 'zod';
import { businessDateSchema, candidateEventPrefix, deadlineRuleSchema, versionSchema } from '../../../packages/contracts/src/index';
import { AppError, type Store } from './store';
import type { Business } from './business';

type Row = Record<string, any>;
const refVersion = z.object({ id: z.string().min(1), version: versionSchema }).strict();
const versionsSchema = z.object({ drafts: z.array(refVersion), event_drafts: z.array(refVersion), events: z.array(refVersion), calendars: z.array(refVersion) }).strict();
const selectionSchema = z.object({
  draft_ids: z.array(z.string().min(1)).max(2000).default([]), event_draft_ids: z.array(z.string().min(1)).max(2000).default([]),
  calendar_id: z.string().min(1).optional(), calendar_version: versionSchema.optional(),
  confirm_review: z.boolean().optional(), expected_versions: versionsSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.draft_ids.length && !value.event_draft_ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '请至少选择一项候选' });
  if (Boolean(value.calendar_id) !== Boolean(value.calendar_version)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '日历标识与版本须同时提供' });
});
type SelectionInput = z.infer<typeof selectionSchema>;
type Selection = { run: Row; document: Row; drafts: Row[]; eventDrafts: Row[]; input: SelectionInput };
const fingerprint = (draft: Row) => createHash('sha256').update(JSON.stringify({ document_version_id: draft.document_version_id, source_text: draft.source_text, clause_index: draft.clause_index, name: draft.name, event_type: draft.event_type, investor_label: draft.investor_label ?? '' })).digest('hex');
function visit(value: any, callback: (value: Row) => void) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(item => visit(item, callback)); return; }
  callback(value); Object.values(value).forEach(item => visit(item, callback));
}
const ordered = (rows: Row[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id)).map(row => ({ id: row.id as string, version: row.version as number }));

/** Candidate review is separate from live records; preview uses the same transaction and always rolls it back. */
export class JointExtractionReview {
  constructor(private store: Store, private business: Business) {}

  private selection(runId: string, raw: unknown): Selection {
    const input = selectionSchema.parse(raw), run = this.store.require('extractions', runId);
    if (!['succeeded', 'partial'].includes(run.state)) throw new AppError('EXTRACTION_NOT_READY', '提取尚未结束或已经失败，请等待结果或重新提取。', 409);
    const document = this.store.require('documents', run.document_id);
    if (document.project_id !== run.project_id || document.state !== 'parsed') throw new AppError('INVALID_SOURCE', '来源协议尚未成功解析。');
    const rows = (table: string, ids: string[]) => [...new Set(ids)].map(id => {
      const row = this.store.require(table, id);
      if (row.extraction_id !== run.id || row.project_id !== run.project_id || row.document_id !== document.id || row.document_version_id !== document.id) throw new AppError('DRAFT_RUN_MISMATCH', '候选不属于本批次及来源协议。');
      if (row.review_state === 'ignored') throw new AppError('DRAFT_IGNORED', '忽略项不能导入，请恢复候选或修改关联。');
      if (!row.source_text?.trim() || !document.text?.includes(row.source_text)) throw new AppError('INVALID_SOURCE', '候选原文无法在来源协议中定位。');
      return row;
    });
    return { run, document, input, drafts: rows('drafts', input.draft_ids), eventDrafts: rows('event_drafts', input.event_draft_ids) };
  }

  private eventTarget(draft: Row, projectId: string): Row | null {
    if (draft.review_state === 'approved' && !draft.event_id) throw new AppError('INVALID_APPROVED_EVENT', '已确认事件缺少正式关联，请保留记录并核查。', 409);
    const id = draft.event_id ?? draft.reuse_event_id;
    if (id) {
      const event = this.store.require('events', id);
      if (event.project_id !== projectId) throw new AppError('FOREIGN_PROJECT', '复用事件不属于本项目。');
      if (draft.review_state !== 'approved' && draft.reuse_event_id && draft.reuse_event_version !== event.version) throw new AppError('REVIEW_PREVIEW_STALE', '复用事件已变化，请重新选择并预览。', 409);
      return event;
    }
    const existing = this.store.all('events', { source_fingerprint: fingerprint(draft) })[0];
    if (!existing) return null;
    if (existing.project_id !== projectId || existing.document_id !== draft.document_id) throw new AppError('FOREIGN_PROJECT', '同源事件范围不一致。');
    if (draft.occurred_on !== null && draft.occurred_on !== existing.occurred_on) throw new AppError('EVENT_SOURCE_CONFLICT', '同源事件的日期已被修改，请核对并明确选择复用现有事件；不会覆盖已有事实。', 409);
    return existing;
  }

  private versions(selection: Selection) {
    const { run, drafts, eventDrafts, input } = selection;
    const events = new Map<string, Row>(), calendars = new Map<string, Row>();
    const addEvent = (id: string) => {
      const event = this.store.require('events', id);
      if (event.project_id !== run.project_id) throw new AppError('FOREIGN_PROJECT', '起算事件不属于本项目。');
      events.set(event.id, event);
    };
    const addCalendar = (id: string, version: number) => {
      const calendar = this.store.require('calendars', id);
      if (!calendar.confirmed) throw new AppError('CALENDAR_UNCONFIRMED', '请先确认工作日日历。');
      if ((calendar.calendar_version ?? calendar.version) !== version) throw new AppError('CALENDAR_VERSION', '日历计算版本已经变化，请重新预览。', 409);
      calendars.set(calendar.id, calendar);
    };
    if (input.calendar_id) addCalendar(input.calendar_id, input.calendar_version!);
    const candidates = new Map(eventDrafts.map(draft => [draft.candidate_key, draft]));
    for (const draft of eventDrafts) {
      businessDateSchema.nullable().parse(draft.occurred_on);
      const target = this.eventTarget(draft, run.project_id); if (target) events.set(target.id, target);
    }
    for (const draft of drafts.filter(d => d.review_state !== 'approved')) {
      visit(draft.rule, value => {
        if (value.type === 'event' && typeof value.event_id === 'string') {
          if (value.event_id.startsWith(candidateEventPrefix)) {
            if (!candidates.has(value.event_id.slice(candidateEventPrefix.length))) throw new AppError('EVENT_CANDIDATE_NOT_SELECTED', '所选义务引用了未选择或已忽略的候选事件，请一并审核或修改关联。');
          } else addEvent(value.event_id);
        }
        if (value.calendar_id) addCalendar(value.calendar_id, value.calendar_version);
      });
    }
    return { drafts: ordered(drafts), event_drafts: ordered(eventDrafts), events: ordered([...events.values()]), calendars: ordered([...calendars.values()]) };
  }

  private apply(selection: Selection, reviewConfirmed: boolean) {
    const { run, document, drafts, eventDrafts, input } = selection;
    const eventsCreated: Row[] = [], eventsReused: Row[] = [], created: Row[] = [], skipped: string[] = [], tasks: Row[] = [], warnings: string[] = [];
    const mapped = new Map<string, string>();
    for (const draft of eventDrafts) {
      let event = this.eventTarget(draft, run.project_id);
      if (event) eventsReused.push(event);
      else {
        event = this.store.create('events', { name: draft.name, event_type: draft.event_type, occurred_on: draft.occurred_on, investor_label: draft.investor_label ?? '', project_id: run.project_id, document_id: document.id, scope: 'document', status: 'confirmed', source_type: 'ai', source_fingerprint: fingerprint(draft), source_text: draft.source_text, source_locator: draft.locator, clause_index: draft.clause_index, document_version_id: document.id, event_draft_id: draft.id, evidence: draft.source_text });
        this.store.audit('events', event!.id, 'create', null, event, '用户审核候选事件后确认'); eventsCreated.push(event!);
      }
      mapped.set(draft.candidate_key, event!.id);
      if (event!.occurred_on === null) warnings.push(`${event!.name}尚未登记实际日期，关联期限将等待事件。`);
      if (draft.review_state !== 'approved') this.store.update('event_drafts', draft.id, draft.version, { review_state: 'approved', event_id: event!.id });
    }
    for (const draft of drafts) {
      if (draft.review_state === 'approved') {
        const existing = this.store.require('obligations', draft.obligation_id); skipped.push(existing.id); tasks.push(...this.store.all('tasks', { obligation_id: existing.id })); continue;
      }
      if (!draft.rule || (draft.rule.kind === 'recurring' && !draft.rule.first_period_start)) throw new AppError('DRAFT_RULE_INCOMPLETE', '所选义务缺少完整期限或周期首期，请补充后预览；其他候选可单独确认。', 422, { draft_id: draft.id });
      const rule = JSON.parse(JSON.stringify(draft.rule));
      visit(rule, value => {
        if (value.type === 'event' && typeof value.event_id === 'string' && value.event_id.startsWith(candidateEventPrefix)) {
          const id = mapped.get(value.event_id.slice(candidateEventPrefix.length));
          if (!id) throw new AppError('EVENT_CANDIDATE_NOT_SELECTED', '所选义务引用的候选事件未确认。'); value.event_id = id;
        }
        if (input.calendar_id && value.convention?.calendar_id === null && (value.convention.end_day_adjustment !== 'none' || value.offsets?.some((offset: Row) => offset.unit === 'business_day'))) {
          value.convention.calendar_id = input.calendar_id; value.convention.calendar_version = input.calendar_version;
        }
      });
      if (reviewConfirmed) rule.confirmation_status = 'confirmed';
      const validated = deadlineRuleSchema.parse(rule); this.business.validateRule(run.project_id, validated);
      const obligation = this.business.createObligation(run.project_id, { title: draft.title, description: draft.description || '', owner_label: draft.owner_label || '', obligor: draft.obligor || '', source_type: 'ai', source_description: '联合提取候选人工审核确认', source_text: draft.source_text, source_locator: draft.locator, clause_index: draft.clause_index, document_id: document.id, document_version_id: document.id, draft_id: draft.id, clause_number: draft.clause_number || '', rule: validated });
      this.store.update('drafts', draft.id, draft.version, { review_state: 'approved', obligation_id: obligation.id, rule: validated });
      if (obligation.duplicate) skipped.push(obligation.id); else created.push(obligation);
      tasks.push(...obligation.tasks);
      for (const task of obligation.tasks.filter((task: Row) => ['waiting_event', 'needs_review'].includes(task.deadline_state))) warnings.push(`${task.title}：${task.deadline_state === 'waiting_event' ? '等待实际事件日期' : '期限或工作日日历仍待确认'}。`);
    }
    return { events_created: eventsCreated, events_reused: eventsReused, created, skipped, tasks, warnings: [...new Set(warnings)] };
  }

  preview(runId: string, input: unknown) {
    const selection = this.selection(runId, input), versions = this.versions(selection);
    const rollback = new Error('JOINT_REVIEW_PREVIEW_ROLLBACK'); let result: ReturnType<JointExtractionReview['apply']> | undefined;
    try { this.store.transaction(() => { result = this.apply(selection, true); throw rollback; }); }
    catch (error) { if (error !== rollback) throw error; }
    return { ...result!, events: [...result!.events_created, ...result!.events_reused], versions };
  }

  confirm(runId: string, raw: unknown) {
    return this.store.transaction(() => {
      const selection = this.selection(runId, raw);
      if (selection.input.confirm_review !== true) throw new AppError('REVIEW_CONFIRMATION_REQUIRED', '请先预览并明确确认已审核候选。');
      if (!selection.input.expected_versions) throw new AppError('REVIEW_PREVIEW_REQUIRED', '请先预览本次确认结果。', 409);
      const allApproved = [...selection.drafts, ...selection.eventDrafts].every(row => row.review_state === 'approved');
      if (!allApproved) {
        const actual = this.versions(selection), expected = selection.input.expected_versions;
        for (const key of ['drafts', 'event_drafts', 'events', 'calendars'] as const) {
          if (JSON.stringify(actual[key]) !== JSON.stringify([...expected[key]].sort((a, b) => a.id.localeCompare(b.id)))) throw new AppError('REVIEW_PREVIEW_STALE', '候选、起算事件或日历已变化，请重新预览后确认。', 409);
        }
      }
      return this.apply(selection, true);
    });
  }
}
