import { describe, it, expect } from 'vitest';
import { isAutomatedSender, isSpecificTopic, cosine } from '../services/pageAssignment.js';

describe('isAutomatedSender', () => {
  it('matches common automated local-parts', () => {
    expect(isAutomatedSender('noreply@example.com')).toBe(true);
    expect(isAutomatedSender('no-reply@example.com')).toBe(true);
    expect(isAutomatedSender('notifications@github.com')).toBe(true);
    expect(isAutomatedSender('alerts@datadog.com')).toBe(true);
    expect(isAutomatedSender('builds@circleci.com')).toBe(true);
    expect(isAutomatedSender('digest@nytimes.com')).toBe(true);
    expect(isAutomatedSender('newsletter@stratechery.com')).toBe(true);
  });

  it('does not flag personal addresses', () => {
    expect(isAutomatedSender('alice@example.com')).toBe(false);
    expect(isAutomatedSender('bob.smith@acme.co')).toBe(false);
    expect(isAutomatedSender('jane_doe@uni.edu')).toBe(false);
  });

  it('handles missing input', () => {
    expect(isAutomatedSender(null)).toBe(false);
    expect(isAutomatedSender(undefined)).toBe(false);
    expect(isAutomatedSender('')).toBe(false);
  });
});

describe('isSpecificTopic — cross-sender topic match gate', () => {
  it('accepts multi-word phrases', () => {
    expect(isSpecificTopic('war in iran')).toBe(true);
    expect(isSpecificTopic('job listings')).toBe(true);
  });

  it('accepts hyphenated/underscored compounds', () => {
    expect(isSpecificTopic('iran-israel-conflict')).toBe(true);
    expect(isSpecificTopic('job_listings')).toBe(true);
  });

  it('accepts long single words', () => {
    expect(isSpecificTopic('inception')).toBe(true);
    expect(isSpecificTopic('artificial')).toBe(true);
  });

  it('rejects short single words (would over-merge)', () => {
    expect(isSpecificTopic('ai')).toBe(false);
    expect(isSpecificTopic('war')).toBe(false);
    expect(isSpecificTopic('tax')).toBe(false);
  });

  it('rejects empty / whitespace input', () => {
    expect(isSpecificTopic('')).toBe(false);
    expect(isSpecificTopic('   ')).toBe(false);
    expect(isSpecificTopic('xy')).toBe(false);
  });
});

describe('cosine', () => {
  it('computes textbook similarity between two vectors', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosine([1, 1], [1, 1])).toBeCloseTo(1, 6);
  });

  it('returns 0 for empty / mismatched-length vectors', () => {
    expect(cosine([], [])).toBe(0);
    expect(cosine([1, 2], [1])).toBe(0);
    expect(cosine([1, 2, 3], [1, 2])).toBe(0);
  });

  it('returns 0 when either vector is all zeros', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});
