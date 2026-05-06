import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  User as UserIcon,
  Film,
  Building2,
  Pencil,
  GitMerge,
  Trash2,
  Save,
  X as XIcon,
  Search as SearchIcon,
  Plus,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';

type EntityType = 'person' | 'work' | 'organization';

type EntityRow = {
  key: string;
  displayName: string;
  type: EntityType;
  aliases: string[];
  pageCount: number;
  lastSeenAt: string | null;
};

const TYPE_FILTERS: Array<{ value: '' | EntityType; label: string }> = [
  { value: '', label: 'All' },
  { value: 'person', label: 'People' },
  { value: 'work', label: 'Works' },
  { value: 'organization', label: 'Orgs' },
];

function typePill(type: EntityType): string {
  switch (type) {
    case 'person':
      return 'bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200';
    case 'work':
      return 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200';
    case 'organization':
      return 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200';
  }
}

function TypeIcon({ type, className }: { type: EntityType; className?: string }) {
  const cls = className ?? 'h-3 w-3';
  if (type === 'person') return <UserIcon className={cls} />;
  if (type === 'work') return <Film className={cls} />;
  return <Building2 className={cls} />;
}

/**
 * Settings → Entities. Mirror of Settings → Tags but operates on
 * the per-user Entity collection instead of TagCanonical. Per row
 * the user can edit displayName / aliases / type, merge into
 * another entity (rewrites Page.entities[] across the corpus),
 * rename the canonical key, or delete (with optional purge).
 */
export default function EntitiesSettings() {
  const api = useApi();
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<'' | EntityType>('');
  const [editing, setEditing] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<EntityType>('person');

  const create = useMutation({
    mutationFn: async () =>
      api.post<{ key: string }>('/api/entities', {
        displayName: newName.trim(),
        type: newType,
      }),
    onSuccess: () => {
      toast.success('Created');
      setShowCreate(false);
      setNewName('');
      qc.invalidateQueries({ queryKey: ['entities'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['entities', typeFilter],
    queryFn: () =>
      api.get<{ entities: EntityRow[] }>(
        typeFilter ? `/api/entities?type=${typeFilter}` : '/api/entities',
      ),
  });

  const filtered = useMemo(() => {
    const rows = data?.entities ?? [];
    const f = filter.trim().toLowerCase();
    if (!f) return rows;
    return rows.filter(
      (r) =>
        r.key.includes(f) ||
        r.displayName.toLowerCase().includes(f) ||
        r.aliases.some((a) => a.includes(f)),
    );
  }, [data, filter]);

  if (isError) {
    return (
      <div className="card text-sm">
        <div className="font-medium text-red-600">Couldn't load entities.</div>
        <div className="mt-1 text-xs text-ink-500">
          {(error as Error)?.message ?? 'Unknown error.'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="mb-2 flex items-center gap-2">
          <UserIcon className="h-5 w-5 text-rose-500" />
          <h2 className="font-semibold">Entities</h2>
        </div>
        <p className="text-sm text-ink-500">
          The named-entity registry Rose maintains so the prose
          auto-linker, the right-rail Mentions card, and the
          /n/&lt;key&gt; aggregation pages all share a fast lookup.
          Edit a row's display name or aliases, merge two entries
          that the extractor split, or rename the canonical
          URL slug — references update across the corpus.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-ink-700 dark:text-ink-200">
          {isLoading
            ? 'Loading…'
            : `${filtered.length} ${filtered.length === 1 ? 'entity' : 'entities'}`}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => setShowCreate((s) => !s)}
            title="Create a new entity (the extractor won't always find everything)"
          >
            <Plus className="h-3.5 w-3.5" /> New entity
          </button>
          <div className="flex gap-1 rounded-lg border border-ink-200 p-0.5 text-xs dark:border-ink-800">
            {TYPE_FILTERS.map((t) => (
              <button
                key={t.value || 'all'}
                onClick={() => setTypeFilter(t.value)}
                className={
                  typeFilter === t.value
                    ? 'rounded px-2 py-1 bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-200'
                    : 'rounded px-2 py-1 text-ink-500 hover:text-ink-900 dark:hover:text-ink-100'
                }
              >
                {t.label}
              </button>
            ))}
          </div>
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
      </div>

      {showCreate && (
        <div className="card flex flex-wrap items-end gap-2 bg-rose-50 dark:bg-rose-950/20">
          <label className="block text-xs">
            <span className="mb-1 block font-medium">Display name</span>
            <input
              autoFocus
              className="input text-sm"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Bill Walsh"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) create.mutate();
              }}
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium">Type</span>
            <select
              className="input text-sm"
              value={newType}
              onChange={(e) => setNewType(e.target.value as EntityType)}
            >
              <option value="person">Person</option>
              <option value="work">Work</option>
              <option value="organization">Organization</option>
            </select>
          </label>
          <button
            type="button"
            className="btn-primary text-sm"
            onClick={() => create.mutate()}
            disabled={create.isPending || !newName.trim()}
          >
            <Save className="h-3.5 w-3.5" /> Create
          </button>
          <button
            type="button"
            className="btn-ghost text-sm"
            onClick={() => {
              setShowCreate(false);
              setNewName('');
            }}
          >
            Cancel
          </button>
        </div>
      )}

      <ul className="divide-y divide-ink-200 rounded-lg border border-ink-200 dark:divide-ink-800 dark:border-ink-800">
        {filtered.length === 0 && !isLoading && (
          <li className="px-3 py-4 text-sm italic text-ink-500">
            {filter || typeFilter
              ? 'No entities match that filter.'
              : 'No entities yet. They appear here as Rose extracts named entities from generated pages.'}
          </li>
        )}
        {filtered.map((row) => (
          <EntityRowEditor
            key={row.key}
            row={row}
            isEditing={editing === row.key}
            onEdit={() => setEditing(row.key)}
            onCancelEdit={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              qc.invalidateQueries({ queryKey: ['entities'] });
            }}
          />
        ))}
      </ul>
    </div>
  );
}

function EntityRowEditor({
  row,
  isEditing,
  onEdit,
  onCancelEdit,
  onSaved,
}: {
  row: EntityRow;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const [displayName, setDisplayName] = useState(row.displayName);
  const [type, setType] = useState<EntityType>(row.type);
  const [aliasesText, setAliasesText] = useState(row.aliases.join(', '));

  const save = useMutation({
    mutationFn: async () =>
      api.patch<{ key: string }>(`/api/entities/${encodeURIComponent(row.key)}`, {
        displayName: displayName.trim(),
        type,
        aliases: aliasesText
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      toast.success('Saved');
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const merge = useMutation({
    mutationFn: async (into: string) =>
      api.post<{ ok: true; affectedPages: number }>(
        `/api/entities/${encodeURIComponent(row.key)}/merge`,
        { into },
      ),
    onSuccess: (resp) => {
      toast.success(
        `Merged — ${resp.affectedPages} page${resp.affectedPages === 1 ? '' : 's'} updated`,
      );
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rename = useMutation({
    mutationFn: async (next: string) =>
      api.post<{ ok: true; affectedPages: number; key: string }>(
        `/api/entities/${encodeURIComponent(row.key)}/rename`,
        { key: next },
      ),
    onSuccess: (resp) => {
      toast.success(
        `Renamed to "${resp.key}" — ${resp.affectedPages} page${resp.affectedPages === 1 ? '' : 's'} updated`,
      );
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (purge: boolean) =>
      api.del<{ ok: true; affectedPages: number }>(
        `/api/entities/${encodeURIComponent(row.key)}?purgeFromPages=${purge}`,
      ),
    onSuccess: (resp) => {
      toast.success(
        resp.affectedPages > 0
          ? `Deleted — purged from ${resp.affectedPages} page${resp.affectedPages === 1 ? '' : 's'}`
          : 'Deleted',
      );
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
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
              placeholder="Wait Wait... Don't Tell Me!"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium">Type</span>
            <select
              className="input text-sm"
              value={type}
              onChange={(e) => setType(e.target.value as EntityType)}
            >
              <option value="person">Person</option>
              <option value="work">Work (movie / show / book / song / article)</option>
              <option value="organization">Organization</option>
            </select>
          </label>
          <label className="col-span-full block text-xs">
            <span className="mb-1 block font-medium">
              Aliases (comma-separated, kebab-case)
            </span>
            <input
              className="input text-sm"
              value={aliasesText}
              onChange={(e) => setAliasesText(e.target.value)}
              placeholder="wait-wait, ww-dtm"
            />
            <span className="mt-1 block text-[11px] text-ink-500">
              Future page extractions whose entity normalises to any
              alias here will fold into <code>{row.key}</code>.
            </span>
          </label>
          <div className="col-span-full text-[11px] text-ink-500">
            Canonical key{' '}
            <code className="rounded bg-ink-100 px-1 dark:bg-ink-800">{row.key}</code>{' '}
            — used as the URL slug (<code>/n/{row.key}</code>). Use Rename to change it.
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary text-sm"
            onClick={() => save.mutate()}
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
                  `Rename "${row.key}" to a new canonical key (kebab-case):`,
                  row.key,
                );
                if (!next || next === row.key) return;
                rename.mutate(next);
              }}
              disabled={rename.isPending}
            >
              <Pencil className="h-3.5 w-3.5" /> Rename…
            </button>
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => {
                const target = window.prompt(
                  `Merge "${row.key}" into which entity? (kebab key)`,
                  '',
                );
                if (!target) return;
                if (
                  !confirm(
                    `Merge "${row.key}" into "${target}"?\n\nEvery page mentioning "${row.key}" will be re-pointed at "${target}". This row is deleted; "${target}" absorbs it as an alias.`,
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
                  `Delete the "${row.key}" entity row?\n\nClick OK to ALSO strip "${row.key}" from every page that mentions it (${row.pageCount} page${row.pageCount === 1 ? '' : 's'}).\nClick Cancel to delete just the row and leave page mentions alone.`,
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
      <span
        className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${typePill(row.type)}`}
        title={row.type}
      >
        <TypeIcon type={row.type} />
        {row.type === 'person' ? 'Person' : row.type === 'work' ? 'Work' : 'Org'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Link
            to={`/n/${encodeURIComponent(row.key)}`}
            className="truncate font-medium hover:text-rose-700 dark:hover:text-rose-300"
            title={`Open ${row.displayName}`}
          >
            {row.displayName}
          </Link>
          <code className="rounded bg-ink-100 px-1 text-[10px] text-ink-500 dark:bg-ink-800">
            {row.key}
          </code>
        </div>
        {row.aliases.length > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-ink-500">
            <span>aliases:</span>
            {row.aliases.slice(0, 6).map((a) => (
              <code key={a} className="rounded bg-ink-100 px-1 dark:bg-ink-800">
                {a}
              </code>
            ))}
            {row.aliases.length > 6 && <span>+{row.aliases.length - 6} more</span>}
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
        title="Edit display name, aliases, type, merge, rename, delete"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
