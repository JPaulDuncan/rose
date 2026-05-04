import { Router } from 'express';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import { Types } from 'mongoose';
import { ShareLink, Page } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { renderMarkdown } from '../lib/renderMarkdown.js';

export const shareRouter: Router = Router();

function newSlug(): string {
  return crypto.randomBytes(9).toString('base64url');
}

shareRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const links = await ShareLink.find({ userId }).sort({ createdAt: -1 }).lean();
  res.json({ links });
});

shareRouter.post('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = (req.body ?? {}) as {
    targetType?: 'page' | 'tag' | 'category';
    targetId?: string;
    targetTag?: string;
    label?: string;
    password?: string;
    expiresAt?: string;
    indexable?: boolean;
  };
  if (!body.targetType) {
    res.status(400).json({ error: 'invalid_request', message: 'targetType required' });
    return;
  }
  if (body.targetType === 'page' && !body.targetId) {
    res.status(400).json({ error: 'invalid_request', message: 'targetId required for pages' });
    return;
  }
  // Verify the target exists + belongs to the user.
  if (body.targetType === 'page') {
    if (!Types.ObjectId.isValid(body.targetId!)) {
      res.status(400).json({ error: 'invalid_request', message: 'invalid targetId' });
      return;
    }
    const exists = await Page.findOne({ _id: body.targetId, userId }).select('_id').lean();
    if (!exists) {
      res.status(404).json({ error: 'not_found', message: 'page not found' });
      return;
    }
  }
  let passwordHash: string | null = null;
  if (body.password) {
    passwordHash = await argon2.hash(body.password);
  }
  // Mongo unique index defends against the (vanishingly rare) slug
  // collision; retry once on conflict.
  let slug = newSlug();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dup = await ShareLink.findOne({ slug }).select('_id').lean();
    if (!dup) break;
    slug = newSlug();
  }
  const link = await ShareLink.create({
    userId,
    targetType: body.targetType,
    targetId:
      body.targetType === 'page' && body.targetId ? new Types.ObjectId(body.targetId) : null,
    targetTag: body.targetTag ?? null,
    slug,
    passwordHash,
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    label: body.label ?? '',
    indexable: !!body.indexable,
  });
  res.status(201).json({
    _id: String(link._id),
    slug: link.slug,
    url: `${req.protocol}://${req.get('host')}/share/${link.slug}`,
  });
});

shareRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const link = await ShareLink.findOne({ _id: req.params.id, userId });
  if (!link) {
    res.json({ ok: true });
    return;
  }
  link.revokedAt = new Date();
  await link.save();
  res.json({ ok: true });
});

// ── Public render ───────────────────────────────────────────────────

export const sharePublicRouter: Router = Router();

sharePublicRouter.get('/:slug', async (req, res) => {
  const link = await ShareLink.findOne({ slug: req.params.slug }).select('+passwordHash');
  if (!link || link.revokedAt || (link.expiresAt && link.expiresAt < new Date())) {
    res.status(410).type('text/html').send(
      pageShell('Gone', '<h1>Gone</h1><p>This share link has been revoked or has expired.</p>'),
    );
    return;
  }
  if (link.passwordHash) {
    const supplied = (req.query.p as string | undefined) ?? '';
    if (!supplied) {
      res.status(401).type('text/html').send(passwordPrompt(link.slug));
      return;
    }
    const ok = await argon2.verify(link.passwordHash, supplied).catch(() => false);
    if (!ok) {
      res.status(401).type('text/html').send(passwordPrompt(link.slug, true));
      return;
    }
  }

  // Page-only render in v1.
  if (link.targetType !== 'page' || !link.targetId) {
    res.status(404).type('text/html').send(pageShell('Not found', '<h1>Not found</h1>'));
    return;
  }
  const page = await Page.findById(link.targetId).lean();
  if (!page) {
    res.status(404).type('text/html').send(pageShell('Not found', '<h1>Not found</h1>'));
    return;
  }
  link.viewCount = (link.viewCount ?? 0) + 1;
  await link.save();

  const meta = link.indexable
    ? ''
    : '<meta name="robots" content="noindex, nofollow">';
  const body = `
    <article>
      <header style="border-bottom:4px double #181818;padding-bottom:12px;margin-bottom:24px;">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:2px;color:#888;">Shared from Rose</div>
        <h1 style="font-size:36px;line-height:1.1;margin:6px 0 0;letter-spacing:-0.02em;">${escape(page.title)}</h1>
        ${page.summary ? `<p style="color:#444;font-size:16px;margin-top:8px;">${escape(page.summary)}</p>` : ''}
      </header>
      <div style="font-size:16px;">${renderMarkdown((page.contentMd as string) ?? '')}</div>
      <footer style="margin-top:48px;border-top:1px solid #ddd;padding-top:12px;font-size:11px;color:#888;">
        Shared via Rose. ${link.label ? `· ${escape(link.label)} ` : ''}<a href="https://github.com" style="color:#888;">about</a>
      </footer>
    </article>`;
  res.type('text/html').send(pageShell(page.title, body, meta));
});

function escape(s: string): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pageShell(title: string, body: string, extraHead = ''): string {
  return `<!doctype html><html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${extraHead}
  <title>${escape(title)}</title>
  <style>
    html,body{margin:0;padding:0;background:#fafafa;color:#181818;}
    body{font-family:Georgia,"Times New Roman",serif;line-height:1.6;}
    main{max-width:680px;margin:48px auto;padding:0 24px;}
    a{color:#c1272d;}
    h1,h2,h3{font-family:Georgia,serif;letter-spacing:-0.01em;}
    pre{background:#f1f1f1;padding:12px;overflow:auto;border-radius:6px;}
    blockquote{border-left:4px solid #c1272d;margin:1em 0;padding-left:1em;color:#444;font-style:italic;}
    img{max-width:100%;height:auto;}
  </style></head><body><main>${body}</main></body></html>`;
}

function passwordPrompt(slug: string, failed = false): string {
  return pageShell(
    'Password required',
    `<h1>Password required</h1>
     ${failed ? '<p style="color:#c1272d;">Wrong password.</p>' : ''}
     <form method="get" action="/share/${slug}" style="display:flex;gap:8px;">
       <input type="password" name="p" autofocus style="flex:1;padding:8px;font-size:16px;">
       <button type="submit" style="padding:8px 16px;background:#181818;color:white;border:0;cursor:pointer;">Open</button>
     </form>`,
  );
}
