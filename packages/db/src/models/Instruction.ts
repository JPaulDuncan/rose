import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

const instructionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    name: { type: String, required: true },
    scope: {
      type: String,
      enum: ['parse', 'categorize', 'generate', 'link', 'dedupe', 'weather', 'events'],
      required: true,
    },
    description: { type: String, default: '' },
    template: { type: String, required: true },
    variables: { type: [String], default: [] },
    isSystem: { type: Boolean, default: false },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);

instructionSchema.index({ userId: 1, name: 1, scope: 1 });
instructionSchema.index({ userId: 1, scope: 1, isDefault: 1 });

export type InstructionDoc = HydratedDocument<InferSchemaType<typeof instructionSchema>>;
export const Instruction = model('Instruction', instructionSchema);
