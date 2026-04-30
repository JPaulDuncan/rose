import { Router } from 'express';
import { Types } from 'mongoose';
import { userIdOf } from '../middleware/auth.js';
import { Category } from '@rose/db';

export const categoriesRouter: Router = Router();

categoriesRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const categories = await Category.find({ userId }).sort({ name: 1 }).lean();
  res.json({ categories });
});

categoriesRouter.post('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const { name, parentId, color, icon } = req.body as {
    name?: string;
    parentId?: string;
    color?: string;
    icon?: string;
  };
  if (!name) {
    res.status(400).json({ error: 'invalid_request', message: 'name is required' });
    return;
  }
  const created = await Category.create({
    userId,
    name,
    parentId: parentId ? new Types.ObjectId(parentId) : null,
    color: color ?? null,
    icon: icon ?? null,
  });
  res.status(201).json(created);
});

categoriesRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  await Category.deleteOne({ _id: req.params.id, userId });
  res.json({ ok: true });
});
