import { Schema, model, type InferSchemaType, type HydratedDocument, Types } from 'mongoose';

/**
 * Audit log of rule firings. Capped collection (~50k entries) so the
 * write cost stays bounded; old entries roll off naturally.
 */
const ruleAuditSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ruleId: { type: Schema.Types.ObjectId, ref: 'Rule', required: true, index: true },
    emailId: { type: Schema.Types.ObjectId, ref: 'Email', required: true, index: true },
    actions: { type: [Schema.Types.Mixed], default: [] },
    at: { type: Date, default: () => new Date() },
  },
  { capped: { size: 1024 * 1024 * 4, max: 50_000 }, timestamps: false },
);

ruleAuditSchema.index({ userId: 1, ruleId: 1, at: -1 });

export type RuleAuditLogDoc = HydratedDocument<InferSchemaType<typeof ruleAuditSchema>> & {
  _id: Types.ObjectId;
};
export const RuleAuditLog = model('RuleAuditLog', ruleAuditSchema);
