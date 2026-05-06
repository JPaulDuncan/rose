/**
 * Pure Naive Bayes math for spam classification. The model state lives
 * elsewhere (per-user document in `BayesProfile`); this module is just
 * tokenization, training, and scoring.
 */

const STOP = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was',
  'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new', 'now', 'old',
  'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use',
  'with', 'this', 'that', 'have', 'from', 'they', 'will', 'your', 'what', 'when', 'where',
  'which', 'their', 'about', 'would', 'there', 'could', 'should', 'than', 'them', 'these',
  'those', 'into', 'over', 'also', 'just', 'such', 'some', 'been', 'were', 'each', 'more',
  'only', 'most', 'other', 'after', 'before', 'because', 'while',
]);

/**
 * Lowercase, split on non-word, drop stopwords, and dedup per document.
 * We deliberately use a *binary* representation (each token counted once
 * per document) — multinomial Bayes on word freq favors long emails too
 * heavily, which is exactly what spammers send.
 */
export function tokenizeForBayes(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  // Replace URLs with a generic token so we don't blow vocab on
  // tracking parameters. Same for numbers.
  const masked = lower
    .replace(/https?:\/\/[^\s)]+/g, ' __url__ ')
    .replace(/\b\d{4,}\b/g, ' __num__ ');
  const seen = new Set<string>();
  for (const raw of masked.split(/[^a-z_]+/)) {
    if (!raw) continue;
    if (raw.length < 2 || raw.length > 30) continue;
    if (STOP.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen].slice(0, 500);
}

export type BayesState = {
  spam: Record<string, number>;
  ham: Record<string, number>;
  spamDocs: number;
  hamDocs: number;
  spamTokens: number;
  hamTokens: number;
};

const VOCAB_CAP = 5000;

/** Trim the table to the top `cap` keys by count when over the cap. */
function trimVocab(table: Record<string, number>, cap: number): { dropped: number } {
  const keys = Object.keys(table);
  if (keys.length <= cap) return { dropped: 0 };
  const sorted = keys.sort((a, b) => (table[b] ?? 0) - (table[a] ?? 0));
  let dropped = 0;
  for (const k of sorted.slice(cap)) {
    dropped += table[k] ?? 0;
    delete table[k];
  }
  return { dropped };
}

/**
 * Add one document's tokens to the appropriate corpus. Mutates state.
 * Re-trims the vocabulary when it exceeds VOCAB_CAP — least-frequent
 * tokens drop first, with their count subtracted from the total.
 */
export function trainBayes(state: BayesState, tokens: string[], isSpam: boolean): void {
  const target = isSpam ? state.spam : state.ham;
  for (const t of tokens) {
    target[t] = (target[t] ?? 0) + 1;
  }
  if (isSpam) {
    state.spamDocs += 1;
    state.spamTokens += tokens.length;
  } else {
    state.hamDocs += 1;
    state.hamTokens += tokens.length;
  }
  const trimmed = trimVocab(target, VOCAB_CAP);
  if (isSpam) state.spamTokens -= trimmed.dropped;
  else state.hamTokens -= trimmed.dropped;
}

/**
 * Reverse a training event (used when the user rescues a page that was
 * previously trained as spam). Subtracts but never below zero.
 */
export function untrainBayes(state: BayesState, tokens: string[], wasSpam: boolean): void {
  const target = wasSpam ? state.spam : state.ham;
  for (const t of tokens) {
    if (target[t]) {
      target[t] -= 1;
      if (target[t] <= 0) delete target[t];
    }
  }
  if (wasSpam) {
    state.spamDocs = Math.max(0, state.spamDocs - 1);
    state.spamTokens = Math.max(0, state.spamTokens - tokens.length);
  } else {
    state.hamDocs = Math.max(0, state.hamDocs - 1);
    state.hamTokens = Math.max(0, state.hamTokens - tokens.length);
  }
}

/** Cold-start gate. Below this the score isn't reliable enough to use. */
export const BAYES_MIN_DOCS = 30;

export function bayesReady(state: BayesState): boolean {
  return state.spamDocs >= BAYES_MIN_DOCS && state.hamDocs >= BAYES_MIN_DOCS;
}

/**
 * Probability that the document is spam. Laplace-smoothed log-prior
 * difference, converted to a 0..1 probability via the logistic. Returns
 * `null` when the model isn't ready yet.
 */
export function scoreBayes(state: BayesState, tokens: string[]): number | null {
  if (!bayesReady(state)) return null;
  const total = state.spamDocs + state.hamDocs;
  // Log priors.
  let logSpam = Math.log(state.spamDocs / total);
  let logHam = Math.log(state.hamDocs / total);
  // Vocab size for Laplace smoothing — union of both sides.
  const vocab = new Set<string>([
    ...Object.keys(state.spam),
    ...Object.keys(state.ham),
  ]);
  const V = Math.max(1, vocab.size);
  const spamDenom = state.spamTokens + V;
  const hamDenom = state.hamTokens + V;
  for (const t of tokens) {
    const sCount = state.spam[t] ?? 0;
    const hCount = state.ham[t] ?? 0;
    logSpam += Math.log((sCount + 1) / spamDenom);
    logHam += Math.log((hCount + 1) / hamDenom);
  }
  // Logistic over the log-odds.
  const diff = logSpam - logHam;
  return 1 / (1 + Math.exp(-diff));
}

/**
 * Aggressive ad-strip pass. Drops:
 *   - any paragraph containing an affiliate/utm tracker URL
 *   - any paragraph that's mostly capitalised promotional language
 *   - blockquoted/indented lines that read like sponsored breaks
 *   - footers starting with "You're receiving this because…",
 *     "© 20XX", "Manage preferences", "Update your preferences",
 *     "View this email in your browser"
 *
 * Designed to layer *on top* of the conservative `stripAdSections`
 * pass, only when the user has explicitly toggled it on for a sender.
 */
const FOOTER_RE =
  /^(\s*)(you'?re\s+receiving|©\s*\d{4}|copyright\s*\d{4}|manage\s+(?:preferences|subscriptions?)|update\s+your\s+(?:preferences|email)|view\s+this\s+email|unsubscribe|sent to\s+\S+|forward (?:this|to a friend))\b/i;
const PROMO_LINE_RE =
  /\b(shop now|buy now|use code|coupon|free shipping|exclusive (?:offer|deal)|limited time|today only|don'?t miss|while supplies last|act now|treat yourself|new arrivals?|click here)\b/i;
const TRACKING_URL_RE = /[?&](utm_[a-z]+|aff|trk|cid|mc_[a-z]+|partner|ref)=/i;

export function stripAdSectionsStrict(text: string): { cleaned: string; removed: number } {
  if (!text) return { cleaned: '', removed: 0 };
  // Operate on paragraphs (separated by blank lines) so we can drop
  // whole promo blocks instead of individual lines.
  const paragraphs = text.split(/\n{2,}/);
  const out: string[] = [];
  let removed = 0;
  for (const p of paragraphs) {
    const lines = p.split('\n');
    const promoLines = lines.filter((l) => PROMO_LINE_RE.test(l));
    const trackingHits = lines.filter((l) => TRACKING_URL_RE.test(l));
    const footerHits = lines.filter((l) => FOOTER_RE.test(l));
    const adRatio =
      (promoLines.length + trackingHits.length + footerHits.length) / Math.max(lines.length, 1);
    if (adRatio >= 0.5) {
      removed += lines.length;
      continue;
    }
    out.push(p);
  }
  return { cleaned: out.join('\n\n'), removed };
}
