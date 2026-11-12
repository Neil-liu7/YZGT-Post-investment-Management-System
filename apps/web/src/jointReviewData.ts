import { deadlineRuleSchema } from '../../../packages/contracts/src/index';
import type { Entity } from './api';

const prefix = 'candidate-event:';
const unitNames: Record<string, string> = { calendar_day: '个自然日', business_day: '个工作日', calendar_month: '个自然月', calendar_year: '个自然年' };
export const eventTypes: Record<string, string> = { signing: '协议签署', investment: '出资 / 收款', closing: '交割', registration: '工商变更', other: '其他事件' };
export const eventKey = (event: Entity): string => event.candidate_key ?? event.key;
export const candidateEventId = (event: Entity): string => prefix + eventKey(event);

export function candidateReferences(rule: any): string[] {
  const keys = new Set<string>();
  function visit(value: any) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'event' && typeof value.event_id === 'string' && value.event_id.startsWith(prefix)) keys.add(value.event_id.slice(prefix.length));
    for (const field of Object.values(value)) if (Array.isArray(field)) field.forEach(visit); else if (field && typeof field === 'object') visit(field);
  }
  visit(rule);
  return [...keys];
}

export function draftIssue(draft: Entity, events: Entity[]): string | null {
  if (!draft.rule) return '尚未识别完整期限，请核对并补充规则。';
  if (draft.rule.kind === 'recurring' && !draft.rule.first_period_start) return '首个周期开始日待补充，暂不导入。';
  if (!deadlineRuleSchema.safeParse(draft.rule).success) return '时间规则不完整，请核对后再导入。';
  for (const key of candidateReferences(draft.rule)) {
    const event = events.find(item => eventKey(item) === key);
    if (!event) return '未找到关联的事件候选，请核对起算事件。';
    if (event.review_state === 'ignored') return '关联事件已忽略，请恢复该事件或修改义务的关联。';
  }
  return null;
}

export function requiredEventDrafts(drafts: Entity[], events: Entity[]): Entity[] {
  const keys = new Set(drafts.flatMap(draft => candidateReferences(draft.rule)));
  return events.filter(event => event.review_state !== 'ignored' && keys.has(eventKey(event)));
}

export function reviewEvents(candidates: Entity[], existing: Entity[]): Entity[] {
  return [...existing, ...candidates.filter(event => event.review_state !== 'ignored').map(event => ({
    ...event, id: candidateEventId(event),
    name: `${event.name}（${event.review_state === 'approved' ? '已确认候选' : '候选'}）`,
    occurred_on: event.reuse_event_id ? existing.find(item => item.id === event.reuse_event_id)?.occurred_on ?? null : event.occurred_on,
  }))];
}

export function ruleSummary(rule: any, events: Entity[]): string {
  if (!rule) return '期限规则待补充';
  const eventName = (id: string) => events.find(event => event.id === id)?.name ?? '待关联事件';
  function anchor(value: any): string {
    if (!value) return '待关联事件';
    if (value.type === 'event') return eventName(value.event_id);
    return `${value.type === 'earliest' ? '孰早' : '孰晚'}（${(value.anchors ?? []).map(anchor).join('、')}）`;
  }
  function offsets(values: any[] = []): string {
    return values.map(value => `${value.amount < 0 ? '前' : '后'} ${Math.abs(value.amount)} ${unitNames[value.unit] ?? value.unit}${value.include_start_day ? '（计入起算日）' : ''}`).join('，再');
  }
  function boundary(value: any): string {
    if (!value) return '无固定终止条件';
    if (value.type === 'date') return value.date;
    if (value.type === 'relative') return `${anchor(value.anchor)}${offsets(value.offsets)}`;
    return `${anchor(value)}发生日`;
  }
  if (rule.kind === 'fixed') return `固定截止日：${rule.date}`;
  if (rule.kind === 'relative') return `${anchor(rule.anchor)}${offsets(rule.offsets)}`;
  if (rule.kind === 'recurring') return `${({ month: '每月', quarter: '每季度', year: '每年' } as Record<string, string>)[rule.frequency]}${rule.anchor === 'period_start' ? '开始日' : '结束日'}${offsets(rule.offsets)}；${rule.first_period_start ? `首期 ${rule.first_period_start}` : '首个周期待补充'}${rule.last_period_end ? `，末期 ${rule.last_period_end}` : ''}`;
  return `履行期间：${boundary(rule.starts_at)} 至 ${boundary(rule.ends_at)}`;
}
