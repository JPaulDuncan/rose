import { describe, it, expect } from 'vitest';
import { isNominalTag, filterNominalTags } from '@rose/email-parser';

/**
 * Tag/topic emission has historically been noisy: the LLM lifts
 * sentence-opener courtesy words ("please", "thanks") and
 * question words ("how", "what") into Page.tags, and the
 * heuristic topic extractor sees them as capitalised proper-noun-
 * looking phrases. The shared isNominalTag / filterNominalTags
 * helpers keep this junk off pages, and these tests pin the
 * behaviour so a regression shows up loudly.
 */
describe('isNominalTag', () => {
  it('accepts plausible noun tags', () => {
    for (const ok of [
      'marketing',
      'q3-budget',
      'acme corp',
      'machine-learning',
      'kubernetes',
      'bay area',
      'taylor swift',
      'product-launch',
    ]) {
      expect(isNominalTag(ok), ok).toBe(true);
    }
  });

  it('rejects too-short tags (≤2 chars) — known v1 limitation', () => {
    // Keeps "hi", "ok", "no" out at the cost of also dropping
    // legit tech acronyms like "AI", "ML", "OS". A future relax
    // can carve out an allowlist; for now the floor is 3 chars.
    expect(isNominalTag('AI')).toBe(false);
    expect(isNominalTag('ML')).toBe(false);
  });

  it('rejects courtesy openers', () => {
    for (const bad of ['please', 'thanks', 'thank', 'hi', 'hello', 'regards']) {
      expect(isNominalTag(bad), bad).toBe(false);
    }
  });

  it('rejects question and modal words', () => {
    for (const bad of ['how', 'what', 'when', 'where', 'why', 'which', 'should', 'could', 'must']) {
      expect(isNominalTag(bad), bad).toBe(false);
    }
  });

  it('rejects pronouns / articles / prepositions', () => {
    for (const bad of ['the', 'a', 'an', 'this', 'that', 'we', 'you', 'they', 'it']) {
      expect(isNominalTag(bad), bad).toBe(false);
    }
  });

  it('rejects email-status words and fillers', () => {
    for (const bad of ['re', 'fwd', 'just', 'really', 'today', 'now', 'asap', 'fyi']) {
      expect(isNominalTag(bad), bad).toBe(false);
    }
  });

  it('rejects too-short and shape-broken inputs', () => {
    expect(isNominalTag('a')).toBe(false);
    expect(isNominalTag('hi?')).toBe(false);
    expect(isNominalTag('123')).toBe(false);
    expect(isNominalTag('')).toBe(false);
    expect(isNominalTag('   ')).toBe(false);
  });

  it('preserves multi-word phrases that contain a stopword', () => {
    // "Bank of America" — the lowercase "of" is a stopword but the
    // overall phrase is a proper noun. Same shape: "Department of
    // Defense", "King of England".
    expect(isNominalTag('bank of america')).toBe(true);
    expect(isNominalTag('king of england')).toBe(true);
  });
});

describe('filterNominalTags', () => {
  it('drops the bad and dedupes the good', () => {
    const got = filterNominalTags([
      'please',
      'Marketing',
      'how',
      'thanks',
      'Q3 Budget',
      'q3 budget', // dup of above after lowercasing
      're',
      'product-launch',
      '',
    ]);
    expect(got).toEqual(['marketing', 'q3 budget', 'product-launch']);
  });

  it('preserves stable order of the survivors', () => {
    expect(filterNominalTags(['c', 'b', 'a', 'marketing', 'sales'])).toEqual([
      'marketing',
      'sales',
    ]);
  });
});
