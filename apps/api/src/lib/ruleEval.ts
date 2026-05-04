/**
 * Read-only rule condition evaluator used by the API for test +
 * preview endpoints. Mirrors the worker's `evalCondition` exactly —
 * if you change the matching semantics, change both. Pure: takes a
 * plain email-shaped object and a condition list, returns a boolean.
 */

type Cond = { field: string; op: string; value: unknown };

type EmailLike = {
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  from?: { address?: string | null } | null;
  topics?: string[];
  attachments?: { contentType?: string }[];
  spamScore?: number;
  isPromotional?: boolean;
  authResults?: { spf?: string; dkim?: string; dmarc?: string };
};

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function evalCondition(cond: Cond, email: EmailLike): boolean {
  const v = cond.value;
  switch (cond.field) {
    case 'from.address': {
      const addr = email.from?.address?.toLowerCase() ?? '';
      const want = asString(v).toLowerCase();
      if (cond.op === 'equals') return addr === want;
      if (cond.op === 'endsWith') return addr.endsWith(want);
      if (cond.op === 'matches') {
        try {
          return new RegExp(want, 'i').test(addr);
        } catch {
          return false;
        }
      }
      return false;
    }
    case 'from.domain': {
      const addr = email.from?.address?.toLowerCase() ?? '';
      const dom = addr.includes('@') ? addr.split('@')[1] ?? '' : '';
      if (cond.op === 'equals') return dom === asString(v).toLowerCase();
      if (cond.op === 'in') {
        const list = Array.isArray(v) ? v.map((x) => asString(x).toLowerCase()) : [];
        return list.includes(dom);
      }
      return false;
    }
    case 'subject': {
      const s = (email.subject ?? '').toLowerCase();
      const want = asString(v).toLowerCase();
      if (cond.op === 'contains') return s.includes(want);
      if (cond.op === 'matches') {
        try {
          return new RegExp(asString(v), 'i').test(email.subject ?? '');
        } catch {
          return false;
        }
      }
      return false;
    }
    case 'body': {
      const s = (email.text ?? '').toLowerCase();
      const want = asString(v).toLowerCase();
      if (cond.op === 'contains') return s.includes(want);
      if (cond.op === 'matches') {
        try {
          return new RegExp(asString(v), 'i').test(email.text ?? '');
        } catch {
          return false;
        }
      }
      return false;
    }
    case 'topic': {
      const topics = email.topics ?? [];
      const wantList = Array.isArray(v)
        ? v.map((x) => asString(x).toLowerCase())
        : [asString(v).toLowerCase()];
      return topics.some((t) => wantList.includes(t.toLowerCase()));
    }
    case 'spamScore': {
      const s = email.spamScore ?? 0;
      const want = Number(v);
      if (Number.isNaN(want)) return false;
      if (cond.op === '>=') return s >= want;
      if (cond.op === '<') return s < want;
      return false;
    }
    case 'isPromotional':
      if (cond.op === 'is') return !!email.isPromotional === !!v;
      return false;
    case 'auth.spf':
    case 'auth.dkim':
    case 'auth.dmarc': {
      const which = cond.field.split('.')[1] as 'spf' | 'dkim' | 'dmarc';
      const got = email.authResults?.[which] ?? 'unknown';
      if (cond.op === 'equals') return got === asString(v);
      return false;
    }
    case 'attachment.contentType': {
      try {
        const re = new RegExp(asString(v), 'i');
        return (email.attachments ?? []).some((a) => re.test(a.contentType ?? ''));
      } catch {
        return false;
      }
    }
    case 'size': {
      const s = (email.text?.length ?? 0) + (email.html?.length ?? 0);
      const want = Number(v);
      if (Number.isNaN(want)) return false;
      if (cond.op === '>=') return s >= want;
      if (cond.op === '<') return s < want;
      return false;
    }
  }
  return false;
}

export function matchesRule(conds: Cond[], email: EmailLike): boolean {
  if (conds.length === 0) return true;
  return conds.every((c) => evalCondition(c, email));
}
