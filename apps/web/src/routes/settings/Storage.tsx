import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, RefreshCw, AlertTriangle, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';

type Retention = {
  emails?: number;
  pageRevisions?: number;
  daydream?: number;
  recipeAudit?: number;
  conversations?: number;
  tagDigests?: number;
  weatherSnapshots?: number;
  emailEmbeddings?: number;
  pages?: number;
  stripOldEmailBodiesDays?: number;
  lastCleanupAt?: string | null;
  lastCleanupSummary?: Record<string, number> | null;
};

type Counts = {
  emails: number;
  emailsWithEmbedding: number;
  emailsWithBody: number;
  pages: number;
  pageRevisions: number;
  daydream: number;
  recipeAudit: number;
  conversations: number;
  messages: number;
  tagDigests: number;
  weatherSnapshots: number;
  shipments: number;
  promoCodes: number;
  libraryDocs: number;
};

const FIELDS: {
  key: keyof Retention;
  label: string;
  description: string;
  countKey?: keyof Counts;
  /** A number-input-friendly preset list (days). 0 = keep forever. */
  presets: number[];
}[] = [
  {
    key: 'emails',
    label: 'Emails',
    description:
      'Hard-delete email rows older than this. Source emails are how article body, sender attribution, and citation links resolve, so set this generously unless you have a specific reason.',
    countKey: 'emails',
    presets: [0, 365, 730, 1825],
  },
  {
    key: 'stripOldEmailBodiesDays',
    label: 'Strip old email bodies',
    description:
      'Older than this AND already part of a generated article: null out email body + HTML to reclaim space. The article keeps the gist; backlinks still resolve. 0 = keep all bodies.',
    countKey: 'emailsWithBody',
    presets: [0, 90, 180, 365],
  },
  {
    key: 'emailEmbeddings',
    label: 'Email embeddings',
    description:
      'Drop the vector from older emails. Text-index search keeps working; only semantic search loses these. Cheap to recompute later if needed.',
    countKey: 'emailsWithEmbedding',
    presets: [0, 90, 180, 365],
  },
  {
    key: 'pages',
    label: 'Articles',
    description:
      'Hard-delete article pages older than this. Most users want articles forever — leave at 0 unless you have a very large archive.',
    countKey: 'pages',
    presets: [0, 365, 1825],
  },
  {
    key: 'pageRevisions',
    label: 'Article revision history',
    description:
      'Prune old revisions. The current version is always preserved.',
    countKey: 'pageRevisions',
    presets: [0, 90, 180, 365],
  },
  {
    key: 'daydream',
    label: 'Daydream notes',
    description:
      'Encyclopedia-style background notes. They regenerate on demand if Daydream is enabled.',
    countKey: 'daydream',
    presets: [0, 30, 90, 180],
  },
  {
    key: 'recipeAudit',
    label: 'Recipe audit log',
    description: 'Per-firing log of every recipe trigger evaluation.',
    countKey: 'recipeAudit',
    presets: [0, 14, 30, 90],
  },
  {
    key: 'conversations',
    label: 'Chat conversations',
    description: 'Older "Ask the archive" threads and their messages.',
    countKey: 'conversations',
    presets: [0, 90, 180, 365],
  },
  {
    key: 'tagDigests',
    label: 'Tag digests',
    description: 'Day-bounded section-editor briefs for each tag.',
    countKey: 'tagDigests',
    presets: [0, 30, 60, 90],
  },
  {
    key: 'weatherSnapshots',
    label: 'Weather snapshots',
    description: 'Cached forecasts. Cheap to refetch from NOAA.',
    countKey: 'weatherSnapshots',
    presets: [0, 14, 30, 60],
  },
];

/**
 * Storage / cleanup settings. Surfaces row counts per collection so
 * the user can see what's eating space, exposes the per-collection
 * retention windows the nightly cleanup worker reads, and offers a
 * "Run now" button that fires the same logic on demand.
 */
export default function StorageSettings() {
  const api = useApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['retention'],
    queryFn: () =>
      api.get<{ retention: Retention; counts: Counts }>('/api/retention'),
  });

  const [draft, setDraft] = useState<Retention>({});
  useEffect(() => {
    if (data?.retention) setDraft(data.retention);
  }, [data?.retention]);

  const save = useMutation({
    mutationFn: async (patch: Retention) =>
      api.patch<{ ok: true; retention: Retention }>('/api/retention', patch),
    onSuccess: () => {
      toast.success('Retention saved');
      void qc.invalidateQueries({ queryKey: ['retention'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const run = useMutation({
    mutationFn: async () =>
      api.post<{ ok: true; summary: Record<string, number> }>(
        '/api/retention/run',
        {},
      ),
    onSuccess: (r) => {
      const total = Object.values(r.summary).reduce((a, b) => a + (b ?? 0), 0);
      toast.success(`Cleanup done — ${total} rows pruned`);
      void qc.invalidateQueries({ queryKey: ['retention'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function setField(key: keyof Retention, value: number) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  const dirty =
    !!data &&
    FIELDS.some((f) => (draft[f.key] ?? 0) !== ((data.retention[f.key] as number) ?? 0));

  if (isLoading || !data) {
    return <div className="card text-sm text-ink-500">Loading…</div>;
  }

  const last = data.retention.lastCleanupAt
    ? new Date(data.retention.lastCleanupAt)
    : null;
  const summary = data.retention.lastCleanupSummary ?? null;

  return (
    <div className="space-y-6">
      <div className="card space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5 text-rose-500" />
            <h2 className="font-semibold">Storage &amp; cleanup</h2>
          </div>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => run.mutate()}
            disabled={run.isPending}
          >
            <RefreshCw
              className={'h-3.5 w-3.5' + (run.isPending ? ' animate-spin' : '')}
            />{' '}
            Run cleanup now
          </button>
        </div>
        <p className="text-sm text-ink-500">
          Set retention windows in days. <strong>0 means keep forever.</strong>{' '}
          The nightly sweep runs automatically; "Run now" applies your settings
          immediately.
        </p>
        {last && summary && (
          <div className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs dark:border-ink-800 dark:bg-ink-900/40">
            <div className="font-medium">Last cleanup</div>
            <div className="text-ink-500">{last.toLocaleString()}</div>
            <ul className="mt-1 grid grid-cols-2 gap-x-4">
              {Object.entries(summary)
                .filter(([, v]) => (v as number) > 0)
                .map(([k, v]) => (
                  <li key={k} className="font-mono text-[11px]">
                    {k}: {v}
                  </li>
                ))}
              {Object.values(summary).every((v) => !v) && (
                <li className="text-ink-500">Nothing to prune.</li>
              )}
            </ul>
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="mb-2 text-sm font-semibold">Current row counts</h3>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
          {Object.entries(data.counts).map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span className="text-ink-500">{labelize(k)}</span>
              <span className="font-mono">{v.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        {FIELDS.map((f) => (
          <RetentionRow
            key={f.key}
            field={f}
            value={(draft[f.key] as number | undefined) ?? 0}
            currentCount={
              f.countKey ? (data.counts[f.countKey] as number | undefined) : undefined
            }
            onChange={(v) => setField(f.key, v)}
          />
        ))}
      </div>

      <div className="sticky bottom-4 z-10 flex justify-end">
        <button
          type="button"
          className="btn-primary"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(draft)}
        >
          {save.isPending ? 'Saving…' : 'Save retention settings'}
        </button>
      </div>

      <div className="card border-amber-200 bg-amber-50/40 text-xs dark:border-amber-900/50 dark:bg-amber-950/20">
        <div className="mb-1 flex items-center gap-1 font-semibold text-amber-800 dark:text-amber-200">
          <AlertTriangle className="h-3.5 w-3.5" />
          Heads up
        </div>
        <p className="text-amber-800 dark:text-amber-200">
          Cleanup is destructive and not reversible. Older articles whose source
          emails got pruned still display; only the inline citations stop
          resolving. If in doubt, lower a window gradually rather than going
          straight to a tight retention.
        </p>
      </div>
    </div>
  );
}

function RetentionRow({
  field,
  value,
  currentCount,
  onChange,
}: {
  field: (typeof FIELDS)[number];
  value: number;
  currentCount?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <h3 className="font-semibold">{field.label}</h3>
          {currentCount != null && (
            <span className="text-xs text-ink-500">
              {currentCount.toLocaleString()} rows
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {field.presets.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              className={
                'rounded-full px-2 py-0.5 text-[11px] ' +
                (value === p
                  ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
                  : 'text-ink-500 hover:text-ink-700 dark:hover:text-ink-200')
              }
            >
              {p === 0 ? 'forever' : `${p}d`}
            </button>
          ))}
          <input
            type="number"
            className="input h-7 w-20 px-1 py-0 text-xs"
            min={0}
            max={3650}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
          />
          <span className="text-xs text-ink-500">days</span>
        </div>
      </div>
      <p className="mt-1 text-xs text-ink-500">{field.description}</p>
    </div>
  );
}

function labelize(k: string): string {
  return k
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .replace('Lib Docs', 'Library docs')
    .replace('Tag Digests', 'Tag digests')
    .replace('Promo Codes', 'Promo codes');
}
