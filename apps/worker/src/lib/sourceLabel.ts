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
 * Daydream subject-key normalisation. Plan 13 (D2) moved the body
 * to `@rose/db::daydreamSubjectKey`; re-exported here under the
 * legacy name so existing worker imports keep compiling. Prefer
 * `daydreamSubjectKey` for new code.
 */
export { daydreamSubjectKey as normaliseSubjectKey } from '@rose/db';
