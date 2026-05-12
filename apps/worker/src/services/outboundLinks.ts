/**
 * Outbound link extraction. Walks a page's contentMd and harvests
 * the slugs it references via `/p/<slug>` URLs. The result is
 * persisted on Page.outboundLinks at write time so the lineage
 * "cited-by" query can use an indexed $in lookup instead of
 * regex-scanning every other page's body.
 *
 * The slug regex matches the same shape the lineage endpoint used
 * to look for: a `/p/` prefix followed by kebab-cased slug
 * characters (`a-z`, `0-9`, `-`), terminating at any non-slug
 * character. The own-slug is filtered out so a page doesn't show
 * up as citing itself.
 */

const SLUG_RE = /\/p\/([a-z0-9][a-z0-9-]*)/g;
/** Cap so an extraordinarily link-heavy page (a daily digest with
 *  hundreds of links) doesn't blow up the array. The lineage
 *  endpoint already caps its inbound list at 40; storing more here
 *  wouldn't be visible downstream. */
const MAX_OUTBOUND = 200;

export function extractOutboundLinks(
  contentMd: string | null | undefined,
  ownSlug: string | null | undefined,
): string[] {
  if (!contentMd) return [];
  const seen = new Set<string>();
  for (const m of contentMd.matchAll(SLUG_RE)) {
    const slug = m[1];
    if (!slug) continue;
    if (ownSlug && slug === ownSlug) continue;
    seen.add(slug);
    if (seen.size >= MAX_OUTBOUND) break;
  }
  return [...seen];
}
