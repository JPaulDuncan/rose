import type { ParsedMail } from 'mailparser';

export type EmailPriority = 'high' | 'normal' | 'low';

export type EmailLink = {
  url: string;
  /** Anchor text from HTML, when known. */
  text?: string;
};

export type EmailImage = {
  url: string;
  alt?: string;
};

export type EmailMetadata = {
  priority: EmailPriority;
  topics: string[];
  links: EmailLink[];
  images: EmailImage[];
  /** 0..1 — higher means more likely spam. */
  spamScore: number;
  /** Human-readable reasons that fed into spamScore, for the UI tooltip. */
  spamSignals: string[];
  /** True for legitimate mass mailings (List-Unsubscribe present). Distinct from spam. */
  isMassMailing: boolean;
};

const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/gi;
const HASHTAG_RE = /(?:^|\s)#([a-z][a-z0-9_-]{1,40})/gi;
const TRACKING_HOSTS = /^(?:click|track|pixel|email|mail|t|r|e)\.[a-z0-9.-]+/i;

const SUSPICIOUS_SENDER_RE =
  /^(?:mailer-daemon|postmaster|bounce|spam|abuse|junk|nobody|root)@/i;

const SUBJECT_HIGH = /\b(urgent|asap|immediately|critical|important|action[- ]required|p0|sev[- ]?[01]|emergency)\b/i;
const SUBJECT_LOW = /\b(fyi|no action required|newsletter|digest|reminder|automated)\b/i;
const SUBJECT_BANG = /!{3,}/;
const SUBJECT_ALL_CAPS_LONG = (s: string) => s.length > 12 && s === s.toUpperCase() && /[A-Z]/.test(s);
const SUBJECT_MONEY = /\$\$\$|💰|free\s+money|guaranteed|act now|limited time|congratulations,?\s+you/i;
const SUBJECT_PHARMA = /\b(viagra|cialis|levitra|pharmacy|crypto|bitcoin|nft|hot singles)\b/i;

function getHeader(parsed: ParsedMail, name: string): string | null {
  const h = parsed.headers?.get(name.toLowerCase());
  if (!h) return null;
  if (typeof h === 'string') return h;
  if (typeof (h as { value?: unknown }).value === 'string') {
    return (h as { value: string }).value;
  }
  return null;
}

function derivePriority(parsed: ParsedMail, subject: string): EmailPriority {
  const xpri = getHeader(parsed, 'X-Priority');
  const importance = getHeader(parsed, 'Importance');
  const priority = getHeader(parsed, 'Priority');
  if (xpri && /^[12]/.test(xpri.trim())) return 'high';
  if (xpri && /^[45]/.test(xpri.trim())) return 'low';
  if (importance && /high|urgent/i.test(importance)) return 'high';
  if (importance && /low/i.test(importance)) return 'low';
  if (priority && /urgent|high/i.test(priority)) return 'high';
  if (priority && /low|non-urgent/i.test(priority)) return 'low';
  if (SUBJECT_HIGH.test(subject)) return 'high';
  if (SUBJECT_LOW.test(subject)) return 'low';
  return 'normal';
}

function extractLinks(text: string, html: string | null): EmailLink[] {
  const seen = new Map<string, EmailLink>();
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:)\]]+$/, '');
    if (!seen.has(url)) seen.set(url, { url });
  }
  if (html) {
    for (const m of html.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = m[1] ?? '';
      if (!url || !/^https?:/i.test(url)) continue;
      const txt = (m[2] ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (!seen.has(url)) seen.set(url, { url, text: txt || undefined });
      else if (!seen.get(url)!.text && txt) seen.get(url)!.text = txt;
    }
  }
  // Drop image-tracker pixels — heuristic on hostname.
  return [...seen.values()].filter((l) => {
    try {
      const host = new URL(l.url).hostname;
      return !TRACKING_HOSTS.test(host);
    } catch {
      return false;
    }
  });
}

const STOPWORDS = new Set(
  'the a an and or but of in on at to for with by from is are was were be been being have has had do does did will would shall should may might can could this that these those it its as if then so not no yes you your we us our they them their he she his her i me my'.split(
    ' ',
  ),
);

/**
 * Pull <img> URLs out of HTML. Skips tracking pixels (1x1, hosts in
 * TRACKING_HOSTS), data: URIs, and non-https schemes. Includes alt text
 * when present so the page UI has something to label thumbnails with.
 */
function extractImages(html: string | null): EmailImage[] {
  if (!html) return [];
  const out = new Map<string, EmailImage>();
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const srcMatch = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const url = srcMatch[1]!.trim();
    if (!/^https?:\/\//i.test(url)) continue;
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (TRACKING_HOSTS.test(host)) continue;
    // Heuristic 1×1 / 2×2 pixel filter via attribute width/height.
    const w = Number(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] ?? '');
    const h = Number(tag.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] ?? '');
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w <= 2 && h <= 2)
      continue;
    // Heuristic URL paths that scream tracker.
    if (/\/(open|track|pixel|beacon|metric|impression)[/.?]/i.test(url)) continue;
    if (out.has(url)) continue;
    const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1]?.trim();
    out.set(url, alt ? { url, alt } : { url });
  }
  return [...out.values()].slice(0, 30);
}

function extractTopics(subject: string, body: string): string[] {
  const seen = new Map<string, number>();
  // Hashtags first — explicit signal from the user.
  for (const m of `${subject} ${body}`.matchAll(HASHTAG_RE)) {
    const tag = m[1]!.toLowerCase();
    seen.set(tag, (seen.get(tag) ?? 0) + 5);
  }
  // Capitalized noun-ish phrases from the subject (high signal).
  for (const m of subject.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g)) {
    const phrase = m[1]!.toLowerCase();
    if (phrase.length < 3 || STOPWORDS.has(phrase)) continue;
    seen.set(phrase, (seen.get(phrase) ?? 0) + 3);
  }
  // Capitalized phrases from the body (lower weight).
  for (const m of body.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g)) {
    const phrase = m[1]!.toLowerCase();
    if (phrase.length < 3 || STOPWORDS.has(phrase)) continue;
    seen.set(phrase, (seen.get(phrase) ?? 0) + 1);
  }
  const sorted = [...seen.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 8).map(([w]) => w);
}

function computeSpam(
  parsed: ParsedMail,
  subject: string,
  body: string,
  links: EmailLink[],
  fromAddr: string | null,
): { score: number; signals: string[]; isMassMailing: boolean } {
  let score = 0;
  const signals: string[] = [];

  const isMassMailing =
    !!getHeader(parsed, 'List-Unsubscribe') ||
    !!getHeader(parsed, 'List-Id') ||
    !!getHeader(parsed, 'X-Mailer-Bulk') ||
    !!getHeader(parsed, 'Precedence');

  if (SUBJECT_ALL_CAPS_LONG(subject)) {
    score += 0.3;
    signals.push('subject is ALL CAPS');
  }
  if (SUBJECT_BANG.test(subject)) {
    score += 0.2;
    signals.push('subject has 3+ exclamation marks');
  }
  if (SUBJECT_MONEY.test(subject)) {
    score += 0.35;
    signals.push('subject contains money/get-rich pattern');
  }
  if (SUBJECT_PHARMA.test(subject)) {
    score += 0.45;
    signals.push('subject contains classic spam keyword');
  }
  if (fromAddr && SUSPICIOUS_SENDER_RE.test(fromAddr)) {
    score += 0.25;
    signals.push(`suspicious sender local part: ${fromAddr.split('@')[0]}`);
  }
  // Link density — emails that are mostly links tend to be promotional.
  if (body.length > 0) {
    const linkChars = links.reduce((n, l) => n + l.url.length, 0);
    const ratio = linkChars / Math.max(body.length, 1);
    if (ratio > 0.4 && links.length >= 3) {
      score += 0.15;
      signals.push('body is mostly links');
    }
  }
  // No body but lots of HTML — common spam shape.
  if (!body.trim() && links.length > 5) {
    score += 0.2;
    signals.push('empty plaintext body with many links');
  }
  // Sender domain mismatch — From: name claims a brand the address doesn't match.
  // (Cheap check: capital-letter brand in display name not present in domain.)
  const fromName = parsed.from?.value?.[0]?.name ?? '';
  const fromDomain = (fromAddr ?? '').split('@')[1] ?? '';
  if (fromName && fromDomain && /^[A-Z][A-Za-z]{2,}$/.test(fromName.split(' ')[0] ?? '')) {
    const brandWord = (fromName.split(' ')[0] ?? '').toLowerCase();
    if (brandWord.length >= 3 && !fromDomain.toLowerCase().includes(brandWord)) {
      score += 0.1;
      signals.push(`display name "${fromName}" doesn't match sender domain`);
    }
  }

  return { score: Math.min(1, score), signals, isMassMailing };
}

/**
 * Derive a sender-brand tag from the From address. e.g.
 *   no-reply@medium.com           → "Medium"
 *   notifications@github.com      → "Github"
 *   alerts@mail.notion.so         → "Notion"
 *   foo@subdomain.googlemail.com  → "Googlemail"
 *
 * Returns null for personal-email providers + free-mail domains where
 * the brand is not informative ("gmail" tag would be useless), and for
 * IPs / localhost / malformed addresses.
 */
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'pm.me',
  'fastmail.com',
  'fastmail.fm',
]);

const COMMON_SENDER_PREFIXES = new Set([
  'mail',
  'email',
  'mailer',
  'send',
  'smtp',
  'notify',
  'notification',
  'notifications',
  'reply',
  'no-reply',
  'noreply',
  'updates',
  'news',
  'newsletter',
  'press',
  'team',
  'support',
  'info',
  'hello',
  'contact',
]);

export function senderDomainTag(addr: string | null | undefined): string | null {
  if (!addr) return null;
  const at = addr.lastIndexOf('@');
  if (at < 0) return null;
  const host = addr.slice(at + 1).toLowerCase().trim();
  if (!host || host.includes(' ') || host.startsWith('[')) return null;
  if (PERSONAL_EMAIL_DOMAINS.has(host)) return null;
  // Strip common mail-routing subdomain prefixes like "mail.", "email.",
  // "notifications." so we land on the brand domain.
  const parts = host.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  while (parts.length > 2 && COMMON_SENDER_PREFIXES.has(parts[0]!)) {
    parts.shift();
  }
  // The brand is the second-level label. e.g. medium.com → "medium",
  // notion.so → "notion", news.ycombinator.com → "ycombinator".
  const label = parts[parts.length - 2];
  if (!label || label.length < 2 || label.length > 32) return null;
  if (PERSONAL_EMAIL_DOMAINS.has(parts.slice(-2).join('.'))) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function extractEmailMetadata(
  parsed: ParsedMail,
  cleanedText: string,
  html: string | null,
): EmailMetadata {
  const subject = (parsed.subject ?? '').trim();
  const fromAddr = parsed.from?.value?.[0]?.address?.toLowerCase() ?? null;
  const links = extractLinks(cleanedText || '', html);
  const images = extractImages(html);
  const topics = extractTopics(subject, cleanedText || '');
  const brand = senderDomainTag(fromAddr);
  if (brand) {
    // Lowercased for consistency with the rest of the topic pipeline,
    // but de-duped so we don't double-count if the LLM also picked it.
    const tag = brand.toLowerCase();
    if (!topics.includes(tag)) topics.unshift(tag);
  }
  const priority = derivePriority(parsed, subject);
  const { score, signals, isMassMailing } = computeSpam(
    parsed,
    subject,
    cleanedText || '',
    links,
    fromAddr,
  );
  return {
    priority,
    topics,
    links,
    images,
    spamScore: score,
    spamSignals: signals,
    isMassMailing,
  };
}
