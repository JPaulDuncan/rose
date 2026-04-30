import { z } from 'zod';

export const Tag = z.string().min(1).max(40);

/**
 * One citation. The `label` is the stable token the LLM emits inline in
 * markdown (e.g. `[e1]`); the resolver maps it back to the email it came
 * from at save time so the UI can render footnote popovers.
 */
export const Citation = z.object({
  emailId: z.string(),
  subject: z.string().default(''),
  from: z.string().nullable().default(null),
  date: z.string().nullable().default(null),
});
export type Citation = z.infer<typeof Citation>;

export const CitationMap = z.record(z.string(), Citation);
export type CitationMap = z.infer<typeof CitationMap>;

export const Page = z.object({
  id: z.string(),
  userId: z.string(),
  slug: z.string(),
  title: z.string(),
  summary: z.string().max(500),
  contentMd: z.string(),
  tags: z.array(Tag).default([]),
  categoryId: z.string().nullable(),
  sourceEmailIds: z.array(z.string()).default([]),
  backlinks: z.array(z.string()).default([]),
  /** Thread identifier (References/In-Reply-To/normalized subject). */
  threadKey: z.string().nullable().default(null),
  /** Inline citation map: label → email metadata. */
  citations: CitationMap.default({}),
  version: z.number().int().nonnegative(),
  hasEmbedding: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Page = z.infer<typeof Page>;

export const PageRevision = z.object({
  id: z.string(),
  pageId: z.string(),
  version: z.number().int().nonnegative(),
  contentMd: z.string(),
  title: z.string(),
  summary: z.string(),
  editor: z.enum(['user', 'llm']),
  createdAt: z.string(),
});
export type PageRevision = z.infer<typeof PageRevision>;

export const PageUpdateRequest = z.object({
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(500).optional(),
  contentMd: z.string().optional(),
  tags: z.array(Tag).optional(),
  categoryId: z.string().nullable().optional(),
});
export type PageUpdateRequest = z.infer<typeof PageUpdateRequest>;

export const PageGenerationDraft = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().max(500),
  contentMd: z.string(),
  tags: z.array(Tag).max(10).default([]),
  suggestedCategory: z.string().nullable().default(null),
});
export type PageGenerationDraft = z.infer<typeof PageGenerationDraft>;
