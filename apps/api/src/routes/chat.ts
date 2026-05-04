import { Router } from 'express';
import { Types } from 'mongoose';
import {
  Conversation,
  Message,
  Page,
  Instruction,
  type PageDoc,
} from '@rose/db';
import { renderTemplate, SYSTEM_PROMPT_BASE } from '@rose/llm';
import { userIdOf } from '../middleware/auth.js';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

export const chatRouter: Router = Router();

/** Cosine similarity between two equal-length vectors. */
function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Pick a 1.5KB-ish window of contentMd centred on the most relevant
 *  paragraph. Cheap heuristic — the paragraph with the highest count
 *  of question keywords wins. Falls back to the first 1.5KB. */
function bestWindow(content: string, queryTokens: string[], targetLen = 1500): string {
  if (!content) return '';
  if (content.length <= targetLen) return content;
  const paras = content.split(/\n{2,}/);
  let bestIdx = 0;
  let bestScore = 0;
  paras.forEach((p, i) => {
    const lower = p.toLowerCase();
    let s = 0;
    for (const t of queryTokens) {
      if (lower.includes(t)) s += 1;
    }
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  });
  // Build outward from bestIdx until we hit the budget.
  let start = bestIdx;
  let end = bestIdx;
  let len = paras[bestIdx]?.length ?? 0;
  while (len < targetLen && (start > 0 || end < paras.length - 1)) {
    if (start > 0) {
      start -= 1;
      len += (paras[start]?.length ?? 0) + 2;
      if (len >= targetLen) break;
    }
    if (end < paras.length - 1) {
      end += 1;
      len += (paras[end]?.length ?? 0) + 2;
    }
  }
  return paras.slice(start, end + 1).join('\n\n').slice(0, targetLen + 200);
}

type Hit = {
  doc: PageDoc;
  score: number;
  matchedBy: string[];
  textRank?: number;
  semRank?: number;
};

/**
 * Hybrid retrieval: text search + embedding kNN, fused with RRF. We
 * keep this self-contained in the chat route rather than pulling in
 * `services/search.ts` because chat needs the *page documents* (for
 * windowing) rather than search-shaped snippets.
 */
async function retrieve(
  userId: Types.ObjectId,
  query: string,
  limit = 12,
): Promise<Hit[]> {
  const filter = {
    userId,
    'flags.userMarkedSpam': { $ne: true },
    'flags.autoQuarantined': { $ne: true },
  };

  // Text search.
  const textHits = (await Page.find({ ...filter, $text: { $search: query } })
    .select('+contentMd')
    .limit(40)
    .lean()) as unknown as PageDoc[];

  // Embedding search.
  let semHits: { doc: PageDoc; score: number }[] = [];
  try {
    const { provider, model } = await resolveProviderForUser(userId, 'embedding');
    if (provider.supportsEmbeddings) {
      const tag = `${provider.id}:${model}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      let qVec: number[];
      try {
        qVec = await provider.embed(model, query, ctrl.signal);
      } finally {
        clearTimeout(timer);
      }
      const candidates = (await Page.find({
        ...filter,
        embedding: { $ne: null },
        embeddingModel: tag,
      })
        .select('+embedding +contentMd')
        .lean()) as unknown as (PageDoc & { embedding: number[] })[];
      semHits = candidates
        .map((doc) => ({ doc, score: cosine(qVec, doc.embedding as number[]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 40);
    }
  } catch (err) {
    logger.warn({ err }, 'chat retrieval: embedding leg failed; falling back to text only');
  }

  // RRF fusion (k=60, standard).
  const k = 60;
  const fused = new Map<string, Hit>();
  textHits.forEach((doc, i) => {
    fused.set(String(doc._id), {
      doc,
      score: 1 / (k + (i + 1)),
      matchedBy: ['text'],
      textRank: i + 1,
    });
  });
  semHits.forEach(({ doc }, i) => {
    const id = String(doc._id);
    const prev = fused.get(id);
    const rrf = 1 / (k + (i + 1));
    if (prev) {
      prev.score += rrf;
      prev.matchedBy.push('semantic');
      prev.semRank = i + 1;
    } else {
      fused.set(id, { doc, score: rrf, matchedBy: ['semantic'], semRank: i + 1 });
    }
  });
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Lowercase tokens with stopword + length filter. Reused by bestWindow. */
function queryTokens(q: string): string[] {
  const stop = new Set(['the', 'and', 'for', 'are', 'but', 'you', 'with', 'this', 'that', 'how', 'what', 'when', 'where']);
  return [...new Set(
    q
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !stop.has(t)),
  )];
}

/** Render the retrieved page windows as a labelled prompt block. */
function renderContext(hits: Hit[], q: string): { text: string; citations: Record<string, { pageId: string; slug: string; title: string; score: number }> } {
  const tokens = queryTokens(q);
  const blocks: string[] = [];
  const citations: Record<string, { pageId: string; slug: string; title: string; score: number }> = {};
  hits.forEach((h, i) => {
    const label = `p${i + 1}`;
    const window = bestWindow((h.doc.contentMd as string) ?? '', tokens);
    citations[label] = {
      pageId: String(h.doc._id),
      slug: h.doc.slug,
      title: h.doc.title,
      score: Number(h.score.toFixed(4)),
    };
    blocks.push(
      `[${label}] "${h.doc.title}"\n` +
        (h.doc.summary ? `Summary: ${h.doc.summary}\n` : '') +
        `"""\n${window.trim()}\n"""`,
    );
  });
  return { text: blocks.join('\n\n'), citations };
}

/** Pull the chat.answer template the user has configured (or the
 *  default seed). Falls back to a hard-coded fallback if neither is
 *  installed yet. */
async function chatTemplate(userId: Types.ObjectId): Promise<string> {
  const userDefault = await Instruction.findOne({ userId, scope: 'chat', isDefault: true });
  if (userDefault) return userDefault.template;
  const system = await Instruction.findOne({ userId, scope: 'chat', isSystem: true });
  if (system) return system.template;
  return `Answer the question over the user's wiki using the labelled context below.

CONTEXT
{{context}}

CONVERSATION
{{history}}

QUESTION
{{question}}

Cite [pN] tokens for every claim. Reply in plain markdown.`;
}

/** Render the last few turns of the conversation for the prompt. */
function renderHistory(messages: { role: string; content: string }[], cap = 4000): string {
  const recent = messages.slice(-8);
  let out = '';
  for (const m of recent) {
    const piece = `${m.role.toUpperCase()}: ${m.content}\n`;
    if (out.length + piece.length > cap) break;
    out += piece;
  }
  return out.trim() || '(no prior turns)';
}

// ── Routes ───────────────────────────────────────────────────────────

chatRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const conversations = await Conversation.find({ userId })
    .sort({ pinned: -1, updatedAt: -1 })
    .limit(200)
    .lean();
  res.json({ conversations });
});

chatRouter.get('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  if (!Types.ObjectId.isValid(req.params.id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const conversation = await Conversation.findOne({ _id: req.params.id, userId }).lean();
  if (!conversation) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const messages = await Message.find({ conversationId: conversation._id, userId })
    .sort({ createdAt: 1 })
    .lean();
  res.json({ conversation, messages });
});

chatRouter.patch('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const { title, pinned } = (req.body ?? {}) as { title?: string; pinned?: boolean };
  const update: Record<string, unknown> = {};
  if (typeof title === 'string' && title.trim()) update.title = title.trim().slice(0, 80);
  if (typeof pinned === 'boolean') update.pinned = pinned;
  const conv = await Conversation.findOneAndUpdate(
    { _id: req.params.id, userId },
    update,
    { new: true },
  );
  if (!conv) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(conv);
});

chatRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const conv = await Conversation.findOneAndDelete({ _id: req.params.id, userId });
  if (conv) await Message.deleteMany({ conversationId: conv._id, userId });
  res.json({ ok: true });
});

/** Retrieval-only preview for the UI ("what would I get back?"). */
chatRouter.post('/search', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const { message } = (req.body ?? {}) as { message?: string };
  if (!message || !message.trim()) {
    res.status(400).json({ error: 'invalid_request', message: 'Message required' });
    return;
  }
  const hits = await retrieve(userId, message, 8);
  res.json({
    hits: hits.map((h) => ({
      pageId: String(h.doc._id),
      slug: h.doc.slug,
      title: h.doc.title,
      summary: h.doc.summary,
      score: h.score,
      matchedBy: h.matchedBy,
    })),
  });
});

/**
 * Streaming chat. Server-Sent Events; emits:
 *   { type: 'conversation', conversationId }
 *   { type: 'citations', citations: { pN: {...} } }
 *   { type: 'token', delta }
 *   { type: 'completed', messageId, model }
 *   { type: 'error', message }
 */
chatRouter.post('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = (req.body ?? {}) as { conversationId?: string; message?: string };
  const message = (body.message ?? '').trim();
  if (!message) {
    res.status(400).json({ error: 'invalid_request', message: 'Message required' });
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

  // Resolve / create conversation.
  let conversation =
    body.conversationId && Types.ObjectId.isValid(body.conversationId)
      ? await Conversation.findOne({ _id: body.conversationId, userId })
      : null;
  if (!conversation) {
    conversation = await Conversation.create({
      userId,
      title: message.slice(0, 60),
    });
  }
  send({ type: 'conversation', conversationId: String(conversation._id) });

  // Persist the user turn first so a disconnect mid-stream doesn't
  // lose the question.
  await Message.create({
    conversationId: conversation._id,
    userId,
    role: 'user',
    content: message,
  });

  // Retrieve.
  let hits: Hit[];
  try {
    hits = await retrieve(userId, message, 12);
  } catch (err) {
    logger.warn({ err }, 'chat retrieval failed; continuing with empty context');
    hits = [];
  }
  // Trim to the top 6 windows so the prompt stays bounded.
  const top = hits.slice(0, 6);
  const { text: contextBlock, citations } = renderContext(top, message);
  send({ type: 'citations', citations });

  // History excluding the just-saved user turn (we add it back below).
  const prior = await Message.find({ conversationId: conversation._id, userId })
    .sort({ createdAt: 1 })
    .lean();
  // The last entry is the user turn we just persisted; include it in
  // history for context but drop it from the "prior" list so it isn't
  // duplicated.
  const history = renderHistory(prior.slice(0, -1));

  const template = await chatTemplate(userId);
  const prompt = renderTemplate(template, {
    context: contextBlock || '(no relevant pages found)',
    history,
    question: message,
  });

  let providerInfo: { provider: { id: string; generateStream: (opts: unknown) => AsyncGenerator<{ response: string }> }; model: string; providerId: string };
  try {
    providerInfo = (await resolveProviderForUser(userId, 'generation')) as typeof providerInfo;
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
      temperature: 0.2,
      signal: ctrl.signal,
    } as Parameters<typeof provider.generateStream>[0])) {
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

  // Strip orphan citations (pN that don't map to retrieved pages).
  const validLabels = new Set(Object.keys(citations));
  const used = new Set<string>();
  for (const m of buffered.matchAll(/\[(p\d+(?:\s*,\s*p\d+)*)\]/g)) {
    for (const label of m[1]!.split(',')) {
      const trimmed = label.trim();
      if (validLabels.has(trimmed)) used.add(trimmed);
    }
  }
  const filteredCitations: Record<string, unknown> = {};
  for (const k of used) filteredCitations[k] = citations[k];

  const assistant = await Message.create({
    conversationId: conversation._id,
    userId,
    role: 'assistant',
    content: buffered.trim(),
    citations: filteredCitations,
    model: `${providerId}:${genModel}`,
  });
  // Bump conversation timestamp so it sorts correctly in the rail.
  conversation.updatedAt = new Date();
  await conversation.save();

  send({
    type: 'completed',
    messageId: String(assistant._id),
    model: `${providerId}:${genModel}`,
  });
  res.end();
});
