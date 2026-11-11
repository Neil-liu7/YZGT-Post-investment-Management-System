import { z } from 'zod';

export function isBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const businessDateSchema = z.string().refine(isBusinessDate, '日期必须是有效的 YYYY-MM-DD');
export const versionSchema = z.number().int().min(1);
export const taskStatusSchema = z.enum(['pending', 'doing', 'done', 'cancelled']);
export const deadlineStateSchema = z.enum(['calculated', 'waiting_event', 'needs_review', 'manual']);

export type Offset = { amount: number; unit: 'calendar_day'|'business_day'|'calendar_month'|'calendar_year'; include_start_day: boolean };
export type Anchor = { type: 'event'; event_id: string } | { type: 'earliest'|'latest'; anchors: Anchor[] };
export type DateConvention = { end_day_adjustment: 'none'|'next_workday'|'previous_workday'; month_end: 'clamp'; calendar_id: string|null; calendar_version: number|null };
export type DateBoundary = Anchor | { type: 'date'; date: string } | { type: 'relative'; anchor: Anchor; offsets: Offset[]; convention: DateConvention };
export type RuleBase = { schema_version: 1; confirmation_status: 'needs_review'|'confirmed'; original_expression: string };
export type DeadlineRule = RuleBase & (
  | { kind: 'fixed'; date: string; convention: DateConvention }
  | { kind: 'relative'; anchor: Anchor; offsets: Offset[]; convention: DateConvention }
  | { kind: 'recurring'; frequency: 'month'|'quarter'|'year'; first_period_start: string; last_period_end: string|null; anchor: 'period_start'|'period_end'; offsets: Offset[]; convention: DateConvention }
  | { kind: 'continuous'; starts_at: DateBoundary; ends_at: DateBoundary|null; review_mode: 'manual' }
);

export const offsetSchema: z.ZodType<Offset> = z.object({
  amount: z.number().int().safe(),
  unit: z.enum(['calendar_day', 'business_day', 'calendar_month', 'calendar_year']),
  include_start_day: z.boolean(),
}).strict().superRefine((offset, ctx) => {
  if (offset.include_start_day && (offset.amount === 0 || !['calendar_day', 'business_day'].includes(offset.unit))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['include_start_day'], message: '计入起算日仅适用于非零的日或工作日偏移' });
  }
});

const eventAnchor = z.object({ type: z.literal('event'), event_id: z.string().trim().min(1) }).strict();
function anchorAtDepth(depth: number): z.ZodType<Anchor> {
  if (depth === 4) return eventAnchor;
  return z.union([eventAnchor, z.object({
    type: z.enum(['earliest', 'latest']), anchors: z.array(anchorAtDepth(depth + 1)).min(2),
  }).strict()]);
}
export const anchorSchema = anchorAtDepth(1);
export const dateConventionSchema: z.ZodType<DateConvention> = z.object({
  end_day_adjustment: z.enum(['none', 'next_workday', 'previous_workday']),
  month_end: z.literal('clamp'), calendar_id: z.string().trim().min(1).nullable(), calendar_version: versionSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.calendar_id === null) !== (value.calendar_version === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['calendar_id'], message: '工作日日历标识与版本必须同时提供' });
  }
});

export const dateBoundarySchema: z.ZodType<DateBoundary> = z.union([
  anchorSchema,
  z.object({ type: z.literal('date'), date: businessDateSchema }).strict(),
  z.object({ type: z.literal('relative'), anchor: anchorSchema, offsets: z.array(offsetSchema), convention: dateConventionSchema }).strict(),
]);
const baseShape = { schema_version: z.literal(1), confirmation_status: z.enum(['needs_review', 'confirmed']), original_expression: z.string().max(20000) };
const ruleUnion = z.discriminatedUnion('kind', [
  z.object({ ...baseShape, kind: z.literal('fixed'), date: businessDateSchema, convention: dateConventionSchema }).strict(),
  z.object({ ...baseShape, kind: z.literal('relative'), anchor: anchorSchema, offsets: z.array(offsetSchema), convention: dateConventionSchema }).strict(),
  z.object({ ...baseShape, kind: z.literal('recurring'), frequency: z.enum(['month', 'quarter', 'year']), first_period_start: businessDateSchema, last_period_end: businessDateSchema.nullable(), anchor: z.enum(['period_start', 'period_end']), offsets: z.array(offsetSchema), convention: dateConventionSchema }).strict(),
  z.object({ ...baseShape, kind: z.literal('continuous'), starts_at: dateBoundarySchema, ends_at: dateBoundarySchema.nullable(), review_mode: z.literal('manual') }).strict(),
]);

export const deadlineRuleSchema: z.ZodType<DeadlineRule> = ruleUnion.superRefine((rule, ctx) => {
  if (rule.kind !== 'recurring') return;
  const [year, month, day] = rule.first_period_start.split('-').map(Number);
  if (day !== 1 || (rule.frequency === 'quarter' && (month - 1) % 3 !== 0) || (rule.frequency === 'year' && month !== 1)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['first_period_start'], message: '首期必须从自然周期第一天开始' });
  }
  if (rule.last_period_end !== null) {
    const end = new Date(`${rule.last_period_end}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    const isEnd = end.getUTCDate() === 1 && (rule.frequency !== 'quarter' || end.getUTCMonth() % 3 === 0) && (rule.frequency !== 'year' || end.getUTCMonth() === 0);
    if (!isEnd || rule.last_period_end < rule.first_period_start) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['last_period_end'], message: '终止日期须为首期之后的对应自然周期末日' });
    }
  }
  // Preserve explicit year use above without interpreting it in the host timezone.
  if (year < 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '无效年份' });
});

export const obligationSchema = z.object({
  title: z.string().trim().min(1).max(300), description: z.string().max(20000).default(''),
  owner_label: z.string().max(200).default(''), obligor: z.string().max(500).default(''),
  source_type: z.enum(['manual', 'ai', 'legacy']), source_description: z.string().max(20000).default(''),
  rule: deadlineRuleSchema, document_id: z.string().min(1).nullable().optional(), document_version_id: z.string().min(1).nullable().optional(),
  source_text: z.string().max(100000).nullable().optional(), source_locator:z.object({page:z.number().int().positive().optional(),paragraph:z.number().int().positive().optional()}).optional(), clause_index:z.number().int().nonnegative().optional(), clause_number: z.string().max(200).nullable().optional(), draft_id: z.string().min(1).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.source_type === 'manual' && !value.source_description.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source_description'], message: '手工义务需要来源说明' });
  }
  if (value.source_type === 'ai' && (!value.document_version_id || !value.source_text?.trim())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['document_version_id'], message: 'AI 义务需要真实文件版本和原文' });
  }
});
export type ObligationInput = z.infer<typeof obligationSchema>;

export const projectSchema = z.object({ name: z.string().trim().min(1).max(300), company: z.string().trim().min(1).max(500), owner_label: z.string().max(200).default(''), notes: z.string().max(20000).default('') }).strict();
export const eventSchema = z.object({ name: z.string().trim().min(1).max(300), occurred_on: businessDateSchema.nullable(), scope: z.enum(['project', 'document', 'investor']).default('project'), document_id: z.string().nullable().optional(), investor_label: z.string().nullable().optional(), notes: z.string().max(20000).default('') }).strict();
