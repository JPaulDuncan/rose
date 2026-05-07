import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

const trackingEventSchema = new Schema(
  {
    at: { type: Date, default: null },
    status: {
      type: String,
      enum: [
        'detected',
        'in_transit',
        'out_for_delivery',
        'delivered',
        'exception',
        'returned',
        'unknown',
      ],
      default: 'unknown',
    },
    description: { type: String, default: '' },
    location: { type: String, default: null },
    /** Where this event came from — `email` for keyword inference,
     *  `carrier-api` when fetched from the carrier's tracking endpoint. */
    source: { type: String, enum: ['email', 'carrier-api'], default: 'email' },
  },
  { _id: false },
);

const shipmentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    carrier: {
      type: String,
      enum: ['ups', 'fedex', 'usps', 'dhl', 'unknown'],
      required: true,
      index: true,
    },
    trackingNumber: { type: String, required: true, index: true },
    /** Subject line of the email that first detected this shipment.
     *  Used as the display name in the list. */
    label: { type: String, default: null },
    status: {
      type: String,
      enum: [
        'detected',
        'in_transit',
        'out_for_delivery',
        'delivered',
        'exception',
        'returned',
        'unknown',
      ],
      default: 'detected',
      index: true,
    },
    trackingUrl: { type: String, required: true },
    lastEventDescription: { type: String, default: null },
    lastEventAt: { type: Date, default: null },
    estimatedDeliveryAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    history: { type: [trackingEventSchema], default: [] },
    sourceEmailIds: { type: [Schema.Types.ObjectId], ref: 'Email', default: [] },
    /** Carrier API state. Null when we've never queried the carrier
     *  directly — status was inferred purely from email keywords. */
    lastCheckedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    pollCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// One shipment per user+tracking-number. Carrier is part of the key
// because the same number can theoretically apply across providers
// when the regex is loose; treat (carrier, trackingNumber) as unique.
shipmentSchema.index(
  { userId: 1, carrier: 1, trackingNumber: 1 },
  { unique: true },
);

export type ShipmentDoc = HydratedDocument<InferSchemaType<typeof shipmentSchema>> & {
  _id: Types.ObjectId;
};
export const Shipment = model('Shipment', shipmentSchema);
