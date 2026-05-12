import { Worker, type Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import {
  Email,
  Page,
  PageRevision,
  Instruction,
  Category,
  normalizeCategoryName,
  displayCategoryName,
  User,
  Sender,
  SenderBrand,
  Entity,
  uniqueSlug,
  type EmailDoc,
  type PageDoc,
} from '@rose/db';
import {
  SYSTEM_PROMPT_BASE,
  extractJson,
  renderTemplate,
} from '@rose/llm';
import { PageGenerationDraft, PageMergeDraft, priorityForDate, slugify, type CitationMap } from '@rose/shared';
import {
  stripAdSectionsStrict,
  filterNominalTags,
  compileSenderBlocklist,
  isSenderWhitelisted,
  senderDomainTag,
  extractHtmlMetadata,
} from '@rose/email-parser';
import { redis, bullConnection } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { observe, inc, METRIC } from '../lib/metrics.js';
import { resolveProviderForUser, applyParamOverrides } from '../lib/providers.js';
import {
  ensureEmailEmbedding,
  findPageForEmail,
  findTopicPageForItem,
  recomputeCentroid,
} from '../services/pageAssignment.js';
import { upsertSendersFromPage } from '../services/senderUpsert.js';
import {
  suggestTaxonomy,
  snapTagsByEmbedding,
  snapCategoryByEmbedding,
} from '../services/taxonomySnap.js';
import { bayesScoreFor } from '../lib/bayesScore.js';
import { evaluateRules, type RuleVerdict, emptyVerdict } from '../services/rules.js';
import { dispatchWebhookEvent } from './webhookDeliver.js';
import { evaluatePageNotifications } from './pushNotify.js';
import { emitRecipeEvent } from '../lib/recipeEmit.js';
import { describePageImages } from '../services/describeImages.js';
import { extractPlacesFromPage, hashContent } from '../services/extractPlaces.js';
import { runPostWriteEntityExtraction } from '../services/extractEntities.js';
import { enrichEntityWikidata } from '../services/wikidataResolver.js';
import { runPostWriteReceiptExtraction } from '../services/extractReceipt.js';
import { runPostWriteRelationExtraction } from '../services/extractRelations.js';
import { runPostWriteSubscriptionExtraction } from '../services/extractSubscription.js';
import { geocode, normalizePlaceKey } from '../lib/geocode.js';
import { canonicalizeTags } from '../services/tagCanonicalize.js';
import { findMergeSuggestions } from '../services/mergeDetect.js';
import {
  extractEventsForPage,
  syncEventsToPage,
} from '../services/eventExtraction.js';

const QUEUE = 'rose.generate-page';
const embedQueue = new Queue('rose.embed-page', { connection: bullConnection() });
// Topic-research auto-trigger queue. Fire-and-forget enqueues from
// generatePage when a strong-signal topic surfaces and the user has
// webResearch enabled. The orchestrator itself lives in
// processors/topicResearch.ts on the worker-llm class.
const topicResearchQueue = new Queue('rose.topic-research', {
  connection: bullConnection(),
});

/**
 * Cooldown between auto-trigger research runs for the same page.
 * The user can still hit Research manually inside this window —
 * this only suppresses the *automatic* enqueue from generatePage,
 * which can fire frequently when a topic page is updated by new
 * mail. 6h is short enough that breaking-news topics refresh in a
 * day, long enough that ten emails landing in 5 minutes don't
 * each kick a research run.
 */
const AUTO_RESEARCH_COOLDOWN_MS = 6 * 3600 * 1000;

type GenerateJobData = { emailId: string; userId: string };

async function getInstructionTemplate(
  userId: Types.ObjectId,
  scope: 'generate' | 'categorize' | 'consolidate',
): Promise<string> {
  const userDefault = await Instruction.findOne({ userId, scope, isDefault: true })
    .select('template')
    .lean();
  if (userDefault?.template) return userDefault.template;
  const system = await Instruction.findOne({ userId, scope, isSystem: true })
    .select('template')
    .lean();
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

        // HTML-metadata scaffold. When the email body's HTML carries
        // a quality title / description / Article headline, surface
        // them as priors so the LLM can reuse the human-authored text
        // verbatim instead of rewriting from scratch. Drops the
        // metadata block when every field is missing or redundant
        // with the subject — no point in spending prompt tokens to
        // tell the LLM "the title is what you already see".
        const html = (e.html as string | undefined) ?? '';
        const meta = html ? extractHtmlMetadata(html) : null;
        const metaLines: string[] = [];
        const subjLc = subj.trim().toLowerCase();
        function metaIsNovel(s: string | null): boolean {
          if (!s) return false;
          const t = s.trim().toLowerCase();
          if (!t) return false;
          // Heuristic dedup: skip when the metadata is a substring of
          // the subject or vice-versa. Most templated mail repeats
          // the subject in og:title, which would just bloat the
          // prompt.
          return !(t === subjLc || t.includes(subjLc) || subjLc.includes(t));
        }
        if (meta) {
          if (metaIsNovel(meta.title)) {
            metaLines.push(`  META-TITLE: ${meta.title!.slice(0, 200)}`);
          }
          if (metaIsNovel(meta.description)) {
            metaLines.push(
              `  META-DESCRIPTION: ${meta.description!.slice(0, 400)}`,
            );
          }
          if (meta.articleHeadline && meta.articleHeadline !== meta.title) {
            metaLines.push(
              `  ARTICLE-HEADLINE: ${meta.articleHeadline.slice(0, 200)}`,
            );
          }
          if (
            meta.articleDescription &&
            meta.articleDescription !== meta.description
          ) {
            metaLines.push(
              `  ARTICLE-DESCRIPTION: ${meta.articleDescription.slice(0, 400)}`,
            );
          }
        }
        const metaBlock = metaLines.length > 0 ? `\n${metaLines.join('\n')}` : '';
        return `  [${label}] From: ${from} | Date: ${date} | Subject: ${subj}${metaBlock}\n  """\n  ${text.replace(/\n/g, '\n  ')}\n  """`;
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

  // Plan 12 (R3) — also upsert each place into the Entity registry
  // with `type: 'place'`. Lets /n/<key> route uniformly across every
  // named thing; the entity page already handles place-specific
  // map rendering when the key matches a Page.places[] row.
  //
  // The place extractor sometimes misclassifies works ("Ariana
  // Grande x Swarovski") as places, so we never overwrite an
  // existing entity's type — `type` is set on insert only.
  // extractEntities (which produces person/work/organization) wins
  // when both fire for the same key.
  for (const p of next) {
    if (!p.normKey) continue;
    try {
      await Entity.updateOne(
        { userId, key: p.normKey },
        {
          $set: {
            displayName: p.displayName ?? p.name,
            lastSeenAt: new Date(),
          },
          $setOnInsert: {
            userId,
            key: p.normKey,
            type: 'place',
            pageCount: 0,
          },
        },
        { upsert: true },
      );
      // Chain into the Wikidata resolver so /n/<place> can render
      // the Q-ID badge and the relation panel populates containment
      // (located-in country/admin entity). Fire-and-forget — the
      // resolver throttles to one fetch per row per 90 days.
      void enrichEntityWikidata(userId, p.normKey).catch((err) =>
        logger.debug(
          { err, key: p.normKey },
          'place → entity wikidata enrich failed',
        ),
      );
    } catch (err) {
      logger.warn(
        { err, userId: String(userId), key: p.normKey },
        'place → entity upsert failed',
      );
    }
  }
}

/**
 * Run the named-entity extractor on the freshly-saved page if its
 * contentMd has changed since the last successful run. Idempotent
 * on the same content hash (mirrors `runPlacesExtraction`). Always
 * best-effort — failures inside `extractEntitiesFromPage` already
 * yield an empty list.
 */
async function runEntityExtraction(
  userId: Types.ObjectId,
  page: PageDoc,
): Promise<void> {
  await runPostWriteEntityExtraction(userId, page, hashContent(page.contentMd ?? ''));
  // Receipt → product wiki. Best-effort, gated by tag — non-receipt
  // pages skip the LLM call entirely inside the runner.
  await runPostWriteReceiptExtraction(userId, page);
  // Typed-relation extraction. Independent hash gate so it can
  // skip without affecting the other extractors.
  await runPostWriteRelationExtraction(userId, page);
  // Subscription extraction — tag/keyword-gated like receipts.
  await runPostWriteSubscriptionExtraction(userId, page);
}

/**
 * Walk every waiting + delayed generate-page job and ensure it
 * carries a priority that reflects the email's real date. Necessary
 * for two cases:
 *
 *   1. Jobs queued before the freshness-priority feature shipped —
 *      they sit at priority 0 (no priority) in BullMQ's regular
 *      FIFO list, which means a six-week-old IMAP backfill keeps
 *      blocking today's mail forever.
 *   2. Edge paths we may have missed when we threaded priorityForDate
 *      through (regenerate calls from older surfaces, third-party
 *      webhook drops, etc.).
 *
 * Runs once at worker boot. Bounded (5_000 jobs) so a startup on a
 * pathologically large queue stays responsive; the next boot picks
 * up where this one left off.
 */
async function reprioritizeGeneratePageBacklog(): Promise<{
  scanned: number;
  rewritten: number;
}> {
  const queue = new Queue<GenerateJobData>(QUEUE, { connection: bullConnection() });
  try {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'paused'], 0, 5000);
    let rewritten = 0;
    for (const job of jobs) {
      try {
        const emailId = job.data?.emailId;
        if (!emailId) continue;
        const email = await Email.findById(emailId).select('date createdAt').lean();
        const ref =
          email?.date ?? (email as { createdAt?: Date } | null)?.createdAt ?? new Date();
        const next = priorityForDate(ref);
        const current = (job.opts?.priority as number | undefined) ?? 0;
        if (current !== next) {
          await job.changePriority({ priority: next });
          rewritten += 1;
        }
      } catch (err) {
        logger.debug({ err, jobId: job.id }, 'reprioritize: per-job failure (continuing)');
      }
    }
    return { scanned: jobs.length, rewritten };
  } finally {
    await queue.close();
  }
}

/**
 * Fire-and-forget enqueue of a topic-research job when the page has
 * a strong-signal topic and the user has webResearch enabled. Gates:
 *
 *   1. User has settings.daydream.webResearch.enabled === true.
 *   2. The page has either a primaryTopic or a strong tag/topic.
 *      We don't try to embed-derive a topic from scratch; topic
 *      research only fires when the existing pipeline already
 *      labelled the page as "about" something specific.
 *   3. Page isn't quarantined or user-marked-spam — those are
 *      explicit "don't surface" signals; researching them would
 *      be an amplification.
 *   4. Page is in topic / source-topic mode. Thread-mode pages are
 *      ad-hoc back-and-forth; topic research doesn't make sense
 *      for "Re: lunch on Friday".
 *   5. Cooldown — skip if a research run completed within the last
 *      AUTO_RESEARCH_COOLDOWN_MS. The user can still hit Research
 *      manually inside the window.
 *   6. researchState isn't already queued or running. Belt-and-
 *      suspenders against a manual trigger landing concurrently.
 */
async function maybeAutoTriggerTopicResearch(args: {
  userId: Types.ObjectId;
  pageId: Types.ObjectId;
  flags: Record<string, boolean>;
  page: PageDoc | null;
  draft: { tags?: string[] };
  topics: string[];
}): Promise<void> {
  const { userId, pageId, flags, draft, topics } = args;

  // Hard gates — quarantine + spam + briefing/synthesis modes.
  if (flags.userMarkedSpam || flags.autoQuarantined) return;

  const user = (await User.findById(userId)
    .select('settings.daydream.webResearch.enabled')
    .lean()) as
    | {
        settings?: { daydream?: { webResearch?: { enabled?: boolean } } };
      }
    | null;
  if (user?.settings?.daydream?.webResearch?.enabled !== true) return;

  // Re-load the freshly-saved page to read the persisted state and
  // confirm we're not racing the API trigger.
  const fresh = (await Page.findById(pageId)
    .select(
      'researchState lastResearchedAt primaryTopic tags topics groupingMode title',
    )
    .lean()) as
    | {
        researchState?: 'idle' | 'queued' | 'running' | 'failed';
        lastResearchedAt?: Date | null;
        primaryTopic?: string | null;
        tags?: string[];
        topics?: string[];
        groupingMode?: string | null;
        title?: string;
      }
    | null;
  if (!fresh) return;
  if (fresh.researchState === 'queued' || fresh.researchState === 'running') return;

  // Mode gate.
  const mode = fresh.groupingMode ?? null;
  if (mode !== 'topic' && mode !== 'source-topic') return;

  // Cooldown.
  if (
    fresh.lastResearchedAt &&
    Date.now() - new Date(fresh.lastResearchedAt).getTime() <
      AUTO_RESEARCH_COOLDOWN_MS
  ) {
    return;
  }

  // Topic resolution — primaryTopic > first persisted topic > first
  // tag > the topics array we computed during this generation.
  const topicLabel =
    fresh.primaryTopic ||
    fresh.topics?.[0] ||
    fresh.tags?.[0] ||
    topics[0] ||
    draft.tags?.[0] ||
    null;
  if (!topicLabel || topicLabel.length < 2) return;

  // Mark queued atomically; the job will set running when it picks up.
  await Page.updateOne(
    { _id: pageId, researchState: { $in: ['idle', 'failed', null] } },
    { $set: { researchState: 'queued', lastResearchError: null } },
  );

  await topicResearchQueue.add(
    'research',
    {
      userId: String(userId),
      pageId: String(pageId),
      topicLabel,
    },
    {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
      // Auto-triggers are background — let any user-initiated
      // research jump the queue ahead of them.
      priority: 100,
    },
  );

  logger.info(
    {
      pageId: String(pageId),
      topicLabel,
      reason: 'auto-trigger',
    },
    'topic-research: enqueued',
  );
}

export function startGeneratePageWorker() {
  // Fire-and-forget: backfill priorities on jobs queued by older
  // code paths so today's mail genuinely beats the backlog. Failure
  // here can't take down the worker — the function logs internally.
  void reprioritizeGeneratePageBacklog()
    .then((r) =>
      logger.info(
        { scanned: r.scanned, rewritten: r.rewritten },
        'generate-page: priority backfill complete',
      ),
    )
    .catch((err) =>
      logger.warn({ err }, 'generate-page: priority backfill failed'),
    );

  const worker = new Worker<GenerateJobData>(
    QUEUE,
    async (job: Job<GenerateJobData>) => {
      const jobT0 = Date.now();
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
      // Trigger email is the seed for the LLM prompt + embedding
      // path; opt in to the body fields the schema marks select:false.
      const triggerEmail = await Email.findOne({
        _id: job.data.emailId,
        userId,
      }).select('+embedding +html +rawText');
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
      const triggerEmbed = await ensureEmailEmbedding(triggerEmail);
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
      // Both branches feed renderLabeledThreads which reads e.text /
      // e.rawText to assemble the LLM prompt — opt the body fields
      // back in (they're select:false on the schema by default).
      if (assignment.page) {
        const ids = new Set<string>(
          (assignment.page.sourceEmailIds as Types.ObjectId[]).map((x) => String(x)),
        );
        ids.add(String(triggerEmail._id));
        pageEmails = (await Email.find({ _id: { $in: [...ids] }, userId })
          .select('+rawText +html')
          .sort({ date: 1, createdAt: 1 })
          .exec()) as unknown as EmailDoc[];
      } else if (triggerEmail.threadKey) {
        // No existing page yet but there are sibling messages in the same
        // thread already ingested — pull them in for the first generation.
        pageEmails = (await Email.find({ userId, threadKey: triggerEmail.threadKey })
          .select('+rawText +html')
          .sort({ date: 1, createdAt: 1 })
          .exec()) as unknown as EmailDoc[];
      } else {
        pageEmails = [triggerEmail];
      }

      const categories = await Category.find({ userId }).select('name').lean();
      // Page counts per category — lets the prompt show the LLM which
      // buckets are popular so it prefers established names over inventing
      // new (often catch-all) ones. Aggregation is bounded by the user's
      // category count, which is small.
      const counts = await Page.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { userId, categoryId: { $ne: null } } },
        { $group: { _id: '$categoryId', n: { $sum: 1 } } },
      ]);
      const countById = new Map(counts.map((c) => [String(c._id), c.n]));
      const categoriesBlock = categories.length
        ? categories
            .map((c) => `${c.name}\t${countById.get(String(c._id)) ?? 0}`)
            .join('\n')
        : '(none yet — pick null or invent a specific category)';
      // Embedding-driven pre-pass. Before the LLM runs, find the
      // user's tags + categories that are most semantically similar
      // to the trigger email and surface them as preferred candidates.
      // Strongly biases the model toward the established vocabulary
      // and avoids near-duplicate tags ("crypto" vs "cryptocurrency").
      // Cold-start users have no centroids — `taxonomyHints` falls
      // back to empty arrays in that case.
      const taxonomyHints = triggerEmbed
        ? await suggestTaxonomy(userId, triggerEmbed.vec)
        : { tags: [], categories: [] };
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
      // Plan 15 — `Sender` carries only per-user fields; addresses
      // live on the global `SenderBrand` row. To find which prompt
      // emails come from senders this user has flagged stripAds=true,
      // first translate prompt addresses → brandKeys via the global
      // brand row, then check the user's Sender rows for the toggle,
      // then translate back to addresses.
      const brandRowsForPrompt = promptAddrs.length
        ? await SenderBrand.find({ addresses: { $in: promptAddrs } })
            .select('brandKey addresses')
            .lean()
        : [];
      const promptBrandKeys = brandRowsForPrompt.map((b) => b.brandKey);
      const stripUserSenders = promptBrandKeys.length
        ? await Sender.find({
            userId,
            brandKey: { $in: promptBrandKeys },
            stripAds: true,
          })
            .select('brandKey')
            .lean()
        : [];
      const stripBrandKeys = new Set(stripUserSenders.map((s) => s.brandKey));
      const stripAddrs = new Set<string>(
        brandRowsForPrompt
          .filter((b) => stripBrandKeys.has(b.brandKey))
          .flatMap((b) => (b.addresses as string[] | undefined) ?? []),
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
      // Embedding-driven hints injected into the prompt. The LLM
      // sees the existing categories block as before; this adds an
      // explicit "your nearest neighbours by semantic similarity"
      // shortlist so it doesn't have to scan the whole list every
      // time. Only included when we actually have hints — empty
      // strings would just confuse the model.
      const taxonomyGuidance = (() => {
        const parts: string[] = [];
        if (taxonomyHints.tags.length > 0) {
          parts.push(
            `\nNEAREST EXISTING TAGS by semantic similarity to this email (prefer these over near-duplicates — e.g. don't emit "crypto" if "cryptocurrency" appears below): ${taxonomyHints.tags.map((t) => t.display).join(', ')}.`,
          );
        }
        if (taxonomyHints.categories.length > 0) {
          parts.push(
            `\nNEAREST EXISTING CATEGORIES by semantic similarity: ${taxonomyHints.categories.map((c) => c.display).join(', ')}. Strongly prefer one of these over inventing a new category.`,
          );
        }
        return parts.join('');
      })();

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
          existing_categories: categoriesBlock,
          extra_instructions: (streamGuidance + taxonomyGuidance).trim() || '(none)',
        });
      } else {
        const generateTemplate = await getInstructionTemplate(userId, 'generate');
        if (!generateTemplate) throw new Error('No generation instruction available');
        prompt = renderTemplate(generateTemplate, {
          labeled_threads: labeledThreads,
          thread_count: String(distinctThreadKeys.size),
          email_count: String(pageEmails.length),
          sender_summary: describeSenders(pageEmails),
          existing_categories: categoriesBlock,
          extra_instructions: (streamGuidance + elidedNote + taxonomyGuidance).trim() || '(none)',
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
        observe(METRIC.OLLAMA_GEN_MS, Date.now() - llmStartedAt, {
          model: genModel,
        });
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

      // Embedding-driven post-pass: snap LLM-emitted tags + category
      // onto existing vocabulary entries when the embeddings are
      // close enough. Catches near-duplicates the prompt biasing
      // didn't fully prevent ("crypto" → "cryptocurrency", "AI
      // safety" → "ai-safety", etc.) — at zero LLM cost. Runs
      // before the LLM-based `canonicalizeTags` so the downstream
      // step has fewer unknowns to resolve and rarely needs to
      // reach for the generation model. Rule-driven `assignCategory`
      // still wins below; we only canonicalise the LLM's own suggestion.
      try {
        const snapped = await snapTagsByEmbedding(userId, draft.tags ?? []);
        draft.tags = snapped;
      } catch (err) {
        logger.warn({ err }, 'generate-page: embedding tag snap failed; using raw LLM tags');
      }
      try {
        const snapped = await snapCategoryByEmbedding(
          userId,
          draft.suggestedCategory ?? null,
        );
        draft.suggestedCategory = snapped;
      } catch (err) {
        logger.warn(
          { err },
          'generate-page: embedding category snap failed; using raw LLM suggestion',
        );
      }

      // Categories. A `assign.category` rule wins over the LLM's
      // suggestion so the user's explicit instruction is honoured.
      // We look up by the *normalized* name so case + punctuation
      // variants ("Email Marketing", "email-marketing") collapse onto
      // a single Category row.
      let categoryId: Types.ObjectId | null = null;
      const rawCategoryName = verdict.assignCategory ?? draft.suggestedCategory;
      // Title-case + de-slug at the seam: an LLM-emitted
      // "email-marketing" lands as "Email Marketing"; an empty
      // suggestion falls back to "Uncategorized" instead of leaving
      // the page with no category.
      const categoryName = displayCategoryName(rawCategoryName ?? '');
      if (categoryName) {
        const normalizedName = normalizeCategoryName(categoryName);
        const cat =
          (await Category.findOne({ userId, normalizedName })) ??
          (await Category.findOne({ userId, name: categoryName }));
        if (cat) {
          // Backfill: legacy rows with a kebab-case or lowercased
          // `name` get rewritten to the canonical Title Case form so
          // the codex / browse views render consistently going
          // forward.
          let dirty = false;
          if (!cat.normalizedName) {
            cat.normalizedName = normalizedName;
            dirty = true;
          }
          const display = displayCategoryName(cat.name);
          if (cat.name !== display) {
            cat.name = display;
            dirty = true;
          }
          if (dirty) await cat.save();
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

      // The article's "as-of" date is the latest contributing email's
      // received date — `date` (RFC 5322 Date: header) when present,
      // otherwise the row's createdAt. This is what the UI surfaces;
      // distinct from the Page row's createdAt which records when
      // generation actually ran.
      const articleDate = ((): Date => {
        let max = 0;
        for (const e of pageEmails) {
          const t = (e.date ?? (e as { createdAt?: Date }).createdAt)?.getTime() ?? 0;
          if (t > max) max = t;
        }
        return max > 0 ? new Date(max) : new Date();
      })();

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
        | {
            spamPolicy?: {
              senders?: string[];
              tags?: string[];
              whitelistedSenders?: string[];
              optInGlobalSpamBrands?: string[];
            };
          }
        | null;
      const policySenders = new Set(userPolicy?.spamPolicy?.senders ?? []);
      const policyTags = new Set(userPolicy?.spamPolicy?.tags ?? []);
      const optInGlobalSpamBrands = new Set(
        userPolicy?.spamPolicy?.optInGlobalSpamBrands ?? [],
      );
      // Whitelist check: any contributing sender whose address is
      // whitelisted (or sits under a default-trusted TLD) immunises
      // the whole page from spam-mark + auto-quarantine. The user
      // explicitly said "this is fine" — honour it across every
      // downstream classifier rather than re-deriving on each one.
      const whitelistSets = compileSenderBlocklist(
        userPolicy?.spamPolicy?.whitelistedSenders ?? [],
      );
      const pageIsWhitelisted = pageEmails.some((e) =>
        isSenderWhitelisted(whitelistSets, (e.from?.address ?? '').toLowerCase()),
      );
      const senderHit =
        !pageIsWhitelisted &&
        pageEmails.some((e) =>
          policySenders.has((e.from?.address ?? '').toLowerCase()),
        );
      const tagHit =
        !pageIsWhitelisted &&
        ((draft.tags ?? []).some((t) => policyTags.has(t)) ||
          topics.some((t) => policyTags.has(t)));
      // Sender-reputation feedback loop: if any contributing sender's
      // brand has tripped the auto-quarantine threshold, surface this
      // page in the Quarantine view rather than the main feed —
      // unless the page is whitelisted.
      const contributingAddrs = pageEmails
        .map((e) => (e.from?.address ?? '').toLowerCase())
        .filter(Boolean);
      const quarantinedSenders = pageIsWhitelisted
        ? []
        : contributingAddrs.length
          ? await Sender.find({
              userId,
              addresses: { $in: contributingAddrs },
              autoQuarantine: true,
            })
              .select('_id')
              .lean()
          : [];
      // Global blacklist gate. Once any user marks a brand as spam,
      // SenderBrand.globalSpam flips on; THIS user's pages from that
      // brand auto-quarantine unless they explicitly opted in via
      // /api/spam/optin. Whitelisted senders bypass this just like
      // they bypass the per-user threshold.
      const contributingBrands = pageIsWhitelisted
        ? []
        : [
            ...new Set(
              contributingAddrs
                .map((a) => senderDomainTag(a)?.toLowerCase() ?? null)
                .filter((b): b is string => !!b)
                .filter((b) => !optInGlobalSpamBrands.has(b)),
            ),
          ];
      const globallyFlaggedBrands = contributingBrands.length
        ? await SenderBrand.find({
            brandKey: { $in: contributingBrands },
            globalSpam: true,
          })
            .select('_id')
            .lean()
        : [];
      const autoQuarantined =
        !pageIsWhitelisted &&
        (quarantinedSenders.length > 0 || globallyFlaggedBrands.length > 0);

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
        // A whitelisted brand short-circuits both spam-marks: the
        // user has explicitly said "this is fine", so we don't want
        // a stale `previousUserMarked` flag dragging the page back
        // into quarantine on regen.
        userMarkedSpam: pageIsWhitelisted
          ? false
          : previousUserMarked || senderHit || tagHit,
        isNotificationStream: stream.yes,
        // A page is promotional when ≥ 60% of contributing emails are.
        isPromotional:
          pageEmails.length > 0 &&
          promotionalCount / pageEmails.length >= 0.6,
        // Whitelist also forces autoQuarantined off — without this,
        // a page that was auto-quarantined before the user trusted
        // the brand would stay quarantined forever (the previous
        // flag is sticky on regen by design, and a rule-driven
        // `verdict.quarantine` could re-trigger it).
        autoQuarantined: pageIsWhitelisted
          ? false
          : autoQuarantined || !!previousFlags.autoQuarantined || verdict.quarantine,
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
        // Canonicalise — folds synonyms ("job-postings", "remote-work",
        // "fully-remote") onto the user's existing canonical taxonomy.
        // Falls back to passthrough on any failure so this step never
        // blocks page persistence.
        const canonicalised = await canonicalizeTags(userId, [...merged]);
        page.tags = canonicalised;
        page.categoryId = categoryId;
        page.sourceEmailIds = sourceEmailIds;
        page.threadKeys = threadKeys;
        page.senderAddresses = senderAddresses;
        page.subjectTemplates = subjectTemplates;
        // Honour a user priority override: only the rule engine can
        // still set priority on an override page; auto-derivation
        // doesn't clobber what the user picked.
        if (verdict.setPriority) {
          page.priority = verdict.setPriority;
        } else if (!page.priorityOverride) {
          page.priority = priority;
        }
        // Advance articleDate only if the new max email date is more
        // recent than what the page already has. Stale resyncs of old
        // emails shouldn't pull the article date backward.
        if (
          !page.articleDate ||
          articleDate.getTime() > new Date(page.articleDate).getTime()
        ) {
          page.articleDate = articleDate;
        }
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
        slug = await uniqueSlug(userId, slugify(draft.title));
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
        const canonicalisedCreate = await canonicalizeTags(userId, [
          ...mergedTagsCreate,
        ]);
        const created = await Page.create({
          userId,
          slug,
          title: draft.title,
          summary: draft.summary,
          contentMd: draft.contentMd,
          tags: canonicalisedCreate,
          categoryId,
          sourceEmailIds,
          threadKeys,
          senderAddresses,
          subjectTemplates,
          priority: verdict.setPriority ?? priority,
          articleDate,
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
        // extractEventsForPage reads e.text / e.rawText; opt the
        // body fields back in.
        const refreshed = (await Email.find({ _id: { $in: sourceEmailIds } })
          .select('+rawText +html')) as unknown as EmailDoc[];
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
          // Merge-detection pass — runs after the centroid is fresh,
          // best-effort. Surfaces suggestions in the UI as a
          // "Potential duplicate of …" banner; never blocks page
          // persistence on its own failures.
          try {
            await findMergeSuggestions(pageObj);
          } catch (err) {
            logger.warn(
              { err, pageId: String(pageId) },
              'merge-detection step failed',
            );
          }
          // Phase 2 of recipes — webhook fan-out and push-notification
          // matching are now handled by user Recipes (see the
          // page.created / tag.applied emits below). The legacy
          // dispatchWebhookEvent + evaluatePageNotifications paths
          // would double-fire, so they're disabled. Boot-time
          // migrations have ported existing WebhookSubscription /
          // NotificationRule rows into matching Recipes.
          void dispatchWebhookEvent; // keep import live for future re-wiring
          void evaluatePageNotifications;
          // Recipes — fan out page.created (new pages only) and
          // tag.applied for every tag this generation pass added.
          // brandKeys are derived from senderAddresses so recipe
          // condition `sender.brand` works without re-resolving.
          try {
            const senderAddresses = (pageObj.senderAddresses ?? []) as string[];
            const brandKeys = senderAddresses
              .map((a) => {
                const at = a.lastIndexOf('@');
                if (at < 0) return null;
                const domain = a.slice(at + 1).toLowerCase();
                const root = domain.split('.').slice(-2).join('.');
                return root.split('.')[0] ?? null;
              })
              .filter((b): b is string => !!b);
            const tags = (pageObj.tags ?? []) as string[];
            const pagePriority =
              (pageObj.priority as 'high' | 'normal' | 'low' | null | undefined) ?? null;
            if (pageWasNew) {
              await emitRecipeEvent({
                kind: 'page.created',
                userId: String(userId),
                pageId: String(pageObj._id),
                slug: pageObj.slug,
                title: pageObj.title,
                tags,
                categoryId: pageObj.categoryId ? String(pageObj.categoryId) : null,
                brandKeys,
                priority: pagePriority,
              });
            }
            for (const tag of tags) {
              await emitRecipeEvent({
                kind: 'tag.applied',
                userId: String(userId),
                pageId: String(pageObj._id),
                slug: pageObj.slug,
                title: pageObj.title,
                tag,
                tags,
                brandKeys,
                priority: pagePriority,
              });
            }
          } catch (err) {
            logger.warn(
              { err, pageId: String(pageId) },
              'recipe emit failed (continuing)',
            );
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
          // Named-entity extraction — people, works, organizations.
          // Drives auto-linking in prose and the /n/<key> entity
          // page. Idempotent on the contentMd hash; best-effort.
          try {
            await runEntityExtraction(userId, pageObj);
          } catch (err) {
            logger.warn(
              { err: (err as Error).message, pageId: String(pageId) },
              'entity extraction step failed',
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
      observe(METRIC.GENERATE_PAGE_DURATION_MS, Date.now() - jobT0, {
        mode: assignment.mode,
        wasNew: assignment.page ? 'false' : 'true',
      });

      // -----------------------------------------------------------
      // Web-integration Phase 2 auto-trigger. Fire a topicResearch
      // job opportunistically when the page has a clear topic and
      // the user has opted in. Quarantined / spam-marked pages are
      // excluded — we don't want to crawl on behalf of pages we
      // don't trust. Cooldown guards against the obvious
      // amplification path (every new email kicks another run).
      // Errors here are swallowed; the page-generation result is
      // already persisted.
      // -----------------------------------------------------------
      try {
        await maybeAutoTriggerTopicResearch({
          userId,
          pageId,
          flags: baseFlags,
          page: assignment.page,
          draft,
          topics,
        });
      } catch (err) {
        logger.warn({ err, pageId: String(pageId) }, 'topic-research: auto-trigger failed');
      }
      return { pageId: pageId.toString(), slug };
    },
    {
      connection: bullConnection(),
      concurrency: 2,
      // LLM streaming for long topic pages can exceed 5 min; bump
      // the lock so BullMQ doesn't declare the job stalled mid-stream
      // and double-fire it.
      lockDuration: 10 * 60_000,
      stalledInterval: 60_000,
      // First stall is recoverable (transient Ollama hiccup); a
      // second consecutive stall is what we actually want to fail.
      maxStalledCount: 2,
    },
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
