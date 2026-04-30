import { Router } from 'express';
import { Types } from 'mongoose';
import { SearchRequest } from '@rose/shared';
import type { AuthedRequest } from '../middleware/auth.js';
import { searchPages } from '../services/search.js';

export const searchRouter = Router();

searchRouter.get('/', async (req, res, next) => {
  try {
    const userId = new Types.ObjectId((req as AuthedRequest).userId);
    const parsed = SearchRequest.parse({
      ...req.query,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      tags: req.query.tags
        ? Array.isArray(req.query.tags)
          ? req.query.tags
          : [req.query.tags as string]
        : undefined,
    });
    const out = await searchPages(userId, parsed);
    res.json(out);
  } catch (err) {
    next(err);
  }
});
