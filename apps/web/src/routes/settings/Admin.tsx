import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ShieldAlert, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';

type Scope = {
  id: string;
  group: 'global' | 'content' | 'metadata' | 'subscriptions' | 'infrastructure';
  label: string;
  description: string;
};

type ResetResult = {
  ok: boolean;
  results: Array<{ id: string; deleted: number; ok: boolean; error?: string }>;
};

const GROUP_LABEL: Record<Scope['group'], string> = {
  global: 'Global knowledge (every user is affected)',
  content: 'Content (every user is affected)',
  metadata: 'Per-user metadata (every user is affected)',
  subscriptions: 'Subscriptions / sources (DESTRUCTIVE — credentials are dropped)',
  infrastructure: 'Infrastructure',
};

const GROUP_ORDER: Scope['group'][] = [
  'global',
  'content',
  'metadata',
  'subscriptions',
  'infrastructure',
];

/**
 * Plan 16 — Settings → Admin. Visible only to the user whose
 * email matches `ADMIN_EMAIL` server-side. Renders the reset
 * scope catalog as grouped checkboxes; the user types `RESET`
 * into the confirm field and clicks the big red button.
 *
 * The endpoint is also gated on the server (`requireAdmin`
 * middleware on /api/admin/*) so a non-admin user crafting the
 * request manually still gets a 403.
 */
export default function AdminSettingsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['admin-scopes'],
    queryFn: () => api.get<{ scopes: Scope[] }>('/api/admin/reset/scopes'),
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmText, setConfirmText] = useState('');
  const [lastResult, setLastResult] = useState<ResetResult | null>(null);

  const reset = useMutation({
    mutationFn: async () =>
      api.post<ResetResult>('/api/admin/reset', {
        confirm: 'RESET',
        scopes: [...selected],
      }),
    onSuccess: (r) => {
      setLastResult(r);
      setSelected(new Set());
      setConfirmText('');
      toast.success(
        r.ok
          ? 'Reset complete'
          : 'Reset finished with errors — see results below',
      );
      // Invalidate everything React Query knows about; lots of data
      // just changed underneath every other view.
      qc.invalidateQueries();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const grouped = useMemo(() => {
    const out: Record<Scope['group'], Scope[]> = {
      global: [],
      content: [],
      metadata: [],
      subscriptions: [],
      infrastructure: [],
    };
    for (const s of data?.scopes ?? []) out[s.group].push(s);
    return out;
  }, [data]);

  if (isError) {
    return (
      <div className="card text-sm">
        <div className="font-medium text-red-600">Couldn't load admin scopes.</div>
        <div className="mt-1 text-xs text-ink-500">
          {(error as Error)?.message ?? 'Unknown error.'}
        </div>
      </div>
    );
  }

  if (isLoading || !data) {
    return <div className="card text-sm text-ink-500">Loading…</div>;
  }

  const allIds = data.scopes.map((s) => s.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const canReset = selected.size > 0 && confirmText === 'RESET' && !reset.isPending;

  return (
    <div className="space-y-4">
      <QueueStats />
      <ExtractionCoverage />

      <div className="card border-red-300 bg-red-50 dark:border-red-900/40 dark:bg-red-950/20">
        <div className="mb-2 flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-red-600" />
          <h2 className="font-semibold text-red-700 dark:text-red-300">
            Operator-mode reset
          </h2>
        </div>
        <p className="text-sm text-red-900 dark:text-red-200">
          Tick the buckets you want to wipe, type <code>RESET</code> into the
          confirm field, hit the button. Each scope runs as a Mongo
          <code> deleteMany</code> across <em>all users</em>; some scopes
          drop credentials and will require users to re-link their accounts.
        </p>
        <p className="mt-2 text-sm text-red-900 dark:text-red-200">
          There is no undo. There is no per-user filter. Use this when
          you genuinely want to start over.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink-700 dark:text-ink-200">
          {selected.size} of {allIds.length} buckets selected
        </h3>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() =>
            setSelected(allSelected ? new Set() : new Set(allIds))
          }
        >
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
      </div>

      <div className="space-y-5">
        {GROUP_ORDER.map((group) => {
          const items = grouped[group];
          if (items.length === 0) return null;
          const groupAllSelected = items.every((s) => selected.has(s.id));
          return (
            <section
              key={group}
              className="rounded-lg border border-ink-200 dark:border-ink-800"
            >
              <header className="flex items-center justify-between border-b border-ink-200 bg-ink-50 px-3 py-2 text-xs font-semibold uppercase tracking-widest text-ink-600 dark:border-ink-800 dark:bg-ink-900 dark:text-ink-300">
                <span>{GROUP_LABEL[group]}</span>
                <button
                  type="button"
                  className="text-[10px] font-normal normal-case text-ink-500 hover:text-rose-600"
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (groupAllSelected) {
                        for (const s of items) next.delete(s.id);
                      } else {
                        for (const s of items) next.add(s.id);
                      }
                      return next;
                    })
                  }
                >
                  {groupAllSelected ? 'unselect group' : 'select group'}
                </button>
              </header>
              <ul className="divide-y divide-ink-200 dark:divide-ink-800">
                {items.map((s) => (
                  <li key={s.id} className="px-3 py-2.5">
                    <label className="flex cursor-pointer items-start gap-3 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1 accent-red-600"
                        checked={selected.has(s.id)}
                        onChange={(e) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(s.id);
                            else next.delete(s.id);
                            return next;
                          })
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-ink-800 dark:text-ink-100">
                          {s.label}
                        </div>
                        <div className="mt-0.5 text-xs text-ink-500">
                          {s.description}
                        </div>
                      </div>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <div className="card border-red-300 bg-red-50 dark:border-red-900/40 dark:bg-red-950/20">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-red-900 dark:text-red-200">
            Type <code>RESET</code> to confirm
          </span>
          <input
            className="input"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="RESET"
            spellCheck={false}
            autoCapitalize="characters"
          />
        </label>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canReset}
            onClick={() => {
              if (
                !window.confirm(
                  `Wipe ${selected.size} bucket${selected.size === 1 ? '' : 's'} across every user? This cannot be undone.`,
                )
              )
                return;
              reset.mutate();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {reset.isPending ? 'Resetting…' : 'Reset selected'}
          </button>
        </div>
      </div>

      {lastResult && (
        <div className="card">
          <h3 className="mb-2 text-sm font-semibold">
            Last reset {lastResult.ok ? '· complete' : '· had errors'}
          </h3>
          <ul className="space-y-1 text-xs">
            {lastResult.results.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <span
                  className={
                    r.ok
                      ? 'rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                      : 'rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-800 dark:bg-red-950/40 dark:text-red-200'
                  }
                >
                  {r.ok ? 'ok' : 'error'}
                </span>
                <code className="text-ink-700 dark:text-ink-200">{r.id}</code>
                <span className="text-ink-500">
                  {r.ok
                    ? `${r.deleted} document${r.deleted === 1 ? '' : 's'} cleared`
                    : (r.error ?? 'unknown error')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ─── Extraction coverage + backfill ──────────────────────────── */

type ExtractionStats = {
  purchases: {
    total: number;
    structured: number;
    vendor: number;
    llm: number;
    structuredRatio: number;
    candidatePages: number;
  };
  subscriptions: {
    total: number;
    structured: number;
    llm: number;
    structuredRatio: number;
  };
  daydream: {
    total: number;
    wikipediaVerbatim: number;
    llm: number;
    verbatimRatio: number;
  };
  relations: {
    total: number;
    wikidataConfirmed: number;
    archiveOnly: number;
    wikidataRatio: number;
  };
  pages: {
    total: number;
    withRelationsExtracted: number;
  };
};

type QueueStatsResponse = {
  totals: { waiting: number; active: number; delayed: number; failed: number };
  queues: Array<{
    name: string;
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
  }>;
};

/**
 * Live worker-queue snapshot. Polls /api/admin/queue-stats every
 * five seconds so the admin can spot a stuck or backlogged queue
 * without tailing the worker logs. The pill shows the totals in
 * green / amber / red bands; expanding it surfaces per-queue rows
 * with the largest backlogs first.
 */
function QueueStats() {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['admin-queue-stats'],
    queryFn: () => api.get<QueueStatsResponse>('/api/admin/queue-stats'),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
  if (!data) {
    return (
      <div className="card flex items-center gap-2 text-sm text-ink-500">
        <Activity className="h-4 w-4" /> Queue stats loading…
      </div>
    );
  }
  const { totals, queues } = data;
  const busy = totals.waiting + totals.active + totals.delayed;
  const band =
    totals.failed > 0
      ? 'bg-red-100 text-red-800 dark:bg-red-950/30 dark:text-red-300'
      : busy > 100
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300'
        : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300';
  const ranked = [...queues].sort(
    (a, b) =>
      b.failed - a.failed ||
      b.active + b.waiting + b.delayed - (a.active + a.waiting + a.delayed),
  );
  return (
    <div className="card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3"
        title="Live queue depth (refreshed every 5s)"
      >
        <Activity className="h-4 w-4 text-rose-500" />
        <h2 className="font-semibold">Worker queues</h2>
        <span
          className={'ml-auto rounded-full px-2 py-0.5 text-xs font-mono ' + band}
        >
          {busy} in flight
          {totals.failed > 0 ? ` · ${totals.failed} failed` : ''}
        </span>
        <span className="text-xs text-ink-500">
          {open ? 'hide' : 'show per-queue'}
        </span>
      </button>
      {open && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-ink-500">
              <tr>
                <th className="text-left font-medium">Queue</th>
                <th className="text-right font-medium">Waiting</th>
                <th className="text-right font-medium">Active</th>
                <th className="text-right font-medium">Delayed</th>
                <th className="text-right font-medium">Failed</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((q) => (
                <tr key={q.name} className="border-t border-ink-100 dark:border-ink-800">
                  <td className="py-1 font-mono">{q.name}</td>
                  <td className="text-right">{q.waiting}</td>
                  <td className="text-right">{q.active}</td>
                  <td className="text-right">{q.delayed}</td>
                  <td
                    className={
                      'text-right ' +
                      (q.failed > 0 ? 'font-semibold text-red-600' : '')
                    }
                  >
                    {q.failed}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Coverage panel for the four extractors that gained
 * deterministic / structured-data fast paths. Shows what
 * percentage of each collection is on the LLM-free path; lets the
 * admin trigger a backfill that re-runs the extractors against
 * historical pages so they can upgrade.
 *
 * Idempotent: extractors short-circuit on unchanged contentMd, so
 * re-running the backfill at any time is safe.
 */
function ExtractionCoverage() {
  const api = useApi();
  const qc = useQueryClient();
  const { data: stats } = useQuery({
    queryKey: ['admin-extraction-stats'],
    queryFn: () => api.get<ExtractionStats>('/api/admin/extraction-stats'),
    refetchInterval: 60_000,
  });
  const backfill = useMutation({
    mutationFn: async (kind: string) =>
      api.post<{ kind: string; candidatePages: number; enqueued: number }>(
        '/api/admin/backfill',
        { kind },
      ),
    onSuccess: (r) => {
      toast.success(
        `Backfill enqueued: ${r.enqueued.toLocaleString()} ${r.kind} pages`,
      );
      qc.invalidateQueries({ queryKey: ['admin-extraction-stats'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  // Entity-Wikidata is fan-out shaped differently (one job per
  // Entity row, not per Page) so it has its own admin endpoint.
  const backfillEntities = useMutation({
    mutationFn: async () =>
      api.post<{ candidateEntities: number; enqueued: number }>(
        '/api/admin/backfill-entities',
        {},
      ),
    onSuccess: (r) => {
      toast.success(
        `Entity Q-ID backfill: ${r.enqueued.toLocaleString()} entities enqueued`,
      );
      qc.invalidateQueries({ queryKey: ['admin-extraction-stats'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!stats) {
    return (
      <div className="card text-sm text-ink-500">Loading coverage…</div>
    );
  }
  const rows: {
    label: string;
    kind: string;
    fastPath: string;
    fast: number;
    total: number;
    ratio: number;
  }[] = [
    {
      label: 'Receipts → product purchases',
      kind: 'receipt',
      // Receipts now have TWO fast-paths: schema.org JSON-LD
      // catches the well-templated vendors, per-vendor parsers
      // catch Amazon / Apple / USPS / etc. Combined here.
      fastPath: `schema.org (${stats.purchases.structured.toLocaleString()}) + vendor (${stats.purchases.vendor.toLocaleString()})`,
      fast: stats.purchases.structured + stats.purchases.vendor,
      total: stats.purchases.total,
      ratio: stats.purchases.structuredRatio,
    },
    {
      label: 'Subscriptions',
      kind: 'subscription',
      fastPath: 'schema.org JSON-LD',
      fast: stats.subscriptions.structured,
      total: stats.subscriptions.total,
      ratio: stats.subscriptions.structuredRatio,
    },
    {
      label: 'Daydream notes',
      kind: 'daydream',
      fastPath: 'Wikipedia verbatim',
      fast: stats.daydream.wikipediaVerbatim,
      total: stats.daydream.total,
      ratio: stats.daydream.verbatimRatio,
    },
    {
      label: 'Entity relations',
      kind: 'relations',
      fastPath: 'Wikidata SPARQL',
      fast: stats.relations.wikidataConfirmed,
      total: stats.relations.total,
      ratio: stats.relations.wikidataRatio,
    },
  ];
  return (
    <div className="card">
      <div className="mb-3 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-rose-500" />
        <h2 className="font-semibold">Extraction coverage</h2>
        <button
          type="button"
          className="ml-auto btn-secondary text-xs"
          onClick={() => backfill.mutate('all')}
          disabled={backfill.isPending}
          title="Re-run every extractor across every page"
        >
          Backfill all
        </button>
      </div>
      <p className="mb-3 text-xs text-ink-500">
        Each row shows what fraction of the collection is on the
        deterministic / structured-data fast path (lower LLM cost,
        higher fidelity). Backfill replays the extractor against
        historical pages so they can upgrade in place. Idempotent —
        unchanged pages short-circuit.
      </p>
      <ul className="space-y-3 text-sm">
        {rows.map((r) => {
          const pct = Math.round(r.ratio * 100);
          return (
            <li
              key={r.kind}
              className="rounded-lg border border-ink-200 px-3 py-2 dark:border-ink-800"
            >
              <div className="flex items-baseline gap-3">
                <span className="font-medium">{r.label}</span>
                <span className="text-xs text-ink-500">
                  ({r.fastPath})
                </span>
                <span className="ml-auto text-xs text-ink-500">
                  {r.fast.toLocaleString()} of {r.total.toLocaleString()} —{' '}
                  <strong
                    className={
                      pct >= 60
                        ? 'text-emerald-700 dark:text-emerald-300'
                        : pct >= 25
                          ? 'text-amber-700 dark:text-amber-300'
                          : 'text-red-700 dark:text-red-300'
                    }
                  >
                    {pct}%
                  </strong>{' '}
                  fast path
                </span>
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() => backfill.mutate(r.kind)}
                  disabled={backfill.isPending}
                  title={`Replay the ${r.kind} extractor across historical pages`}
                >
                  Backfill
                </button>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded bg-ink-100 dark:bg-ink-800">
                <div
                  className={
                    'h-full ' +
                    (pct >= 60
                      ? 'bg-emerald-500'
                      : pct >= 25
                        ? 'bg-amber-500'
                        : 'bg-red-500')
                  }
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex items-center gap-3 rounded-lg border border-dashed border-ink-200 px-3 py-2 text-xs dark:border-ink-800">
        <span className="text-ink-500">
          Person + place entities don't appear in extraction coverage —
          they live on the per-user Entity collection. Resolve their
          Wikidata Q-IDs (and the SPARQL relations that chain off
          them) here.
        </span>
        <button
          type="button"
          className="ml-auto btn-secondary text-xs"
          onClick={() => backfillEntities.mutate()}
          disabled={backfillEntities.isPending}
          title="Run the Wikidata resolver against every person/place Entity that hasn't been touched in 90 days"
        >
          Backfill entity Q-IDs
        </button>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => backfill.mutate('outbound-links')}
          disabled={backfill.isPending}
          title="Populate Page.outboundLinks across every page so the lineage cited-by query uses the indexed lookup"
        >
          Backfill outbound links
        </button>
      </div>
    </div>
  );
}
