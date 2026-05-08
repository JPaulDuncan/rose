import { describe, it, expect } from 'vitest';
import { cosine, dot, magnitude, toUnitFloat32, meanVec } from '../lib/vec.js';

/**
 * Vector primitives feeding the taxonomy snap + page assignment +
 * topic research scoring. Drift here silently corrupts every
 * "is this email about X" decision the worker makes — these tests
 * are cheap insurance.
 */

describe('cosine', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosine([1, 2], [-1, -2])).toBeCloseTo(-1, 6);
  });

  it('returns 0 on empty / mismatched / all-zero inputs', () => {
    expect(cosine([], [])).toBe(0);
    expect(cosine([1], [1, 2])).toBe(0);
    expect(cosine([0, 0, 0], [0, 0, 0])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it('accepts Float32Array inputs', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    expect(cosine(a, b)).toBeCloseTo(1, 6);
  });

  it('accepts a mix of number[] and Float32Array', () => {
    expect(cosine([1, 0, 0], new Float32Array([1, 0, 0]))).toBeCloseTo(1, 6);
  });
});

describe('dot', () => {
  it('returns the standard inner product', () => {
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  it('returns 0 on empty / mismatched-length inputs', () => {
    expect(dot([], [])).toBe(0);
    expect(dot([1, 2], [1])).toBe(0);
  });

  it('on unit vectors equals cosine similarity', () => {
    // Two non-trivial unit vectors — dot product should equal
    // cosine to floating-point precision.
    const a = toUnitFloat32([3, 4]);
    const b = toUnitFloat32([5, 12]);
    const d = dot(a, b);
    const c = cosine(a, b);
    expect(d).toBeCloseTo(c, 6);
  });
});

describe('magnitude', () => {
  it('returns the L2 norm', () => {
    expect(magnitude([3, 4])).toBe(5);
    expect(magnitude([0, 0])).toBe(0);
  });

  it('handles Float32Array', () => {
    expect(magnitude(new Float32Array([3, 4]))).toBeCloseTo(5, 6);
  });
});

describe('toUnitFloat32', () => {
  it('returns a unit-length Float32Array', () => {
    const v = toUnitFloat32([3, 4]);
    expect(v).toBeInstanceOf(Float32Array);
    expect(magnitude(v)).toBeCloseTo(1, 5);
  });

  it('returns empty Float32Array for empty input', () => {
    const v = toUnitFloat32([]);
    expect(v.length).toBe(0);
  });

  it('returns a zero Float32Array for all-zero input (avoids NaN)', () => {
    const v = toUnitFloat32([0, 0, 0]);
    expect(v.length).toBe(3);
    expect(v[0]).toBe(0);
    expect(v[1]).toBe(0);
    expect(v[2]).toBe(0);
  });

  it('does NOT mutate the input', () => {
    const input = [3, 4];
    toUnitFloat32(input);
    expect(input).toEqual([3, 4]);
  });
});

describe('meanVec', () => {
  it('averages component-wise', () => {
    expect(meanVec([[1, 2], [3, 4], [5, 6]])).toEqual([3, 4]);
  });

  it('returns null on empty input', () => {
    expect(meanVec([])).toBeNull();
  });

  it('skips mismatched-length entries silently', () => {
    // Real-world: a stale embedding from a different model dimension.
    // The sweep should drop it rather than corrupt the centroid.
    const r = meanVec([[1, 2, 3], [4, 5, 6], [7, 8]]);
    expect(r).toEqual([2.5, 3.5, 4.5]);
  });

  it('first entry sets the canonical dim; later mismatches drop', () => {
    // [1,2,3] sets dim=3; [4,5] is mismatched and dropped; result
    // is the average of just [1,2,3] (i.e. itself).
    const r = meanVec([[1, 2, 3], [4, 5]]);
    expect(r).toEqual([1, 2, 3]);
  });
});
