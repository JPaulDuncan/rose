import { describe, it, expect } from 'vitest';
import {
  greedyCoverScore,
  augmentSystemPromptWithUserFacts,
} from '../services/xRetrieve.js';

/**
 * Stage I scoring math (xMemory paper Eq. 4 — simplified to a
 * uniform edge weight since Rose's neighbour links are an
 * unweighted top-K set, not a similarity-weighted graph).
 *
 * The greedy loop itself touches Mongo + an embed provider; the
 * scoring inside the loop is what's worth pinning here.
 */

describe('greedyCoverScore', () => {
  const POOL = 10;
  const WEIGHT = 0.5;

  it('prefers a higher-similarity candidate when coverage is equal', () => {
    const covered = new Set<string>();
    const noNeighbours = new Set<string>();
    const a = greedyCoverScore('a', 0.9, covered, noNeighbours, POOL, WEIGHT);
    const b = greedyCoverScore('b', 0.4, covered, noNeighbours, POOL, WEIGHT);
    expect(a).toBeGreaterThan(b);
  });

  it('rewards candidates that cover more uncovered neighbours', () => {
    const covered = new Set<string>();
    const wideNeighbours = new Set(['n1', 'n2', 'n3', 'n4']);
    const noNeighbours = new Set<string>();
    // Both candidates have the SAME query similarity. The one with
    // the wider neighbourhood should win on the coverage term.
    const wide = greedyCoverScore('a', 0.5, covered, wideNeighbours, POOL, WEIGHT);
    const narrow = greedyCoverScore('b', 0.5, covered, noNeighbours, POOL, WEIGHT);
    expect(wide).toBeGreaterThan(narrow);
  });

  it("doesn't double-count neighbours that are already covered", () => {
    const covered = new Set(['n1', 'n2', 'n3']);
    const overlappingNeighbours = new Set(['n1', 'n2', 'n3', 'n4']);
    const sim = 0.7;
    // 4 neighbours but 3 already covered + the candidate itself
    // (not in `covered`) → delta should be 1 (self) + 1 (n4) = 2.
    const score = greedyCoverScore(
      'a',
      sim,
      covered,
      overlappingNeighbours,
      POOL,
      WEIGHT,
    );
    const expectedCoverage = WEIGHT * (2 / POOL);
    expect(score).toBeCloseTo(expectedCoverage + sim);
  });

  it('treats negative query similarity as zero (no penalty)', () => {
    // Cosine can in theory be negative; we don't want a strongly-
    // anti-correlated candidate to outrank a neutral one purely
    // because of its coverage payoff. Score floors the sim term.
    const covered = new Set<string>();
    const wide = new Set(['n1', 'n2', 'n3', 'n4', 'n5']);
    const negSim = greedyCoverScore('a', -0.8, covered, wide, POOL, WEIGHT);
    const expected = WEIGHT * (6 / POOL); // self + 5 neighbours
    expect(negSim).toBeCloseTo(expected);
  });

  it('coverage weight scales the trade-off — pure-similarity at weight 0', () => {
    const covered = new Set<string>();
    const wide = new Set(['n1', 'n2', 'n3', 'n4']);
    const lowSimWideCoverage = greedyCoverScore('a', 0.2, covered, wide, POOL, 0);
    const highSimNoCoverage = greedyCoverScore('b', 0.7, covered, new Set(), POOL, 0);
    expect(highSimNoCoverage).toBeGreaterThan(lowSimWideCoverage);
  });
});

describe('xRetrieveWorldFacts — substring-relevance helper', () => {
  // The Mongo+embed path is integration-only; the unit-testable
  // piece is the substring/threshold logic that lives inside the
  // function. We test it indirectly via a tiny re-implementation
  // matching the production filter — if the production code
  // diverges, this test should be updated in the same commit.
  function passesFilter(
    componentText: string,
    similarity: number,
    subject: string,
    minSimilarity: number,
  ): boolean {
    if (similarity < minSimilarity) return false;
    return componentText.toLowerCase().includes(subject.toLowerCase().trim());
  }

  it('keeps a fact whose text contains the subject AND meets similarity floor', () => {
    expect(passesFilter('The Drama is a 2017 A24 film', 0.8, 'The Drama', 0.5)).toBe(true);
  });

  it('rejects a high-similarity fact whose text does not contain the subject', () => {
    // Tangentially-related fact: high cosine because both are about
    // film, but it's NOT about "The Drama" specifically.
    expect(passesFilter('A24 is a film studio founded in 2012', 0.85, 'The Drama', 0.5)).toBe(false);
  });

  it('rejects a low-similarity fact even if the substring matches', () => {
    expect(passesFilter('The Drama Department staged a production', 0.4, 'The Drama', 0.5)).toBe(false);
  });

  it('subject match is case-insensitive', () => {
    expect(passesFilter('the drama released in cannes', 0.7, 'The Drama', 0.5)).toBe(true);
  });

  it('subject is trimmed before substring check', () => {
    expect(passesFilter('Anthropic released Claude 3.5', 0.7, '  Anthropic  ', 0.5)).toBe(true);
  });
});

describe('augmentSystemPromptWithUserFacts', () => {
  const BASE = 'You are Rose, the assistant. Write clearly.';

  it('returns the base prompt unchanged when no facts are provided', () => {
    expect(augmentSystemPromptWithUserFacts(BASE, [])).toBe(BASE);
  });

  it('appends a labeled, bulleted background block when facts are present', () => {
    const out = augmentSystemPromptWithUserFacts(BASE, [
      'I run 5K twice a week',
      'I prefer concise updates',
    ]);
    expect(out.startsWith(BASE)).toBe(true);
    expect(out).toContain('Background on the recipient');
    expect(out).toContain('  - I run 5K twice a week');
    expect(out).toContain('  - I prefer concise updates');
  });

  it("warns the model that facts are about the user, not subjects to summarise", () => {
    const out = augmentSystemPromptWithUserFacts(BASE, ['I am a chef']);
    // The exact warning wording matters — it's what stops the model
    // from writing "this week, I am a chef…" into a briefing body.
    expect(out).toMatch(/ABOUT THEM/);
    expect(out).toMatch(/not subjects to summarise/);
  });

  it('separates the base prompt from the addendum with a blank line', () => {
    const out = augmentSystemPromptWithUserFacts(BASE, ['fact one']);
    expect(out).toContain(`${BASE}\n\nBackground`);
  });
});
