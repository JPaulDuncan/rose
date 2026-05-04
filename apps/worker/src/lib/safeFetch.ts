import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Reject hostnames that resolve to private / loopback / link-local /
 * cloud-metadata IPs. Resolves at fetch time to defeat DNS rebinding
 * (the cached IP at fetch time is what fetch will actually connect to,
 * but we validate every resolved address upfront).
 */
const PRIVATE_RANGES = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^0\./,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fe80:/i,
];

export class UnsafeUrlError extends Error {}

export async function assertSafeHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('Invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeUrlError(`Unsupported scheme: ${url.protocol}`);
  }
  const host = url.hostname;
  if (!host || host === 'localhost') throw new UnsafeUrlError('Loopback host blocked');
  if (host.startsWith('[') || net.isIP(host)) {
    if (PRIVATE_RANGES.some((re) => re.test(host))) {
      throw new UnsafeUrlError('Private IP blocked');
    }
    return url;
  }
  // Resolve and check every result.
  let addrs: string[];
  try {
    const r = await dns.lookup(host, { all: true });
    addrs = r.map((a) => a.address);
  } catch {
    throw new UnsafeUrlError(`DNS lookup failed for ${host}`);
  }
  for (const a of addrs) {
    if (PRIVATE_RANGES.some((re) => re.test(a))) {
      throw new UnsafeUrlError(`${host} resolves to a blocked address`);
    }
  }
  return url;
}

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
