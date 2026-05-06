import { describe, it, expect } from 'vitest';
import { hashContent } from '../services/extractPlaces.js';

describe('hashContent', () => {
  it('is deterministic for the same input', () => {
    expect(hashContent('hello world')).toBe(hashContent('hello world'));
  });

  it('changes with content', () => {
    expect(hashContent('hello')).not.toBe(hashContent('world'));
  });

  it('returns a 32-char hex slice', () => {
    const h = hashContent('the quick brown fox');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  it('treats empty / nullish input as the empty string', () => {
    expect(hashContent('')).toBe(hashContent(undefined as unknown as string));
  });
});
