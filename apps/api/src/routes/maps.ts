import { Router } from 'express';
import { z } from 'zod';
import { User } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';

export const mapsRouter: Router = Router();

const MapsSettings = z.object({
  enabled: z.boolean().default(false),
  /** Set to non-null after the user accepts the egress note. */
  acknowledgedAt: z.string().nullable().default(null),
});
export type MapsSettings = z.infer<typeof MapsSettings>;

const MapsSettingsUpdate = z.object({
  enabled: z.boolean().optional(),
  /** Pass `true` to record the user has seen the egress note (sets
   *  lastAcknowledgedAt server-side). */
  acknowledge: z.boolean().optional(),
});

/**
 * Read the user's maps preferences. Returns the current `enabled`
 * flag plus an `acknowledgedAt` timestamp the UI uses to decide
 * whether to show the first-time egress note.
 */
mapsRouter.get('/settings', async (req, res) => {
  const userId = userIdOf(req);
  const user = await User.findById(userId).select('settings.maps').lean();
  const cfg =
    (user?.settings as { maps?: { enabled?: boolean; lastAcknowledgedAt?: Date } } | undefined)
      ?.maps ?? {};
  const safe: MapsSettings = {
    enabled: !!cfg.enabled,
    acknowledgedAt: cfg.lastAcknowledgedAt
      ? new Date(cfg.lastAcknowledgedAt).toISOString()
      : null,
  };
  res.json(safe);
});

mapsRouter.patch('/settings', validateBody(MapsSettingsUpdate), async (req, res) => {
  const userId = userIdOf(req);
  const body = req.body as typeof MapsSettingsUpdate._type;
  const update: Record<string, unknown> = {};
  if (body.enabled !== undefined) update['settings.maps.enabled'] = body.enabled;
  if (body.acknowledge) update['settings.maps.lastAcknowledgedAt'] = new Date();
  if (Object.keys(update).length === 0) {
    res.json({ ok: true });
    return;
  }
  await User.findByIdAndUpdate(userId, { $set: update });
  res.json({ ok: true });
});
