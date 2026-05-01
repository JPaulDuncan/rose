import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import { createHash } from 'node:crypto';

export { formatImapError } from './imapErrors.js';

export type CleanedEmail = {
  messageId: string | null;
  threadKey: string | null;
  /**
   * Normalized "shape" of the subject — variable parts (numbers, hex IDs,
   * dates, URLs, version strings) are replaced with placeholders so two
   * GitHub Actions failure emails or two Stripe receipts collapse to the
   * same template even though their actual subjects differ.
   */
  subjectTemplate: string | null;
  from: { name?: string; address: string } | null;
  to: { name?: string; address: string }[];
  cc: { name?: string; address: string }[];
  subject: string;
  date: Date | null;
  /** Cleaned body: signatures and quoted replies stripped. */
  text: string;
  /** Raw plaintext as parsed (no cleanup applied). */
  rawText: string;
  html: string | null;
  attachments: {
    filename: string;
    contentType: string;
    size: number;
    contentId?: string;
    content: Buffer;
  }[];
  rawHash: string;
};

const SIGNATURE_DELIMITERS = [/^-- $/m, /^—\s*$/m, /^_{2,}\s*$/m];
const QUOTE_LINE = /^>\s?/;
const ON_WROTE = /^(On\s.+wrote:|From:.+\nSent:.+\nTo:.+\nSubject:.+)/m;
const FORWARDED = /^-{2,}\s*Forwarded message\s*-{2,}/im;
/** Below this threshold the original message is so short that any of our
 *  strip rules might erase the meaningful content. We bail and return the
 *  trimmed input instead of an empty string. */
const MIN_KEEP_LEN = 30;

/** Strip quoted replies and signatures while keeping useful body text. */
export function cleanBody(input: string): string {
  if (!input) return '';
  const original = input.replace(/\r\n/g, '\n').trim();
  let text = original;

  for (const delim of SIGNATURE_DELIMITERS) {
    const idx = text.search(delim);
    if (idx > 0) text = text.slice(0, idx);
  }

  const onWrote = text.search(ON_WROTE);
  if (onWrote > 0) text = text.slice(0, onWrote);

  const forwarded = text.search(FORWARDED);
  if (forwarded > 0) text = text.slice(0, forwarded);

  text = text
    .split('\n')
    .filter((line) => !QUOTE_LINE.test(line))
    .join('\n');

  const cleaned = text.replace(/\n{3,}/g, '\n\n').trim();
  // Safety net: when the heuristics erase everything (e.g. a body that
  // starts with "-- " or a single quoted line), fall back to the trimmed
  // original so downstream generation has *something* to work with — but
  // only when the original was non-trivial.
  if (cleaned.length === 0 && original.length >= MIN_KEEP_LEN) {
    return original;
  }
  return cleaned;
}

function pickAddresses(addr: AddressObject | AddressObject[] | undefined) {
  if (!addr) return [];
  const objs = Array.isArray(addr) ? addr : [addr];
  return objs.flatMap((o) =>
    (o.value ?? []).map((v) => ({
      name: v.name?.trim() || undefined,
      address: (v.address ?? '').toLowerCase(),
    })),
  );
}

/**
 * Strip variable parts of a subject so templated notifications collapse
 * to the same key. Examples:
 *   "CI / build #1234 — Failed for main"  → "ci / build <n> — failed for main"
 *   "Run failed: foo/bar@a1b2c3d"          → "run failed: foo/bar@<hex>"
 *   "Stripe receipt for $42.50 (May 2026)" → "stripe receipt for <money> (<month> <n>)"
 */
export function extractSubjectTemplate(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const out = subject
    .toLowerCase()
    .replace(/^(re|fwd?):\s*/i, '')
    .replace(/\bhttps?:\/\/\S+/g, '<url>')
    .replace(
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:[a-z]*)\b/g,
      '<month>',
    )
    .replace(/\b\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}(?::\d{2})?z?)?\b/g, '<date>')
    .replace(/\$\d+(?:\.\d+)?/g, '<money>')
    .replace(/\b\d+(?:\.\d+){2,}\b/g, '<v>')
    .replace(/\b[a-f0-9]{6,}\b/g, '<hex>')
    .replace(/#?\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return out || null;
}

function deriveThreadKey(parsed: ParsedMail): string | null {
  const refs = parsed.references;
  if (refs) {
    const first = Array.isArray(refs) ? refs[0] : refs.split(/\s+/)[0];
    if (first) return first.replace(/[<>]/g, '');
  }
  if (parsed.inReplyTo) return parsed.inReplyTo.replace(/[<>]/g, '');
  if (parsed.subject) {
    return parsed.subject.replace(/^(re:|fwd?:)\s*/i, '').trim().toLowerCase().slice(0, 120) || null;
  }
  return null;
}

export async function parseEmail(raw: Buffer | string): Promise<CleanedEmail> {
  const parsed = await simpleParser(raw, { skipHtmlToText: false });
  const text = parsed.text ?? '';
  const cleaned = cleanBody(text);
  const fromAddrs = pickAddresses(parsed.from);
  const toAddrs = pickAddresses(parsed.to);
  const ccAddrs = pickAddresses(parsed.cc);
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const rawHash = createHash('sha256').update(buffer).digest('hex');

  return {
    messageId: parsed.messageId ? parsed.messageId.replace(/[<>]/g, '') : null,
    threadKey: deriveThreadKey(parsed),
    subjectTemplate: extractSubjectTemplate(parsed.subject),
    from: fromAddrs[0] ?? null,
    to: toAddrs,
    cc: ccAddrs,
    subject: parsed.subject ?? '',
    date: parsed.date ?? null,
    text: cleaned,
    rawText: text,
    html: typeof parsed.html === 'string' ? parsed.html : null,
    attachments: (parsed.attachments ?? []).map((a) => ({
      filename: a.filename ?? 'attachment',
      contentType: a.contentType ?? 'application/octet-stream',
      size: a.size ?? a.content.length,
      contentId: a.contentId,
      content: a.content,
    })),
    rawHash,
  };
}
