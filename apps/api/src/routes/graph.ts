import { Router } from 'express';
import { Types } from 'mongoose';
import type { AuthedRequest } from '../middleware/auth.js';
import { Page } from '@rose/db';

export const graphRouter = Router();

graphRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId((req as AuthedRequest).userId);
  const pages = await Page.find({ userId })
    .select('_id title slug tags backlinks categoryId')
    .lean();
  const nodes = pages.map((p) => ({
    id: String(p._id),
    label: p.title,
    slug: p.slug,
    tags: p.tags ?? [],
    categoryId: p.categoryId ? String(p.categoryId) : null,
  }));
  const links: Array<{ source: string; target: string }> = [];
  for (const p of pages) {
    for (const b of p.backlinks ?? []) {
      links.push({ source: String(p._id), target: String(b) });
    }
  }
  res.json({ nodes, links });
});
