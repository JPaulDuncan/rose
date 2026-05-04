import { z } from 'zod';

export const InstructionScope = z.enum([
  'parse',
  'categorize',
  'generate',
  'link',
  'dedupe',
  'weather',
  'events',
  'sender',
  'chat',
]);
export type InstructionScope = z.infer<typeof InstructionScope>;

export const Instruction = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  name: z.string().min(1).max(80),
  scope: InstructionScope,
  description: z.string().max(500).default(''),
  template: z.string().min(1),
  variables: z.array(z.string()).default([]),
  isSystem: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Instruction = z.infer<typeof Instruction>;

export const InstructionUpsertRequest = z.object({
  name: z.string().min(1).max(80),
  scope: InstructionScope,
  description: z.string().max(500).optional(),
  template: z.string().min(1),
  variables: z.array(z.string()).optional(),
  isDefault: z.boolean().optional(),
});
export type InstructionUpsertRequest = z.infer<typeof InstructionUpsertRequest>;
