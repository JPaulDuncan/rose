import { describe, it, expect } from 'vitest';
import {
  _buildSubjectPrompt as buildSubjectPrompt,
  _renderContextBlock as renderContextBlock,
  _pickExcerpt as pickExcerpt,
  _pickSenderFromCitations as pickSenderFromCitations,
  _mapEntityType as mapEntityType,
} from '../processors/daydream.js';
import type { DaydreamContext, DaydreamSnippet } from '@rose/llm';

/**
 * Daydream's disambiguating context plumbing. The whole point: when
 * the LLM is asked to write an encyclopedic entry for "The Drama"
 * surfaced from an email signed by A24, it should see enough
 * context to pick the 2017 film over the generic English noun. The
 * helpers below assemble that context block; lock down the shapes
 * the synthesis prompt depends on.
 */

const baseSnippet = (overrides: Partial<DaydreamSnippet> = {}): DaydreamSnippet => ({
  title: 'Wikipedia',
  url: 'https://en.wikipedia.org/wiki/Foo',
  content: 'A short excerpt.',
  confidence: 0.9,
  fetchedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

describe('renderContextBlock', () => {
  it('returns nothing when context is undefined', () => {
    expect(renderContextBlock(undefined)).toEqual([]);
  });

  it('returns nothing when context has no usable fields', () => {
    expect(renderContextBlock({})).toEqual([]);
    expect(renderContextBlock({ pageTags: [] })).toEqual([]);
  });

  it('emits one labelled line per filled field, ordered title→type→sender→tags→excerpt', () => {
    const lines = renderContextBlock({
      pageTitle: 'A24 Spring Releases',
      entityType: 'work',
      senderName: 'A24',
      senderDomain: 'a24films.com',
      pageTags: ['film', 'cinema'],
      excerpt: '…trailer dropped for The Drama…',
    });
    expect(lines[0]).toBe('CONTEXT:');
    // Final line is the trailing empty separator before SNIPPETS.
    expect(lines[lines.length - 1]).toBe('');
    const body = lines.slice(1, -1);
    expect(body).toEqual([
      'Page title: A24 Spring Releases',
      'Entity type: work',
      'Email sender: A24 <a24films.com>',
      'Page tags: film, cinema',
      'Excerpt: "…trailer dropped for The Drama…"',
    ]);
  });

  it('falls back to bare-domain rendering when name is missing', () => {
    const lines = renderContextBlock({ senderDomain: 'a24films.com' });
    expect(lines).toContain('Email sender domain: a24films.com');
  });

  it('caps page tags at 8 entries', () => {
    const lines = renderContextBlock({
      pageTags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
    });
    const tagLine = lines.find((l) => l.startsWith('Page tags:'));
    expect(tagLine).toBe('Page tags: a, b, c, d, e, f, g, h');
  });

  it('renders userFacts under a disambiguation-only header with bullets', () => {
    const lines = renderContextBlock({
      userFacts: ['I am a film school graduate', 'I prefer A24 releases'],
    });
    expect(lines).toContain(
      'User context (for disambiguation only, NOT facts about the subject):',
    );
    expect(lines).toContain('  - I am a film school graduate');
    expect(lines).toContain('  - I prefer A24 releases');
  });

  it('caps userFacts at 8 entries', () => {
    const facts = Array.from({ length: 12 }, (_, i) => `fact ${i + 1}`);
    const lines = renderContextBlock({ userFacts: facts });
    const bullets = lines.filter((l) => l.startsWith('  - fact '));
    expect(bullets).toHaveLength(8);
  });

  it('omits the userFacts section when the array is empty', () => {
    const lines = renderContextBlock({ userFacts: [] });
    expect(lines).toEqual([]);
  });
});

describe('buildSubjectPrompt', () => {
  it('renders a SUBJECT + SNIPPETS prompt without a CONTEXT block when no context is provided', () => {
    const out = buildSubjectPrompt('entity', 'The Drama', [baseSnippet()]);
    expect(out).toContain('SUBJECT (entity): The Drama');
    expect(out).not.toContain('CONTEXT:');
    expect(out).toContain('SNIPPETS:');
  });

  it('inserts the CONTEXT block between SUBJECT and SNIPPETS', () => {
    const ctx: DaydreamContext = {
      pageTitle: 'A24 Spring Releases',
      senderName: 'A24',
      senderDomain: 'a24films.com',
      entityType: 'work',
      pageTags: ['film'],
    };
    const out = buildSubjectPrompt('entity', 'The Drama', [baseSnippet()], ctx);
    const subjectAt = out.indexOf('SUBJECT (entity):');
    const ctxAt = out.indexOf('CONTEXT:');
    const snippetsAt = out.indexOf('SNIPPETS:');
    expect(subjectAt).toBeGreaterThanOrEqual(0);
    expect(ctxAt).toBeGreaterThan(subjectAt);
    expect(snippetsAt).toBeGreaterThan(ctxAt);
    expect(out).toContain('Email sender: A24 <a24films.com>');
    expect(out).toContain('Entity type: work');
  });

  it('does not emit an empty CONTEXT block when context is provided but empty', () => {
    const out = buildSubjectPrompt('tag', 'misc', [baseSnippet()], {});
    expect(out).not.toContain('CONTEXT:');
  });
});

describe('pickExcerpt', () => {
  it('returns null when target is absent from the text', () => {
    expect(pickExcerpt('Some other prose entirely.', 'The Drama')).toBeNull();
  });

  it('returns null when text itself is null/empty', () => {
    expect(pickExcerpt(null, 'The Drama')).toBeNull();
    expect(pickExcerpt('', 'The Drama')).toBeNull();
    expect(pickExcerpt(undefined, 'The Drama')).toBeNull();
  });

  it('extracts a window around the first occurrence of the target', () => {
    const prelude = 'Filler paragraph the entity does not appear in. '.repeat(6);
    const middle =
      'In April 2017 A24 quietly released The Drama, a coming-of-age film that received warm reviews from critics.';
    const tail = ' Subsequent paragraphs continue unrelated.'.repeat(6);
    const text = prelude + middle + tail;
    const out = pickExcerpt(text, 'The Drama');
    expect(out).toMatch(/The Drama/);
    expect(out!.length).toBeLessThan(text.length);
    // The excerpt should be a window, not the whole text.
    expect(out!.length).toBeLessThan(300);
  });

  it('is case-insensitive on the target match', () => {
    const text = 'A24 released THE DRAMA last spring. It opened to wide praise.';
    const out = pickExcerpt(text, 'The Drama');
    expect(out).not.toBeNull();
    expect(out!.toLowerCase()).toContain('the drama');
  });

  it('prefixes/suffixes with an ellipsis when truncating', () => {
    const long = `${'lorem ipsum '.repeat(40)}The Drama${' dolor sit amet'.repeat(40)}`;
    const out = pickExcerpt(long, 'The Drama');
    expect(out).toMatch(/^…/);
    expect(out).toMatch(/…$/);
  });
});

describe('pickSenderFromCitations', () => {
  it('returns nulls when citations is missing or not an object', () => {
    expect(pickSenderFromCitations(null)).toEqual({ name: null, domain: null });
    expect(pickSenderFromCitations(undefined)).toEqual({ name: null, domain: null });
    expect(pickSenderFromCitations('garbage')).toEqual({ name: null, domain: null });
  });

  it('extracts name + domain from the canonical {from: {name, address}} shape', () => {
    expect(
      pickSenderFromCitations({
        e1: { from: { name: 'A24', address: 'hello@a24films.com' } },
      }),
    ).toEqual({ name: 'A24', domain: 'a24films.com' });
  });

  it('falls back through entries until one has a usable from', () => {
    expect(
      pickSenderFromCitations({
        e1: {},
        e2: { subject: 'no from here' },
        e3: { from: { name: 'A24', address: 'hello@a24films.com' } },
      }),
    ).toEqual({ name: 'A24', domain: 'a24films.com' });
  });

  it('handles the legacy string shape "A24 <hello@a24films.com>"', () => {
    const out = pickSenderFromCitations({
      e1: { from: 'A24 <hello@a24films.com>' },
    });
    expect(out.domain).toBe('a24films.com');
    expect(out.name).toBe('A24');
  });

  it('handles a bare-string from like "hello@a24films.com"', () => {
    expect(pickSenderFromCitations({ e1: { from: 'hello@a24films.com' } })).toEqual({
      name: null,
      domain: 'a24films.com',
    });
  });
});

describe('mapEntityType', () => {
  it('passes through registry types unchanged', () => {
    expect(mapEntityType('person')).toBe('person');
    expect(mapEntityType('work')).toBe('work');
    expect(mapEntityType('organization')).toBe('organization');
    expect(mapEntityType('place')).toBe('place');
  });

  it('returns null for null/undefined', () => {
    expect(mapEntityType(null)).toBeNull();
    expect(mapEntityType(undefined)).toBeNull();
  });
});
