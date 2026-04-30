import { Worker, type Job, Queue } from 'bullmq';
import { Types } from 'mongoose';
import { Email, Page, PageRevision, Instruction, Category, type EmailDoc } from '@rose/db';
import {
  SYSTEM_PROMPT_BASE,
  extractJson,
  renderTemplate,
} from '@rose/llm';
import { PageGenerationDraft, slugify, type CitationMap } from '@rose/shared';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { resolveProviderForUser } from '../lib/providers.js';

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

/** Render emails to a labeled block the LLM can cite. */
function renderLabeledEmails(emails: EmailDoc[]): string {
  return emails
    .map((e, i) => {
      const label = `e${i + 1}`;
      const from = e.from?.address ?? 'unknown';
      const date = e.date ? new Date(e.date).toISOString() : '';
      const subject = e.subject ?? '';
      const body = (e.text || e.rawText || '').slice(0, 8000);
      return `[${label}] From: ${from} | Date: ${date} | Subject: ${subject}\n"""\n${body}\n"""`;
    })
    .join('\n\n');
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

export function startGeneratePageWorker() {
  const worker = new Worker<GenerateJobData>(
    QUEUE,
    async (job: Job<GenerateJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const triggerEmail = await Email.findOne({ _id: job.data.emailId, userId });
      if (!triggerEmail) throw new Error('Email not found');

      await job.updateProgress({ type: 'started', jobId: String(job.id) });

      const generateTemplate = await getInstructionTemplate(userId, 'generate');
      if (!generateTemplate) throw new Error('No generation instruction available');

      // Collect all emails in this thread (oldest first). If no threadKey,
      // it's a thread-of-one — same code path keeps things simple.
      const threadKey = triggerEmail.threadKey;
      const threadEmails: EmailDoc[] = threadKey
        ? ((await Email.find({ userId, threadKey })
            .sort({ date: 1, createdAt: 1 })
            .exec()) as unknown as EmailDoc[])
        : [triggerEmail];

      // Find an existing page already attached to this thread so we can
      // update-in-place rather than create duplicates.
      let existingPage = threadKey
        ? await Page.findOne({ userId, threadKey })
        : null;
      // Backfill: pages predating thread-consolidation don't have threadKey;
      // try to locate one whose sourceEmailIds includes any email in this thread.
      if (!existingPage && threadKey) {
        existingPage = await Page.findOne({
          userId,
          sourceEmailIds: { $in: threadEmails.map((e) => e._id) },
        });
        if (existingPage) {
          existingPage.threadKey = threadKey;
          await existingPage.save();
        }
      }

      const categories = await Category.find({ userId }).select('name').lean();
      const labeledEmails = renderLabeledEmails(threadEmails);
      const prompt = renderTemplate(generateTemplate, {
        labeled_emails: labeledEmails,
        email_count: String(threadEmails.length),
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
          emailId: String(triggerEmail._id),
          threadKey,
          threadSize: threadEmails.length,
          mode: existingPage ? 'update' : 'create',
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

      let categoryId: Types.ObjectId | null = null;
      if (draft.suggestedCategory) {
        const cat = await Category.findOneAndUpdate(
          { userId, name: draft.suggestedCategory },
          { $setOnInsert: { userId, name: draft.suggestedCategory } },
          { upsert: true, new: true },
        );
        categoryId = cat._id as Types.ObjectId;
      }

      // Build citation map from labels actually cited in the markdown.
      const usedLabels = extractCitedLabels(draft.contentMd);
      const citations: CitationMap = {};
      threadEmails.forEach((e, i) => {
        const label = `e${i + 1}`;
        if (!usedLabels.has(label)) return;
        citations[label] = {
          emailId: e._id.toString(),
          subject: e.subject ?? '',
          from: e.from?.name ?? e.from?.address ?? null,
          date: e.date ? new Date(e.date).toISOString() : null,
        };
      });

      let pageId: Types.ObjectId;
      let slug: string;

      if (existingPage) {
        existingPage.title = draft.title;
        existingPage.summary = draft.summary;
        existingPage.contentMd = draft.contentMd;
        existingPage.tags = draft.tags ?? [];
        existingPage.categoryId = categoryId;
        existingPage.sourceEmailIds = threadEmails.map((e) => e._id) as Types.ObjectId[];
        existingPage.threadKey = threadKey;
        existingPage.citations = citations;
        existingPage.version = (existingPage.version ?? 1) + 1;
        existingPage.markModified('citations');
        await existingPage.save();
        pageId = existingPage._id;
        slug = existingPage.slug;
        await PageRevision.create({
          pageId,
          version: existingPage.version,
          title: draft.title,
          summary: draft.summary,
          contentMd: draft.contentMd,
          editor: 'llm',
        });
      } else {
        const baseSlug = slugify(draft.title);
        slug = baseSlug;
        let i = 1;
        while (await Page.findOne({ userId, slug })) {
          i += 1;
          slug = `${baseSlug}-${i}`;
        }
        const created = await Page.create({
          userId,
          slug,
          title: draft.title,
          summary: draft.summary,
          contentMd: draft.contentMd,
          tags: draft.tags ?? [],
          categoryId,
          sourceEmailIds: threadEmails.map((e) => e._id),
          threadKey,
          citations,
          version: 1,
        });
        pageId = created._id;
        await PageRevision.create({
          pageId,
          version: 1,
          title: created.title,
          summary: created.summary,
          contentMd: created.contentMd,
          editor: 'llm',
        });
      }

      // Mark every email in the thread as generated and pointing at this page.
      await Email.updateMany(
        { _id: { $in: threadEmails.map((e) => e._id) } },
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

  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'generate-page failed'));
  return worker;
}
