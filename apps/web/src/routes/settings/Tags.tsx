import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Tag as TagIcon,
  Pencil,
  GitMerge,
  Trash2,
  Save,
  X as XIcon,
  Search as SearchIcon,
  AlertTriangle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';
import { useCanonicalMutations } from '../../lib/useCanonicalMutations';

type CanonicalRow = {
  canonical: string;
  displayName: string;
  aliases: string[];
  pageCount: number;
  /**
   * False for "emergent" tags — kebab keys that exist on Page.tags
   * but have no canonical row (legacy / canonicalisation fell back
   * to passthrough). Editing or merging an emergent tag upserts its
   * row implicitly.
   */
  isCanonicalRow: boolean;
  updatedAt: string | null;
};

type CanonicalsResponse = { canonicals: CanonicalRow[] };

/**
 * Settings → Tags. Surfaces every canonical the user has plus any
 * emergent tags (on pages but with no canonical row yet). Per row
 * the user can:
 *   • Edit displayName / aliases inline.
 *   • Merge into another canonical (rewrites Page.tags across the
 *     corpus, deletes the source row).
 *   • Rename to a new canonical key (also rewrites Page.tags;
 *     stashes the old key as an alias).
 *   • Delete (drops the canonical row; optional purge from pages).
 */
export default function TagsSettings() {
  const api = useApi();
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['tag-canonicals'],
    queryFn: () => api.get<CanonicalsResponse>('/api/tags/canonicals'),
  });

  const filtered = useMemo(() => {
    const rows = data?.canonicals ?? [];
    const f = filter.trim().toLowerCase();
    if (!f) return rows;
    return rows.filter(
      (r) =>
        r.canonical.includes(f) ||
        r.displayName.toLowerCase().includes(f) ||
        r.aliases.some((a) => a.includes(f)),
    );
  }, [data, filter]);

  if (isError) {
    return (
      <div className="card text-sm">
        <div className="font-medium text-red-600">Couldn't load tags.</div>
        <div className="mt-1 text-xs text-ink-500">
          {(error as Error)?.message ?? 'Unknown error.'}
        </div>
      </div>
    );
  }

  const totalCanonicals = (data?.canonicals ?? []).filter((r) => r.isCanonicalRow).length;
  const totalEmergent = (data?.canonicals ?? []).filter((r) => !r.isCanonicalRow).length;

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="mb-2 flex items-center gap-2">
          <TagIcon className="h-5 w-5 text-rose-500" />
          <h2 className="font-semibold">Tags</h2>
        </div>
        <p className="text-sm text-ink-500">
          The canonical-tag taxonomy Rose maintains so synonyms
          ("job-postings", "remote-work", "fully-remote") collapse
          onto one tag with a single human-readable display name.
          Edit a row's display name or aliases, or merge two
          canonicals into one — page references update across the
          corpus.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-700 dark:text-ink-200">
          {isLoading
            ? 'Loading…'
            : `${totalCanonicals} canonical${totalCanonicals === 1 ? '' : 's'}` +
              (totalEmergent > 0
                ? ` · ${totalEmergent} uncanonicalised`
                : '')}
        </h3>
        <div className="flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-2 py-1 text-xs dark:border-ink-800 dark:bg-ink-950">
          <SearchIcon className="h-3.5 w-3.5 text-ink-400" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="w-44 bg-transparent outline-none"
          />
          {filter && (
            <button
              onClick={() => setFilter('')}
              className="text-ink-400 hover:text-rose-600"
              aria-label="Clear filter"
            >
              <XIcon className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <ul className="divide-y divide-ink-200 rounded-lg border border-ink-200 dark:divide-ink-800 dark:border-ink-800">
        {filtered.length === 0 && !isLoading && (
          <li className="px-3 py-4 text-sm italic text-ink-500">
            {filter
              ? 'No tags match that filter.'
              : 'No tags yet. They appear here as Rose generates pages.'}
          </li>
        )}
        {filtered.map((row) => (
          <TagRow
            key={row.canonical}
            row={row}
            isEditing={editing === row.canonical}
            onEdit={() => setEditing(row.canonical)}
            onCancelEdit={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              qc.invalidateQueries({ queryKey: ['tag-canonicals'] });
            }}
            allCanonicals={data?.canonicals ?? []}
          />
        ))}
      </ul>
    </div>
  );
}

function TagRow({
  row,
  isEditing,
  onEdit,
  onCancelEdit,
  onSaved,
  allCanonicals,
}: {
  row: CanonicalRow;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
  allCanonicals: CanonicalRow[];
}) {
  const [displayName, setDisplayName] = useState(row.displayName);
  const [aliasesText, setAliasesText] = useState(row.aliases.join(', '));
  // Plan 13 (D4) — shared mutations live in useCanonicalMutations.
  const { save, merge, rename, remove } = useCanonicalMutations({
    apiBase: '/api/tags/canonicals',
    rowKey: row.canonical,
    keyField: 'canonical',
    queryKey: ['tag-canonicals'],
    onSaved,
  });

  if (isEditing) {
    return (
      <li className="bg-rose-50 px-3 py-3 dark:bg-rose-950/20">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-xs">
            <span className="mb-1 block font-medium">Display name</span>
            <input
              className="input text-sm"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Job Listings"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium">
              Canonical key{' '}
              <code className="rounded bg-ink-100 px-1 text-[10px] dark:bg-ink-800">
                {row.canonical}
              </code>
            </span>
            <span className="text-[11px] text-ink-500">
              The kebab key Rose stores on pages and exposes as a URL
              (<code>/t/{row.canonical}</code>). Use Rename to change it.
            </span>
          </label>
          <label className="col-span-full block text-xs">
            <span className="mb-1 block font-medium">
              Aliases (comma-separated, lowercase)
            </span>
            <input
              className="input text-sm"
              value={aliasesText}
              onChange={(e) => setAliasesText(e.target.value)}
              placeholder="job-postings, remote-work, fully-remote"
            />
            <span className="mt-1 block text-[11px] text-ink-500">
              Future emails / pages whose tags resolve to any alias here
              will be canonicalised to <code>{row.canonical}</code>.
            </span>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary text-sm"
            onClick={() =>
              save.mutate({
                displayName,
                aliases: aliasesText.split(',').map((a) => a.trim()).filter(Boolean),
              })
            }
            disabled={save.isPending}
          >
            <Save className="h-3.5 w-3.5" /> Save
          </button>
          <button
            type="button"
            className="btn-ghost text-sm"
            onClick={onCancelEdit}
            disabled={save.isPending}
          >
            Cancel
          </button>
          <span className="ml-auto flex items-center gap-2 text-xs">
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => {
                const next = window.prompt(
                  `Rename "${row.canonical}" to a new canonical key (kebab-case):`,
                  row.canonical,
                );
                if (!next || next === row.canonical) return;
                rename.mutate(next);
              }}
              disabled={rename.isPending}
            >
              <Pencil className="h-3.5 w-3.5" /> Rename canonical…
            </button>
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => {
                const candidates = allCanonicals.filter(
                  (c) => c.canonical !== row.canonical,
                );
                if (candidates.length === 0) {
                  toast.error('No other tags to merge into.');
                  return;
                }
                const target = window.prompt(
                  `Merge "${row.canonical}" into which canonical key? (e.g. ${candidates[0]?.canonical})`,
                  '',
                );
                if (!target) return;
                if (
                  !confirm(
                    `Merge "${row.canonical}" into "${target}"?\n\nEvery page tagged "${row.canonical}" will be re-tagged. The "${row.canonical}" canonical row is deleted; "${target}" absorbs it as an alias.`,
                  )
                )
                  return;
                merge.mutate(target);
              }}
              disabled={merge.isPending}
            >
              <GitMerge className="h-3.5 w-3.5" /> Merge into…
            </button>
            <button
              type="button"
              className="btn-ghost text-xs text-red-600"
              onClick={() => {
                const purge = confirm(
                  `Delete the "${row.canonical}" canonical row?\n\nClick OK to ALSO strip "${row.canonical}" from every page that has it (${row.pageCount} page${row.pageCount === 1 ? '' : 's'}).\nClick Cancel to delete just the canonical row and leave page tags alone.`,
                );
                remove.mutate(purge);
              }}
              disabled={remove.isPending}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete…
            </button>
          </span>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-3 px-3 py-2 hover:bg-ink-50 dark:hover:bg-ink-900">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Link
            to={`/t/${encodeURIComponent(row.canonical)}`}
            className="truncate font-medium hover:text-rose-700 dark:hover:text-rose-300"
            title={`Open #${row.canonical}`}
          >
            {row.displayName || row.canonical}
          </Link>
          <code className="rounded bg-ink-100 px-1 text-[10px] text-ink-500 dark:bg-ink-800">
            {row.canonical}
          </code>
          {!row.isCanonicalRow && (
            <span
              className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
              title="This tag exists on pages but has no canonical row yet. Edit it to create one."
            >
              <AlertTriangle className="h-2.5 w-2.5" /> uncanonicalised
            </span>
          )}
        </div>
        {row.aliases.length > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-ink-500">
            <span>aliases:</span>
            {row.aliases.slice(0, 8).map((a) => (
              <code key={a} className="rounded bg-ink-100 px-1 dark:bg-ink-800">
                {a}
              </code>
            ))}
            {row.aliases.length > 8 && <span>+{row.aliases.length - 8} more</span>}
          </div>
        )}
      </div>
      <div className="shrink-0 text-right text-xs text-ink-500">
        <div>
          {row.pageCount} page{row.pageCount === 1 ? '' : 's'}
        </div>
      </div>
      <button
        type="button"
        className="btn-ghost text-xs"
        onClick={onEdit}
        title="Edit display name, aliases, merge, rename, delete"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
