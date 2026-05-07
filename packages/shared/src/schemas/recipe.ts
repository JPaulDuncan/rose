import { z } from 'zod';

/**
 * IFTTT-style recipe schemas. Triggers, conditions, and actions are
 * discriminated unions on a `kind` field; the matching `config` shape
 * is enforced per kind so the API can validate before the recipes
 * dispatcher ever sees a recipe.
 *
 * Phase 1 surface (per .devlogs/IFTTT-feature.md):
 *   triggers:   email.ingested, page.created, tag.applied, time.scheduled
 *   conditions: tag.contains, sender.brand, priority.is, subject.matches
 *   actions:    notify.push, tag.add, category.set, webhook.post
 */

// ─── Triggers ────────────────────────────────────────────────────────

export const TriggerKind = z.enum([
  'email.ingested',
  'page.created',
  'tag.applied',
  'time.scheduled',
]);
export type TriggerKind = z.infer<typeof TriggerKind>;

const EmailIngestedTrigger = z.object({
  kind: z.literal('email.ingested'),
  config: z
    .object({
      /** Lower-case substring (case-insensitive) match against
       *  `from.address`. Empty/undefined = match every sender. */
      senderContains: z.string().max(200).optional(),
      /** Lower-case brandKey match. */
      brandKey: z.string().max(120).optional(),
      /** Substring match against the email subject. */
      subjectContains: z.string().max(200).optional(),
    })
    .default({}),
});

const PageCreatedTrigger = z.object({
  kind: z.literal('page.created'),
  config: z.object({}).default({}),
});

const TagAppliedTrigger = z.object({
  kind: z.literal('tag.applied'),
  config: z.object({
    /** The tag whose application fires the recipe. Lower-case kebab-case. */
    tag: z.string().min(1).max(80),
  }),
});

const TimeScheduledTrigger = z.object({
  kind: z.literal('time.scheduled'),
  config: z.object({
    /** Standard 5-field cron (`MIN HOUR DOM MON DOW`). Validated by
     *  BullMQ when the repeatable is registered; we just length-cap
     *  here. */
    cron: z.string().min(5).max(80),
    /** IANA tz; defaults to user's digest timezone. */
    timezone: z.string().min(1).max(64).default('UTC'),
  }),
});

export const TriggerSchema = z.discriminatedUnion('kind', [
  EmailIngestedTrigger,
  PageCreatedTrigger,
  TagAppliedTrigger,
  TimeScheduledTrigger,
]);
export type Trigger = z.infer<typeof TriggerSchema>;

// ─── Conditions ──────────────────────────────────────────────────────

export const ConditionKind = z.enum([
  'tag.contains',
  'sender.brand',
  'priority.is',
  'subject.matches',
]);
export type ConditionKind = z.infer<typeof ConditionKind>;

const TagContainsCondition = z.object({
  kind: z.literal('tag.contains'),
  config: z.object({ tag: z.string().min(1).max(80) }),
});

const SenderBrandCondition = z.object({
  kind: z.literal('sender.brand'),
  config: z.object({ brandKey: z.string().min(1).max(120) }),
});

const PriorityIsCondition = z.object({
  kind: z.literal('priority.is'),
  config: z.object({ priority: z.enum(['high', 'normal', 'low']) }),
});

const SubjectMatchesCondition = z.object({
  kind: z.literal('subject.matches'),
  config: z.object({
    /** Regex pattern (without delimiters). Compiled with the
     *  case-insensitive flag by default. */
    pattern: z.string().min(1).max(200),
  }),
});

export const ConditionSchema = z.discriminatedUnion('kind', [
  TagContainsCondition,
  SenderBrandCondition,
  PriorityIsCondition,
  SubjectMatchesCondition,
]);
export type Condition = z.infer<typeof ConditionSchema>;

// ─── Actions ─────────────────────────────────────────────────────────

export const ActionKind = z.enum([
  'notify.push',
  'tag.add',
  'category.set',
  'webhook.post',
  'email.delete',
  'email.deleteOnSource',
  'email.markSpam',
  'email.archive',
  'email.block',
  'llm.run',
  'briefing.generate',
]);
export type ActionKind = z.infer<typeof ActionKind>;

const NotifyPushAction = z.object({
  kind: z.literal('notify.push'),
  config: z
    .object({
      /** Override message; if omitted the dispatcher derives one
       *  from the subject (email subject / page title / cron name). */
      message: z.string().max(280).optional(),
      /** Override title; default depends on trigger. */
      title: z.string().max(80).optional(),
    })
    .default({}),
});

const TagAddAction = z.object({
  kind: z.literal('tag.add'),
  config: z.object({
    tag: z.string().min(1).max(80),
  }),
});

const CategorySetAction = z.object({
  kind: z.literal('category.set'),
  config: z.object({
    name: z.string().min(1).max(120),
  }),
});

const WebhookPostAction = z.object({
  kind: z.literal('webhook.post'),
  config: z.object({
    url: z.string().url().max(2000),
    /** Optional headers; never includes Authorization automatically. */
    headers: z.record(z.string().max(200)).optional(),
  }),
});

/** Delete the email row in Rose's database. Only valid on
 *  email-shaped triggers (email.ingested). */
const EmailDeleteAction = z.object({
  kind: z.literal('email.delete'),
  config: z.object({}).default({}),
});

/** Move/trash the message on the upstream provider (IMAP / Gmail
 *  OAuth). Best-effort — falls back to a local delete when the source
 *  can't be reached or is a kind we can't write to. */
const EmailDeleteOnSourceAction = z.object({
  kind: z.literal('email.deleteOnSource'),
  config: z
    .object({
      /** Also remove the local Email row after the source deletion
       *  attempt. Defaults to true so the message disappears from
       *  Rose's inbox on success. */
      deleteLocal: z.boolean().default(true),
    })
    .default({}),
});

/** Cascade a sender-level spam mark: adds the email's `from.address`
 *  to `user.spamPolicy.senders` and flags every page that lists this
 *  sender. Mirrors `POST /api/spam/sender`. */
const EmailMarkSpamAction = z.object({
  kind: z.literal('email.markSpam'),
  config: z.object({}).default({}),
});

/** Mark the email as archived. Sets `archivedAt` so list views can
 *  filter it out without losing the data. */
const EmailArchiveAction = z.object({
  kind: z.literal('email.archive'),
  config: z.object({}).default({}),
});

/** Block the sender outright: adds to `spamPolicy.blockedSenders`
 *  and (when `removeExisting`) deletes the email plus pages where
 *  the sender is the sole contributor. */
const EmailBlockAction = z.object({
  kind: z.literal('email.block'),
  config: z
    .object({
      /** Also delete existing emails / pages from this sender.
       *  Default true to match the API behaviour. */
      removeExisting: z.boolean().default(true),
    })
    .default({}),
});

/** Run a free-form LLM prompt against the trigger subject and
 *  surface the result as a push notification. The template supports
 *  Mustache-style variables: `{{from}}`, `{{subject}}`, `{{body}}`,
 *  `{{title}}`, `{{tag}}`. */
const LlmRunAction = z.object({
  kind: z.literal('llm.run'),
  config: z.object({
    prompt: z.string().min(1).max(4000),
    /** Optional system prompt for tone / persona. */
    system: z.string().max(2000).optional(),
    /** What to do with the LLM's reply. `push` sends it as a push
     *  notification; `tag` splits commas and adds them as tags
     *  (page subjects only); `audit-only` records the result on
     *  RecipeAudit and does nothing else. */
    output: z.enum(['push', 'tag', 'audit-only']).default('push'),
    /** Title to use when output = push. Defaults to the recipe name. */
    pushTitle: z.string().max(80).optional(),
    /** Sampling controls (optional; all clamp to safe ranges). */
    temperature: z.number().min(0).max(1).optional(),
    maxTokens: z.number().int().min(1).max(4000).optional(),
  }),
});

/** Scheduled topic briefing — pulls fresh context from the user's
 *  configured Daydream sources (Wikipedia, news, etc.) and asks the
 *  LLM to write a short article filed as a Page. The pairing with a
 *  `time.scheduled` trigger is what makes this useful: "every
 *  morning at 8am, brief me on Spider-Man." See `apps/web` Topic
 *  Watches surface for the novice-friendly editor. */
const BriefingGenerateAction = z.object({
  kind: z.literal('briefing.generate'),
  config: z.object({
    /** Free-text topic the daydream sources are queried with. */
    topic: z.string().min(1).max(200),
    /** Optional Mustache-style prompt template. {{topic}}, {{date}},
     *  and {{snippets}} are pre-rendered. Falls back to a sensible
     *  built-in template when omitted. */
    promptTemplate: z.string().max(4000).optional(),
    /** Cap on snippets per source so a chatty adapter can't drown
     *  the prompt. */
    maxResultsPerSource: z.number().int().min(1).max(10).default(5),
    /** Word-count target for the resulting article. Loose hint passed
     *  to the LLM, not a hard cap. */
    targetWords: z.number().int().min(80).max(2000).default(400),
  }),
});

export const ActionSchema = z.discriminatedUnion('kind', [
  NotifyPushAction,
  TagAddAction,
  CategorySetAction,
  WebhookPostAction,
  EmailDeleteAction,
  EmailDeleteOnSourceAction,
  EmailMarkSpamAction,
  EmailArchiveAction,
  EmailBlockAction,
  LlmRunAction,
  BriefingGenerateAction,
]);
export type Action = z.infer<typeof ActionSchema>;

// ─── Recipe ──────────────────────────────────────────────────────────

export const Recipe = z.object({
  _id: z.string(),
  userId: z.string(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  enabled: z.boolean().default(true),
  trigger: TriggerSchema,
  conditions: z.array(ConditionSchema).max(10).default([]),
  actions: z.array(ActionSchema).min(1).max(10),
  cooldownSeconds: z.number().int().min(0).max(7 * 24 * 3600).default(0),
  fireLimitPerHour: z.number().int().min(1).max(1000).default(60),
  importedFrom: z
    .enum(['notification-rule', 'webhook', 'spam-policy', 'rule', 'topic-watch'])
    .nullable()
    .default(null),
  fireCount: z.number().int().min(0).default(0),
  errorCount: z.number().int().min(0).default(0),
  lastFiredAt: z.string().nullable().default(null),
  lastErrorAt: z.string().nullable().default(null),
  lastErrorMessage: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Recipe = z.infer<typeof Recipe>;

export const RecipeCreateRequest = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  trigger: TriggerSchema,
  conditions: z.array(ConditionSchema).max(10).optional(),
  actions: z.array(ActionSchema).min(1).max(10),
  cooldownSeconds: z.number().int().min(0).max(7 * 24 * 3600).optional(),
  fireLimitPerHour: z.number().int().min(1).max(1000).optional(),
});
export type RecipeCreateRequest = z.infer<typeof RecipeCreateRequest>;

export const RecipeUpdateRequest = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  trigger: TriggerSchema.optional(),
  conditions: z.array(ConditionSchema).max(10).optional(),
  actions: z.array(ActionSchema).min(1).max(10).optional(),
  cooldownSeconds: z.number().int().min(0).max(7 * 24 * 3600).optional(),
  fireLimitPerHour: z.number().int().min(1).max(1000).optional(),
});
export type RecipeUpdateRequest = z.infer<typeof RecipeUpdateRequest>;

// ─── Event payloads (worker → dispatcher) ────────────────────────────

/** What state-change processors emit onto the `rose.recipes` queue.
 *  The dispatcher matches on `eventKind` and routes the event to
 *  every recipe with a matching trigger.  */
export const RecipeEventKind = z.enum([
  'email.ingested',
  'page.created',
  'tag.applied',
  'time.scheduled',
]);
export type RecipeEventKind = z.infer<typeof RecipeEventKind>;

export type RecipeEvent =
  | {
      kind: 'email.ingested';
      userId: string;
      emailId: string;
      from: string | null;
      subject: string;
      brandKey: string | null;
      priority: 'high' | 'normal' | 'low' | null;
      tags: string[];
    }
  | {
      kind: 'page.created';
      userId: string;
      pageId: string;
      slug: string;
      title: string;
      tags: string[];
      categoryId: string | null;
      brandKeys: string[];
      /** Page priority — needed for the `priority.is` condition on
       *  page-shaped events (mirrors NotificationRule.kind 'priority-high'). */
      priority: 'high' | 'normal' | 'low' | null;
    }
  | {
      kind: 'tag.applied';
      userId: string;
      pageId: string;
      slug: string;
      title: string;
      tag: string;
      tags: string[];
      brandKeys: string[];
      priority: 'high' | 'normal' | 'low' | null;
    }
  | {
      kind: 'time.scheduled';
      userId: string;
      recipeId: string;
    };
