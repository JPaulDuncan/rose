import { z } from 'zod';

export const RuleConditionField = z.enum([
  'from.address',
  'from.domain',
  'subject',
  'body',
  'topic',
  'header',
  'spamScore',
  'isPromotional',
  'auth.spf',
  'auth.dkim',
  'auth.dmarc',
  'attachment.contentType',
  'size',
]);
export type RuleConditionField = z.infer<typeof RuleConditionField>;

export const RuleConditionOp = z.enum([
  'equals',
  'in',
  'endsWith',
  'contains',
  'matches',
  'present',
  '>=',
  '<',
  'is',
]);
export type RuleConditionOp = z.infer<typeof RuleConditionOp>;

export const RuleCondition = z.object({
  field: RuleConditionField,
  op: RuleConditionOp,
  value: z.unknown().optional(),
});
export type RuleCondition = z.infer<typeof RuleCondition>;

export const RuleActionKind = z.enum([
  'tag.add',
  'tag.remove',
  'priority.set',
  'flag.set',
  'route.topicPage',
  'assign.category',
  'archive',
  'quarantine',
  'halt',
]);
export type RuleActionKind = z.infer<typeof RuleActionKind>;

export const RuleAction = z.object({
  kind: RuleActionKind,
  /** Action-specific parameters. Validated per-kind on the server. */
  params: z.record(z.unknown()).default({}),
});
export type RuleAction = z.infer<typeof RuleAction>;

/** Rule scope — mirrors Recipe.scope. 'global' is admin-only. */
export const RuleScope = z.enum(['user', 'global']);
export type RuleScope = z.infer<typeof RuleScope>;

export const RuleUpsert = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(10000).default(100),
  /** Defaults to 'user'. 'global' requires admin at the API. */
  scope: RuleScope.optional(),
  conditions: z.array(RuleCondition).max(20),
  actions: z.array(RuleAction).min(1).max(10),
});
export type RuleUpsert = z.infer<typeof RuleUpsert>;
