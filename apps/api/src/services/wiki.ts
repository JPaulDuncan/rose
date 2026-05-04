import { Types } from 'mongoose';
import { Page } from '@rose/db';
import { PageRevision } from '@rose/db';
import { slugify } from '@rose/shared';

export async function uniqueSlug(
  userId: Types.ObjectId,
  base: string,
  excludePageId?: Types.ObjectId,
): Promise<string> {
  let slug = slugify(base);
  let n = 1;
  while (true) {
    const conflict = await Page.findOne({ userId, slug });
    if (!conflict || (excludePageId && conflict._id.equals(excludePageId))) return slug;
    n += 1;
    slug = `${slugify(base)}-${n}`;
  }
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
