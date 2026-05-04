import { Types } from 'mongoose';
import {
  Rule,
  RuleAuditLog,
  type EmailDoc,
  type RuleDoc,
} from '@rose/db';
import { senderDomainTag } from '@rose/email-parser';
import { logger } from '../lib/logger.js';

/**
 * The verdict produced by evaluating every enabled rule against an
 * incoming email. The caller (ingest paths + generatePage) consumes
 * these flags rather than mutating directly, so a single rule pass
 * applies cleanly across email + downstream page generation.
 */
export type RuleVerdict = {
  /** Tags to add to the resulting page on top of LLM-derived ones. */
  addTags: Set<string>;
  /** Tags that, if the LLM emits them, should be removed. */
  removeTags: Set<string>;
  /** Force a page priority. */
  setPriority: 'high' | 'normal' | 'low' | null;
  /** Force `flags.X = true` on the page. */
  setFlags: Record<string, boolean>;
  /** Force topic-mode grouping with this primaryTopic. */
  forceTopicPage: string | null;
  /** Category name to assign (worker creates if missing). */
  assignCategory: string | null;
  /** Skip generating a page entirely (email row stays for audit). */
  archive: boolean;
  /** Force the resulting page into the Quarantine view. */
  quarantine: boolean;
  /** Rules that fired, recorded in the audit log. */
  matchedRules: { ruleId: Types.ObjectId; actions: { kind: string; params: Record<string, unknown> }[] }[];
};

export function emptyVerdict(): RuleVerdict {
  return {
    addTags: new Set(),
    removeTags: new Set(),
    setPriority: null,
    setFlags: {},
    forceTopicPage: null,
    assignCategory: null,
    archive: false,
    quarantine: false,
    matchedRules: [],
  };
}

type Cond = { field: string; op: string; value: unknown };

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function evalCondition(cond: Cond, email: EmailDoc): boolean {
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
      const topics = (email.topics as string[] | undefined) ?? [];
      const wantList = Array.isArray(v) ? v.map((x) => asString(x).toLowerCase()) : [asString(v).toLowerCase()];
      return topics.some((t) => wantList.includes(t.toLowerCase()));
    }
    case 'header': {
      const params = (v ?? {}) as { name?: string; value?: string };
      const name = (params.name ?? '').toLowerCase();
      if (!name) return false;
      // mailparser leaves headers on parsed; we already extract a few
      // into top-level fields. For a generic header lookup, fall
      // through to spamSignals which records auth failures + similar.
      const present = name in (email as unknown as Record<string, unknown>);
      if (cond.op === 'present') return present;
      if (cond.op === 'equals' && params.value) {
        return asString((email as unknown as Record<string, unknown>)[name]).toLowerCase() === params.value.toLowerCase();
      }
      return false;
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
      const got = (email.authResults?.[which] ?? 'unknown') as string;
      if (cond.op === 'equals') return got === asString(v);
      return false;
    }
    case 'attachment.contentType': {
      const list = (email.attachments as { contentType?: string }[] | undefined) ?? [];
      try {
        const re = new RegExp(asString(v), 'i');
        return list.some((a) => re.test(a.contentType ?? ''));
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

function applyAction(
  rule: RuleDoc,
  action: { kind: string; params: Record<string, unknown> },
  v: RuleVerdict,
): { halt: boolean } {
  const p = action.params ?? {};
  switch (action.kind) {
    case 'tag.add': {
      const tags = (Array.isArray(p.tags) ? p.tags : [p.tag]).filter(
        (t): t is string => typeof t === 'string' && !!t,
      );
      for (const t of tags) v.addTags.add(t.toLowerCase());
      return { halt: false };
    }
    case 'tag.remove': {
      const tags = (Array.isArray(p.tags) ? p.tags : [p.tag]).filter(
        (t): t is string => typeof t === 'string' && !!t,
      );
      for (const t of tags) v.removeTags.add(t.toLowerCase());
      return { halt: false };
    }
    case 'priority.set': {
      const pr = p.priority;
      if (pr === 'high' || pr === 'normal' || pr === 'low') v.setPriority = pr;
      return { halt: false };
    }
    case 'flag.set': {
      const name = typeof p.name === 'string' ? p.name : null;
      if (!name) return { halt: false };
      v.setFlags[name] = p.value !== false;
      return { halt: false };
    }
    case 'route.topicPage': {
      const topic = typeof p.primaryTopic === 'string' ? p.primaryTopic.toLowerCase() : null;
      if (topic) v.forceTopicPage = topic;
      return { halt: false };
    }
    case 'assign.category': {
      const name = typeof p.name === 'string' ? p.name : null;
      if (name) v.assignCategory = name;
      return { halt: false };
    }
    case 'archive':
      v.archive = true;
      return { halt: true };
    case 'quarantine':
      v.quarantine = true;
      return { halt: false };
    case 'halt':
      return { halt: true };
  }
  logger.warn({ kind: action.kind, ruleId: String(rule._id) }, 'rules: unknown action kind');
  return { halt: false };
}

/**
 * Run every enabled rule for the user against `email`. Returns a
 * verdict the caller folds into its existing pipeline (page assignment,
 * generation, etc). Audit-log writes are best-effort.
 */
export async function evaluateRules(
  userId: Types.ObjectId,
  email: EmailDoc,
): Promise<RuleVerdict> {
  const v = emptyVerdict();
  const rules = await Rule.find({ userId, enabled: true })
    .sort({ priority: 1, createdAt: 1 })
    .lean();
  if (!rules.length) return v;

  for (const rule of rules) {
    const conds = ((rule.conditions ?? []) as Cond[]) || [];
    const matches = conds.length === 0 || conds.every((c) => evalCondition(c, email));
    if (!matches) continue;
    const applied: { kind: string; params: Record<string, unknown> }[] = [];
    let halt = false;
    for (const a of (rule.actions ?? []) as { kind: string; params: Record<string, unknown> }[]) {
      const r = applyAction(rule as unknown as RuleDoc, a, v);
      applied.push(a);
      if (r.halt) {
        halt = true;
        break;
      }
    }
    v.matchedRules.push({ ruleId: rule._id as Types.ObjectId, actions: applied });
    // Bump counters async — fire-and-forget; failure is fine.
    Rule.updateOne(
      { _id: rule._id },
      { $inc: { matchCount: 1 }, $set: { lastMatchedAt: new Date() } },
    ).catch(() => null);
    RuleAuditLog.create({
      userId,
      ruleId: rule._id,
      emailId: email._id,
      actions: applied,
    }).catch(() => null);
    if (halt) break;
  }

  // De-duplicate: tags removed by a later rule shouldn't also appear
  // in the addTags set.
  for (const t of v.removeTags) v.addTags.delete(t);

  // Calling code uses the synthesised brand domain elsewhere; stash
  // it on the verdict for free for actions like assign.category that
  // might want it. (Currently no consumer; leaving for future.)
  void senderDomainTag;
  return v;
}

/** Persist verdict-driven state on the email row. Called by ingest
 *  paths so an `archive` verdict gets reflected immediately and
 *  generate-page never runs. */
export async function applyArchiveVerdict(email: EmailDoc, v: RuleVerdict): Promise<void> {
  if (v.archive) {
    email.ingestStatus = 'skipped';
    await email.save();
  }
}
