import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Cpu,
  Database,
  HardDrive,
  Layers,
  RefreshCw,
} from 'lucide-react';
import { useApi } from '../../lib/api';

/**
 * Operator-facing dashboard reading /api/diagnostics. Built to
 * answer the three questions the metrics surface is meant to
 * answer at a glance:
 *
 *   1. Is the worker keeping up?  (queue depths + active counts)
 *   2. Are the LLM calls fast?    (Ollama gen + embed p50/p95/p99)
 *   3. Is web research costing me? (per-run counters + fetched
 *                                    / kept / robots-blocked tallies)
 *
 * Auto-refreshes every 10s. Anything beyond the at-a-glance read
 * intentionally stays here rather than splintering into multiple
 * tabs — the operator can scroll. Workers that publish snapshots
 * less often than 30s show up after their first publish lands.
 */

type Histogram = {
  count: number;
  sum: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
};

type WorkerSnapshot = {
  workerId: string;
  workerMode: string;
  pid: number;
  hostname: string;
  uptimeSec: number;
  startedAt: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  loopDelay: { p50: number; p95: number; p99: number; max: number };
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, Histogram>;
};

type Diagnostics = {
  generatedAt: string;
  workers: WorkerSnapshot[];
  totals: {
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, Histogram>;
  };
  queues: {
    name: string;
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
    completed: number;
  }[];
  mongo: {
    state: string;
    collectionCounts: Record<string, number>;
  };
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

function fmtMs(ms: number): string {
  if (!ms) return '—';
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function DiagnosticsPage() {
  const api = useApi();
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['diagnostics'],
    queryFn: () => api.get<Diagnostics>('/api/diagnostics'),
    refetchInterval: 10_000,
  });

  if (!data) {
    return (
      <div className="text-sm text-ink-500">
        <span className="animate-pulse">Loading diagnostics…</span>
      </div>
    );
  }

  const totalQueueWaiting = data.queues.reduce((s, q) => s + q.waiting, 0);
  const totalQueueActive = data.queues.reduce((s, q) => s + q.active, 0);
  const totalQueueFailed = data.queues.reduce((s, q) => s + q.failed, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Diagnostics</h2>
        <div className="flex items-center gap-2 text-xs text-ink-500">
          <span>
            Last updated {new Date(data.generatedAt).toLocaleTimeString()}
          </span>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="rounded border border-ink-200 px-2 py-1 text-xs hover:bg-ink-50 disabled:opacity-50 dark:border-ink-700 dark:hover:bg-ink-800"
          >
            <RefreshCw
              className={
                'mr-1 inline h-3 w-3 ' + (isFetching ? 'animate-spin' : '')
              }
            />
            Refresh
          </button>
        </div>
      </div>

      {/* Headline cards — the three at-a-glance signals. */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Queues — waiting"
          value={String(totalQueueWaiting)}
          sub={`${totalQueueActive} active · ${totalQueueFailed} failed`}
          icon={<Layers className="h-4 w-4 text-rose-500" />}
        />
        <Stat
          label="Generate-page p95"
          value={fmtMs(
            data.totals.histograms['generate_page_duration_ms']?.p95 ?? 0,
          )}
          sub={`${data.totals.histograms['generate_page_duration_ms']?.count ?? 0} runs`}
          icon={<Activity className="h-4 w-4 text-rose-500" />}
        />
        <Stat
          label="Web research — fetches"
          value={String(data.totals.counters['topic_research_fetches'] ?? 0)}
          sub={`${data.totals.counters['topic_research_kept'] ?? 0} kept · ${
            data.totals.counters['topic_research_off_topic'] ?? 0
          } off-topic · ${
            data.totals.counters['topic_research_robots_blocked'] ?? 0
          } robots`}
          icon={<HardDrive className="h-4 w-4 text-rose-500" />}
        />
      </div>

      {/* Mongo + the largest collections. */}
      <section className="card">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Database className="h-4 w-4 text-rose-500" /> Storage
        </h3>
        <div className="text-xs text-ink-500">
          MongoDB: <strong className={data.mongo.state === 'connected' ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}>{data.mongo.state}</strong>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {Object.entries(data.mongo.collectionCounts).map(([k, v]) => (
            <div
              key={k}
              className="rounded border border-ink-200 px-2 py-1.5 text-xs dark:border-ink-800"
            >
              <span className="text-ink-500">{k}</span>
              <div className="font-mono tabular-nums">
                {v < 0 ? '—' : v.toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Per-queue table. */}
      <section className="card">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Layers className="h-4 w-4 text-rose-500" /> Queues
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-ink-500">
              <tr>
                <th className="py-1.5 pr-3">Queue</th>
                <th className="py-1.5 pr-3 text-right">Waiting</th>
                <th className="py-1.5 pr-3 text-right">Active</th>
                <th className="py-1.5 pr-3 text-right">Delayed</th>
                <th className="py-1.5 pr-3 text-right">Failed</th>
                <th className="py-1.5 pr-3 text-right">Completed</th>
              </tr>
            </thead>
            <tbody>
              {data.queues
                .filter(
                  (q) =>
                    q.waiting + q.active + q.delayed + q.failed + q.completed > 0,
                )
                .map((q) => (
                  <tr key={q.name} className="border-t border-ink-200 dark:border-ink-800">
                    <td className="py-1 pr-3 font-mono">{q.name.replace(/^rose\./, '')}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">{q.waiting}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">
                      {q.active > 0 ? (
                        <span className="font-medium text-rose-700 dark:text-rose-300">
                          {q.active}
                        </span>
                      ) : (
                        q.active
                      )}
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums">{q.delayed}</td>
                    <td className="py-1 pr-3 text-right tabular-nums">
                      {q.failed > 0 ? (
                        <span className="font-medium text-red-700 dark:text-red-300">
                          {q.failed}
                        </span>
                      ) : (
                        q.failed
                      )}
                    </td>
                    <td className="py-1 pr-3 text-right tabular-nums">{q.completed.toLocaleString()}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Per-worker rollup. */}
      <section className="card">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Cpu className="h-4 w-4 text-rose-500" /> Workers ({data.workers.length})
        </h3>
        {data.workers.length === 0 ? (
          <div className="text-xs italic text-ink-500">
            No worker snapshots — either nothing's running or the publishers haven't ticked yet (every 30s).
          </div>
        ) : (
          <div className="space-y-3">
            {data.workers.map((w) => (
              <div
                key={w.workerId}
                className="rounded border border-ink-200 p-3 text-xs dark:border-ink-800"
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="rounded bg-rose-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-rose-800 dark:bg-rose-950/50 dark:text-rose-200">
                    {w.workerMode}
                  </span>
                  <span className="font-mono text-[11px] text-ink-500">
                    {w.hostname}:{w.pid}
                  </span>
                  <span className="text-ink-500">
                    up {formatDuration(w.uptimeSec)}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Mini label="RSS" value={formatBytes(w.rssBytes)} />
                  <Mini
                    label="Heap"
                    value={`${formatBytes(w.heapUsedBytes)} / ${formatBytes(w.heapTotalBytes)}`}
                  />
                  <Mini
                    label="Loop p95"
                    value={fmtMs(w.loopDelay.p95)}
                    danger={w.loopDelay.p95 > 50}
                  />
                  <Mini
                    label="Loop max"
                    value={fmtMs(w.loopDelay.max)}
                    danger={w.loopDelay.max > 200}
                  />
                </div>
                {Object.keys(w.histograms).length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] text-ink-500 hover:text-ink-900 dark:hover:text-ink-100">
                      Histograms ({Object.keys(w.histograms).length})
                    </summary>
                    <div className="mt-1 space-y-0.5 font-mono text-[11px]">
                      {Object.entries(w.histograms).map(([k, h]) => (
                        <div key={k}>
                          <span className="text-ink-500">{k}</span>: {h.count}× ·
                          p50 {fmtMs(h.p50)} · p95 {fmtMs(h.p95)} · p99 {fmtMs(h.p99)} · max {fmtMs(h.max)}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                {Object.keys(w.counters).length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] text-ink-500 hover:text-ink-900 dark:hover:text-ink-100">
                      Counters ({Object.keys(w.counters).length})
                    </summary>
                    <div className="mt-1 grid grid-cols-1 gap-0.5 font-mono text-[11px] sm:grid-cols-2">
                      {Object.entries(w.counters).map(([k, v]) => (
                        <div key={k} className="truncate">
                          <span className="text-ink-500">{k}</span>: {v.toLocaleString()}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-ink-500">
        {icon}
        {label}
      </div>
      <div className="mt-1 font-mono text-2xl tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] text-ink-500">{sub}</div>
    </div>
  );
}

function Mini({
  label,
  value,
  danger,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded border border-ink-200 px-2 py-1 dark:border-ink-800">
      <div className="text-[10px] uppercase tracking-widest text-ink-500">{label}</div>
      <div
        className={
          'font-mono tabular-nums ' +
          (danger ? 'text-amber-700 dark:text-amber-300' : '')
        }
      >
        {value}
      </div>
    </div>
  );
}
