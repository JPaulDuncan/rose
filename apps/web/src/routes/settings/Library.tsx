import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  Plus,
  Trash2,
  Pause,
  Play,
  RotateCw,
  Upload,
  Download,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';

type LibrarySettings = {
  enabled: boolean;
  dailyCrawlCap: number;
  useInDaydream: boolean;
};

type Source = {
  _id: string;
  kind: 'rss' | 'sitemap' | 'url' | 'urlList';
  name: string;
  url: string | null;
  urlsCount: number;
  tags: string[];
  pollIntervalMinutes: number;
  lastSyncAt: string | null;
  lastError: string | null;
  status: 'active' | 'paused' | 'error' | 'proposed' | 'rejected';
  proposalReason?: string | null;
  proposalEvidence?: string[];
  docCount: number;
};

export default function LibrarySettings() {
  const api = useApi();
  const qc = useQueryClient();
  const { token } = useAuth();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['library-settings'],
    queryFn: () => api.get<LibrarySettings>('/api/library/settings'),
  });
  const { data: sources } = useQuery({
    queryKey: ['library-sources'],
    queryFn: () => api.get<{ sources: Source[] }>('/api/library/sources'),
    refetchInterval: 15_000,
  });
  // Proposed sources from the xMemory-driven library proposer.
  // Polls fast for ~2min after the user kicks the proposer so
  // suggestions appear as the worker writes them.
  const proposed = useQuery({
    queryKey: ['library-sources', 'proposed'],
    queryFn: () =>
      api.get<{ sources: Source[] }>('/api/library/sources?status=proposed'),
    refetchInterval: ({ state }) => {
      const ms = Date.now() - state.dataUpdatedAt;
      return ms < 120_000 ? 5_000 : false;
    },
  });
  const acceptProposed = useMutation({
    mutationFn: async (id: string) =>
      api.post<{ ok: true }>(`/api/library/sources/${id}/accept`, {}),
    onSuccess: () => {
      toast.success('Source added to your library');
      qc.invalidateQueries({ queryKey: ['library-sources'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const rejectProposed = useMutation({
    mutationFn: async (id: string) =>
      api.post<{ ok: true }>(`/api/library/sources/${id}/reject`, {}),
    onSuccess: () => {
      toast.success('Suggestion dismissed');
      qc.invalidateQueries({ queryKey: ['library-sources'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const suggest = useMutation({
    mutationFn: async () =>
      api.post<{ ok: true }>('/api/library/sources/suggest', {}),
    onSuccess: () => {
      toast.success(
        'Looking for sources matching your interests — suggestions will appear as the worker finishes.',
      );
      qc.invalidateQueries({ queryKey: ['library-sources', 'proposed'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [form, setForm] = useState<LibrarySettings | null>(null);
  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const saveSettings = useMutation({
    mutationFn: (patch: Partial<LibrarySettings>) =>
      api.patch<{ ok: true }>('/api/library/settings', patch),
    onSuccess: () => {
      toast.success('Library settings saved');
      qc.invalidateQueries({ queryKey: ['library-settings'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !form) {
    return <div className="card text-sm text-ink-500">Loading…</div>;
  }
  const dirty = JSON.stringify(form) !== JSON.stringify(settings);

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="mb-2 flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-rose-500" />
          <h2 className="font-semibold">Library</h2>
        </div>
        <p className="text-sm text-ink-500">
          A user-curated source corpus the worker crawls, indexes, and
          exposes both as a standalone search surface (
          <code>/library</code>) and as a Daydream adapter so article
          Background notes can pull from sources you trust. Off by
          default; once enabled, runs on the worker's schedule.
        </p>

        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          <span>Enabled</span>
        </label>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-xs">
            <span className="mb-1 block font-medium">Daily crawl cap</span>
            <input
              className="input"
              type="number"
              min={10}
              max={10000}
              value={form.dailyCrawlCap}
              onChange={(e) =>
                setForm({ ...form, dailyCrawlCap: Number(e.target.value) })
              }
            />
            <span className="mt-1 block text-[11px] text-ink-500">
              Hard ceiling on documents fetched per UTC day across all
              sources.
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.useInDaydream}
              onChange={(e) =>
                setForm({ ...form, useInDaydream: e.target.checked })
              }
            />
            <span>
              Use Library in Daydream
              <span className="block text-[11px] text-ink-500">
                Lets daydream pull library documents into article
                Background notes.
              </span>
            </span>
          </label>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="btn-primary"
            onClick={() => saveSettings.mutate(form)}
            disabled={saveSettings.isPending || !dirty}
          >
            Save
          </button>
        </div>
      </div>

      <SuggestedSourcesCard
        proposed={proposed.data?.sources ?? []}
        onSuggest={() => suggest.mutate()}
        onAccept={(id) => acceptProposed.mutate(id)}
        onReject={(id) => rejectProposed.mutate(id)}
        suggestBusy={suggest.isPending}
      />
      <SourcesCard
        sources={(sources?.sources ?? []).filter((s) => s.status !== 'proposed')}
        qc={qc}
      />
      <OpmlCard qc={qc} token={token} />
    </div>
  );
}

/**
 * xMemory-driven library suggestions. Pulls from
 * /api/library/sources?status=proposed and renders each as an
 * Accept / Reject card with the reason + sample user-facts the
 * proposer used. Always rendered (even when empty) so the
 * "Suggest sources" button is discoverable; the empty state
 * explains what the button does.
 */
function SuggestedSourcesCard({
  proposed,
  onSuggest,
  onAccept,
  onReject,
  suggestBusy,
}: {
  proposed: Source[];
  onSuggest: () => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  suggestBusy: boolean;
}) {
  return (
    <div className="card space-y-3">
      <header className="flex items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Suggested sources</h2>
          <p className="text-xs text-ink-500">
            Rose proposes RSS feeds and pages based on the user-facts
            it has extracted from your archive. Accepted suggestions
            start syncing immediately; rejected ones won't be
            re-suggested.
          </p>
        </div>
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={onSuggest}
          disabled={suggestBusy}
        >
          {suggestBusy ? 'Queued…' : 'Suggest sources'}
        </button>
      </header>
      {proposed.length === 0 ? (
        <div className="text-xs text-ink-500">
          No suggestions right now. Click <strong>Suggest sources</strong>{' '}
          to have Rose look for feeds matching your interests.
        </div>
      ) : (
        <ul className="space-y-2">
          {proposed.map((s) => (
            <li
              key={s._id}
              className="rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-950/20"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-mono uppercase text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                      {s.kind}
                    </span>
                    <span className="font-semibold">{s.name}</span>
                  </div>
                  {s.url && (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-0.5 block truncate text-[11px] text-ink-500 hover:underline"
                    >
                      {s.url}
                    </a>
                  )}
                  {s.proposalReason && (
                    <p className="mt-2 text-xs text-ink-600 dark:text-ink-300">
                      {s.proposalReason}
                    </p>
                  )}
                  {s.proposalEvidence && s.proposalEvidence.length > 0 && (
                    <div className="mt-1 text-[11px] text-ink-500">
                      Because you've said: {s.proposalEvidence.slice(0, 3).map((e) => `"${e}"`).join(' · ')}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() => onAccept(s._id)}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="btn-ghost text-xs text-red-600"
                    onClick={() => onReject(s._id)}
                  >
                    Reject
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SourcesCard({
  sources,
  qc,
}: {
  sources: Source[];
  qc: ReturnType<typeof useQueryClient>;
}) {
  const api = useApi();
  const [adding, setAdding] = useState(false);

  const remove = useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/api/library/sources/${id}`),
    onSuccess: () => {
      toast.success('Source removed');
      qc.invalidateQueries({ queryKey: ['library-sources'] });
    },
  });
  const togglePause = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'paused' }) =>
      api.patch<{ ok: true }>(`/api/library/sources/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['library-sources'] }),
  });
  const syncNow = useMutation({
    mutationFn: (id: string) =>
      api.post<{ jobId: string }>(`/api/library/sources/${id}/sync-now`),
    onSuccess: () => {
      toast.success('Sync queued');
      qc.invalidateQueries({ queryKey: ['library-sources'] });
    },
  });

  return (
    <div className="card">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Sources ({sources.length})</h2>
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={() => setAdding((v) => !v)}
        >
          <Plus className="h-3 w-3" />
          Add source
        </button>
      </div>
      {adding && <AddSourceForm onClose={() => setAdding(false)} qc={qc} />}
      {sources.length === 0 ? (
        <p className="text-sm italic text-ink-500">
          No sources yet — add an RSS feed or URL above.
        </p>
      ) : (
        <ul className="divide-y divide-ink-200 dark:divide-ink-800">
          {sources.map((s) => (
            <li key={s._id} className="flex items-start gap-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{s.name}</span>
                  <span className="text-[10px] uppercase tracking-widest text-ink-500">
                    {s.kind}
                  </span>
                  {s.status === 'paused' && (
                    <span className="rounded bg-ink-200 px-1.5 py-0.5 text-[10px] text-ink-700 dark:bg-ink-800 dark:text-ink-300">
                      paused
                    </span>
                  )}
                  {s.status === 'error' && (
                    <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700 dark:bg-red-950/40 dark:text-red-300">
                      <AlertTriangle className="h-2.5 w-2.5" /> error
                    </span>
                  )}
                </div>
                {s.url && (
                  <div className="mt-0.5 truncate text-xs text-ink-500">
                    {s.url}
                  </div>
                )}
                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-ink-500">
                  <span>{s.docCount} docs</span>
                  <span>· every {s.pollIntervalMinutes}m</span>
                  {s.lastSyncAt && (
                    <span>
                      · last sync {new Date(s.lastSyncAt).toLocaleString()}
                    </span>
                  )}
                  {s.lastError && (
                    <span className="text-red-500" title={s.lastError}>
                      · error: {s.lastError.slice(0, 80)}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => syncNow.mutate(s._id)}
                  disabled={syncNow.isPending}
                  title="Sync now"
                >
                  <RotateCw
                    className={`h-3.5 w-3.5 ${syncNow.isPending ? 'animate-spin' : ''}`}
                  />
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() =>
                    togglePause.mutate({
                      id: s._id,
                      status: s.status === 'paused' ? 'active' : 'paused',
                    })
                  }
                  title={s.status === 'paused' ? 'Resume' : 'Pause'}
                >
                  {s.status === 'paused' ? (
                    <Play className="h-3.5 w-3.5" />
                  ) : (
                    <Pause className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  className="btn-ghost text-red-600"
                  onClick={() => {
                    if (
                      confirm(
                        `Remove "${s.name}"? Its ${s.docCount} indexed documents will also be deleted.`,
                      )
                    )
                      remove.mutate(s._id);
                  }}
                  title="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddSourceForm({
  onClose,
  qc,
}: {
  onClose: () => void;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const api = useApi();
  const [kind, setKind] = useState<'rss' | 'url'>('rss');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [tags, setTags] = useState('');

  const create = useMutation({
    mutationFn: (body: {
      kind: 'rss' | 'url';
      name: string;
      url: string;
      tags: string[];
    }) =>
      api.post<{ source: { _id: string } }>('/api/library/sources', body),
    onSuccess: () => {
      toast.success('Source added — first sync queued');
      qc.invalidateQueries({ queryKey: ['library-sources'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <form
      className="mb-4 rounded border border-ink-200 bg-ink-50 p-3 dark:border-ink-800 dark:bg-ink-900"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !url.trim()) return;
        create.mutate({
          kind,
          name: name.trim(),
          url: url.trim(),
          tags: tags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        });
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[100px_1fr_1fr_auto]">
        <select
          className="input"
          value={kind}
          onChange={(e) => setKind(e.target.value as 'rss' | 'url')}
        >
          <option value="rss">RSS</option>
          <option value="url">URL</option>
        </select>
        <input
          className="input"
          placeholder="Display name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          className="input"
          placeholder={
            kind === 'rss'
              ? 'https://example.com/feed.xml'
              : 'https://example.com/article'
          }
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
        <button type="submit" className="btn-primary" disabled={create.isPending}>
          Add
        </button>
      </div>
      <input
        className="input mt-2 text-xs"
        placeholder="tags (comma-separated, optional)"
        value={tags}
        onChange={(e) => setTags(e.target.value)}
      />
      <div className="mt-2 flex justify-end">
        <button type="button" className="btn-ghost text-xs" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function OpmlCard({
  qc,
  token,
}: {
  qc: ReturnType<typeof useQueryClient>;
  token: string | null;
}) {
  const api = useApi();
  const fileRef = useRef<HTMLInputElement>(null);

  const importOpml = useMutation({
    mutationFn: async (text: string) =>
      api.post<{ parsed: number; created: number; duplicate: number }>(
        '/api/library/sources/import-opml',
        { opml: text, defaultTags: [] },
      ),
    onSuccess: (r) => {
      toast.success(
        `Imported ${r.created} feed${r.created === 1 ? '' : 's'} (${r.duplicate} duplicate${r.duplicate === 1 ? '' : 's'})`,
      );
      qc.invalidateQueries({ queryKey: ['library-sources'] });
      if (fileRef.current) fileRef.current.value = '';
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="card">
      <div className="mb-3 flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-rose-500" />
        <h2 className="font-semibold">OPML import / export</h2>
      </div>
      <p className="text-xs text-ink-500">
        OPML is the standard XML format for RSS feed lists — export from
        any reader (NetNewsWire, Feedly, Inoreader, …) and drop the
        file here.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <label className="btn-secondary cursor-pointer text-xs">
          <Upload className="h-3 w-3" />
          Import OPML
          <input
            ref={fileRef}
            type="file"
            accept=".opml,.xml,application/xml,text/xml"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const text = await f.text();
              importOpml.mutate(text);
            }}
          />
        </label>
        <a
          className="btn-ghost text-xs"
          // The export endpoint is GET — open in a new tab so the
          // browser handles the download via the content-disposition
          // header. The auth helper sticks the token on the URL.
          href={`/api/library/sources/export-opml${token ? `?access_token=${encodeURIComponent(token)}` : ''}`}
          target="_blank"
          rel="noreferrer"
        >
          <Download className="h-3 w-3" />
          Export OPML
        </a>
      </div>
    </div>
  );
}
