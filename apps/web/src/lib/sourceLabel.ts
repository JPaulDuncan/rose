/**
 * Render a friendly label for a daydream source's adapter chip
 * ("via wikipedia", "via openalex", etc).
 *
 * Worker-side notes written before the adapter-id fix landed have
 * `adapter: 'unknown'` for everything except wikipedia. When that
 * happens — or when the adapter string is empty — we fall back to a
 * trimmed hostname so the chip never reads "unknown source" or
 * "via " (empty).
 *
 * Future regenerations of those notes will write the real adapter
 * id and bypass this fallback.
 */
export function adapterLabel(adapter: string | null | undefined, url: string): string {
  const a = (adapter ?? '').trim().toLowerCase();
  if (a && a !== 'unknown') return a;
  return hostnameLabel(url);
}

function hostnameLabel(url: string): string {
  try {
    let host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    // Drop language subdomain on wiki* sites so "en.wikipedia.org"
    // surfaces as "wikipedia".
    host = host.replace(/^(?:en|es|fr|de|ja|zh)\./, '');
    const parts = host.split('.');
    if (parts.length >= 2) return parts[parts.length - 2]!;
    return host || 'source';
  } catch {
    return 'source';
  }
}
