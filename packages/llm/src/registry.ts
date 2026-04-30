import type { InstructionScope } from '@rose/shared';

export type InstructionSeed = {
  name: string;
  scope: InstructionScope;
  description: string;
  template: string;
  variables: string[];
  isDefault: boolean;
};

export const SYSTEM_PROMPT_BASE = `You are Rose, an assistant that turns emails into well-structured wiki entries.
You write in clear, neutral prose. You never invent facts that are not in the email.
When asked for JSON, you respond with JSON only, no commentary, no markdown fences.`;
