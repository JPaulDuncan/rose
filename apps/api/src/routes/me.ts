import { Router } from 'express';
import type { AuthedRequest } from '../middleware/auth.js';
import { User } from '@rose/db';

export const meRouter = Router();

meRouter.get('/', async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const user = await User.findById(userId);
  if (!user) {
    res.status(404).json({ error: 'not_found', message: 'User not found' });
    return;
  }
  res.json({
    id: user._id.toString(),
    email: user.email,
    displayName: user.displayName,
    settings: user.settings,
    createdAt: (user as unknown as { createdAt: Date }).createdAt.toISOString(),
  });
});

meRouter.patch('/', async (req, res) => {
  const userId = (req as AuthedRequest).userId;
  const { displayName, settings } = (req.body ?? {}) as {
    displayName?: string;
    settings?: Record<string, unknown>;
  };
  const update: Record<string, unknown> = {};
  if (displayName) update.displayName = displayName;
  if (settings) update.settings = { ...settings };
  const user = await User.findByIdAndUpdate(userId, update, { new: true });
  res.json({ ok: true, user });
});
