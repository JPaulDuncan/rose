import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, Trash2, UserX, Tag as TagIcon } from 'lucide-react';
import toast from 'react-hot-toast';
import type { SpamPolicy } from '@rose/shared';
import { useApi } from '../../lib/api';

export default function SpamSettings() {
  const api = useApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['spam'],
    queryFn: () => api.get<SpamPolicy>('/api/spam'),
  });
  const [newSender, setNewSender] = useState('');
  const [newTag, setNewTag] = useState('');

  const addSender = useMutation({
    mutationFn: async (address: string) =>
      api.post<{ pagesAffected: number }>('/api/spam/sender', { address }),
    onSuccess: (r) => {
      toast.success(
        `Blocked — ${r.pagesAffected} page${r.pagesAffected === 1 ? '' : 's'} marked as spam.`,
      );
      qc.invalidateQueries({ queryKey: ['spam'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
      setNewSender('');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeSender = useMutation({
    mutationFn: async (address: string) =>
      api.del<{ ok: true }>(`/api/spam/sender/${encodeURIComponent(address)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spam'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
    },
  });
  const addTag = useMutation({
    mutationFn: async (tag: string) =>
      api.post<{ pagesAffected: number }>('/api/spam/tag', { tag }),
    onSuccess: (r) => {
      toast.success(
        `Blocked — ${r.pagesAffected} page${r.pagesAffected === 1 ? '' : 's'} marked as spam.`,
      );
      qc.invalidateQueries({ queryKey: ['spam'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
      setNewTag('');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeTag = useMutation({
    mutationFn: async (tag: string) =>
      api.del<{ ok: true }>(`/api/spam/tag/${encodeURIComponent(tag)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spam'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
    },
  });

  if (isLoading || !data) {
    return <div className="card text-sm text-ink-500">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="mb-2 flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-red-500" />
          <h2 className="font-semibold">Spam policy</h2>
        </div>
        <p className="text-sm text-ink-500">
          Pages whose sender or tags match a rule below are flagged as spam,
          hidden from the home digest, and excluded from search by default.
          You can also mark individual pages as spam from the page view's
          ⋯ menu.
        </p>
      </div>

      <div className="card">
        <div className="mb-3 flex items-center gap-2">
          <UserX className="h-4 w-4 text-rose-500" />
          <h3 className="font-semibold">Blocked senders</h3>
          <span className="ml-auto text-xs text-ink-500">{data.senders.length}</span>
        </div>
        <form
          className="mb-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = newSender.trim().toLowerCase();
            if (!v) return;
            if (data.senders.includes(v)) {
              toast.error('Already blocked');
              return;
            }
            addSender.mutate(v);
          }}
        >
          <input
            className="input"
            placeholder="address@example.com"
            value={newSender}
            onChange={(e) => setNewSender(e.target.value)}
            type="email"
          />
          <button className="btn-primary" disabled={addSender.isPending}>
            Block sender
          </button>
        </form>
        {data.senders.length === 0 ? (
          <div className="text-xs text-ink-500">No blocked senders yet.</div>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.senders.map((s) => (
              <li
                key={s}
                className="flex items-center justify-between rounded-lg border border-ink-200 px-3 py-1.5 dark:border-ink-800"
              >
                <code className="truncate text-xs">{s}</code>
                <button
                  className="btn-ghost text-red-600"
                  onClick={() => removeSender.mutate(s)}
                  aria-label={`Unblock ${s}`}
                  title="Unblock"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <div className="mb-3 flex items-center gap-2">
          <TagIcon className="h-4 w-4 text-rose-500" />
          <h3 className="font-semibold">Blocked tags</h3>
          <span className="ml-auto text-xs text-ink-500">{data.tags.length}</span>
        </div>
        <form
          className="mb-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = newTag.trim().toLowerCase();
            if (!v) return;
            if (data.tags.includes(v)) {
              toast.error('Already blocked');
              return;
            }
            addTag.mutate(v);
          }}
        >
          <input
            className="input"
            placeholder="tag-name"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
          />
          <button className="btn-primary" disabled={addTag.isPending}>
            Block tag
          </button>
        </form>
        {data.tags.length === 0 ? (
          <div className="text-xs text-ink-500">No blocked tags yet.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {data.tags.map((t) => (
              <button
                key={t}
                className="pill text-xs hover:bg-red-100 hover:text-red-800 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                onClick={() => removeTag.mutate(t)}
                title={`Unblock #${t}`}
              >
                #{t} <Trash2 className="ml-1 inline h-3 w-3" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
