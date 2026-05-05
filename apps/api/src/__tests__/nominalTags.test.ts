import { describe, it, expect } from 'vitest';
import { isNominalTag, filterNominalTags, singularize } from '@rose/email-parser';

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

describe('singularize', () => {
  it('strips simple plurals', () => {
    expect(singularize('promotions')).toBe('promotion');
    expect(singularize('emails')).toBe('email');
    expect(singularize('articles')).toBe('article');
  });

  it('handles -ies → -y', () => {
    expect(singularize('queries')).toBe('query');
    expect(singularize('categories')).toBe('category');
    expect(singularize('industries')).toBe('industry');
  });

  it('handles -es endings', () => {
    expect(singularize('boxes')).toBe('box');
    expect(singularize('classes')).toBe('class'); // class is a NON_PLURAL, stays
    expect(singularize('beaches')).toBe('beach');
    expect(singularize('dishes')).toBe('dish');
  });

  it('preserves words that look plural but are singular', () => {
    expect(singularize('news')).toBe('news');
    expect(singularize('series')).toBe('series');
    expect(singularize('analysis')).toBe('analysis');
    expect(singularize('business')).toBe('business');
  });

  it('handles common irregulars', () => {
    expect(singularize('children')).toBe('child');
    expect(singularize('people')).toBe('person');
  });

  it('singularizes the last word in multi-word phrases', () => {
    expect(singularize('marketing campaigns')).toBe('marketing campaign');
    expect(singularize('product-launches')).toBe('product-launch');
  });

  it('leaves already-singular words alone', () => {
    expect(singularize('promotion')).toBe('promotion');
    expect(singularize('marketing')).toBe('marketing');
    expect(singularize('user')).toBe('user');
  });

  it('does not over-strip very short words', () => {
    expect(singularize('cat')).toBe('cat');
    expect(singularize('bus')).toBe('bus'); // ends -us
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

  it('preserves stable order of the survivors and singularizes', () => {
    // "sales" → "sale" via the singularizer; the short single
    // letters and pure stopwords get dropped.
    expect(filterNominalTags(['c', 'b', 'a', 'marketing', 'sales'])).toEqual([
      'marketing',
      'sale',
    ]);
  });

  it('collapses plural + singular onto one tag', () => {
    expect(filterNominalTags(['promotions', 'promotion'])).toEqual(['promotion']);
    expect(filterNominalTags(['categories', 'category', 'queries'])).toEqual([
      'category',
      'query',
    ]);
  });
});
