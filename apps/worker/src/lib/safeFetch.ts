// Re-export the canonical SSRF guard from @rose/llm so cross-package
// `instanceof UnsafeUrlError` works (one shared class). The redirect-
// following safeFetch below stays here because URL ingestion needs
// the by-hand redirect loop with per-hop revalidation, which is more
// than the simpler webFetch tool exposes.
export { assertSafeHttpUrl, UnsafeUrlError } from '@rose/llm';
import { assertSafeHttpUrl, UnsafeUrlError } from '@rose/llm';

export type SafeFetchResult = {
  buffer: Buffer;
  contentType: string;
  finalUrl: string;
};

/**
 * Fetch a URL with SSRF guards, hard size cap, and hard timeout.
 * Follows redirects but re-validates each new hostname.
 */
export async function safeFetch(
  raw: string,
  opts: { maxBytes?: number; timeoutMs?: number; userAgent?: string } = {},
): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const ua = opts.userAgent ?? 'Rose/1.0 (+https://rose.local)';

  // The Node fetch implementation does the redirect handling, but we
  // need to validate each redirect target. We follow up to 5 hops by
  // hand: fetch with `redirect: 'manual'`, validate, repeat.
  let current = raw;
  for (let hop = 0; hop < 6; hop += 1) {
    await assertSafeHttpUrl(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, {
        headers: { 'User-Agent': ua, Accept: '*/*' },
        redirect: 'manual',
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new UnsafeUrlError('Redirect without Location header');
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) {
      throw new UnsafeUrlError(`Upstream responded ${res.status} ${res.statusText}`);
    }
    const ct = res.headers.get('content-type') ?? 'application/octet-stream';
    // Size cap: stream and bail if we go over.
    const reader = res.body?.getReader();
    if (!reader) throw new UnsafeUrlError('Empty response body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          ctrl.abort();
          throw new UnsafeUrlError(`Body exceeded ${maxBytes} byte cap`);
        }
        chunks.push(value);
      }
    }
    return { buffer: Buffer.concat(chunks), contentType: ct, finalUrl: current };
  }
  throw new UnsafeUrlError('Too many redirects');
}
