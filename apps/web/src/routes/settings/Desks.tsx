import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Newspaper,
  Pencil,
  Archive,
  Plus,
  Check,
  X,
  Sparkles,
  Lock,
  Star,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';

/**
 * Settings → Desks. Curated newspaper-section vocabulary the page
 * generator picks from. Two sections:
 *
 *   - Active desks: rename, edit description, archive (except
 *     seeded defaults — those can only be renamed). New desks the
 *     user adds manually land here.
 *   - Pending suggestions: proposals from the clustering pass
 *     ("Suggest new desks"). Each shows sample page titles so the
 *     user can verify the theme before accepting.
 */

type Category = {
  _id: string;
  name: string;
  description?: string;
  kind: 'desk' | 'ad-hoc';
  status: 'active' | 'proposed' | 'archived';
  seedDefault?: boolean;
  icon?: string | null;
  proposalSamplePages?: { pageId: string; title: string }[];
};

export default function DesksSettingsPage() {
  const api = useApi();
  const qc = useQueryClient();

  const active = useQuery({
    queryKey: ['categories', 'desk', 'active'],
    queryFn: () =>
      api.get<{ categories: Category[] }>(
        '/api/categories?kind=desk&status=active',
      ),
  });
  const proposed = useQuery({
    queryKey: ['categories', 'desk', 'proposed'],
    queryFn: () =>
      api.get<{ categories: Category[] }>(
        '/api/categories?kind=desk&status=proposed',
      ),
    // Poll faster after the user triggers a suggest pass — the
    // worker writes proposals as it processes clusters, so they
    // appear in batches over 5–30s. After 60s of no churn the
    // polling falls back to the default refetchOnMount only.
    refetchInterval: ({ state }) => {
      const lastUpdate = state.dataUpdatedAt;
      const ms = Date.now() - lastUpdate;
      return ms < 90_000 ? 4_000 : false;
    },
  });

  // Featured-categories state — drives the star toggle per desk.
  // Lives on User, mirrors the existing featured-tags pattern.
  const featured = useQuery({
    queryKey: ['featured-categories'],
    queryFn: () => api.get<{ categoryIds: string[] }>('/api/featured-categories'),
  });
  const featuredSet = new Set(featured.data?.categoryIds ?? []);
  const togglePin = useMutation({
    mutationFn: async ({ id, pin }: { id: string; pin: boolean }) =>
      pin
        ? api.post<{ categoryIds: string[] }>('/api/featured-categories', {
            categoryId: id,
          })
        : api.del<{ categoryIds: string[] }>(`/api/featured-categories/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['featured-categories'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: { name?: string; description?: string; status?: string };
    }) => api.patch<{ ok: true }>(`/api/categories/${id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const accept = useMutation({
    mutationFn: async (id: string) =>
      api.post<{ ok: true }>(`/api/categories/${id}/accept`, {}),
    onSuccess: () => {
      toast.success('Desk accepted');
      qc.invalidateQueries({ queryKey: ['categories'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reject = useMutation({
    mutationFn: async (id: string) =>
      api.post<{ ok: true }>(`/api/categories/${id}/reject`, {}),
    onSuccess: () => {
      toast.success('Suggestion rejected');
      qc.invalidateQueries({ queryKey: ['categories'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const suggest = useMutation({
    mutationFn: async () =>
      api.post<{ ok: true }>('/api/categories/suggest-desks', {}),
    onSuccess: () => {
      toast.success(
        'Looking for new desks — proposals will appear below as the worker finishes.',
      );
      qc.invalidateQueries({ queryKey: ['categories', 'desk', 'proposed'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [editing, setEditing] = useState<{
    id: string;
    name: string;
    description: string;
  } | null>(null);

  const activeDesks = active.data?.categories ?? [];
  const proposedDesks = proposed.data?.categories ?? [];

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="mb-2 flex items-center gap-2">
          <Newspaper className="h-5 w-5 text-rose-500" />
          <h2 className="font-semibold">Desks</h2>
        </div>
        <p className="text-sm text-ink-500">
          Newspaper-style sections that organize your archive. The
          page generator picks exactly one desk per page from this
          list. Use <strong>Suggest new desks</strong> to have Rose
          cluster your existing pages and propose themes worth
          adding.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => suggest.mutate()}
            disabled={suggest.isPending}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {suggest.isPending ? 'Queued…' : 'Suggest new desks'}
          </button>
        </div>
      </div>

      {proposedDesks.length > 0 && (
        <div className="card space-y-2">
          <header className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-500" />
            <h3 className="text-sm font-semibold">
              Pending suggestions ({proposedDesks.length})
            </h3>
          </header>
          <ul className="space-y-2">
            {proposedDesks.map((p) => (
              <li
                key={p._id}
                className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-950/20"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{p.name}</div>
                    {p.description && (
                      <p className="mt-1 text-xs text-ink-600 dark:text-ink-400">
                        {p.description}
                      </p>
                    )}
                    {p.proposalSamplePages && p.proposalSamplePages.length > 0 && (
                      <div className="mt-2 text-[11px] text-ink-500">
                        sample pages:{' '}
                        {p.proposalSamplePages
                          .map((s) => s.title)
                          .filter(Boolean)
                          .slice(0, 4)
                          .join(' · ')}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={() => accept.mutate(p._id)}
                      title="Accept this desk — pages will start being assigned to it"
                    >
                      <Check className="h-3.5 w-3.5" /> Accept
                    </button>
                    <button
                      type="button"
                      className="btn-ghost text-xs text-red-600"
                      onClick={() => reject.mutate(p._id)}
                      title="Reject — Rose won't propose this theme again"
                    >
                      <X className="h-3.5 w-3.5" /> Reject
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card space-y-2">
        <header className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            Active desks ({activeDesks.length})
          </h3>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => setEditing({ id: 'new', name: '', description: '' })}
          >
            <Plus className="h-3.5 w-3.5" /> Add desk
          </button>
        </header>
        {active.isLoading && (
          <div className="text-sm text-ink-500">Loading…</div>
        )}
        {editing?.id === 'new' && (
          <NewDeskRow
            initial={editing}
            onCancel={() => setEditing(null)}
            onSave={async (values) => {
              try {
                await api.post('/api/categories', values);
                toast.success('Desk created');
                setEditing(null);
                qc.invalidateQueries({ queryKey: ['categories'] });
              } catch (e) {
                toast.error((e as Error).message);
              }
            }}
          />
        )}
        <ul className="space-y-2">
          {activeDesks.map((d) => (
            <li
              key={d._id}
              className="rounded-md border border-ink-200 p-3 dark:border-ink-800"
            >
              {editing?.id === d._id ? (
                <EditDeskRow
                  initial={editing}
                  onCancel={() => setEditing(null)}
                  onSave={(values) => {
                    update.mutate({ id: d._id, patch: values });
                    setEditing(null);
                  }}
                />
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 font-semibold">
                      {d.name}
                      {d.seedDefault && (
                        <span
                          className="inline-flex items-center gap-1 rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-600 dark:bg-ink-800 dark:text-ink-300"
                          title="Seeded default — can be renamed but not archived"
                        >
                          <Lock className="h-2.5 w-2.5" /> default
                        </span>
                      )}
                    </div>
                    {d.description && (
                      <p className="mt-1 text-xs text-ink-600 dark:text-ink-400">
                        {d.description}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      className={
                        'btn-ghost text-xs ' +
                        (featuredSet.has(d._id) ? 'text-amber-500' : '')
                      }
                      onClick={() =>
                        togglePin.mutate({
                          id: d._id,
                          pin: !featuredSet.has(d._id),
                        })
                      }
                      disabled={togglePin.isPending}
                      title={
                        featuredSet.has(d._id)
                          ? 'Unpin from Home + Newsletter'
                          : 'Pin to Home + Newsletter as a featured section'
                      }
                    >
                      <Star
                        className={
                          'h-3.5 w-3.5 ' +
                          (featuredSet.has(d._id) ? 'fill-amber-400' : '')
                        }
                      />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={() =>
                        setEditing({
                          id: d._id,
                          name: d.name,
                          description: d.description ?? '',
                        })
                      }
                      title="Rename / edit description"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {!d.seedDefault && (
                      <button
                        type="button"
                        className="btn-ghost text-xs text-red-600"
                        onClick={() =>
                          update.mutate({
                            id: d._id,
                            patch: { status: 'archived' },
                          })
                        }
                        title="Archive — hide from the generator vocabulary"
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function EditDeskRow({
  initial,
  onCancel,
  onSave,
}: {
  initial: { name: string; description: string };
  onCancel: () => void;
  onSave: (values: { name: string; description: string }) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  return (
    <div className="space-y-2">
      <input
        className="input w-full text-sm"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Desk name"
        autoFocus
      />
      <textarea
        className="input w-full text-xs"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="One-line description (used by the generator to decide what fits here)"
        rows={2}
      />
      <div className="flex justify-end gap-2 text-xs">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => onSave({ name, description })}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function NewDeskRow({
  initial,
  onCancel,
  onSave,
}: {
  initial: { name: string; description: string };
  onCancel: () => void;
  onSave: (values: { name: string; description: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-md border border-ink-300 bg-ink-50 p-3 dark:border-ink-700 dark:bg-ink-900/30">
      <div className="space-y-2">
        <input
          className="input w-full text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Desk name (Title Case)"
          autoFocus
        />
        <textarea
          className="input w-full text-xs"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What kinds of pages belong here?"
          rows={2}
        />
        <div className="flex justify-end gap-2 text-xs">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave({ name: name.trim(), description: description.trim() });
              } finally {
                setBusy(false);
              }
            }}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
