import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Brain,
  Trash2,
  Archive,
  ArchiveRestore,
  CheckCircle2,
  Pencil,
  X,
  ExternalLink,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';

/**
 * "What Rose knows about you" — the user-visible surface of the
 * xMemory user-facts substrate. Lists atomic claims Rose has
 * extracted from your inbox + pages, grouped into themes the
 * background sweeper aggregates.
 *
 * Every component shows its source pages so you can verify where
 * Rose learned the claim. The action affordances are:
 *   • Mark wrong (status='rejected'): suppresses + prevents
 *     re-extraction of the same claim from any page.
 *   • Archive (status='archived'): hide but keep — useful for
 *     "this used to be true."
 *   • Edit: change the text Rose remembers.
 *   • Delete: hard remove (will be re-emitted if a future page
 *     re-extracts the same claim; use "Mark wrong" instead for
 *     permanence).
 */

type Component = {
  _id: string;
  subject: 'user' | 'world';
  type: 'fact' | 'preference' | 'constraint' | 'relation' | 'state-update';
  text: string;
  confidence: number;
  status: 'active' | 'archived' | 'rejected';
  groupId: string | null;
  sourcePageIds: string[];
  sources: { id: string; title: string; slug: string }[];
  firstSeenAt: string;
  lastSeenAt: string;
};

type Group = {
  _id: string;
  label: string;
  labelLockedByUser: boolean;
  componentCount: number;
};

type MemoryResponse = {
  components: Component[];
  groups: Group[];
  totals: {
    components: number;
    groups: number;
    byType: Record<string, number>;
  };
};

const TYPE_LABEL: Record<Component['type'], string> = {
  fact: 'Fact',
  preference: 'Preference',
  constraint: 'Constraint',
  relation: 'Relation',
  'state-update': 'Update',
};

const TYPE_TINT: Record<Component['type'], string> = {
  fact: 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200',
  preference: 'bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200',
  constraint: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  relation: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
  'state-update': 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
};

export default function MemorySettingsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'active' | 'archived' | 'rejected'>('active');
  const [subject, setSubject] = useState<'user' | 'world'>('user');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<{ id: string; label: string } | null>(
    null,
  );

  const { data, isLoading } = useQuery({
    queryKey: ['memory', status, subject],
    queryFn: () =>
      api.get<MemoryResponse>(`/api/memory?status=${status}&subject=${subject}`),
  });

  const update = useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: { text?: string; status?: 'active' | 'archived' | 'rejected' };
    }) => api.patch<{ ok: true }>(`/api/memory/components/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memory'] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      api.del<{ ok: true }>(`/api/memory/components/${id}`),
    onSuccess: () => {
      toast.success('Removed');
      qc.invalidateQueries({ queryKey: ['memory'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const renameGroup = useMutation({
    mutationFn: async ({ id, label }: { id: string; label: string }) =>
      api.patch<{ ok: true }>(`/api/memory/groups/${id}`, { label }),
    onSuccess: () => {
      toast.success('Renamed');
      setRenamingGroup(null);
      qc.invalidateQueries({ queryKey: ['memory'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Group components by groupId so the page renders themed
  // sections. Ungrouped components (just-extracted, before the
  // sweeper has had a chance to attach them) land in an
  // "Awaiting review" section at the bottom.
  const sectioned = useMemo(() => {
    const byGroup = new Map<string | null, Component[]>();
    for (const c of data?.components ?? []) {
      const k = c.groupId;
      const arr = byGroup.get(k) ?? [];
      arr.push(c);
      byGroup.set(k, arr);
    }
    const groups = data?.groups ?? [];
    const out: { group: Group | null; items: Component[] }[] = [];
    for (const g of groups) {
      const items = byGroup.get(g._id) ?? [];
      if (items.length > 0) out.push({ group: g, items });
    }
    const ungrouped = byGroup.get(null) ?? [];
    if (ungrouped.length > 0) out.push({ group: null, items: ungrouped });
    return out;
  }, [data]);

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="mb-2 flex items-center gap-2">
          <Brain className="h-5 w-5 text-rose-500" />
          <h2 className="font-semibold">
            {subject === 'user' ? 'What Rose knows about you' : 'Atomic facts in your archive'}
          </h2>
        </div>
        <p className="text-sm text-ink-500">
          {subject === 'user'
            ? "Atomic facts Rose has extracted from your inbox + pages, grouped into themes. Every entry shows the pages it was learned from. Mark anything wrong to suppress it permanently — Rose won't re-learn it from a later page."
            : 'Atomic, third-person claims Rose has extracted about the subjects of your pages (people, places, works, organizations). Used to ground retrieval-augmented prose in claims Rose has previously seen rather than re-reading every page body.'}
        </p>
        {data && (
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-500">
            <span>
              <strong className="text-ink-700 dark:text-ink-300">
                {data.totals.components}
              </strong>{' '}
              {status} component{data.totals.components === 1 ? '' : 's'}
            </span>
            {data.totals.groups > 0 && (
              <span>
                · <strong className="text-ink-700 dark:text-ink-300">
                  {data.totals.groups}
                </strong>{' '}
                theme{data.totals.groups === 1 ? '' : 's'}
              </span>
            )}
            {Object.entries(data.totals.byType)
              .filter(([, n]) => n > 0)
              .map(([t, n]) => (
                <span key={t}>
                  · {n} {t}
                </span>
              ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <div className="inline-flex rounded-md border border-ink-200 p-0.5 dark:border-ink-800">
          {(['user', 'world'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSubject(s)}
              className={
                'rounded px-3 py-1 ' +
                (subject === s
                  ? 'bg-rose-500 text-white'
                  : 'text-ink-600 dark:text-ink-300')
              }
              title={
                s === 'user'
                  ? 'Facts Rose has learned about you'
                  : 'Atomic claims about subjects in your pages'
              }
            >
              {s === 'user' ? 'About you' : 'About the world'}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {(['active', 'archived', 'rejected'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              className={
                'rounded-full border px-2.5 py-1 capitalize ' +
                (status === s
                  ? 'border-rose-300 bg-rose-100 text-rose-800 dark:border-rose-700 dark:bg-rose-950/40 dark:text-rose-200'
                  : 'border-ink-200 text-ink-600 hover:bg-ink-50 dark:border-ink-800 dark:text-ink-300 dark:hover:bg-ink-900')
              }
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <div className="card text-sm text-ink-500">Loading…</div>}

      {!isLoading && sectioned.length === 0 && (
        <div className="card flex flex-col items-center gap-3 py-12 text-center">
          <Brain className="h-10 w-10 text-rose-500" />
          <div>
            <h3 className="font-semibold">
              {status === 'active'
                ? 'Nothing learned yet'
                : status === 'archived'
                  ? 'Nothing archived'
                  : 'Nothing rejected'}
            </h3>
            <p className="mt-1 text-sm text-ink-500">
              {status === 'active'
                ? 'Rose extracts user-facts in the background as new pages are generated. Once a few pages about you have been processed, the themes will appear here.'
                : 'Switch back to "active" to see currently-known facts.'}
            </p>
          </div>
        </div>
      )}

      {sectioned.map(({ group, items }) => (
        <section key={group?._id ?? 'ungrouped'} className="card space-y-2">
          <header className="flex items-center justify-between gap-2">
            {group && renamingGroup?.id === group._id ? (
              <div className="flex flex-1 items-center gap-2">
                <input
                  className="input flex-1 text-sm"
                  value={renamingGroup.label}
                  onChange={(e) =>
                    setRenamingGroup({ id: group._id, label: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter')
                      renameGroup.mutate({
                        id: group._id,
                        label: renamingGroup.label,
                      });
                    if (e.key === 'Escape') setRenamingGroup(null);
                  }}
                  autoFocus
                />
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() => setRenamingGroup(null)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="btn-primary text-xs"
                  onClick={() =>
                    renameGroup.mutate({
                      id: group._id,
                      label: renamingGroup.label,
                    })
                  }
                  disabled={renameGroup.isPending}
                >
                  Save
                </button>
              </div>
            ) : (
              <>
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  {group?.label ?? 'Awaiting grouping'}
                  <span className="text-xs font-normal text-ink-500">
                    · {items.length}
                  </span>
                  {group?.labelLockedByUser && (
                    <span className="rounded bg-ink-100 px-1 text-[10px] font-medium text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                      renamed
                    </span>
                  )}
                </h3>
                {group && (
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() =>
                      setRenamingGroup({ id: group._id, label: group.label })
                    }
                    title="Rename theme"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
              </>
            )}
          </header>
          <ul className="space-y-2">
            {items.map((c) => (
              <li
                key={c._id}
                className={
                  'rounded-md border p-2 ' +
                  (c.status === 'active'
                    ? 'border-ink-200 dark:border-ink-800'
                    : 'border-ink-100 opacity-60 dark:border-ink-900')
                }
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={
                          'rounded px-1.5 py-0.5 text-[10px] font-medium ' +
                          TYPE_TINT[c.type]
                        }
                      >
                        {TYPE_LABEL[c.type]}
                      </span>
                      <span className="text-[10px] text-ink-400">
                        confidence {Math.round(c.confidence * 100)}%
                      </span>
                    </div>
                    {editing?.id === c._id ? (
                      <div className="mt-1 flex items-center gap-2">
                        <input
                          className="input flex-1 text-sm"
                          value={editing.text}
                          onChange={(e) =>
                            setEditing({ id: c._id, text: e.target.value })
                          }
                          autoFocus
                        />
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn-primary text-xs"
                          onClick={() => {
                            update.mutate({
                              id: c._id,
                              patch: { text: editing.text },
                            });
                            setEditing(null);
                          }}
                        >
                          Save
                        </button>
                      </div>
                    ) : (
                      <p className="mt-1 text-sm">{c.text}</p>
                    )}
                    {c.sources.length > 0 && (
                      <div className="mt-1 text-[11px] text-ink-500">
                        learned from:{' '}
                        {c.sources.map((s, i) => (
                          <span key={s.id}>
                            {i > 0 && ', '}
                            <Link
                              to={`/p/${s.slug}`}
                              className="hover:underline"
                            >
                              {s.title}
                            </Link>
                          </span>
                        ))}
                        {c.sourcePageIds.length > c.sources.length && (
                          <span className="text-ink-400">
                            {' '}
                            + {c.sourcePageIds.length - c.sources.length} more
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {c.sources[0] && (
                      <Link
                        to={`/p/${c.sources[0].slug}`}
                        className="btn-ghost text-xs"
                        title="Open most-recent source page"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Link>
                    )}
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={() => setEditing({ id: c._id, text: c.text })}
                      title="Edit text"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {c.status === 'active' ? (
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        onClick={() =>
                          update.mutate({
                            id: c._id,
                            patch: { status: 'archived' },
                          })
                        }
                        title="Archive — hide but keep the record"
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        onClick={() =>
                          update.mutate({
                            id: c._id,
                            patch: { status: 'active' },
                          })
                        }
                        title="Restore"
                      >
                        <ArchiveRestore className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {c.status !== 'rejected' && (
                      <button
                        type="button"
                        className="btn-ghost text-xs text-red-600"
                        onClick={() =>
                          update.mutate({
                            id: c._id,
                            patch: { status: 'rejected' },
                          })
                        }
                        title="Mark wrong — suppress + prevent re-learning"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-ghost text-xs text-red-600"
                      onClick={() => {
                        if (
                          confirm(
                            'Delete this fact? It may come back if a future page re-extracts it. Use "Mark wrong" for permanent suppression.',
                          )
                        ) {
                          remove.mutate(c._id);
                        }
                      }}
                      title="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
