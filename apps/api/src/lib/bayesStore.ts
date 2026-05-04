import { Types } from 'mongoose';
import { BayesProfile, Email, type EmailDoc } from '@rose/db';
import {
  tokenizeForBayes,
  trainBayes,
  untrainBayes,
  type BayesState,
} from '@rose/email-parser';

/**
 * Materialise (or create) the user's Bayes profile and run a training
 * batch over a set of emails. `delta` is +1 for "this is spam" and -1
 * for "this is ham" (a rescue or trust action). The state is mutated
 * in place and saved at the end.
 *
 * We use the email's subject + cleaned body as the document. Tokens
 * are deduped per document so the model isn't dominated by long
 * promotional emails.
 */
export async function trainBayesForEmails(
  userId: Types.ObjectId,
  emails: { subject?: string | null; text?: string | null }[],
  isSpam: boolean,
): Promise<{ trained: number }> {
  if (!emails.length) return { trained: 0 };
  const profile =
    (await BayesProfile.findOne({ userId })) ??
    (await BayesProfile.create({ userId }));
  const state = toState(profile);
  let n = 0;
  for (const e of emails) {
    const text = `${e.subject ?? ''}\n${(e.text ?? '').slice(0, 8000)}`.trim();
    if (!text) continue;
    const tokens = tokenizeForBayes(text);
    if (!tokens.length) continue;
    trainBayes(state, tokens, isSpam);
    n += 1;
  }
  fromState(profile, state);
  await profile.save();
  return { trained: n };
}

/**
 * Reverse a previous training pass — used when a user changes their
 * mind (rescues a previously-marked-spam page, or unblocks a sender).
 */
export async function untrainBayesForEmails(
  userId: Types.ObjectId,
  emails: { subject?: string | null; text?: string | null }[],
  wasSpam: boolean,
): Promise<{ untrained: number }> {
  if (!emails.length) return { untrained: 0 };
  const profile = await BayesProfile.findOne({ userId });
  if (!profile) return { untrained: 0 };
  const state = toState(profile);
  let n = 0;
  for (const e of emails) {
    const text = `${e.subject ?? ''}\n${(e.text ?? '').slice(0, 8000)}`.trim();
    if (!text) continue;
    const tokens = tokenizeForBayes(text);
    if (!tokens.length) continue;
    untrainBayes(state, tokens, wasSpam);
    n += 1;
  }
  fromState(profile, state);
  await profile.save();
  return { untrained: n };
}

/** Pull the (de-duped) subject+text for the contributing emails of a
 *  set of pages — used by the spam route to train the classifier
 *  in a single round-trip whenever a page or sender is flagged. */
export async function emailsContributingToPageIds(
  userId: Types.ObjectId,
  pageIds: Types.ObjectId[],
): Promise<EmailDoc[]> {
  if (!pageIds.length) return [];
  return (await Email.find({ userId, pageId: { $in: pageIds } })
    .select('subject text rawText')
    .lean()) as unknown as EmailDoc[];
}

function toState(profile: { spam?: unknown; ham?: unknown; spamDocs?: number; hamDocs?: number; spamTokens?: number; hamTokens?: number }): BayesState {
  return {
    spam: (profile.spam as Record<string, number>) ?? {},
    ham: (profile.ham as Record<string, number>) ?? {},
    spamDocs: profile.spamDocs ?? 0,
    hamDocs: profile.hamDocs ?? 0,
    spamTokens: profile.spamTokens ?? 0,
    hamTokens: profile.hamTokens ?? 0,
  };
}

function fromState(
  profile: { spam?: unknown; ham?: unknown; spamDocs?: number; hamDocs?: number; spamTokens?: number; hamTokens?: number; markModified?: (path: string) => void },
  state: BayesState,
): void {
  profile.spam = state.spam;
  profile.ham = state.ham;
  profile.spamDocs = state.spamDocs;
  profile.hamDocs = state.hamDocs;
  profile.spamTokens = state.spamTokens;
  profile.hamTokens = state.hamTokens;
  profile.markModified?.('spam');
  profile.markModified?.('ham');
}
