import { Worker, type Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import {
  Email,
  Page,
  PageRevision,
  Instruction,
  Category,
  User,
  type EmailDoc,
} from '@rose/db';
import {
  SYSTEM_PROMPT_BASE,
  extractJson,
  renderTemplate,
} from '@rose/llm';
import { PageGenerationDraft, slugify, type CitationMap } from '@rose/shared';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { resolveProviderForUser } from '../lib/providers.js';
import {
  ensureEmailEmbedding,
  findPageForEmail,
  recomputeCentroid,
} from '../services/pageAssignment.js';

const QUEUE = 'rose.generate-page';
const embedQueue = new Queue('rose.embed-page', { connection: redis });

type GenerateJobData = { emailId: string; userId: string };

async function getInstructionTemplate(
  userId: Types.ObjectId,
  scope: 'generate' | 'categorize',
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
 *  rendered prompt block plus the label→email mapping for citations. */
function renderLabeledThreads(emails: EmailDoc[]): {
  text: string;
  labels: { label: string; email: EmailDoc }[];
} {
  const groups = groupByThread(emails);
  const labels: { label: string; email: EmailDoc }[] = [];
  const blocks: string[] = [];
  let n = 0;
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
        const text = (e.text || e.rawText || '').slice(0, 6000);
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
      const triggerEmail = await Email.findOne({
        _id: job.data.emailId,
        userId,
      }).select('+embedding');
      if (!triggerEmail) throw new Error('Email not found');

      await job.updateProgress({ type: 'started', jobId: String(job.id) });

      // Ensure the trigger email has a cached embedding before assignment.
      await ensureEmailEmbedding(triggerEmail);
      const assignment = await findPageForEmail(triggerEmail);
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

      const generateTemplate = await getInstructionTemplate(userId, 'generate');
      if (!generateTemplate) throw new Error('No generation instruction available');

      const categories = await Category.find({ userId }).select('name').lean();
      const stream = isNotificationStream(pageEmails);
      const { selected: promptEmails, elidedSummary } = selectEmailsForPrompt(pageEmails);
      const { text: labeledThreads, labels } = renderLabeledThreads(promptEmails);
      const distinctThreadKeys = new Set(
        pageEmails.map((e) => e.threadKey ?? `__loose:${String(e._id)}`),
      );
      const streamGuidance = stream.yes
        ? `\nNOTIFICATION STREAM DETECTED: ${Math.round(stream.ratio * 100)}% of these messages share the same subject template. Treat this page as a long-running notification stream — write a stable, dashboard-style summary instead of a per-message description. Required H2 sections: "Overview" (what this stream is and how often it fires), "Recent Activity" (a tight bullet list of the most recent occurrences with timestamp + the one-line distinguishing detail per item — citing each), and "Patterns" (any common themes you observe across instances). Do NOT enumerate every message individually.`
        : '';
      const elidedNote = elidedSummary ? `\nNOTE: ${elidedSummary}` : '';
      const prompt = renderTemplate(generateTemplate, {
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

      const { provider, model: genModel, providerId } = await resolveProviderForUser(
        userId,
        'generation',
      );
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
        let buffered = '';
        for await (const chunk of provider.generateStream({
          model: genModel,
          prompt,
          system: SYSTEM_PROMPT_BASE,
          format: 'json',
          temperature: 0.2,
        })) {
          buffered += chunk.response;
          if (chunk.response) {
            await job.updateProgress({
              type: 'token',
              jobId: String(job.id),
              token: chunk.response,
            });
          }
        }
        try {
          draft = PageGenerationDraft.parse(extractJson(buffered));
        } catch (err) {
          logger.warn(
            { err, raw: buffered.slice(0, 400) },
            'failed to parse generation draft',
          );
          throw new Error('LLM returned invalid JSON for page generation');
        }
      }

      // Categories
      let categoryId: Types.ObjectId | null = null;
      if (draft.suggestedCategory) {
        const cat = await Category.findOneAndUpdate(
          { userId, name: draft.suggestedCategory },
          { $setOnInsert: { userId, name: draft.suggestedCategory } },
          { upsert: true, new: true },
        );
        categoryId = cat._id as Types.ObjectId;
      }

      // Build citation map from labels actually cited.
      const usedLabels = extractCitedLabels(draft.contentMd);
      const citations: CitationMap = {};
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
      const topics = [...topicCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([t]) => t);
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
      // Preserve an existing user flag if the page already had one.
      const previousUserMarked = !!(assignment.page?.flags as { userMarkedSpam?: boolean } | undefined)
        ?.userMarkedSpam;
      const flags = {
        hasLikelySpam: topSpamScore >= 0.5,
        hasMassMailing,
        isSparse: isThin,
        userMarkedSpam: previousUserMarked || senderHit || tagHit,
      };
      // -------------------------------------------------------------------------


      let pageId: Types.ObjectId;
      let slug: string;

      if (assignment.page) {
        const page = assignment.page;
        page.title = draft.title;
        page.summary = draft.summary;
        page.contentMd = draft.contentMd;
        page.tags = draft.tags ?? [];
        page.categoryId = categoryId;
        page.sourceEmailIds = sourceEmailIds;
        page.threadKeys = threadKeys;
        page.senderAddresses = senderAddresses;
        page.subjectTemplates = subjectTemplates;
        page.priority = priority;
        page.topics = topics;
        page.set('pageLinks', pageLinks);
        page.set('pageImages', pageImages);
        page.heroImageUrl = heroImageUrl;
        page.set('pageAttachments', pageAttachments);
        page.spamScore = topSpamScore;
        page.set('flags', flags);
        page.markModified('flags');
        page.markModified('pageLinks');
        page.markModified('pageAttachments');
        page.groupingMode =
          assignment.mode === 'thread'
            ? 'thread'
            : assignment.mode === 'source-template'
              ? 'source-topic'
              : 'source-topic';
        page.citations = citations;
        page.markModified('citations');
        page.version = (page.version ?? 1) + 1;
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
        });
      } else {
        const baseSlug = slugify(draft.title);
        slug = baseSlug;
        let n = 1;
        while (await Page.findOne({ userId, slug })) {
          n += 1;
          slug = `${baseSlug}-${n}`;
        }
        const created = await Page.create({
          userId,
          slug,
          title: draft.title,
          summary: draft.summary,
          contentMd: draft.contentMd,
          tags: draft.tags ?? [],
          categoryId,
          sourceEmailIds,
          threadKeys,
          senderAddresses,
          subjectTemplates,
          priority,
          topics,
          pageLinks,
          pageImages,
          heroImageUrl,
          pageAttachments,
          spamScore: topSpamScore,
          flags,
          groupingMode: triggerEmail.threadKey ? 'thread' : 'source-topic',
          citations,
          version: 1,
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
        });
      }

      // Mark every email currently on the page as generated and pointing at it.
      await Email.updateMany(
        { _id: { $in: sourceEmailIds } },
        { $set: { ingestStatus: 'generated', pageId } },
      );

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

      return { pageId: pageId.toString(), slug };
    },
    { connection: redis, concurrency: 2 },
  );

  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'generate-page failed'),
  );
  return worker;
}
