import { Router } from 'express';
import { Types } from 'mongoose';
import { Shipment } from '@rose/db';
import {
  type Carrier,
  type ShipmentStatus,
  type TrackingEvent,
} from '@rose/shared';
import { adapterFor } from '@rose/shipments';
import { userIdOf } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';

export const shipmentsRouter: Router = Router();

/**
 * Personal shipment tracker. Rose detects carrier tracking numbers
 * during email ingest (see `@rose/shipments`), upserts a Shipment
 * row, and surfaces it here grouped by current status. The optional
 * `carrier` and `status` query filters mirror the UI's tab layout.
 */
shipmentsRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const carrier = req.query.carrier as Carrier | undefined;
  const status = req.query.status as ShipmentStatus | undefined;
  const includeDelivered = req.query.includeDelivered === '1';
  const filter: Record<string, unknown> = { userId };
  if (carrier) filter.carrier = carrier;
  if (status) filter.status = status;
  // Default: hide delivered/returned more than 14 days old so the
  // page focuses on in-flight packages without losing history.
  if (!includeDelivered && !status) {
    const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000);
    filter.$or = [
      { status: { $nin: ['delivered', 'returned'] } },
      { deliveredAt: { $gte: cutoff } },
    ];
  }
  const shipments = await Shipment.find(filter)
    .sort({ updatedAt: -1 })
    .limit(500)
    .lean();
  res.json({ shipments });
});

shipmentsRouter.get('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  const shipment = await Shipment.findOne({ _id: req.params.id, userId }).lean();
  if (!shipment) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(shipment);
});

/**
 * Manual carrier-API refresh. Adapters that aren't configured (no
 * creds) report `{ ok: false, error: ... }` rather than throwing
 * 500 — the UI surfaces the message inline so the user understands
 * why nothing changed.
 */
shipmentsRouter.post('/:id/refresh', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  const shipment = await Shipment.findOne({ _id: req.params.id, userId });
  if (!shipment) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const adapter = adapterFor(shipment.carrier);
  if (!adapter) {
    res.json({ ok: false, error: `No adapter for ${shipment.carrier}`, shipment });
    return;
  }
  if (!adapter.available()) {
    const msg = `Carrier API not configured for ${shipment.carrier}.`;
    shipment.lastError = msg;
    shipment.lastCheckedAt = new Date();
    shipment.pollCount += 1;
    await shipment.save();
    res.json({ ok: false, error: msg, shipment });
    return;
  }
  try {
    const result = await adapter.track(shipment.trackingNumber);
    shipment.status = result.status;
    if (result.lastEventDescription) {
      shipment.lastEventDescription = result.lastEventDescription;
    }
    if (result.lastEventAt) shipment.lastEventAt = result.lastEventAt;
    if (result.estimatedDeliveryAt) {
      shipment.estimatedDeliveryAt = result.estimatedDeliveryAt;
    }
    if (result.deliveredAt) shipment.deliveredAt = result.deliveredAt;
    if (result.history.length > 0) {
      shipment.history = result.history.map((h: TrackingEvent) => ({
        ...h,
        at: h.at ? new Date(h.at) : null,
      })) as unknown as typeof shipment.history;
    }
    shipment.lastError = null;
    shipment.lastCheckedAt = new Date();
    shipment.pollCount += 1;
    await shipment.save();
    res.json({ ok: true, shipment });
  } catch (err) {
    const msg = (err as Error).message ?? 'carrier track failed';
    logger.warn({ err, shipmentId: req.params.id }, 'shipment refresh failed');
    shipment.lastError = msg;
    shipment.lastCheckedAt = new Date();
    shipment.pollCount += 1;
    await shipment.save();
    res.json({ ok: false, error: msg, shipment });
  }
});

shipmentsRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id ?? '')) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  await Shipment.deleteOne({ _id: req.params.id, userId });
  res.json({ ok: true });
});
