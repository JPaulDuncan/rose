/**
 * Promo-code extraction. Two-pass scan over the email body:
 *
 *   1. Find sentences that mention a coupon-like keyword
 *      ("use code", "promo code", "with code", "code:", etc.).
 *   2. Within those sentences, pick out an alphanumeric token that
 *      *looks* like a code — distinctive caps/digits run, length cap,
 *      and a stop-list to drop noise like FREE / SHIPPING / BLACK
 *      that aren't actually codes.
 *
 * Heuristic by design — false positives degrade UX (users get noisy
 * rows) but a missed code is recoverable. We bias toward precision.
 */

const COUPON_KEYWORDS = [
  'use code',
  'use promo code',
  'use the code',
  'promo code',
  'coupon code',
  'discount code',
  'voucher code',
  'with code',
  'with the code',
  'enter code',
  'apply code',
  'redeem with',
  'redeem code',
  'code:',
  'coupon:',
  'promo:',
];

const DISCOUNT_PATTERNS: { pattern: RegExp; format: (m: RegExpMatchArray) => string }[] = [
  { pattern: /\b(\d{1,3})\s?%\s?off\b/i, format: (m) => `${m[1]}% off` },
  { pattern: /\b\$(\d{1,4})\s?off\b/i, format: (m) => `$${m[1]} off` },
  { pattern: /\bfree\s+shipping\b/i, format: () => 'free shipping' },
  { pattern: /\bbuy\s+one\s+get\s+one\b/i, format: () => 'BOGO' },
  { pattern: /\b(\d{1,3})\s?%\s+(?:discount|savings)\b/i, format: (m) => `${m[1]}% off` },
];

/** Tokens that look code-shaped (all-caps + digits) but never are. */
const STOP_TOKENS = new Set([
  'FREE',
  'SHIPPING',
  'TODAY',
  'NOW',
  'SALE',
  'NEW',
  'USA',
  'GMT',
  'EST',
  'PST',
  'EDT',
  'PDT',
  'CST',
  'CDT',
  'MST',
  'MDT',
  'INC',
  'LLC',
  'CORP',
  'LTD',
  'OFF',
  'SAVE',
  'GET',
  'BOGO',
  'BLACK',
  'FRIDAY',
  'CYBER',
  'MONDAY',
  'PRIME',
  'DEAL',
  'DEALS',
  'CODE',
  'PROMO',
  'COUPON',
  'OFFER',
  'OFFERS',
  'EXPIRES',
  'TERMS',
  'APPLY',
  'CLICK',
  'HERE',
  'SHOP',
  'ONLY',
  'LIMITED',
  'TIME',
  'ENDS',
]);

/** Looks like a candidate promo code. */
function looksLikeCode(token: string): boolean {
  if (token.length < 4 || token.length > 20) return false;
  if (STOP_TOKENS.has(token)) return false;
  if (!/[A-Z]/.test(token)) return false; // need at least one letter
  if (!/^[A-Z0-9]+$/.test(token)) return false;
  return true;
}

/**
 * Split text into sentence-shaped fragments. Cheap and good enough
 * for promo-code work where sentences are usually short and end with
 * `.`, `!`, `\n`, or `*` (asterisk-bullet emails).
 */
function sentencesOf(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/[\n.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length < 600);
}

function parseExpiration(sentence: string, now: Date): Date | null {
  const mNumeric = sentence.match(
    /\b(?:expires?|ends?|valid\s+(?:through|until)|good\s+(?:through|until))\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i,
  );
  if (mNumeric) {
    const month = Number(mNumeric[1]);
    const day = Number(mNumeric[2]);
    const yearRaw = mNumeric[3];
    let year: number;
    if (!yearRaw) {
      year = now.getFullYear();
      const candidate = new Date(year, month - 1, day);
      if (candidate.getTime() < now.getTime()) year += 1;
    } else {
      year = Number(yearRaw);
      if (year < 100) year = 2000 + year;
    }
    if (
      Number.isFinite(month) &&
      Number.isFinite(day) &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= 31
    ) {
      return new Date(year, month - 1, day, 23, 59, 59);
    }
  }
  const mMonthName = sentence.match(
    /\b(?:expires?|ends?|valid\s+through|good\s+through)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?/i,
  );
  if (mMonthName) {
    const monthIdx =
      ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
        mMonthName[1]!.toLowerCase().slice(0, 3),
      );
    const day = Number(mMonthName[2]);
    let year = mMonthName[3] ? Number(mMonthName[3]) : now.getFullYear();
    if (monthIdx >= 0 && day >= 1 && day <= 31) {
      const candidate = new Date(year, monthIdx, day, 23, 59, 59);
      if (!mMonthName[3] && candidate.getTime() < now.getTime()) {
        year += 1;
      }
      return new Date(year, monthIdx, day, 23, 59, 59);
    }
  }
  return null;
}

function parseDiscount(sentence: string): string | null {
  for (const { pattern, format } of DISCOUNT_PATTERNS) {
    const m = sentence.match(pattern);
    if (m) return format(m);
  }
  return null;
}

export type ExtractedPromoCode = {
  code: string;
  description: string;
  discount: string | null;
  expiresAt: Date | null;
};

/**
 * Find promo codes in the given email text. Subject is included in
 * the haystack since some senders put the code in the headline
 * ("BLACKFRIDAY: 20% off everything").
 */
export function extractPromoCodes(
  text: string,
  subject = '',
  now: Date = new Date(),
): ExtractedPromoCode[] {
  const haystack = `${subject}\n${text}`;
  const sentences = sentencesOf(haystack);
  const out = new Map<string, ExtractedPromoCode>();

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (!COUPON_KEYWORDS.some((kw) => lower.includes(kw))) continue;
    const tokenMatches = sentence.match(/\b[A-Z][A-Z0-9]{2,19}\b/g) ?? [];
    let code: string | null = null;
    for (const tok of tokenMatches) {
      if (looksLikeCode(tok)) {
        code = tok;
        break;
      }
    }
    if (!code) continue;
    if (out.has(code)) continue;

    out.set(code, {
      code,
      description: sentence.length > 220 ? sentence.slice(0, 217) + '…' : sentence,
      discount: parseDiscount(sentence),
      expiresAt: parseExpiration(sentence, now) ?? parseExpiration(haystack, now),
    });
  }
  return [...out.values()];
}
