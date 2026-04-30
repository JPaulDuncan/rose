import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';
import { Email, Page, PageRevision, Instruction, Category } from '@rose/db';
import {
  OllamaClient,
  SYSTEM_PROMPT_BASE,
  extractJson,
  renderTemplate,
} from '@rose/llm';
import { PageGenerationDraft, slugify } from '@rose/shared';
import { redis } from '../lib/redis.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

const QUEUE = 'rose.generate-page';
const ollama = new OllamaClient({ baseUrl: env.OLLAMA_URL });

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

export function startGeneratePageWorker() {
  const worker = new Worker<GenerateJobData>(
    QUEUE,
    async (job: Job<GenerateJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const email = await Email.findOne({ _id: job.data.emailId, userId });
      if (!email) throw new Error('Email not found');

      await job.updateProgress({ type: 'started', jobId: String(job.id) });

      const generateTemplate = await getInstructionTemplate(userId, 'generate');
      if (!generateTemplate) throw new Error('No generation instruction available');

      const categories = await Category.find({ userId }).select('name').lean();
      const prompt = renderTemplate(generateTemplate, {
        email_subject: email.subject ?? '',
        email_from: email.from?.address ?? '',
        email_date: email.date ? new Date(email.date).toISOString() : '',
        email_body: email.text ?? email.rawText ?? '',
        extra_instructions:
          'Available categories: ' + (categories.map((c) => c.name).join(', ') || '(none)'),
      });

      let buffered = '';
      for await (const chunk of ollama.generateStream({
        model: env.DEFAULT_GENERATION_MODEL,
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

      const baseSlug = slugify(draft.title);
      let slug = baseSlug;
      let i = 1;
      while (await Page.findOne({ userId, slug })) {
        i += 1;
        slug = `${baseSlug}-${i}`;
      }

      const page = await Page.create({
        userId,
        slug,
        title: draft.title,
        summary: draft.summary,
        contentMd: draft.contentMd,
        tags: draft.tags ?? [],
        categoryId,
        sourceEmailIds: [email._id],
        version: 1,
      });

      await PageRevision.create({
        pageId: page._id,
        version: 1,
        title: page.title,
        summary: page.summary,
        contentMd: page.contentMd,
        editor: 'llm',
      });

      email.ingestStatus = 'generated';
      email.pageId = page._id as Types.ObjectId;
      await email.save();

      await job.updateProgress({
        type: 'completed',
        jobId: String(job.id),
        pageId: page._id.toString(),
      });

      return { pageId: page._id.toString(), slug: page.slug };
    },
    { connection: redis, concurrency: 2 },
  );

  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'generate-page failed'));
  return worker;
}
