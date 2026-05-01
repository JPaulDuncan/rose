import { describe, it, expect } from 'vitest';
import { cleanBody, extractSubjectTemplate, htmlToPlain } from '../index.js';

describe('cleanBody', () => {
  it('strips quoted reply lines', () => {
    const input = `Hello,\n> Original message\n> stays out\nMy reply continues.`;
    const out = cleanBody(input);
    expect(out).toContain('Hello');
    expect(out).not.toContain('Original message');
    expect(out).toContain('My reply continues');
  });

  it('strips signature delimiter', () => {
    const input = `Body content\n\n-- \nName\nTitle`;
    const out = cleanBody(input);
    expect(out).toContain('Body content');
    expect(out).not.toContain('Name');
  });

  it('strips reply marker', () => {
    const input = `Reply text\n\nOn Mon, Apr 1 2026, Joe <joe@x> wrote:\nold stuff`;
    const out = cleanBody(input);
    expect(out).toContain('Reply text');
    expect(out).not.toContain('old stuff');
  });

  it('does not over-strip a short body that looks signature-like', () => {
    // Without the safety net, the leading "-- " would erase everything.
    const input = `-- \nThe quick brown fox jumps over the lazy dog and goes home.`;
    const out = cleanBody(input);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('quick brown fox');
  });
});

describe('extractSubjectTemplate', () => {
  it('collapses build numbers and SHAs to placeholders', () => {
    const a = extractSubjectTemplate('CI / build #1234 — Failed for a1b2c3d4e5f6');
    const b = extractSubjectTemplate('CI / build #5678 — Failed for fedcba987654');
    expect(a).toBe(b);
  });

  it('strips Re: / Fwd: prefixes', () => {
    expect(extractSubjectTemplate('Re: Hello')).toBe(extractSubjectTemplate('Hello'));
    expect(extractSubjectTemplate('FWD: Daily digest')).toBe(
      extractSubjectTemplate('Daily digest'),
    );
  });

  it('replaces dates and money', () => {
    const a = extractSubjectTemplate('Receipt $42.50 on 2026-04-30');
    const b = extractSubjectTemplate('Receipt $99.00 on 2026-05-01');
    expect(a).toBe(b);
  });

  it('returns null for empty input', () => {
    expect(extractSubjectTemplate(null)).toBeNull();
    expect(extractSubjectTemplate('')).toBeNull();
  });
});

describe('htmlToPlain', () => {
  it('strips tags and decodes common entities', () => {
    const html =
      '<style>.x{color:red}</style><p>Hello&nbsp;world &amp; <strong>friends</strong>!</p>';
    const out = htmlToPlain(html);
    expect(out).toContain('Hello world & friends!');
    expect(out).not.toContain('<');
    expect(out).not.toContain('color:red');
  });

  it('preserves paragraph breaks', () => {
    const out = htmlToPlain('<p>Line one</p><p>Line two</p>');
    expect(out).toContain('Line one');
    expect(out).toContain('Line two');
    expect(out.indexOf('Line one')).toBeLessThan(out.indexOf('Line two'));
  });
});
