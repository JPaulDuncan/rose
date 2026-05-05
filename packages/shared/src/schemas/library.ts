import { z } from 'zod';

export const LibrarySourceKind = z.enum(['rss', 'sitemap', 'url', 'urlList']);
export type LibrarySourceKind = z.infer<typeof LibrarySourceKind>;

export const LibrarySourceCreate = z
  .object({
    kind: LibrarySourceKind,
    name: z.string().min(1).max(120),
    url: z.string().url().nullable().optional(),
    urls: z.array(z.string().url()).max(5000).optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).default([]),
    pollIntervalMinutes: z
      .number()
      .int()
      .min(5)
      .max(7 * 24 * 60)
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'urlList') {
      if (!v.urls || v.urls.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'urlList requires `urls` (1+).',
          path: ['urls'],
        });
      }
    } else if (!v.url) {
      ctx.addIssue({
        code: 'custom',
        message: `${v.kind} requires \`url\`.`,
        path: ['url'],
      });
    }
  });
export type LibrarySourceCreate = z.infer<typeof LibrarySourceCreate>;

export const LibrarySourceUpdate = z.object({
  name: z.string().min(1).max(120).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  pollIntervalMinutes: z
    .number()
    .int()
    .min(5)
    .max(7 * 24 * 60)
    .optional(),
  status: z.enum(['active', 'paused']).optional(),
});
export type LibrarySourceUpdate = z.infer<typeof LibrarySourceUpdate>;

export const LibrarySettings = z.object({
  enabled: z.boolean().default(false),
  dailyCrawlCap: z.number().int().min(10).max(10000).default(500),
  useInDaydream: z.boolean().default(true),
});
export type LibrarySettings = z.infer<typeof LibrarySettings>;

export const LibrarySettingsUpdate = LibrarySettings.partial();
export type LibrarySettingsUpdate = z.infer<typeof LibrarySettingsUpdate>;
