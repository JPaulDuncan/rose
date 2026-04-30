import { z } from 'zod';

export const SearchRequest = z.object({
  q: z.string().min(1).max(500),
  tags: z.array(z.string()).optional(),
  categoryId: z.string().nullable().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20),
  mode: z.enum(['hybrid', 'text', 'semantic']).default('hybrid'),
});
export type SearchRequest = z.infer<typeof SearchRequest>;

export const SearchHit = z.object({
  pageId: z.string(),
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  snippet: z.string(),
  score: z.number(),
  matchedBy: z.array(z.enum(['text', 'semantic'])),
  tags: z.array(z.string()).default([]),
  updatedAt: z.string(),
});
export type SearchHit = z.infer<typeof SearchHit>;

export const SearchResponse = z.object({
  hits: z.array(SearchHit),
  totalText: z.number().int().nonnegative(),
  totalSemantic: z.number().int().nonnegative(),
  tookMs: z.number().nonnegative(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;
