import { Worker, type Job } from 'bullmq';
import { Types } from 'mongoose';
import { Sender, SenderBrand, Email, Instruction } from '@rose/db';
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
      // Plan 15 — brand-global brief lives on SenderBrand. Read
      // canonical brand metadata from there; the per-user Sender
      // row only carries counters / overrides.
      const brand = await SenderBrand.findOne({ brandKey: sender.brandKey })
        .select('name domain addresses websites')
        .lean();
      if (!brand) {
        logger.warn(
          { senderId: String(sender._id), brandKey: sender.brandKey },
          'summarize: brand row missing — skipping',
        );
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
      // Pull recent subjects from THIS user's mail to give the LLM
      // something to work with. The brief itself is brand-global,
      // but the recent-subjects evidence comes from whoever
      // triggered the regen. The prompt template enforces
      // encyclopedic prose (no "you often get…") so the result
      // stays usable for every other user too.
      const recent = await Email.find({
        userId,
        'from.address': { $in: brand.addresses ?? [] },
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
        name: brand.name ?? sender.brandKey,
        domain: brand.domain ?? '(none)',
        addresses: (brand.addresses ?? []).slice(0, 6).join(', ') || '(none)',
        websites: (brand.websites ?? []).slice(0, 8).join(', ') || '(none)',
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
      const finalSummary = text.trim().slice(0, 600);
      const generatedAt = new Date();

      // Plan 15 — the brief is global; only write to SenderBrand.
      // `forgottenBriefBy` clears so anyone who'd previously muted
      // sees the refreshed version.
      try {
        await SenderBrand.updateOne(
          { brandKey: sender.brandKey },
          {
            $setOnInsert: {
              brandKey: sender.brandKey,
              firstSeenBy: userId,
            },
            $set: {
              summary: finalSummary,
              summaryGeneratedAt: generatedAt,
              summaryModel: `${(provider as { id?: string }).id ?? 'provider'}:${model}`,
              forgottenBriefBy: [],
            },
          },
          { upsert: true },
        );
      } catch (err) {
        logger.warn(
          { err, senderId: String(sender._id), brandKey: sender.brandKey },
          'sender-brand summary write failed',
        );
      }
      logger.info({ senderId: String(sender._id) }, 'summary written');
    },
    { connection: redis, concurrency: 2, lockDuration: 5 * 60_000, stalledInterval: 60_000, maxStalledCount: 1 },
  );
  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, err }, 'summarize-sender failed'),
  );
  return worker;
}
