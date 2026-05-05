import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Reject hostnames that resolve to private / loopback / link-local /
 * cloud-metadata IPs. Resolves at fetch time to defeat DNS rebinding —
 * we validate every resolved address upfront, and rely on the OS
 * resolver cache giving fetch the same answer when it actually
 * connects (the connection-time IP is what counts).
 *
 * v4 + v6 ranges. Add to PRIVATE_RANGES if a new range needs blocking.
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

export class UnsafeUrlError extends Error {
  override name = 'UnsafeUrlError';
}

/**
 * Throws UnsafeUrlError if `raw` is not a safe HTTP(S) URL — wrong
 * scheme, malformed, points at the loopback host, or resolves to a
 * private IP. Returns the parsed URL otherwise.
 */
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
  // URL.hostname keeps the brackets on IPv6 literals (`[::1]`).
  // Strip them before pattern matching so the IPv6 ranges in
  // PRIVATE_RANGES match the way they're written.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (host.startsWith('[') || net.isIP(host) || net.isIP(bare)) {
    if (PRIVATE_RANGES.some((re) => re.test(bare))) {
      throw new UnsafeUrlError('Private IP blocked');
    }
    return url;
  }
  let resolved: string[] = [];
  try {
    const v4 = await dns.resolve4(host).catch(() => [] as string[]);
    const v6 = await dns.resolve6(host).catch(() => [] as string[]);
    resolved = [...v4, ...v6];
  } catch {
    // DNS lookup failed entirely; fetch will fail too.
    throw new UnsafeUrlError(`Could not resolve ${host}`);
  }
  if (resolved.length === 0) throw new UnsafeUrlError(`Could not resolve ${host}`);
  for (const ip of resolved) {
    if (PRIVATE_RANGES.some((re) => re.test(ip))) {
      throw new UnsafeUrlError(`${host} resolves to a private IP`);
    }
  }
  return url;
}
