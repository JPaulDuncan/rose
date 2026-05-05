import { z } from 'zod';

/** Subject kinds the daydream worker can research. */
export const DaydreamKind = z.enum(['topic', 'sender', 'tag', 'entity']);
export type DaydreamKind = z.infer<typeof DaydreamKind>;

/** Public view of the user's daydream config. Subset of User.settings.daydream. */
export const DaydreamSettings = z.object({
  enabled: z.boolean().default(false),
  schedule: z.enum(['idle', 'daily', 'off']).default('idle'),
  dailyAtLocal: z.string().default('03:00'),
  timezone: z.string().default('UTC'),
  dailyCallCap: z.number().int().min(1).max(500).default(50),
  perPageMaxSubjects: z.number().int().min(1).max(20).default(3),
  refreshAfterDays: z.number().int().min(1).max(365).default(30),
  sources: z.object({
    wikipedia: z.object({
      enabled: z.boolean().default(true),
      lang: z.string().default('en'),
    }),
    wiktionary: z.object({
      enabled: z.boolean().default(false),
      lang: z.string().default('en'),
    }),
    wikidata: z.object({
      enabled: z.boolean().default(false),
      lang: z.string().default('en'),
    }),
    openalex: z.object({
      enabled: z.boolean().default(false),
      mailto: z.string().default(''),
    }),
    linkGraph: z.object({
      enabled: z.boolean().default(false),
      minHostCount: z.number().int().min(1).max(10).default(2),
    }),
    stackexchange: z.object({
      enabled: z.boolean().default(false),
      sites: z.array(z.string()).default(['stackoverflow']),
      apiKey: z.string().default(''),
    }),
    arxiv: z.object({ enabled: z.boolean().default(false) }),
    hackernews: z.object({ enabled: z.boolean().default(false) }),
    crossref: z.object({
      enabled: z.boolean().default(false),
      mailto: z.string().default(''),
    }),
    github: z.object({
      enabled: z.boolean().default(false),
      token: z.string().default(''),
    }),
  }),
  skip: z.object({
    senderBrandKeys: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    categoryIds: z.array(z.string()).default([]),
  }),
});
export type DaydreamSettings = z.infer<typeof DaydreamSettings>;

/** Patch payload — every field optional, deep-merged on the API side. */
export const DaydreamSettingsUpdate = DaydreamSettings.partial().extend({
  sources: DaydreamSettings.shape.sources.partial().optional(),
  skip: DaydreamSettings.shape.skip.partial().optional(),
});
export type DaydreamSettingsUpdate = z.infer<typeof DaydreamSettingsUpdate>;

/** A daydream note as returned by the API to the page view. */
export const DaydreamNoteView = z.object({
  _id: z.string(),
  kind: DaydreamKind,
  subjectKey: z.string(),
  displayName: z.string(),
  summary: z.string(),
  bodyMd: z.string(),
  sources: z.array(
    z.object({
      adapter: z.string(),
      url: z.string(),
      title: z.string().default(''),
      fetchedAt: z.string().nullable(),
    }),
  ),
  confidence: z.enum(['low', 'medium', 'high']),
  model: z.string().nullable(),
  generatedAt: z.string().nullable(),
  failed: z.boolean(),
  failureReason: z.string().nullable(),
});
export type DaydreamNoteView = z.infer<typeof DaydreamNoteView>;

/**
 * Schema the LLM is asked to emit during synthesis. JSON-mode + Zod
 * validation closes the prompt-injection loop — a model that complies
 * with an injected instruction would fail this parse.
 */
export const DaydreamSynthesisOutput = z.object({
  displayName: z.string().min(1).max(120),
  summary: z.string().min(1).max(320),
  bodyMd: z.string().max(900),
  /** Indices into the snippet array passed in the prompt. */
  usedSources: z.array(z.number().int().nonnegative()).default([]),
  confidence: z.enum(['low', 'medium', 'high']).default('medium'),
});
export type DaydreamSynthesisOutput = z.infer<typeof DaydreamSynthesisOutput>;
