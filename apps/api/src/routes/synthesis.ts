import { Router } from 'express';
import { Types } from 'mongoose';
import { Page, PageRevision, Instruction } from '@rose/db';
import { renderTemplate, SYSTEM_PROMPT_BASE } from '@rose/llm';
import { slugify, type CitationMap } from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';
import { postWriteHooksQueue } from '../lib/queues.js';

export const synthesisRouter: Router = Router();

async function templateFor(userId: Types.ObjectId): Promise<string> {
  const userOverride = await Instruction.findOne({
    userId,
    scope: 'synthesis',
    isDefault: true,
  });
  if (userOverride) return userOverride.template;
  const system = await Instruction.findOne({ userId, scope: 'synthesis', isSystem: true });
  if (system) return system.template;
  return `Combine the wiki entries below into one coherent meta-entry. Cite each as [pN] inline. No preamble.

ENTRIES
{{entries}}

OPTIONAL FOCUS
{{focus}}

Output the meta-entry only.`;
}

async function uniqueSlug(userId: Types.ObjectId, base: string): Promise<string> {
  let slug = base;
  let n = 1;
  while (await Page.findOne({ userId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

/**
 * Synthesize a user-selected set of wiki pages into a meta-entry.
 * Streams tokens; on completion persists a new Page with
 * groupingMode='synthesis' + synthesisOf[] populated so the source
 * pages are reachable from the result.
 */
synthesisRouter.post('/synthesize', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = (req.body ?? {}) as {
    pageIds?: string[];
    focus?: string;
    title?: string;
  };
  const ids = (body.pageIds ?? [])
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  if (ids.length < 2) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'At least 2 page IDs required',
    });
    return;
  }
  // Skip pages that are themselves syntheses to avoid feedback loops.
  const pages = (await Page.find({
    userId,
    _id: { $in: ids },
    groupingMode: { $ne: 'synthesis' },
  })
    .select('+contentMd')
    .lean()) as unknown as Array<{
    _id: Types.ObjectId;
    slug: string;
    title: string;
    summary: string;
    contentMd: string;
  }>;
  if (pages.length < 2) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Not enough non-synthesis pages found for the given IDs',
    });
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Build the labeled context block.
  const citations: CitationMap = {};
  const entries = pages
    .map((p, i) => {
      const label = `p${i + 1}`;
      // Citation map shape mirrors the chat route — slug + title for the UI.
      (citations as Record<string, unknown>)[label] = {
        emailId: '',
        subject: p.title,
        from: null,
        date: null,
      };
      const md = (p.contentMd ?? '').slice(0, 6000);
      return `[${label}] "${p.title}"\n${p.summary ? `Summary: ${p.summary}\n` : ''}"""\n${md}\n"""`;
    })
    .join('\n\n');
  send({
    type: 'pages',
    pages: pages.map((p, i) => ({
      label: `p${i + 1}`,
      _id: String(p._id),
      slug: p.slug,
      title: p.title,
    })),
  });

  const template = await templateFor(userId);
  const prompt = renderTemplate(template, {
    entries,
    focus: (body.focus ?? '').trim() || '(none)',
  });

  let providerInfo;
  try {
    providerInfo = await resolveProviderForUser(userId, 'generation');
  } catch (err) {
    send({ type: 'error', message: (err as Error).message });
    res.end();
    return;
  }
  const { provider, model: genModel, providerId } = providerInfo;

  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());

  let buffered = '';
  try {
    for await (const chunk of provider.generateStream({
      model: genModel,
      prompt,
      system: SYSTEM_PROMPT_BASE,
      temperature: 0.3,
    })) {
      if (chunk.response) {
        buffered += chunk.response;
        send({ type: 'token', delta: chunk.response });
      }
    }
  } catch (err) {
    send({ type: 'error', message: (err as Error).message });
    res.end();
    return;
  }

  // Persist as a Page with groupingMode='synthesis'. Title comes from
  // the user (when given) or a deterministic default.
  const titleBase =
    (body.title ?? '').trim() ||
    `Synthesis · ${pages
      .slice(0, 2)
      .map((p) => p.title)
      .join(' + ')}${pages.length > 2 ? ` (+${pages.length - 2})` : ''}`;
  const title = titleBase.slice(0, 200);
  const baseSlug = slugify(`synthesis-${title}`);
  const slug = await uniqueSlug(userId, baseSlug);
  const summary = buffered.split('\n\n')[0]?.slice(0, 280) ?? '';

  try {
    const created = await Page.create({
      userId,
      slug,
      title,
      summary,
      contentMd: buffered.trim(),
      tags: ['synthesis'],
      topics: ['synthesis'],
      priority: 'normal',
      groupingMode: 'synthesis',
      synthesisOf: pages.map((p) => p._id),
      sourceEmailIds: [],
      senderAddresses: [],
      threadKeys: [],
      citations,
      version: 1,
      generationModel: `${providerId}:${genModel}`,
      generatedAt: new Date(),
      generatedBy: 'synth',
    });
    await PageRevision.create({
      pageId: created._id,
      version: 1,
      title: created.title,
      summary: created.summary,
      contentMd: created.contentMd,
      editor: 'synth',
      model: `${providerId}:${genModel}`,
    });
    // Plan 12 (G1 finish) — enqueue entity extraction so the
    // synthesis page also gets its prose auto-linked to /n/<key>.
    // The synthesis route lives in the API process; the actual
    // extraction runs in the worker via the post-write-hooks queue.
    try {
      await postWriteHooksQueue.add(
        'entity-extract',
        {
          kind: 'entity-extract',
          userId: String(userId),
          pageId: String(created._id),
        },
        {
          attempts: 1,
          removeOnComplete: 200,
          removeOnFail: 200,
          jobId: `synth-postwrite__${String(created._id)}`,
        },
      );
    } catch (err) {
      logger.warn({ err, pageId: String(created._id) }, 'synthesis: post-write enqueue failed');
    }
    send({
      type: 'completed',
      pageId: String(created._id),
      slug: created.slug,
      model: `${providerId}:${genModel}`,
    });
  } catch (err) {
    logger.warn({ err }, 'synthesis: persist failed');
    send({ type: 'error', message: 'Failed to persist meta-entry' });
  }
  res.end();
});
