import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';
import { Sender, Email, Instruction } from '@rose/db';
import { renderTemplate, SYSTEM_PROMPT_BASE } from '@rose/llm';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { resolveProviderForUser } from '../lib/providers.js';

const QUEUE = 'rose.summarize-sender';

type SummarizeJobData = { senderId: string; userId: string };

async function templateFor(userId: Types.ObjectId): Promise<string | null> {
  const userOverride = await Instruction.findOne({
    userId,
    scope: 'sender',
    isDefault: true,
  });
  if (userOverride) return userOverride.template;
  const system = await Instruction.findOne({
    userId,
    scope: 'sender',
    isSystem: true,
  });
  return system?.template ?? null;
}

export function startSummarizeSenderWorker() {
  const worker = new Worker<SummarizeJobData>(
    QUEUE,
    async (job: Job<SummarizeJobData>) => {
      const userId = new Types.ObjectId(job.data.userId);
      const sender = await Sender.findOne({ _id: job.data.senderId, userId });
      if (!sender) return;
      if (sender.summaryLocked) {
        logger.info({ senderId: String(sender._id) }, 'summary locked — skipping');
        return;
      }
      const template = await templateFor(userId);
      if (!template) {
        logger.warn(
          { userId: String(userId) },
          'no sender summary instruction available — skipping',
        );
        return;
      }
      // Pull recent subjects from this sender's mail to give the LLM
      // something to work with. We bias toward variety: distinct subjects
      // first, capped to 12.
      const recent = await Email.find({
        userId,
        'from.address': { $in: sender.addresses ?? [] },
      })
        .sort({ date: -1 })
        .limit(60)
        .select('subject date')
        .lean();
      const seen = new Set<string>();
      const subjects: string[] = [];
      for (const r of recent) {
        const s = (r.subject ?? '').trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        subjects.push(`- ${s.slice(0, 140)}`);
        if (subjects.length >= 12) break;
      }

      const prompt = renderTemplate(template, {
        name: sender.name,
        domain: sender.domain ?? '(none)',
        addresses: (sender.addresses ?? []).slice(0, 6).join(', ') || '(none)',
        websites: (sender.websites ?? []).slice(0, 8).join(', ') || '(none)',
        recent_subjects: subjects.join('\n') || '(no recent subjects)',
        email_count: String(sender.emailCount ?? 0),
        page_count: String(sender.pageCount ?? 0),
      });

      const { provider, model } = await resolveProviderForUser(userId, 'generation');
      const text = await provider.generate({
        model,
        prompt,
        system: SYSTEM_PROMPT_BASE,
        temperature: 0.3,
      });
      sender.summary = text.trim().slice(0, 600);
      sender.summaryGeneratedAt = new Date();
      await sender.save();
      logger.info({ senderId: String(sender._id) }, 'summary written');
    },
    { connection: redis, concurrency: 2, lockDuration: 5 * 60_000, stalledInterval: 60_000, maxStalledCount: 1 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'summarize-sender failed'),
  );
  return worker;
}
