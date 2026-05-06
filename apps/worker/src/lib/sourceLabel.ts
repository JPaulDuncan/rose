/**
 * Worker-side mirror of `apps/web/src/lib/sourceLabel.ts`. Used by
 * the daydream upserter to label sources whose snippets arrived
 * without an `adapterId` tag (legacy callers, or future adapters
 * that bypass the standard collect path). Lives in its own file so
 * unit tests can import it without pulling in BullMQ / mongoose.
 */
export function hostnameAdapterLabel(url: string): string {
  try {
    let host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    // Drop language subdomain on wikipedia / wikidata / wiktionary.
    host = host.replace(/^(?:en|es|fr|de|ja|zh)\./, '');
    const parts = host.split('.');
    if (parts.length >= 2) return parts[parts.length - 2]!;
    return host || 'source';
  } catch {
    return 'source';
  }
}

/**
 * Daydream subject-key normalisation. Whitespace-collapsed lowercase
 * displayName form (NOT kebab) — the daydream system uses this so
 * notes are reusable across surfaces (page, /n/<key> entity page,
 * Settings → Daydream recent activity).
 */
export function normaliseSubjectKey(s: string): string {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}
