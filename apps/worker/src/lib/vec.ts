/**
 * Vector helpers shared across worker services that compare
 * embedding vectors. Kept tiny on purpose — pulling in a math
 * library is overkill for the two-or-three operations we need
 * (cosine similarity, occasionally magnitude). Plan 13 (D1) folded
 * three independent copies in `pageAssignment`, `mergeDetect`, and
 * `briefing` into this single export.
 */

/**
 * Cosine similarity between two same-length numeric vectors.
 * Returns 0 for empty / mismatched-length / all-zero inputs so
 * callers can treat "no signal" and "low signal" the same way
 * without an extra null check.
 */
export function cosine(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
