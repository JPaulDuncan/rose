import { Types } from 'mongoose';
import { BayesProfile } from '@rose/db';
import {
  tokenizeForBayes,
  scoreBayes,
  bayesReady,
  type BayesState,
} from '@rose/email-parser';

/**
 * Score one email's spam likelihood against the user's Bayes profile.
 * Returns null if the profile isn't trained enough yet (cold-start
 * gate; callers should fall back to the heuristic score). Pure read —
 * doesn't mutate the profile.
 */
export async function bayesScoreFor(
  userId: Types.ObjectId,
  email: { subject?: string | null; text?: string | null; rawText?: string | null },
): Promise<number | null> {
  const profile = await BayesProfile.findOne({ userId }).lean();
  if (!profile) return null;
  const state: BayesState = {
    spam: (profile.spam as Record<string, number>) ?? {},
    ham: (profile.ham as Record<string, number>) ?? {},
    spamDocs: profile.spamDocs ?? 0,
    hamDocs: profile.hamDocs ?? 0,
    spamTokens: profile.spamTokens ?? 0,
    hamTokens: profile.hamTokens ?? 0,
  };
  if (!bayesReady(state)) return null;
  const tokens = tokenizeForBayes(
    `${email.subject ?? ''}\n${(email.text ?? email.rawText ?? '').slice(0, 8000)}`,
  );
  if (!tokens.length) return null;
  return scoreBayes(state, tokens);
}
