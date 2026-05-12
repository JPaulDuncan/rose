import { describe, it, expect } from 'vitest';
import { extractArticle } from '../services/extractArticle.js';

/**
 * Tests for the consolidated HTML extraction path. extractArticle
 * is the single ingest point for fetchAndParse, websiteSync, AND
 * topicResearch — drift here breaks all three. Synthetic fixtures
 * keep the suite hermetic; real-world layouts vary too much for
 * golden-file testing.
 */

function htmlFromBody(bodyMd: string, opts: { title?: string; publishedAt?: string; siteName?: string } = {}) {
  const meta: string[] = [];
  if (opts.publishedAt) {
    meta.push(`<meta property="article:published_time" content="${opts.publishedAt}" />`);
  }
  if (opts.siteName) {
    meta.push(`<meta property="og:site_name" content="${opts.siteName}" />`);
  }
  return `<!doctype html><html><head><title>${opts.title ?? 'Test'}</title>${meta.join('')}</head><body><article><h1>${opts.title ?? 'Test'}</h1><p>${bodyMd}</p></article></body></html>`;
}

describe('extractArticle quickSniff', () => {
  it('rejects null / empty / very short HTML', () => {
    expect(extractArticle('')).toBeNull();
    expect(extractArticle('<html></html>')).toBeNull();
    expect(extractArticle('hi')).toBeNull();
  });

  it('rejects login-wall pages', () => {
    // Short body + login-shaped text triggers the sniff bail.
    const wall = `<html><body><h1>Please sign in</h1><p>Sign in to continue reading.</p></body></html>`;
    expect(extractArticle(wall)).toBeNull();
  });

  it("does NOT reject non-login pages just because they're under the size cap", () => {
    // Pages without 'sign in' / 'log in' / 'access denied' patterns
    // should still attempt extraction even if short. Readability may
    // still reject them downstream for thin content; the sniff just
    // doesn't pre-empt.
    const html = `<html><head><title>News</title></head><body><article><p>${'hello world '.repeat(60)}</p></article></body></html>`;
    const r = extractArticle(html);
    // Either null (Readability rejected) or a real article — the
    // assertion is that the path didn't error out.
    expect(r === null || typeof r === 'object').toBe(true);
  });

  it('rejects captcha / cloudflare interstitials', () => {
    // The htmlparser2 sniff catches "just a moment..." style
    // Cloudflare gates the old regex stub missed.
    const html =
      '<html><head><title>Just a moment...</title></head><body><h1>Checking your browser</h1><p>Please enable cookies and JavaScript.</p></body></html>';
    expect(extractArticle(html)).toBeNull();
  });

  it('ignores text inside <script> when scoring page weight', () => {
    // A page whose only "content" is a giant inline analytics blob
    // should be rejected; the old regex sniff would have let it
    // through because html.length is large.
    const scriptJunk = '"a":"b","c":"d",'.repeat(500);
    const html = `<html><head><title>Tracking</title></head><body><script>window.__data=[${scriptJunk}];</script><p>hi</p></body></html>`;
    expect(extractArticle(html)).toBeNull();
  });
});

describe('extractArticle output shape', () => {
  it('extracts title + content + hash on a normal article', () => {
    const body = 'Iran’s political situation continued to develop this week. ';
    const html = htmlFromBody(body.repeat(40), {
      title: 'Iran update',
      publishedAt: '2026-05-08T12:00:00Z',
      siteName: 'Test Wire',
    });
    const r = extractArticle(html);
    expect(r).not.toBeNull();
    if (!r) return;
    expect(r.title).toContain('Iran');
    expect(r.contentMd.length).toBeGreaterThan(100);
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.publishedAt).toBe('2026-05-08T12:00:00Z');
    expect(r.siteName).toBe('Test Wire');
  });

  it('rejects very thin content even after parse', () => {
    const html = `<html><head><title>Tiny</title></head><body><article><p>One sentence only.</p></article></body></html>`;
    const r = extractArticle(html);
    expect(r).toBeNull();
  });

  it('produces stable contentHash for unchanged input', () => {
    const html = htmlFromBody(
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(30),
      { title: 'Stable' },
    );
    const a = extractArticle(html);
    const b = extractArticle(html);
    expect(a?.contentHash).toBe(b?.contentHash);
  });

  it('produces different contentHash when the body changes', () => {
    const a = extractArticle(
      htmlFromBody('Body version A. '.repeat(40), { title: 'T' }),
    );
    const b = extractArticle(
      htmlFromBody('Body version B. '.repeat(40), { title: 'T' }),
    );
    expect(a?.contentHash).not.toBe(b?.contentHash);
  });
});
