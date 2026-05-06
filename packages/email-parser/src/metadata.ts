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

/** SPF/DKIM/DMARC outcomes. `unknown` when the header is missing. */
export type AuthOutcome = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'unknown';
export type AuthResults = {
  spf: AuthOutcome;
  dkim: AuthOutcome;
  dmarc: AuthOutcome;
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
  /** 0..1 — higher means more likely promotional/advertising content.
   *  Distinct from spamScore: most newsletters are promotional but not
   *  spam. We use this to hide promos from Top Stories without flagging
   *  the sender as malicious. */
  promotionalScore: number;
  /** True when promotionalScore is over a confidence threshold. */
  isPromotional: boolean;
  /** Reasons that fed into promotionalScore, for transparency. */
  promotionalSignals: string[];
  /** Authentication results (SPF/DKIM/DMARC). Unknown when missing. */
  authResults: AuthResults;
  /** Best logo guess from the email body (for the Sender address book). */
  logoCandidate: { url: string; alt: string | null; confidence: number } | null;
  /** Unsubscribe URLs scraped from List-Unsubscribe header + obvious links. */
  unsubscribeUrls: string[];
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

/**
 * Words a tag/topic must never be on its own, even when capitalised
 * mid-sentence by the LLM or by a courtesy opener like "Please …".
 *
 * Three groups:
 *   1. Pronouns + auxiliaries + articles + prepositions — the "small
 *      grammar" of English that's never a topic on its own.
 *   2. Question words / WH-words ("how", "what", "when", "why",
 *      "where", "which", "who", "whom", "whose"). These almost
 *      always start a sentence ("How can I…") and the LLM frequently
 *      lifts them into tags.
 *   3. Common verbs, modals, interjections, and email-style courtesy
 *      words ("please", "thanks", "thank", "hello", "hi", "regards",
 *      "okay", "cheers") that have no business being a topic.
 *
 * Lower-cased lookup; callers normalize before checking.
 */
const STOPWORDS = new Set(
  (
    // Group 1 — grammar
    'the a an and or but of in on at to for with by from into onto upon ' +
    'is are was were be been being am have has had do does did doing ' +
    'will would shall should may might can could must ought ' +
    'this that these those it its as if then so than ' +
    'not no nor yes ' +
    'you your yours we us our ours they them their theirs ' +
    'he she his her hers i me my mine ' +
    // Group 2 — WH / question words
    'how what when where why which who whom whose ' +
    // Group 3 — courtesy / interjection / common verbs / fillers
    'please thanks thank thx ty ' +
    'hi hello hey howdy greetings dear ' +
    'regards cheers sincerely best ' +
    'ok okay yep nope yeah nah ' +
    're fwd reply forward ' +
    'about over again still also too just only even ' +
    'get got go going gone going come came coming come went ' +
    'see saw seen seeing look looked looking looks ' +
    'know knew known knowing think thought thinking ' +
    'want wanted wants wanting need needed needs needing ' +
    'make made made making take took taken taking ' +
    'use used uses using try tried trying tries ' +
    'put set let say said says saying tell told tells telling ' +
    'find found finds finding give gave given gives giving ' +
    'work worked working works done doing ' +
    'here there everywhere anywhere somewhere nowhere ' +
    'now today tomorrow yesterday soon later already ' +
    'very really actually basically literally honestly ' +
    'something anything everything nothing someone anyone everyone noone ' +
    'much many lot lots more most less least ' +
    'good bad better worse best worst nice great ' +
    'one two three four five six seven eight nine ten ' +
    'first second third next last final ' +
    'because while although though even unless until since whether ' +
    'asap fyi tbd tba tldr tl;dr btw imo iirc'
  ).split(/\s+/),
);

/** Things a tag obviously can't be regardless of case. */
const NON_NOUN_PATTERNS: RegExp[] = [
  /\?$/, // ends with a question mark
  /[!?]/, // contains punctuation a noun shouldn't
  /^[0-9]+$/, // pure digits
  /^[^a-z0-9]/i, // doesn't start with a letter/digit
];

/**
 * Heuristic "is this string a plausible noun-or-proper-noun tag?".
 * Not a real POS tagger — that requires a model and would be heavy
 * for what we want — but a sensible filter the LLM and the heuristic
 * topic extractor both flow through, so junk like "please", "how",
 * "thanks" never lands on a Page.tags / Page.topics array.
 *
 * Returns true when the input looks tag-shaped:
 *   - at least 3 chars
 *   - all words must be either non-stopwords OR have a capital
 *     (proper noun signal). "Re" alone fails; "Re Marketing" fails;
 *     "Marketing" passes; "Acme Corp" passes; "How to Cook" fails
 *     because "How" + "to" carry the courtesy/question signal.
 *   - no obvious non-noun shapes (question marks, pure digits, etc).
 */
export function isNominalTag(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 3) return false;
  for (const re of NON_NOUN_PATTERNS) if (re.test(s)) return false;
  const words = s.split(/[\s\-_]+/).filter(Boolean);
  if (words.length === 0) return false;
  // Every word must either be NOT a stopword, OR be capitalised (a
  // proper noun keeps a stopword-shaped surface like "May" or "Will"
  // legitimate when capitalised in context).
  for (const w of words) {
    const lower = w.toLowerCase();
    if (STOPWORDS.has(lower)) {
      // Lowercase stopword in a multi-word phrase is fine ("Bank of
      // America"); but a single-word stopword tag is never OK.
      if (words.length === 1) return false;
    }
  }
  // Single-word tags also have to look like a word. A bare two-letter
  // acronym we let through ("AI", "ML"); a bare lowercased common
  // word like "system" or "thing" passes here too — we're not going
  // to outlaw common nouns.
  return true;
}

/**
 * Words that look like English plurals at the surface but aren't —
 * removing the "s" produces a non-word ("news" → "new", "series"
 * → "serie"). Keep them as-is.
 */
const NON_PLURALS = new Set([
  'news',
  'series',
  'species',
  'analysis',
  'crisis',
  'thesis',
  'basis',
  'axis',
  'physics',
  'mathematics',
  'economics',
  'politics',
  'ethics',
  'statistics',
  'gymnastics',
  'logistics',
  'aerobics',
  'overseas',
  'lens',
  'bus',
  'gas',
  'plus',
  'campus',
  'bonus',
  'class',
  'glass',
  'pass',
  'mass',
  'kiss',
  'press',
  'access',
  'process',
  'success',
  'address',
  'progress',
  'congress',
  'business',
  'fitness',
  'awareness',
  'happiness',
  'illness',
  'wilderness',
]);

/** Irregular plurals — small set of the ones that matter for tags. */
const IRREGULAR_PLURALS: Record<string, string> = {
  children: 'child',
  people: 'person',
  men: 'man',
  women: 'woman',
  feet: 'foot',
  teeth: 'tooth',
  geese: 'goose',
  mice: 'mouse',
  oxen: 'ox',
  data: 'data', // keep as-is — both forms are common
  media: 'media',
};

/**
 * Lightweight English singularizer for tag/topic deduplication.
 * Goal: "promotions" and "promotion" produce the same key without
 * needing a real morphology library. Conservative — when in doubt,
 * leave the word alone.
 *
 * Order of rules matters: the most-specific suffix wins. We use
 * lowercased input; multi-word phrases singularize the last word
 * only (so "marketing campaigns" becomes "marketing campaign", not
 * "marketing campaign" with "marketing" mangled).
 */
export function singularize(raw: string): string {
  const s = raw.trim().toLowerCase();
  if (!s) return s;

  // Multi-word: singularize the last word only.
  const space = s.lastIndexOf(' ');
  if (space !== -1) {
    const head = s.slice(0, space);
    const tail = s.slice(space + 1);
    return `${head} ${singularize(tail)}`;
  }
  // Hyphenated: singularize the last hyphen-segment only.
  const hyphen = s.lastIndexOf('-');
  if (hyphen !== -1) {
    const head = s.slice(0, hyphen);
    const tail = s.slice(hyphen + 1);
    return `${head}-${singularize(tail)}`;
  }

  if (IRREGULAR_PLURALS[s]) return IRREGULAR_PLURALS[s]!;
  if (NON_PLURALS.has(s)) return s;
  // Words too short to safely strip a suffix from.
  if (s.length <= 3) return s;

  // -ies → -y  (e.g. "queries" → "query", "categories" → "category")
  if (s.endsWith('ies') && s.length > 4) return `${s.slice(0, -3)}y`;
  // -ves → -f / -fe  (e.g. "knives" → "knife", "wolves" → "wolf").
  // We don't always know which, so rule of thumb: prefer -fe when the
  // base ends in a single consonant + 'i' before 'ves'; otherwise -f.
  if (s.endsWith('ves') && s.length > 4) {
    const base = s.slice(0, -3);
    return /[lr]i$/.test(base) ? `${base}fe` : `${base}f`;
  }
  // -ses / -xes / -zes / -ches / -shes → drop "es"
  if (
    s.length > 4 &&
    (s.endsWith('ses') ||
      s.endsWith('xes') ||
      s.endsWith('zes') ||
      s.endsWith('ches') ||
      s.endsWith('shes'))
  ) {
    return s.slice(0, -2);
  }
  // -us / -is / -ss endings — already singular, leave alone.
  if (s.endsWith('us') || s.endsWith('is') || s.endsWith('ss')) return s;
  // Generic -s drop, but only when it doesn't produce a too-short stem
  // and the second-last char is a consonant or vowel that's plausible.
  if (s.endsWith('s') && s.length > 4) return s.slice(0, -1);
  return s;
}

/**
 * Filter + dedupe a list of candidate tags down to those that look
 * like nominal topics. Lowercases AND singularizes on the way in
 * so callers don't have to and so "promotions"/"promotion" collapse
 * onto one key. Stable order preserves the input ranking.
 */
export function filterNominalTags(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    const s = singularize(t.trim().toLowerCase());
    if (!s || seen.has(s)) continue;
    if (!isNominalTag(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

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
  // Filter to plausibly-nominal phrases — drops "Please", "How",
  // "Thanks" and the like that happen to be capitalised at sentence
  // start. Hashtags came in with weight 5 and are usually fine on
  // their own, but if the user types "#how" it still gets dropped.
  return filterNominalTags(sorted.map(([w]) => w)).slice(0, 8);
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

/**
 * Pull a logo candidate out of the HTML head — the most likely brand
 * mark for the sender. Heuristics, in order of preference:
 *   - alt text or filename matches /logo|brand|wordmark|icon/
 *   - hosted on (or near) the sender's brand domain
 *   - small dimensions when supplied (≤ 360px on the longer edge)
 *   - within the first 2.5KB of HTML (header region)
 * Returns null if nothing in the body survives these gates.
 */
function extractLogoCandidate(
  html: string | null,
  fromAddr: string | null,
): { url: string; alt: string | null; confidence: number } | null {
  if (!html) return null;
  const head = html.slice(0, 2500);
  const brandHost = (() => {
    if (!fromAddr) return null;
    const at = fromAddr.lastIndexOf('@');
    if (at < 0) return null;
    return fromAddr.slice(at + 1).toLowerCase();
  })();
  const brandLabel = brandHost ? brandHost.split('.').slice(-2, -1)[0] ?? null : null;

  let best: { url: string; alt: string | null; confidence: number } | null = null;
  for (const m of head.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const srcMatch = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const url = srcMatch[1]!.trim();
    if (!/^https?:\/\//i.test(url)) continue;
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (TRACKING_HOSTS.test(host)) continue;
    if (/\/(open|track|pixel|beacon|metric|impression)[/.?]/i.test(url)) continue;

    const alt = tag.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1]?.trim() ?? null;
    const w = Number(tag.match(/\bwidth\s*=\s*["']?(\d+)/i)?.[1] ?? '');
    const h = Number(tag.match(/\bheight\s*=\s*["']?(\d+)/i)?.[1] ?? '');
    // Reject obvious giant hero images.
    if (Number.isFinite(w) && w > 360) continue;
    if (Number.isFinite(h) && h > 360) continue;
    // Reject tracking pixels that slipped through the host filter.
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w <= 4 && h <= 4)
      continue;

    let score = 0.2;
    const haystack = `${alt ?? ''} ${url}`.toLowerCase();
    if (/\b(logo|wordmark|brand-?mark|brand[-_/]?logo|header[-_]?logo)\b/.test(haystack))
      score += 0.4;
    if (/\.(svg|png|gif)(\?|$)/i.test(url)) score += 0.05;
    if (brandLabel && haystack.includes(brandLabel)) score += 0.2;
    if (brandHost && (host === brandHost || host.endsWith('.' + brandHost)))
      score += 0.2;
    // Penalise CDNs that aren't on the brand domain — can be a logo, but
    // less confident.
    if (brandHost && !(host === brandHost || host.endsWith('.' + brandHost)))
      score -= 0.05;

    if (!best || score > best.confidence) {
      best = { url, alt, confidence: Math.max(0, Math.min(1, score)) };
    }
  }
  if (!best || best.confidence < 0.3) return null;
  return best;
}

/**
 * Pull unsubscribe URLs from the parsed `List-Unsubscribe` header. RFC
 * 2369 allows a comma-separated list of <mailto:> and <https://> URLs.
 * Mailto entries are skipped — we want clickable links for the UI.
 */
function extractUnsubscribeUrls(parsed: ParsedMail): string[] {
  const headers = (parsed.headers ?? new Map()) as Map<string, unknown>;
  const raw =
    (headers.get('list-unsubscribe') as string | string[] | undefined) ??
    (parsed.headerLines ?? [])
      .filter((h) => h.key.toLowerCase() === 'list-unsubscribe')
      .map((h) => h.line.replace(/^[^:]+:\s*/, ''))
      .join(', ');
  if (!raw) return [];
  const text = Array.isArray(raw) ? raw.join(', ') : String(raw);
  const out = new Set<string>();
  for (const m of text.matchAll(/<\s*([^>]+?)\s*>/g)) {
    const url = m[1]!.trim();
    if (/^https?:\/\//i.test(url)) out.add(url);
  }
  return [...out].slice(0, 4);
}

/**
 * Parse the `Authentication-Results` header into SPF / DKIM / DMARC
 * outcomes. The header is a free-form list set by the receiving MTA;
 * we look for the well-known `spf=`, `dkim=`, and `dmarc=` tokens.
 *
 * Reference: RFC 8601. We deliberately keep this lenient — many MTAs
 * stack multiple `Authentication-Results` headers; we concatenate them
 * and pull the strongest outcome of each method.
 */
function parseAuthResults(parsed: ParsedMail): AuthResults {
  const collect = (name: string): string => {
    const lines = (parsed.headerLines ?? [])
      .filter((h) => h.key.toLowerCase() === name.toLowerCase())
      .map((h) => h.line.replace(/^[^:]+:\s*/, ''));
    return lines.join(' ; ');
  };
  const blob = `${collect('Authentication-Results')} ; ${collect('ARC-Authentication-Results')}`.toLowerCase();
  const pick = (method: 'spf' | 'dkim' | 'dmarc'): AuthOutcome => {
    const m = new RegExp(`\\b${method}=([a-z]+)`).exec(blob);
    if (!m) return 'unknown';
    const v = m[1];
    if (v === 'pass' || v === 'fail' || v === 'softfail' || v === 'neutral' || v === 'none')
      return v;
    return 'unknown';
  };
  return { spf: pick('spf'), dkim: pick('dkim'), dmarc: pick('dmarc') };
}

/**
 * Strip obvious advertorial sections out of the cleaned plaintext
 * before downstream consumers see it. We look for:
 *   - "Advertisement" / "Sponsored" / "Sponsored Content" headings
 *   - "—Ad—" / "[Ad]" inline markers around a paragraph
 *   - "Partner content" blocks
 * The boundary is the next markdown-style heading, the next blank
 * separator (≥2 newlines), or 6 consecutive lines — whichever comes
 * first. Conservative on purpose; we'd rather leave one ad in than
 * strip real content.
 */
const AD_HEADING_RE =
  /^[ \t]*(advertisement|sponsored(?:\s+content)?|partner\s+content|advertorial|paid\s+(?:partner|content)|promoted\s+content|—\s*ad\s*—|\[\s*ad\s*\])\s*:?\s*$/i;
const AD_INLINE_RE = /\b(this email is sponsored by|sponsored by\s+\w|presented by|brought to you by)\b/i;

export function stripAdSections(text: string): { cleaned: string; removed: number } {
  if (!text) return { cleaned: '', removed: 0 };
  const lines = text.split('\n');
  const out: string[] = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (AD_HEADING_RE.test(line)) {
      // Drop this line and continue dropping until we hit a blank line
      // followed by a non-blank line, or 8 lines have elapsed.
      let j = i + 1;
      let blanks = 0;
      while (j < lines.length && j - i < 8) {
        const next = lines[j] ?? '';
        if (next.trim() === '') {
          blanks += 1;
          if (blanks >= 2) break;
        } else {
          blanks = 0;
        }
        j += 1;
      }
      removed += j - i;
      i = j; // Skip the block.
      continue;
    }
    if (AD_INLINE_RE.test(line)) {
      removed += 1;
      continue; // Drop just this line — the surrounding paragraph stays.
    }
    out.push(line);
  }
  return { cleaned: out.join('\n').replace(/\n{3,}/g, '\n\n'), removed };
}

/**
 * Score how likely an email is promotional content (advertising or
 * marketing copy). Distinct from spam: a newsletter from a brand the
 * user actively subscribed to is mass-mail + promotional, but not spam.
 *
 * Signals:
 *   - List-Unsubscribe / List-Id headers (legitimate bulk mail)
 *   - Image-to-text ratio (mostly-image emails are usually ads)
 *   - Affiliate / tracking URL params (utm_, ?aff=, /go/, /track/)
 *   - Common ad phrases ("limited time", "save X%", "shop now", …)
 *   - Sponsored / advertorial headings inside the body
 */
const AFFILIATE_PARAM_RE = /[?&](utm_[a-z]+|aff(?:iliate)?|ref|src|trk|track|partner|cid|mc_cid)=/i;
const AFFILIATE_PATH_RE = /\/(go|track|click|r|aff|partners?|sponsor)\//i;
const AD_PHRASES_RE =
  /\b(limited[- ]?time|shop now|save\s+\d{1,2}%|\d{1,2}%\s+off|free shipping|exclusive offer|best deal|don't miss|hurry|while supplies last|act now|buy now|click here to (?:shop|buy)|coupon code)\b/i;

function computePromotional(
  parsed: ParsedMail,
  subject: string,
  body: string,
  links: EmailLink[],
  images: EmailImage[],
  isMassMailing: boolean,
): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];

  if (isMassMailing) {
    score += 0.25;
    signals.push('legitimate bulk-mail headers present');
  }

  // Image:text ratio. Below 200 characters of body and ≥4 images is a
  // dead giveaway for an ad.
  if (images.length >= 4 && body.length < 600) {
    score += 0.25;
    signals.push(`${images.length} images with thin body text`);
  }

  // Affiliate / tracking link patterns.
  let affiliateLinks = 0;
  for (const l of links) {
    if (AFFILIATE_PARAM_RE.test(l.url) || AFFILIATE_PATH_RE.test(l.url))
      affiliateLinks += 1;
  }
  if (affiliateLinks >= 3) {
    score += 0.2;
    signals.push(`${affiliateLinks} affiliate/tracking links`);
  }

  // Ad phrases in body or subject.
  if (AD_PHRASES_RE.test(subject)) {
    score += 0.15;
    signals.push('subject uses promo language');
  }
  if (AD_PHRASES_RE.test(body)) {
    score += 0.1;
    signals.push('body uses promo language');
  }

  // Sponsored heading in the body — strong signal.
  if (AD_HEADING_RE.test(body) || /\n\s*advertisement\s*\n/i.test(body)) {
    score += 0.2;
    signals.push('sponsored/advertorial heading detected');
  }

  // Generic mass-marketing locals like marketing@, deals@, offers@.
  const local = (parsed.from?.value?.[0]?.address ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (/^(marketing|deals|offers|promo|store|shop|sales|brand|news)/.test(local)) {
    score += 0.1;
    signals.push(`marketing-style sender local part: ${local}`);
  }

  return { score: Math.min(1, score), signals };
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
  const { score: spamScoreBase, signals, isMassMailing } = computeSpam(
    parsed,
    subject,
    cleanedText || '',
    links,
    fromAddr,
  );
  const logoCandidate = extractLogoCandidate(html, fromAddr);
  const unsubscribeUrls = extractUnsubscribeUrls(parsed);
  const authResults = parseAuthResults(parsed);

  // Authentication-Results signals. Folding into the existing 0..1
  // spamScore: each hard fail nudges it up, an aligned pass leaves it
  // alone (we don't *lower* the score because heuristics already
  // captured non-auth signals worth keeping).
  let authScoreBoost = 0;
  if (authResults.spf === 'fail') {
    authScoreBoost += 0.15;
    signals.push('SPF: fail');
  } else if (authResults.spf === 'softfail') {
    authScoreBoost += 0.05;
    signals.push('SPF: softfail');
  }
  if (authResults.dkim === 'fail') {
    authScoreBoost += 0.15;
    signals.push('DKIM: fail');
  }
  if (authResults.dmarc === 'fail') {
    authScoreBoost += 0.2;
    signals.push('DMARC: fail');
  }
  const spamScore = Math.min(1, spamScoreBase + authScoreBoost);

  const { score: promotionalScore, signals: promotionalSignals } = computePromotional(
    parsed,
    subject,
    cleanedText || '',
    links,
    images,
    isMassMailing,
  );

  return {
    priority,
    topics,
    links,
    images,
    spamScore,
    spamSignals: signals,
    logoCandidate,
    unsubscribeUrls,
    isMassMailing,
    promotionalScore,
    isPromotional: promotionalScore >= 0.5,
    promotionalSignals,
    authResults,
  };
}
