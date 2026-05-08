/**
 * Vector helpers shared across worker services that compare
 * embedding vectors. Kept tiny on purpose — pulling in a math
 * library is overkill for the two-or-three operations we need
 * (cosine similarity, occasionally magnitude). Plan 13 (D1) folded
 * three independent copies in `pageAssignment`, `mergeDetect`, and
 * `briefing` into this single export.
 */

export type VecLike = readonly number[] | Float32Array;

/**
 * Cosine similarity between two same-length numeric vectors.
 * Returns 0 for empty / mismatched-length / all-zero inputs so
 * callers can treat "no signal" and "low signal" the same way
 * without an extra null check.
 *
 * Accepts both `number[]` (Mongoose's default storage shape for
 * arrays of doubles) and `Float32Array` (the in-process unit-vector
 * form used by the taxonomy snap + page-assignment hot loops).
 */
export function cosine(a: VecLike, b: VecLike): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Dot product of two same-length vectors. When both inputs are
 * unit-normalised vectors (see `toUnitFloat32`), the dot product
 * equals cosine similarity — but without the per-call magnitude
 * computation and `Math.sqrt`. The tight inner loops (taxonomy
 * snap, page assignment) pre-normalise their corpus once and then
 * use this for the per-candidate scoring.
 *
 * Returns 0 for empty / mismatched-length inputs.
 */
export function dot(a: VecLike, b: VecLike): number {
  if (!a.length || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i]! * b[i]!;
  }
  return s;
}

/**
 * Magnitude (L2 norm) of a vector. Returns 0 for empty input.
 */
export function magnitude(v: VecLike): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    s += x * x;
  }
  return Math.sqrt(s);
}

/**
 * Convert a `number[]` (or another Float32Array) into a unit-length
 * `Float32Array`. Halves memory footprint vs the boxed double form
 * (3KB vs 6KB for a 768-dim vector) and lets the inner loop use
 * the cheaper `dot()` instead of `cosine()`.
 *
 * Returns an empty Float32Array for empty / all-zero input so
 * callers can treat the result as a vec without a null check.
 */
export function toUnitFloat32(v: VecLike): Float32Array {
  if (!v.length) return new Float32Array(0);
  const out = new Float32Array(v.length);
  let mag = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    out[i] = x;
    mag += x * x;
  }
  if (mag === 0) return out;
  const inv = 1 / Math.sqrt(mag);
  for (let i = 0; i < out.length; i++) {
    out[i]! *= inv;
  }
  return out;
}

/**
 * Element-wise mean of a non-empty list of vectors, returned as a
 * plain `number[]`. Caller decides whether to unit-normalise (for
 * the taxonomy snap centroids we do, since the inner loop is dot-
 * product-only).
 */
export function meanVec(vecs: VecLike[]): number[] | null {
  if (vecs.length === 0) return null;
  const len = vecs[0]!.length;
  const out: number[] = new Array(len).fill(0);
  let n = 0;
  for (const v of vecs) {
    if (v.length !== len) continue;
    for (let i = 0; i < len; i++) out[i]! += v[i]!;
    n += 1;
  }
  if (n === 0) return null;
  for (let i = 0; i < len; i++) out[i]! /= n;
  return out;
}
