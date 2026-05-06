import { Worker, type Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import {
  Email,
  Page,
  PageRevision,
  Instruction,
  Category,
  normalizeCategoryName,
  User,
  Sender,
  type EmailDoc,
  type PageDoc,
} from '@rose/db';
import {
  SYSTEM_PROMPT_BASE,
  extractJson,
  renderTemplate,
} from '@rose/llm';
import { PageGenerationDraft, PageMergeDraft, slugify, type CitationMap } from '@rose/shared';
import { stripAdSectionsStrict, filterNominalTags } from '@rose/email-parser';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { resolveProviderForUser, applyParamOverrides } from '../lib/providers.js';
import {
  ensureEmailEmbedding,
  findPageForEmail,
  findTopicPageForItem,
  recomputeCentroid,
} from '../services/pageAssignment.js';
import { upsertSendersFromPage } from '../services/senderUpsert.js';
import { bayesScoreFor } from '../lib/bayesScore.js';
import { evaluateRules, type RuleVerdict, emptyVerdict } from '../services/rules.js';
import { dispatchWebhookEvent } from './webhookDeliver.js';
import { evaluatePageNotifications } from './pushNotify.js';
import { describePageImages } from '../services/describeImages.js';
import { extractPlacesFromPage, hashContent } from '../services/extractPlaces.js';
import { geocode, normalizePlaceKey } from '../lib/geocode.js';
import {
  extractEventsForPage,
  syncEventsToPage,
} from '../services/eventExtraction.js';

const QUEUE = 'rose.generate-page';
const embedQueue = new Queue('rose.embed-page', { connection: redis });

type GenerateJobData = { emailId: string; userId: string };

async function getInstructionTemplate(
  userId: Types.ObjectId,
  scope: 'generate' | 'categorize' | 'consolidate',
): Promise<string> {
  const userDefault = await Instruction.findOne({ userId, scope, isDefault: true });
  if (userDefault) return userDefault.template;
  const system = await Instruction.findOne({ userId, scope, isSystem: true });
  return system?.template ?? '';
}

/** Group emails by threadKey, preserving chronological order within a thread. */
function groupByThread(emails: EmailDoc[]): EmailDoc[][] {
  const buckets = new Map<string, EmailDoc[]>();
  for (const e of emails) {
    const key = e.threadKey ?? `__loose:${String(e._id)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(e);
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : 0;
      const db = b.date ? new Date(b.date).getTime() : 0;
      return da - db;
    });
  }
  return [...buckets.values()].sort((a, b) => {
    const da = a[0]?.date ? new Date(a[0].date).getTime() : 0;
    const db = b[0]?.date ? new Date(b[0].date).getTime() : 0;
    return da - db;
  });
}

/** Render thread groups for the LLM with stable e1..eN labels. Returns the
 *  rendered prompt block plus the label→email mapping for citations.
 *  When `stripAdsFor` returns true for an email's address, the body gets
 *  the aggressive ad-strip pass before being sliced into the prompt — so
 *  the LLM never has to summarise sponsored breaks. */
function renderLabeledThreads(
  emails: EmailDoc[],
  stripAdsFor: (address: string | undefined | null) => boolean = () => false,
  /**
   * Optional label-number offset. Defaults to 0 (labels start at e1).
   * Incremental generation passes the highest existing label so new
   * emails get e<N+1>, e<N+2>, … and don't collide with citation
   * markers already present in the existing contentMd.
   */
  startN: number = 0,
): {
  text: string;
  labels: { label: string; email: EmailDoc }[];
} {
  const groups = groupByThread(emails);
  const labels: { label: string; email: EmailDoc }[] = [];
  const blocks: string[] = [];
  let n = startN;
  groups.forEach((group, gi) => {
    const subject = group[0]?.subject || '(no subject)';
    const dateRange = (() => {
      const ds = group.map((e) => (e.date ? new Date(e.date) : null)).filter((d): d is Date => !!d);
      if (!ds.length) return '';
      const lo = new Date(Math.min(...ds.map((d) => d.getTime()))).toISOString().slice(0, 10);
      const hi = new Date(Math.max(...ds.map((d) => d.getTime()))).toISOString().slice(0, 10);
      return lo === hi ? lo : `${lo} → ${hi}`;
    })();
    const head = `THREAD ${gi + 1}: "${subject}" (${group.length} msg${group.length > 1 ? 's' : ''}${dateRange ? `, ${dateRange}` : ''})`;
    const body = group
      .map((e) => {
        n += 1;
        const label = `e${n}`;
        labels.push({ label, email: e });
        const from = e.from?.address ?? 'unknown';
        const date = e.date ? new Date(e.date).toISOString() : '';
        const subj = e.subject ?? '';
        let text = e.text || e.rawText || '';
        if (stripAdsFor(e.from?.address)) {
          text = stripAdSectionsStrict(text).cleaned;
        }
        text = text.slice(0, 6000);
        return `  [${label}] From: ${from} | Date: ${date} | Subject: ${subj}\n  """\n  ${text.replace(/\n/g, '\n  ')}\n  """`;
      })
      .join('\n');
    blocks.push(`${head}\n${body}`);
  });
  return { text: blocks.join('\n\n'), labels };
}

/** Extract `[e1]` or `[e1, e3]` tokens that the LLM actually emitted. */
function extractCitedLabels(md: string): Set<string> {
  const seen = new Set<string>();
  for (const m of md.matchAll(/\[((?:e\d+\s*,\s*)*e\d+)\]/g)) {
    for (const label of m[1]!.split(',')) {
      const trimmed = label.trim();
      if (/^e\d+$/.test(trimmed)) seen.add(trimmed);
    }
  }
  return seen;
}

function describeSenders(emails: EmailDoc[]): string {
  const counts = new Map<string, number>();
  for (const e of emails) {
    const a = e.from?.address?.toLowerCase();
    if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return 'Sender info unavailable.';
  const top = sorted.slice(0, 3).map(([a, n]) => `${a} (${n})`).join(', ');
  const more = sorted.length > 3 ? `, +${sorted.length - 3} more sender(s)` : '';
  return `Senders contributing to this page: ${top}${more}.`;
}

const PROMPT_EMAIL_LIMIT = 12;

/**
 * For high-volume notification streams (e.g. 100 GH Actions failure emails)
 * we don't want to send every body to the LLM — context cost balloons and
 * the model produces a per-message log instead of a synthesis. Take the
 * newest N and roll the rest into a metadata summary.
 */
function selectEmailsForPrompt(
  emails: EmailDoc[],
): { selected: EmailDoc[]; elidedSummary: string } {
  if (emails.length <= PROMPT_EMAIL_LIMIT) return { selected: emails, elidedSummary: '' };
  const sorted = [...emails].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return db - da;
  });
  const selected = sorted.slice(0, PROMPT_EMAIL_LIMIT).reverse(); // chronological
  const elided = sorted.slice(PROMPT_EMAIL_LIMIT);
  const dates = elided
    .map((e) => (e.date ? new Date(e.date) : null))
    .filter((d): d is Date => !!d);
  const range =
    dates.length > 0
      ? `${new Date(Math.min(...dates.map((d) => d.getTime()))).toISOString().slice(0, 10)} → ${new Date(Math.max(...dates.map((d) => d.getTime()))).toISOString().slice(0, 10)}`
      : 'unknown range';
  return {
    selected,
    elidedSummary: `${elided.length} additional similar messages omitted from this prompt for brevity (date range: ${range}). Acknowledge their existence in the summary and counts; do not invent details about them.`,
  };
}

/** True when most of the page's emails share the same subject template. */
function isNotificationStream(emails: EmailDoc[]): {
  yes: boolean;
  template: string | null;
  ratio: number;
} {
  if (emails.length < 3) return { yes: false, template: null, ratio: 0 };
  const counts = new Map<string, number>();
  for (const e of emails) {
    const t = e.subjectTemplate;
    if (!t) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  if (!counts.size) return { yes: false, template: null, ratio: 0 };
  const [topTemplate, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  const ratio = topCount / emails.length;
  return { yes: ratio >= 0.7, template: topTemplate, ratio };
}

/** Total length of meaningful body text across all emails on the page. */
function totalBodyChars(emails: EmailDoc[]): number {
  let n = 0;
  for (const e of emails) n += (e.text || e.rawText || '').trim().length;
  return n;
}

function dateRangeOf(emails: EmailDoc[]): string {
  const ds = emails
    .map((e) => (e.date ? new Date(e.date) : null))
    .filter((d): d is Date => !!d);
  if (!ds.length) return '';
  const lo = new Date(Math.min(...ds.map((d) => d.getTime())));
  const hi = new Date(Math.max(...ds.map((d) => d.getTime())));
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return fmt(lo) === fmt(hi) ? fmt(lo) : `${fmt(lo)} → ${fmt(hi)}`;
}

/**
 * Pull place entities out of the page body, geocode each, and
 * persist to Page.places. Only runs when the user has Settings →
 * Maps enabled. Idempotent — bails out fast if the content hash
 * matches the one stored on the last successful run, so a
 * regenerate that doesn't change the body doesn't burn an LLM
 * call. Plan 11.
 */
async function runPlacesExtraction(
  userId: Types.ObjectId,
  page: PageDoc,
): Promise<void> {
  const user = await User.findById(userId).select('settings.maps').lean();
  const enabled = !!(
    (user?.settings as { maps?: { enabled?: boolean } } | undefined)?.maps?.enabled
  );
  if (!enabled) return;
  const hash = hashContent(page.contentMd ?? '');
  if (hash && page.placesExtractedFromHash === hash) return;

  const extracted = await extractPlacesFromPage(userId, page);
  // Build a key→entry map so re-extracting drops places that no
  // longer appear AND keeps existing geocoded entries (we
  // shouldn't re-geocode an already-resolved place).
  const existing = new Map<string, (typeof page.places)[number]>();
  for (const p of (page.places ?? []) as (typeof page.places)[number][]) {
    existing.set(p.normKey, p);
  }
  const next: (typeof page.places)[number][] = [];
  for (const e of extracted) {
    const normKey = normalizePlaceKey(e.name);
    if (!normKey) continue;
    const prior = existing.get(normKey);
    if (prior?.lat != null && prior.lon != null) {
      // Already geocoded — keep as-is.
      next.push(prior);
      continue;
    }
    if (prior?.failed) {
      // Failed in a prior run — keep the failure flag rather than
      // grinding Nominatim again on the same dead string.
      next.push(prior);
      continue;
    }
    let lat: number | null = null;
    let lon: number | null = null;
    let displayName: string | null = null;
    let failed = false;
    try {
      const r = await geocode(e.name);
      if (r) {
        lat = r.lat;
        lon = r.lon;
        displayName = r.displayName;
      } else {
        failed = true;
      }
    } catch (err) {
      logger.warn({ err, name: e.name }, 'page place geocode failed');
      failed = true;
    }
    next.push({
      name: e.name.slice(0, 200),
      normKey,
      lat,
      lon,
      displayName,
      geocodedAt: lat != null ? new Date() : null,
      failed,
    } as (typeof page.places)[number]);
  }
  page.places = next as typeof page.places;
  page.placesExtractedFromHash = hash;
  page.markModified('places');
  await page.save();
}

export function startGeneratePageWorker() {
  const worker = new Worker<GenerateJobData>(
    QUEUE,
    async (job: Job<GenerateJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      // NOTE: `.select('+embedding embeddingModel')` switches Mongoose into
      // inclusion mode and returns ONLY those two fields — that bug erased
      // subject/from/date/text and produced "(no subject) — unknown sender"
      // pages for every email. Using a single `+`-prefixed field correctly
      // augments the default selection.
      logger.info(
        { jobId: String(job.id), emailId: job.data.emailId, userId: job.data.userId },
        'generate-page: start',
      );
      const triggerEmail = await Email.findOne({
        _id: job.data.emailId,
        userId,
      }).select('+embedding');
      if (!triggerEmail) {
        logger.warn(
          { jobId: String(job.id), emailId: job.data.emailId },
          'generate-page: trigger email not found — skipping (probably deleted before job ran)',
        );
        throw new Error('Email not found');
      }
      logger.debug(
        {
          emailId: String(triggerEmail._id),
          subject: triggerEmail.subject,
          from: triggerEmail.from?.address,
          kind: triggerEmail.kind,
          status: triggerEmail.ingestStatus,
          textLen: (triggerEmail.text ?? '').length,
        },
        'generate-page: loaded trigger email',
      );

      await job.updateProgress({ type: 'started', jobId: String(job.id) });

      // Run user-defined rules first. If any rule archives the email,
      // skip all downstream work entirely.
      let verdict: RuleVerdict = emptyVerdict();
      try {
        verdict = await evaluateRules(userId, triggerEmail);
      } catch (err) {
        logger.warn({ err }, 'rule evaluation failed; continuing without verdict');
      }
      if (verdict.archive) {
        triggerEmail.ingestStatus = 'skipped';
        await triggerEmail.save();
        logger.info(
          { emailId: String(triggerEmail._id), matched: verdict.matchedRules.length },
          'rules: archive verdict — skipping generation',
        );
        return { skipped: true, reason: 'archived-by-rule' } as unknown as { pageId: string; slug: string };
      }

      // Ensure the trigger email has a cached embedding before assignment.
      await ensureEmailEmbedding(triggerEmail);
      // RSS items always feed topic-mode pages (one wiki page per topic),
      // bypassing sender/thread grouping. For email we use the existing
      // thread → subject-template → sender+centroid path. A rule with
      // route.topicPage forces topic-mode regardless of source.
      const assignment = verdict.forceTopicPage
        ? await findTopicPageForItem({
            ...triggerEmail.toObject(),
            topics: [verdict.forceTopicPage, ...((triggerEmail.topics as string[]) ?? [])],
          } as typeof triggerEmail)
        : triggerEmail.kind === 'rss'
          ? await findTopicPageForItem(triggerEmail)
          : await findPageForEmail(triggerEmail);
      logger.info(
        {
          emailId: String(triggerEmail._id),
          userId: String(userId),
          mode: assignment.mode,
          existingPage: assignment.page ? String(assignment.page._id) : null,
        },
        'page assignment',
      );

      // Build the full email list for whichever page we're targeting.
      let pageEmails: EmailDoc[];
      if (assignment.page) {
        const ids = new Set<string>(
          (assignment.page.sourceEmailIds as Types.ObjectId[]).map((x) => String(x)),
        );
        ids.add(String(triggerEmail._id));
        pageEmails = (await Email.find({ _id: { $in: [...ids] }, userId })
          .sort({ date: 1, createdAt: 1 })
          .exec()) as unknown as EmailDoc[];
      } else if (triggerEmail.threadKey) {
        // No existing page yet but there are sibling messages in the same
        // thread already ingested — pull them in for the first generation.
        pageEmails = (await Email.find({ userId, threadKey: triggerEmail.threadKey })
          .sort({ date: 1, createdAt: 1 })
          .exec()) as unknown as EmailDoc[];
      } else {
        pageEmails = [triggerEmail];
      }

      const categories = await Category.find({ userId }).select('name').lean();
      const stream = isNotificationStream(pageEmails);

      // Decide rebuild vs incremental. Incremental kicks in when the
      // assignment landed on a topic-mode page that already has
      // substantive content AND we have a snapshot of which emails
      // were in the prior pass — then we can identify just the new
      // dispatches and merge them into the existing prose. First-time
      // promotion to topic mode (or pages without a prior snapshot)
      // falls through to rebuild, which establishes the baseline that
      // the *next* pass will merge into.
      const priorSnapshot = new Set<string>(
        ((assignment.page?.lastGeneratedFromEmailIds ?? []) as Types.ObjectId[]).map((x) =>
          String(x),
        ),
      );
      const newEmails = assignment.page
        ? pageEmails.filter((e) => !priorSnapshot.has(String(e._id)))
        : pageEmails;
      const useIncremental =
        assignment.mode === 'topic' &&
        !!assignment.page &&
        priorSnapshot.size > 0 &&
        newEmails.length > 0 &&
        newEmails.length < pageEmails.length &&
        (assignment.page.contentMd ?? '').length >= 200;

      // Pick which corpus the prompt sees. Incremental shows only the
      // new emails (the existing contentMd carries the older context);
      // rebuild shows everything (with elision for very large pages).
      const corpus = useIncremental ? newEmails : pageEmails;
      const { selected: promptEmails, elidedSummary } = useIncremental
        ? { selected: corpus, elidedSummary: '' }
        : selectEmailsForPrompt(corpus);

      const promptAddrs = [
        ...new Set(
          promptEmails
            .map((e) => e.from?.address?.toLowerCase())
            .filter((a): a is string => !!a),
        ),
      ];
      const stripBrands = promptAddrs.length
        ? await Sender.find({
            userId,
            addresses: { $in: promptAddrs },
            stripAds: true,
          })
            .select('addresses')
            .lean()
        : [];
      const stripAddrs = new Set<string>(
        stripBrands.flatMap((s) => (s.addresses as string[] | undefined) ?? []),
      );
      const stripAdsFor = (addr: string | undefined | null) =>
        !!(addr && stripAddrs.has(addr.toLowerCase()));
      // Continue label numbering past the highest existing citation
      // when merging into an existing topic page; rebuild always
      // starts at e1.
      const existingCitationKeys = useIncremental
        ? Object.keys((assignment.page?.citations ?? {}) as Record<string, unknown>)
        : [];
      const labelOffset = useIncremental
        ? existingCitationKeys.reduce((max, k) => {
            const m = /^e(\d+)$/.exec(k);
            return m ? Math.max(max, Number(m[1])) : max;
          }, 0)
        : 0;
      const { text: labeledThreads, labels } = renderLabeledThreads(
        promptEmails,
        stripAdsFor,
        labelOffset,
      );
      const distinctThreadKeys = new Set(
        pageEmails.map((e) => e.threadKey ?? `__loose:${String(e._id)}`),
      );
      const streamGuidance = stream.yes
        ? `\nNOTIFICATION STREAM DETECTED: ${Math.round(stream.ratio * 100)}% of these messages share the same subject template. Treat this page as a long-running notification stream — write a stable, dashboard-style summary instead of a per-message description. Required H2 sections: "Overview" (what this stream is and how often it fires), "Recent Activity" (a tight bullet list of the most recent occurrences with timestamp + the one-line distinguishing detail per item — citing each), and "Patterns" (any common themes you observe across instances). Do NOT enumerate every message individually.`
        : '';
      const elidedNote = elidedSummary ? `\nNOTE: ${elidedSummary}` : '';

      let prompt: string;
      if (useIncremental) {
        const consolidateTemplate = await getInstructionTemplate(userId, 'consolidate');
        if (!consolidateTemplate) throw new Error('No consolidate instruction available');
        const existingPage = assignment.page!;
        prompt = renderTemplate(consolidateTemplate, {
          page_title: existingPage.title ?? '',
          page_summary: existingPage.summary ?? '',
          existing_content: existingPage.contentMd ?? '',
          new_labeled_threads: labeledThreads,
          new_email_count: String(newEmails.length),
          sender_summary: describeSenders(pageEmails),
          extra_instructions:
            'Available categories: ' +
            (categories.map((c) => c.name).join(', ') || '(none)') +
            streamGuidance,
        });
      } else {
        const generateTemplate = await getInstructionTemplate(userId, 'generate');
        if (!generateTemplate) throw new Error('No generation instruction available');
        prompt = renderTemplate(generateTemplate, {
          labeled_threads: labeledThreads,
          thread_count: String(distinctThreadKeys.size),
          email_count: String(pageEmails.length),
          sender_summary: describeSenders(pageEmails),
          extra_instructions:
            'Available categories: ' +
            (categories.map((c) => c.name).join(', ') || '(none)') +
            streamGuidance +
            elidedNote,
        });
      }

      const { provider, model: genModel, providerId, params: userParams } =
        await resolveProviderForUser(userId, 'generation');
      logger.info(
        {
          providerId,
          model: genModel,
          mode: assignment.mode,
          threadCount: distinctThreadKeys.size,
          emailCount: pageEmails.length,
        },
        'generating',
      );

      const totalChars = totalBodyChars(pageEmails);
      const isThin = totalChars < 30;

      let draft;
      if (isThin) {
        // Bodies are empty or near-empty but at least one of subject/sender
        // is present. Skip the LLM and produce a metadata-only placeholder
        // so the page still anchors the source emails and offers a
        // back-link, but doesn't hallucinate filler.
        logger.info(
          { totalChars, emailCount: pageEmails.length },
          'thin content — using metadata placeholder instead of LLM call',
        );
        const senderList = [
          ...new Set(
            pageEmails
              .map((e) => e.from?.address?.toLowerCase())
              .filter((a): a is string => !!a),
          ),
        ];
        const dr = dateRangeOf(pageEmails);
        const subj = pageEmails[0]?.subject?.trim() || '(no subject)';
        const title =
          (subj && subj.length <= 80
            ? subj
            : senderList[0]
              ? `Messages from ${senderList[0]}`
              : 'Messages with no body') || 'Untitled page';
        const summary =
          `${pageEmails.length} message${pageEmails.length === 1 ? '' : 's'} ` +
          (senderList.length
            ? `from ${senderList.slice(0, 2).join(', ')}${senderList.length > 2 ? ` +${senderList.length - 2} more` : ''}`
            : 'from unknown sender(s)') +
          (dr ? ` (${dr})` : '') +
          '. Bodies are empty or very short — see the source emails below for the original content.';
        const lines = labels
          .map(({ label, email: e }) => {
            const dt = e.date ? new Date(e.date).toLocaleString() : '';
            const fromAddr = e.from?.address ?? 'unknown';
            const sub = (e.subject || '(no subject)').replace(/\s+/g, ' ').slice(0, 120);
            return `- **${sub}** — from ${fromAddr}${dt ? ` on ${dt}` : ''} [${label}]`;
          })
          .join('\n');
        draft = {
          title,
          summary: summary.slice(0, 280),
          contentMd: `## Overview\n\nThis page tracks ${pageEmails.length} message${
            pageEmails.length === 1 ? ' that has' : 's that have'
          } no usable body content; only the headers (sender, subject, date) are available.\n\n## Messages\n\n${lines}`,
          tags: ['empty-body'],
          suggestedCategory: null,
        };
      } else {
        const llmStartedAt = Date.now();
        let buffered = '';
        // Hard ceiling for the whole call (covers slow Ollama loads),
        // plus an idle-token watchdog so a hung stream aborts even when
        // bytes stop arriving mid-response. Both share one AbortController
        // so whichever fires first cancels the underlying fetch.
        const ctrl = new AbortController();
        const HARD_TIMEOUT_MS = 4 * 60_000;
        const IDLE_TIMEOUT_MS = 90_000;
        const hardTimer = setTimeout(
          () => ctrl.abort(new Error('LLM hard timeout exceeded')),
          HARD_TIMEOUT_MS,
        );
        let idleTimer = setTimeout(
          () => ctrl.abort(new Error('LLM idle timeout — no tokens')),
          IDLE_TIMEOUT_MS,
        );
        try {
          // 0.2 keeps the JSON well-formed; user can raise it via
          // Settings → Models → Generation → Advanced if they want
          // more variety, at the cost of occasional Zod parse failures.
          const merged = applyParamOverrides({ temperature: 0.2 }, userParams);
          for await (const chunk of provider.generateStream({
            model: genModel,
            prompt,
            system: SYSTEM_PROMPT_BASE,
            format: 'json',
            temperature: merged.temperature ?? 0.2,
            maxTokens: merged.maxTokens ?? undefined,
            topP: merged.topP ?? undefined,
            topK: merged.topK ?? undefined,
            repeatPenalty: merged.repeatPenalty ?? undefined,
            numCtx: merged.numCtx ?? undefined,
            signal: ctrl.signal,
          })) {
            buffered += chunk.response;
            if (chunk.response) {
              clearTimeout(idleTimer);
              idleTimer = setTimeout(
                () => ctrl.abort(new Error('LLM idle timeout — no tokens')),
                IDLE_TIMEOUT_MS,
              );
              await job.updateProgress({
                type: 'token',
                jobId: String(job.id),
                token: chunk.response,
              });
            }
          }
        } catch (err) {
          // Provider errors are the most common silent failure mode
          // (Ollama not running, missing model, expired API key).
          // Surface the full message + stack so the operator can fix.
          logger.error(
            {
              err,
              providerId,
              model: genModel,
              promptChars: prompt.length,
              bufferedChars: buffered.length,
              elapsedMs: Date.now() - llmStartedAt,
            },
            'generate-page: provider call failed',
          );
          throw err;
        } finally {
          clearTimeout(hardTimer);
          clearTimeout(idleTimer);
        }
        logger.debug(
          {
            providerId,
            model: genModel,
            elapsedMs: Date.now() - llmStartedAt,
            outputChars: buffered.length,
          },
          'generate-page: provider call complete',
        );
        try {
          // Incremental path expects PageMergeDraft (adds topicAliases).
          // If the LLM forgets the field, PageMergeDraft.default([])
          // tolerates the omission. If the JSON is otherwise malformed
          // both schemas throw; the rebuild path stays on
          // PageGenerationDraft so the merge contract is opt-in.
          draft = useIncremental
            ? PageMergeDraft.parse(extractJson(buffered))
            : PageGenerationDraft.parse(extractJson(buffered));
        } catch (err) {
          // Log the FULL raw output, not a truncated slice — when a
          // wiki page silently fails to materialise this is almost
          // always why.
          logger.error(
            { err, providerId, model: genModel, raw: buffered },
            'generate-page: invalid JSON from LLM',
          );
          throw new Error('LLM returned invalid JSON for page generation');
        }
      }

      // Categories. A `assign.category` rule wins over the LLM's
      // suggestion so the user's explicit instruction is honoured.
      // We look up by the *normalized* name so case + punctuation
      // variants ("Email Marketing", "email-marketing") collapse onto
      // a single Category row.
      let categoryId: Types.ObjectId | null = null;
      const categoryName = verdict.assignCategory ?? draft.suggestedCategory;
      if (categoryName) {
        const normalizedName = normalizeCategoryName(categoryName);
        const cat =
          (await Category.findOne({ userId, normalizedName })) ??
          (await Category.findOne({ userId, name: categoryName }));
        if (cat) {
          // Make sure the normalizedName is populated on legacy rows
          // so subsequent lookups hit the indexed path.
          if (!cat.normalizedName) {
            cat.normalizedName = normalizedName;
            await cat.save();
          }
          categoryId = cat._id as Types.ObjectId;
        } else {
          const created = await Category.create({
            userId,
            name: categoryName,
            normalizedName,
          });
          categoryId = created._id as Types.ObjectId;
        }
      }

      // Build citation map from labels actually cited. For
      // incremental merges, start with the page's existing citations
      // so old [eN] markers in the preserved prose still resolve, then
      // overlay any new citations the merge prompt emitted.
      const usedLabels = extractCitedLabels(draft.contentMd);
      const citations: CitationMap = useIncremental
        ? { ...((assignment.page?.citations ?? {}) as CitationMap) }
        : {};
      for (const { label, email: e } of labels) {
        if (!usedLabels.has(label)) continue;
        citations[label] = {
          emailId: String(e._id),
          subject: e.subject ?? '',
          from: e.from?.name ?? e.from?.address ?? null,
          date: e.date ? new Date(e.date).toISOString() : null,
        };
      }

      const threadKeys = [...distinctThreadKeys].filter((k) => !k.startsWith('__loose:'));
      const senderAddresses = [
        ...new Set(
          pageEmails
            .map((e) => e.from?.address?.toLowerCase())
            .filter((a): a is string => !!a),
        ),
      ];
      const subjectTemplates = [
        ...new Set(
          pageEmails.map((e) => e.subjectTemplate).filter((s): s is string => !!s),
        ),
      ];
      const sourceEmailIds = pageEmails.map((e) => e._id) as Types.ObjectId[];

      // ---- metadata rollup ---------------------------------------------------
      const priorityRank = { high: 2, normal: 1, low: 0 } as const;
      let priority: 'high' | 'normal' | 'low' = 'normal';
      let topSpamScore = 0;
      let hasMassMailing = false;
      // Roll up the per-email promotional flag — a page counts as
      // promotional once a majority of contributing emails are.
      let promotionalCount = 0;
      const topicCounts = new Map<string, number>();
      const linkAccum = new Map<string, { url: string; text?: string | null; count: number }>();
      const imageAccum = new Map<
        string,
        { url: string; alt?: string | null; count: number; fromEmailId: Types.ObjectId }
      >();
      const pageAttachments: {
        filename: string;
        contentType: string;
        size: number;
        fromEmailId: Types.ObjectId;
      }[] = [];
      for (const e of pageEmails) {
        const p = (e.priority as 'high' | 'normal' | 'low' | undefined) ?? 'normal';
        if (priorityRank[p] > priorityRank[priority]) priority = p;
        topSpamScore = Math.max(topSpamScore, (e.spamScore as number | undefined) ?? 0);
        if (e.isMassMailing) hasMassMailing = true;
        if (e.isPromotional) promotionalCount += 1;
        for (const t of (e.topics as string[] | undefined) ?? []) {
          topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
        }
        for (const l of (e.links as { url: string; text?: string | null }[] | undefined) ?? []) {
          if (!l?.url) continue;
          const prev = linkAccum.get(l.url);
          if (prev) prev.count += 1;
          else linkAccum.set(l.url, { url: l.url, text: l.text ?? null, count: 1 });
        }
        for (const img of (e.images as { url: string; alt?: string | null }[] | undefined) ?? []) {
          if (!img?.url) continue;
          const prev = imageAccum.get(img.url);
          if (prev) prev.count += 1;
          else
            imageAccum.set(img.url, {
              url: img.url,
              alt: img.alt ?? null,
              count: 1,
              fromEmailId: e._id as Types.ObjectId,
            });
        }
        for (const a of (e.attachments as { filename?: string; contentType?: string; size?: number }[] | undefined) ?? []) {
          if (!a?.filename) continue;
          pageAttachments.push({
            filename: a.filename,
            contentType: a.contentType ?? 'application/octet-stream',
            size: a.size ?? 0,
            fromEmailId: e._id as Types.ObjectId,
          });
        }
      }
      // Topics are aggregated from per-email extracted topics (which
      // filterNominalTags has already cleaned) AND any forceTopicPage
      // override. Re-filter here as a defense-in-depth step in case
      // a legacy email carried unfiltered topics on it from before
      // this change shipped.
      const topics = filterNominalTags(
        [...topicCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([t]) => t),
      );
      const pageLinks = [...linkAccum.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 50);
      const pageImages = [...imageAccum.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 30);
      const heroImageUrl = pageImages[0]?.url ?? null;
      // Apply the user's manual spam policy. Any contributing sender or any
      // tag in the policy lists trips userMarkedSpam.
      const userPolicy = (await User.findById(userId).select('spamPolicy').lean()) as
        | { spamPolicy?: { senders?: string[]; tags?: string[] } }
        | null;
      const policySenders = new Set(userPolicy?.spamPolicy?.senders ?? []);
      const policyTags = new Set(userPolicy?.spamPolicy?.tags ?? []);
      const senderHit = pageEmails.some((e) =>
        policySenders.has((e.from?.address ?? '').toLowerCase()),
      );
      const tagHit =
        (draft.tags ?? []).some((t) => policyTags.has(t)) ||
        topics.some((t) => policyTags.has(t));
      // Sender-reputation feedback loop: if any contributing sender's
      // brand has tripped the auto-quarantine threshold, surface this
      // page in the Quarantine view rather than the main feed.
      const contributingAddrs = pageEmails
        .map((e) => (e.from?.address ?? '').toLowerCase())
        .filter(Boolean);
      const quarantinedSenders = contributingAddrs.length
        ? await Sender.find({
            userId,
            addresses: { $in: contributingAddrs },
            autoQuarantine: true,
          })
            .select('_id')
            .lean()
        : [];
      const autoQuarantined = quarantinedSenders.length > 0;

      // Bayesian classifier — score the trigger email against the
      // user's per-user profile. Falls through to null on cold-start
      // (under 30 spam + 30 ham trained); when present, blend with the
      // heuristic score (60% heuristic, 40% Bayes) so neither side
      // dominates and a single-mismatch never auto-flips a page.
      const bayes = await bayesScoreFor(userId, triggerEmail);
      const blendedSpamScore =
        bayes != null ? 0.6 * topSpamScore + 0.4 * bayes : topSpamScore;
      // Preserve an existing user flag if the page already had one.
      const previousFlags = (assignment.page?.flags ?? {}) as {
        userMarkedSpam?: boolean;
        autoQuarantined?: boolean;
      };
      const previousUserMarked = !!previousFlags.userMarkedSpam;
      const baseFlags: Record<string, boolean> = {
        hasLikelySpam: blendedSpamScore >= 0.5,
        hasMassMailing,
        isSparse: isThin,
        userMarkedSpam: previousUserMarked || senderHit || tagHit,
        isNotificationStream: stream.yes,
        // A page is promotional when ≥ 60% of contributing emails are.
        isPromotional:
          pageEmails.length > 0 &&
          promotionalCount / pageEmails.length >= 0.6,
        // Don't clear an existing autoQuarantine flag silently — it gets
        // cleared explicitly on rescue.
        autoQuarantined:
          autoQuarantined || !!previousFlags.autoQuarantined || verdict.quarantine,
      };
      // Rule-driven flag.set actions override the heuristics above.
      const flags = { ...baseFlags, ...verdict.setFlags };
      // -------------------------------------------------------------------------


      let pageId: Types.ObjectId;
      let slug: string;

      if (assignment.page) {
        const page = assignment.page;
        page.title = draft.title;
        page.summary = draft.summary;
        page.contentMd = draft.contentMd;
        // Rule-driven tag mutations: add wins, remove strips both
        // LLM-emitted tags and previous user tags. We pass the LLM's
        // tags through filterNominalTags first so courtesy openers
        // ("please", "how", "thanks") and other obvious non-nouns
        // never make it onto Page.tags. Rule-engine `addTags` are
        // user-curated and therefore exempt from the filter.
        const draftTags = filterNominalTags(draft.tags ?? []);
        const merged = new Set<string>(draftTags);
        for (const t of verdict.addTags) merged.add(t);
        for (const t of verdict.removeTags) merged.delete(t);
        page.tags = [...merged];
        page.categoryId = categoryId;
        page.sourceEmailIds = sourceEmailIds;
        page.threadKeys = threadKeys;
        page.senderAddresses = senderAddresses;
        page.subjectTemplates = subjectTemplates;
        page.priority = verdict.setPriority ?? priority;
        page.topics = topics;
        page.set('pageLinks', pageLinks);
        page.set('pageImages', pageImages);
        page.heroImageUrl = heroImageUrl;
        page.set('pageAttachments', pageAttachments);
        page.spamScore = blendedSpamScore;
        page.set('flags', flags);
        page.markModified('flags');
        page.markModified('pageLinks');
        page.markModified('pageAttachments');
        page.groupingMode =
          assignment.mode === 'thread'
            ? 'thread'
            : assignment.mode === 'topic'
              ? 'topic'
              : assignment.mode === 'source-template'
                ? 'source-topic'
                : 'source-topic';
        page.citations = citations;
        page.markModified('citations');
        page.version = (page.version ?? 1) + 1;
        page.generationModel = `${providerId}:${genModel}`;
        page.generatedAt = new Date();
        page.generatedBy = 'llm';
        // Topic-mode pages run incrementally going forward; everything
        // else stays on rebuild. Once a page is in topic mode the
        // assignment ladder routes future emails here, and the next
        // pass diffs against `lastGeneratedFromEmailIds` to extract
        // just the new dispatches.
        page.generationMode = page.groupingMode === 'topic' ? 'incremental' : 'rebuild';
        page.lastGeneratedFromEmailIds = sourceEmailIds;
        // Merge any LLM-suggested topic aliases into the persisted set.
        // Lowercased, deduped, capped — the UI uses these for the
        // assignment ladder so an unbounded list would slow lookups.
        if (useIncremental && (draft as PageMergeDraft).topicAliases) {
          const incoming = ((draft as PageMergeDraft).topicAliases ?? [])
            .map((a) => a.trim().toLowerCase())
            .filter(Boolean);
          const merged = new Set<string>([
            ...((page.topicAliases as string[] | undefined) ?? []),
            ...incoming,
          ]);
          page.topicAliases = [...merged].slice(0, 20);
        }
        // Anchor the topic on whatever the merge produced (or the
        // first topic if rebuild). Stays stable across passes; only
        // overwritten when not yet set.
        if (!page.primaryTopic) {
          const candidate = (topics[0] ?? page.tags?.[0] ?? null);
          page.primaryTopic = candidate ? candidate.toLowerCase() : null;
        }
        page.topicCentroid = await recomputeCentroid(page);
        await page.save();
        pageId = page._id;
        slug = page.slug;
        await PageRevision.create({
          pageId,
          version: page.version,
          title: page.title,
          summary: page.summary,
          contentMd: page.contentMd,
          editor: 'llm',
          model: `${providerId}:${genModel}`,
        });
      } else {
        const baseSlug = slugify(draft.title);
        slug = baseSlug;
        let n = 1;
        while (await Page.findOne({ userId, slug })) {
          n += 1;
          slug = `${baseSlug}-${n}`;
        }
        const isRss = triggerEmail.kind === 'rss';
        const newGroupingMode: 'thread' | 'topic' | 'source-topic' = isRss
          ? 'topic'
          : triggerEmail.threadKey
            ? 'thread'
            : 'source-topic';
        const primaryTopic = isRss
          ? ((triggerEmail.topics as string[] | undefined)?.[0] ?? null)?.toLowerCase() ?? null
          : null;
        // Same nominal filter as the update branch above — LLM tags
        // sanitised, rule-engine adds exempt.
        const draftTagsCreate = filterNominalTags(draft.tags ?? []);
        const mergedTagsCreate = new Set<string>(draftTagsCreate);
        for (const t of verdict.addTags) mergedTagsCreate.add(t);
        for (const t of verdict.removeTags) mergedTagsCreate.delete(t);
        const created = await Page.create({
          userId,
          slug,
          title: draft.title,
          summary: draft.summary,
          contentMd: draft.contentMd,
          tags: [...mergedTagsCreate],
          categoryId,
          sourceEmailIds,
          threadKeys,
          senderAddresses,
          subjectTemplates,
          priority: verdict.setPriority ?? priority,
          topics,
          pageLinks,
          pageImages,
          heroImageUrl,
          pageAttachments,
          spamScore: blendedSpamScore,
          flags,
          groupingMode: newGroupingMode,
          primaryTopic,
          citations,
          version: 1,
          generationModel: `${providerId}:${genModel}`,
          generatedAt: new Date(),
          generatedBy: 'llm',
          // First write seeds the snapshot so the next pass can run
          // incremental once the page is in topic mode.
          generationMode: newGroupingMode === 'topic' ? 'incremental' : 'rebuild',
          lastGeneratedFromEmailIds: sourceEmailIds,
        });
        pageId = created._id;
        created.topicCentroid = await recomputeCentroid(created);
        await created.save();
        await PageRevision.create({
          pageId,
          version: 1,
          title: created.title,
          summary: created.summary,
          contentMd: created.contentMd,
          editor: 'llm',
          model: `${providerId}:${genModel}`,
        });
      }

      // Mark every email currently on the page as generated and pointing at it.
      await Email.updateMany(
        { _id: { $in: sourceEmailIds } },
        { $set: { ingestStatus: 'generated', pageId } },
      );

      // Extract calendar events from each contributing email (idempotent;
      // skips emails already extracted unless forced). Cheap wrapper around
      // an LLM JSON call per email — ignored on failure.
      const pageWasNew = !assignment.page;
      try {
        const refreshed = (await Email.find({ _id: { $in: sourceEmailIds } })) as unknown as EmailDoc[];
        const pageObj = (assignment.page ?? (await Page.findById(pageId))) as PageDoc | null;
        if (pageObj) {
          await extractEventsForPage(pageObj, refreshed);
          await syncEventsToPage(pageId, pageObj.slug);
          // Update the address book of senders with everything we learned
          // from this page's contributing emails. Best-effort; never fails
          // the generation job.
          try {
            await upsertSendersFromPage(userId, pageObj, refreshed, pageWasNew);
          } catch (err) {
            logger.warn(
              { err, pageId: String(pageId) },
              'sender upsert step failed',
            );
          }
          // Fan out webhook events to subscribers — best-effort.
          try {
            const event = pageWasNew ? 'page.created' : 'page.updated';
            await dispatchWebhookEvent(userId, event, {
              page: {
                id: String(pageObj._id),
                slug: pageObj.slug,
                title: pageObj.title,
                summary: pageObj.summary,
                tags: pageObj.tags,
                priority: pageObj.priority,
                version: pageObj.version,
                updatedAt: pageObj.updatedAt,
              },
              sourceEmailIds: sourceEmailIds.map((x) => String(x)),
            });
            if (pageObj.flags?.userMarkedSpam || pageObj.flags?.autoQuarantined) {
              await dispatchWebhookEvent(userId, 'page.spam.flagged', {
                page: { id: String(pageObj._id), slug: pageObj.slug, title: pageObj.title },
                reason: pageObj.flags.autoQuarantined ? 'auto-quarantined' : 'user-marked',
              });
            }
          } catch (err) {
            logger.warn({ err, pageId: String(pageId) }, 'webhook dispatch failed');
          }
          // Push notifications — fire matching subscriptions for this
          // page. Best-effort; failures don't break generation.
          try {
            await evaluatePageNotifications(userId, pageObj);
          } catch (err) {
            logger.warn({ err, pageId: String(pageId) }, 'push dispatch failed');
          }
          // Vision — describe inline images when the user has opted in.
          // Respects per-user daily cap; never throws upward.
          try {
            await describePageImages(userId, pageObj);
          } catch (err) {
            logger.warn(
              { err: (err as Error).message, pageId: String(pageId) },
              'vision describe step failed',
            );
          }
          // Maps — extract place entities from the body and geocode
          // each (Nominatim, 30d cached). Only runs when the user
          // has Settings → Maps enabled. Idempotent: skips when the
          // contentMd hash hasn't changed since the last run. Plan 11.
          try {
            await runPlacesExtraction(userId, pageObj);
          } catch (err) {
            logger.warn(
              { err: (err as Error).message, pageId: String(pageId) },
              'places extraction step failed',
            );
          }
        }
      } catch (err) {
        logger.warn({ err, pageId: String(pageId) }, 'event extraction step failed');
      }

      await embedQueue.add(
        'embed',
        { pageId: pageId.toString() },
        { attempts: 3, removeOnComplete: 200, removeOnFail: 200 },
      );

      await job.updateProgress({
        type: 'completed',
        jobId: String(job.id),
        pageId: pageId.toString(),
      });

      logger.info(
        {
          jobId: String(job.id),
          pageId: String(pageId),
          slug,
          mode: assignment.mode,
          wasNew: !assignment.page,
          emailCount: pageEmails.length,
        },
        'generate-page: persisted',
      );
      return { pageId: pageId.toString(), slug };
    },
    { connection: redis, concurrency: 2, lockDuration: 5 * 60_000, stalledInterval: 60_000, maxStalledCount: 1 },
  );

  worker.on('failed', (job, err) =>
    logger.error(
      {
        jobId: job?.id,
        emailId: job?.data?.emailId,
        userId: job?.data?.userId,
        attemptsMade: job?.attemptsMade,
        err,
      },
      'generate-page failed',
    ),
  );
  worker.on('error', (err) => logger.error({ err }, 'generate-page worker error'));
  return worker;
}
