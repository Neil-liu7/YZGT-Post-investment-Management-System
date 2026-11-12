import { z } from 'zod';
import { businessDateSchema, deadlineRuleSchema, dateConventionSchema, offsetSchema, type DeadlineRule } from './index.ts';

export const extractionRequestSchema = z.object({ prompt: z.string().trim().max(4000, '补充提取要求最多4000字').default('') }).strict();
export const candidateEventPrefix = 'candidate-event:';
export type DraftDeadlineRule = DeadlineRule | (Omit<Extract<DeadlineRule, { kind: 'recurring' }>, 'first_period_start'> & { first_period_start: null });

// Lazy references keep this companion module safe when re-exported by index.ts.
const incompleteRecurringSchema = z.object({
  schema_version: z.literal(1), confirmation_status: z.enum(['needs_review', 'confirmed']), original_expression: z.string().max(20000),
  kind: z.literal('recurring'), frequency: z.enum(['month', 'quarter', 'year']), first_period_start: z.null(),
  last_period_end: z.lazy(() => businessDateSchema).nullable(), anchor: z.enum(['period_start', 'period_end']),
  offsets: z.array(z.lazy(() => offsetSchema)), convention: z.lazy(() => dateConventionSchema),
}).strict().superRefine((rule, ctx) => {
  if (!rule.last_period_end) return;
  const end = new Date(`${rule.last_period_end}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 1);
  if (end.getUTCDate() !== 1 || (rule.frequency === 'quarter' && end.getUTCMonth() % 3 !== 0) || (rule.frequency === 'year' && end.getUTCMonth() !== 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['last_period_end'], message: '终止日期须为对应自然周期末日' });
  }
});
export const draftDeadlineRuleSchema: z.ZodType<DraftDeadlineRule> = z.union([z.lazy(() => deadlineRuleSchema), incompleteRecurringSchema]);
const sourceShape = {
  source_text: z.string().trim().min(1).max(100000),
  locator: z.object({ page: z.number().int().positive().optional(), paragraph: z.number().int().positive().optional() }),
  clause_number: z.string().max(200).optional(), clause_index: z.number().int().nonnegative(),
  unresolved_items: z.array(z.string().max(2000)).max(100),
};
export const eventCandidateSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), name: z.string().trim().min(1).max(300),
  event_type: z.enum(['signing', 'investment', 'closing', 'registration', 'other']),
  occurred_on: z.lazy(() => businessDateSchema).nullable(), investor_label: z.string().max(500).default(''), ...sourceShape,
}).strict();
export type EventCandidate = z.infer<typeof eventCandidateSchema>;
export const jointCandidateSchema = z.object({
  title: z.string().trim().min(1).max(300), description: z.string().max(20000), obligor: z.string().max(500),
  action: z.string().max(20000), deliverable: z.string().max(20000), trigger: z.string().max(20000),
  deadline_rule: draftDeadlineRuleSchema.nullable(), ...sourceShape,
}).strict();
export type JointCandidate = z.infer<typeof jointCandidateSchema>;
export const jointExtractionResponseSchema = z.object({
  event_candidates: z.array(eventCandidateSchema).max(2000), candidates: z.array(jointCandidateSchema).max(2000),
}).strict();
