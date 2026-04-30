import { Worker, type Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import {
  Email,
  Page,
  PageRevision,
  Instruction,
  Category,
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

export function startGeneratePageWorker() {
  const worker = new Worker<GenerateJobData>(
    QUEUE,
    async (job: Job<GenerateJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const triggerEmail = await Email.findOne({ _id: job.data.emailId, userId }).select(
        '+embedding embeddingModel',
      );
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
      const { text: labeledThreads, labels } = renderLabeledThreads(pageEmails);
      const distinctThreadKeys = new Set(
        pageEmails.map((e) => e.threadKey ?? `__loose:${String(e._id)}`),
      );
      const prompt = renderTemplate(generateTemplate, {
        labeled_threads: labeledThreads,
        thread_count: String(distinctThreadKeys.size),
        email_count: String(pageEmails.length),
        sender_summary: describeSenders(pageEmails),
        extra_instructions:
          'Available categories: ' +
          (categories.map((c) => c.name).join(', ') || '(none)'),
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

      let draft;
      try {
        draft = PageGenerationDraft.parse(extractJson(buffered));
      } catch (err) {
        logger.warn({ err, raw: buffered.slice(0, 400) }, 'failed to parse generation draft');
        throw new Error('LLM returned invalid JSON for page generation');
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
      const sourceEmailIds = pageEmails.map((e) => e._id) as Types.ObjectId[];

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
        page.groupingMode = assignment.mode === 'thread' ? 'thread' : 'source-topic';
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
