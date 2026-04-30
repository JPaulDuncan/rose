import type { Types } from 'mongoose';
import { Instruction } from '@rose/db';
import { SEED_INSTRUCTIONS } from '@rose/llm';

/**
 * Seed system instructions for a freshly registered user. We always upsert
 * `template`/`description`/`variables` for `isSystem: true` rows so existing
 * users pick up improvements to the seed prompts after a deploy. Custom
 * instructions (cloned by the user) are untouched — they live as separate
 * `isSystem: false` rows.
 */
export async function seedSystemInstructionsForUser(userId: Types.ObjectId): Promise<void> {
  for (const seed of SEED_INSTRUCTIONS) {
    await Instruction.updateOne(
      { userId, name: seed.name, scope: seed.scope, isSystem: true },
      {
        $set: {
          description: seed.description,
          template: seed.template,
          variables: seed.variables,
        },
        $setOnInsert: {
          userId,
          name: seed.name,
          scope: seed.scope,
          isSystem: true,
          isDefault: seed.isDefault,
        },
      },
      { upsert: true },
    );
  }
}

export async function getDefaultInstruction(userId: Types.ObjectId, scope: string) {
  const def = await Instruction.findOne({ userId, scope, isDefault: true });
  if (def) return def;
  return Instruction.findOne({ userId, scope, isSystem: true });
}
