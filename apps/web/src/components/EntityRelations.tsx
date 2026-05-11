import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Network, ArrowRight, ArrowLeft } from 'lucide-react';
import { useApi } from '../lib/api';

type Relation = {
  _id: string;
  predicate: string;
  predicateLabel: string;
  direction: 'incoming' | 'outgoing';
  otherKey: string;
  otherDisplayName: string;
  otherType: string | null;
  confidence: number;
  evidenceCount: number;
  evidence: {
    pageId: string;
    pageSlug: string | null;
    snippet: string;
    extractedAt: string | null;
  }[];
};

/**
 * EntityRelations — typed-relationship panel for /n/<key>. Pulls
 * relations the user's archive has evidenced, groups by predicate
 * label (so outgoing "Employer" and incoming "Employs" render
 * under one header from each side's perspective), and links each
 * counter-party to its own entity page.
 *
 * Evidence is hidden by default — click a row to expand its
 * snippets so the user can audit why Rose thinks the relation
 * holds. Snippets ≤ 240 chars each.
 */
export function EntityRelations({ entityKey }: { entityKey: string }) {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['entity-relations', entityKey],
    queryFn: () =>
      api.get<{ relations: Relation[] }>(
        `/api/ontology/relations?entity=${encodeURIComponent(entityKey)}`,
      ),
    enabled: !!entityKey,
  });

  if (isLoading) return null;
  const relations = data?.relations ?? [];
  if (relations.length === 0) return null;

  // Group by predicateLabel so "Employer" and "Employs" each become
  // their own section header. Stable order: outgoing predicates
  // first (more useful to the reader), then incoming.
  const groups = new Map<string, Relation[]>();
  for (const r of relations) {
    const key = `${r.direction === 'outgoing' ? '0' : '1'}__${r.predicateLabel}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const entries = [...groups.entries()].sort(
    (a, b) => a[0].localeCompare(b[0]),
  );

  return (
    <section className="card mt-6">
      <header className="mb-3 flex items-center gap-2">
        <Network className="h-4 w-4 text-rose-500" />
        <h2 className="font-semibold">Relationships</h2>
        <span className="ml-auto text-xs text-ink-500">
          {relations.length} typed link{relations.length === 1 ? '' : 's'}
        </span>
      </header>
      <div className="space-y-4">
        {entries.map(([key, items]) => (
          <div key={key}>
            <h3 className="mb-1 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-ink-500">
              {items[0]!.direction === 'outgoing' ? (
                <ArrowRight className="h-3 w-3" />
              ) : (
                <ArrowLeft className="h-3 w-3" />
              )}
              {items[0]!.predicateLabel}
            </h3>
            <ul className="space-y-1 text-sm">
              {items.map((r) => (
                <RelationRow key={r._id} relation={r} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function RelationRow({ relation }: { relation: Relation }) {
  return (
    <li>
      <details className="group">
        <summary className="flex cursor-pointer items-baseline gap-2 rounded px-2 py-1 hover:bg-rose-50 dark:hover:bg-rose-950/20">
          <Link
            to={`/n/${encodeURIComponent(relation.otherKey)}`}
            className="font-medium text-ink-900 hover:underline dark:text-ink-100"
            onClick={(e) => e.stopPropagation()}
          >
            {relation.otherDisplayName}
          </Link>
          {relation.otherType && (
            <span className="rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-ink-600 dark:bg-ink-800 dark:text-ink-300">
              {relation.otherType}
            </span>
          )}
          <span className="ml-auto text-[11px] italic text-ink-500">
            {Math.round(relation.confidence * 100)}% · {relation.evidenceCount}{' '}
            mention{relation.evidenceCount === 1 ? '' : 's'}
          </span>
        </summary>
        {relation.evidence.length > 0 && (
          <ul className="mt-1 space-y-1 pl-3 text-[11px]">
            {relation.evidence.map((e, i) => (
              <li
                key={i}
                className="border-l-2 border-ink-200 pl-2 italic text-ink-500 dark:border-ink-800"
              >
                {e.snippet || '(no snippet)'}{' '}
                {e.pageSlug && (
                  <Link
                    to={`/p/${e.pageSlug}`}
                    className="text-rose-600 hover:underline dark:text-rose-300"
                    title="Source page"
                  >
                    [source]
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </details>
    </li>
  );
}
