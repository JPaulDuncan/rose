import { Types } from 'mongoose';
import { uniqueSlug as uniqueSlugCore } from '@rose/db';
import { PageRevision } from '@rose/db';
import { slugify } from '@rose/shared';

/**
 * Adapter over `@rose/db::uniqueSlug` that accepts a raw title and
 * runs `slugify` first. The api callers used this convenience shape
 * before plan 13 (D3); preserved so they don't have to slugify at
 * every callsite.
 */
export async function uniqueSlug(
  userId: Types.ObjectId,
  base: string,
  excludePageId?: Types.ObjectId,
): Promise<string> {
  return uniqueSlugCore(userId, slugify(base), { excludePageId });
}

export async function recordRevision(
  page: { _id: Types.ObjectId; version: number; title: string; summary: string; contentMd: string },
  editor: 'user' | 'llm' | 'synth' | 'briefing',
  model: string | null = null,
): Promise<void> {
  await PageRevision.create({
    pageId: page._id,
    version: page.version,
    title: page.title,
    summary: page.summary,
    contentMd: page.contentMd,
    editor,
    model,
  });
}
