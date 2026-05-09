import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  FileText,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Flame,
  ShieldAlert,
  Megaphone,
  Bug,
  X,
  Loader2,
  Clock,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { IngestionDrawer } from '../../components/IngestionDrawer';

type EmailRow = {
  _id: string;
  subject: string;
  from?: { address: string; name?: string };
  date?: string;
  ingestStatus: string;
  pageId?: string;
  pageSlug?: string | null;
  error?: string | null;
  priority?: 'high' | 'normal' | 'low';
  spamScore?: number;
  spamSignals?: string[];
  isMassMailing?: boolean;
  createdAt: string;
};

type QueueCounts = {
  waiting?: number;
  active?: number;
  completed?: number;
  failed?: number;
  delayed?: number;
};

type ProviderHealth = {
  providerId: 'ollama' | 'anthropic' | 'openai';
  model: string;
  ok: boolean;
  message?: string;
};

type Health = {
  queues: { generate: QueueCounts; embed: QueueCounts; imap: QueueCounts };
  generation: ProviderHealth;
  embedding: ProviderHealth;
  ollama: { installedModels: string[]; missingModels: string[] };
};

type ActiveJob = {
  id: string;
  state: 'active' | 'waiting';
  emailId: string | null;
  priority: number | null;
  attemptsMade: number;
  timestamp: number | null;
  processedOn: number | null;
  subject: string | null;
  from: string | null;
  fromName: string | null;
  emailDate: string | null;
  kind: string | null;
};

export default function IngestPage() {
  const api = useApi();
  const { token } = useAuth();
  const qc = useQueryClient();
  const [activeJob, setActiveJob] = useState<string | null>(null);
  const [diagEmailId, setDiagEmailId] = useState<string | null>(null);

  // `pending=1` server-side filters out terminal states (generated +
  // skipped) so this view only shows emails that still need
  // attention. Successfully-generated items live on /p/<slug> from
  // the article view; surfacing them here just adds noise to the
  // "what's stuck" mental model the queue is trying to communicate.
  const { data, isLoading } = useQuery({
    queryKey: ['emails', 'pending'],
    queryFn: () =>
      api.get<{ emails: EmailRow[] }>('/api/emails?limit=100&pending=1'),
    refetchInterval: 5000,
  });

  const { data: health } = useQuery({
    queryKey: ['jobs-health'],
    queryFn: () => api.get<Health>('/api/jobs/health/summary'),
    refetchInterval: 5000,
  });

  const { data: activeJobs } = useQuery({
    queryKey: ['jobs-active'],
    queryFn: () => api.get<{ active: ActiveJob[]; upNext: ActiveJob[] }>('/api/jobs/active'),
    // Tighter cadence than the email list since this is the
    // "what's happening right now" widget.
    refetchInterval: 2000,
  });

  const regenerate = useMutation({
    mutationFn: async (id: string) =>
      api.post<{ jobId: string }>(`/api/emails/${id}/regenerate`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['emails'] });
      qc.invalidateQueries({ queryKey: ['jobs-health'] });
      toast.success('Regeneration queued');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const regenerateAll = useMutation({
    mutationFn: async () =>
      api.post<{ enqueued: number }>('/api/emails/regenerate-stuck', { limit: 5000 }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['emails'] });
      qc.invalidateQueries({ queryKey: ['jobs-health'] });
      toast.success(`Re-queued ${r.enqueued} email(s)`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const stuckCount = data?.emails.filter((e) => e.ingestStatus === 'parsed').length ?? 0;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Ingest queue</h2>
          <p className="text-xs text-ink-500">
            Live view of every email pulled in by your sources, with the
            generation status for each. Use this when something didn't
            land on an article and you need to see why.
          </p>
        </div>
        <span className="text-sm text-ink-500">{data?.emails.length ?? 0} emails</span>
      </div>

      {health && <HealthBanner health={health} stuckCount={stuckCount} onRetryAll={() => regenerateAll.mutate()} retryPending={regenerateAll.isPending} />}

      {activeJobs && (activeJobs.active.length > 0 || activeJobs.upNext.length > 0) && (
        <NowProcessingPanel
          active={activeJobs.active}
          upNext={activeJobs.upNext}
        />
      )}

      {isLoading ? (
        <div className="text-ink-500">Loading…</div>
      ) : (data?.emails.length ?? 0) === 0 ? (
        <EmptyIngest />
      ) : (
        <ul className="space-y-2">
          {data!.emails.map((e) => (
            <li key={e._id} className="card flex items-center gap-3">
              <FileText className="h-5 w-5 shrink-0 text-ink-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{e.subject || '(no subject)'}</div>
                <div className="truncate text-xs text-ink-500">
                  {e.from?.name || e.from?.address} · {new Date(e.date ?? e.createdAt).toLocaleString()}
                </div>
              </div>
              {e.priority === 'high' && (
                <span
                  className="pill !bg-rose-100 !text-rose-800 dark:!bg-rose-950/40 dark:!text-rose-300 inline-flex items-center gap-1"
                  title="High priority"
                >
                  <Flame className="h-3 w-3" /> high
                </span>
              )}
              {(e.spamScore ?? 0) >= 0.5 && (
                <span
                  className="pill !bg-red-100 !text-red-800 dark:!bg-red-950/40 dark:!text-red-300 inline-flex items-center gap-1"
                  title={`Likely spam (${Math.round((e.spamScore ?? 0) * 100)}%): ${(e.spamSignals ?? []).join('; ') || 'heuristic match'}`}
                >
                  <ShieldAlert className="h-3 w-3" /> spam
                </span>
              )}
              {e.isMassMailing && (e.spamScore ?? 0) < 0.5 && (
                <span
                  className="pill inline-flex items-center gap-1"
                  title="Mass mailing (List-Unsubscribe / List-Id present)"
                >
                  <Megaphone className="h-3 w-3" /> bulk
                </span>
              )}
              <span
                className={statusClass(e.ingestStatus)}
                title={e.error ?? undefined}
              >
                {e.ingestStatus}
              </span>
              <Link
                to={`/e/${e._id}`}
                className="btn-ghost text-xs"
                title="Open original email"
              >
                Open
              </Link>
              {e.pageSlug && (
                <Link to={`/p/${e.pageSlug}`} className="btn-ghost text-xs">
                  View page
                </Link>
              )}
              {(e.ingestStatus === 'parsed' ||
                e.ingestStatus === 'failed' ||
                e.ingestStatus === 'skipped') && (
                <button
                  className="btn-ghost"
                  onClick={() => regenerate.mutate(e._id)}
                  disabled={regenerate.isPending}
                  aria-label="Regenerate page"
                  title="Regenerate page"
                >
                  <RefreshCw
                    className={`h-4 w-4 ${regenerate.isPending ? 'animate-spin' : ''}`}
                  />
                </button>
              )}
              <button
                className={`btn-ghost ${
                  e.ingestStatus === 'failed' || e.error ? 'text-red-600' : ''
                }`}
                onClick={() => setDiagEmailId(e._id)}
                aria-label="Show generation history"
                title="Show generation history (success + failure details)"
              >
                <Bug className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {activeJob && token && (
        <IngestionDrawer
          jobId={activeJob}
          token={token}
          onClose={() => setActiveJob(null)}
        />
      )}

      {diagEmailId && (
        <GenerationHistoryModal
          emailId={diagEmailId}
          onClose={() => setDiagEmailId(null)}
          onRegenerate={() => {
            regenerate.mutate(diagEmailId);
            setDiagEmailId(null);
          }}
        />
      )}
    </div>
  );
}

type JobHistoryEntry = {
  id: string;
  state: 'failed' | 'completed' | 'active' | 'waiting' | 'delayed';
  attemptsMade: number;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  failedReason: string | null;
  stacktrace: string[];
  returnvalue: unknown;
};

/**
 * Modal that lists every generate-page job ever queued for an email,
 * newest first. For failed jobs it shows the verbatim failedReason and
 * full stacktrace from BullMQ — the same data the worker logs but
 * surfaced inline so you don't have to `docker logs worker`. Useful
 * for debugging when an email parses but never produces a page.
 */
function GenerationHistoryModal({
  emailId,
  onClose,
  onRegenerate,
}: {
  emailId: string;
  onClose: () => void;
  onRegenerate: () => void;
}) {
  const api = useApi();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['email-jobs', emailId],
    queryFn: () => api.get<{ jobs: JobHistoryEntry[] }>(`/api/emails/${emailId}/jobs`),
    refetchInterval: 5000,
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 sm:p-10"
      onClick={onClose}
    >
      <div
        className="relative max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-ink-950"
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-200 px-5 py-3 dark:border-ink-800">
          <h2 className="font-semibold">Generation history</h2>
          <div className="flex items-center gap-2">
            <button
              className="btn-secondary text-xs"
              onClick={onRegenerate}
            >
              <RefreshCw className="h-3 w-3" />
              Regenerate now
            </button>
            <button
              className="btn-ghost"
              onClick={onClose}
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="max-h-[75vh] overflow-y-auto px-5 py-4">
          {isLoading ? (
            <div className="text-sm text-ink-500">Loading…</div>
          ) : isError ? (
            <div className="text-sm text-red-600">
              {(error as Error)?.message ?? 'Failed to load jobs.'}
            </div>
          ) : (data?.jobs.length ?? 0) === 0 ? (
            <div className="text-sm text-ink-500">
              No generate-page jobs found for this email. Either it was
              never enqueued, or BullMQ has rotated old job records out
              (we keep the most recent ~500 per state). Try the
              Regenerate button above to enqueue a fresh attempt and
              come back here once it runs.
            </div>
          ) : (
            <ul className="space-y-3">
              {data!.jobs.map((j) => (
                <JobRow key={j.id + j.state} job={j} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function JobRow({ job }: { job: JobHistoryEntry }) {
  const stateClass =
    job.state === 'failed'
      ? 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300'
      : job.state === 'completed'
        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
        : job.state === 'active'
          ? 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300'
          : 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-300';
  const queuedAt = job.timestamp ? new Date(job.timestamp).toLocaleString() : '—';
  const finishedAt = job.finishedOn ? new Date(job.finishedOn).toLocaleString() : null;
  const elapsedMs =
    job.processedOn && job.finishedOn ? job.finishedOn - job.processedOn : null;

  return (
    <li className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs dark:border-ink-800 dark:bg-ink-900">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 font-medium ${stateClass}`}>
          {job.state}
        </span>
        <code className="text-[11px] text-ink-500">{job.id}</code>
        <span className="text-ink-500">queued {queuedAt}</span>
        {finishedAt && <span className="text-ink-500">· finished {finishedAt}</span>}
        {elapsedMs != null && (
          <span className="text-ink-500">· took {(elapsedMs / 1000).toFixed(1)}s</span>
        )}
        <span className="ml-auto text-ink-500">
          attempt {job.attemptsMade}
        </span>
      </div>
      {job.failedReason && (
        <div className="mt-2 rounded bg-red-50 p-2 text-red-900 dark:bg-red-950/40 dark:text-red-200">
          <div className="font-medium">failedReason</div>
          <div className="mt-0.5 break-words">{job.failedReason}</div>
        </div>
      )}
      {job.stacktrace.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-ink-600 hover:text-rose-600 dark:text-ink-300">
            Stack trace ({job.stacktrace.length} frame{job.stacktrace.length === 1 ? '' : 's'})
          </summary>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-black/80 p-2 text-[11px] text-emerald-200">
            {job.stacktrace.join('\n\n')}
          </pre>
        </details>
      )}
      {job.state === 'completed' && Boolean(job.returnvalue) && (
        <details className="mt-2">
          <summary className="cursor-pointer text-ink-600 hover:text-rose-600 dark:text-ink-300">
            Return value
          </summary>
          <pre className="mt-1 overflow-auto rounded bg-ink-100 p-2 text-[11px] dark:bg-ink-800">
            {JSON.stringify(job.returnvalue, null, 2)}
          </pre>
        </details>
      )}
    </li>
  );
}

function HealthBanner({
  health,
  stuckCount,
  onRetryAll,
  retryPending,
}: {
  health: Health;
  stuckCount: number;
  onRetryAll: () => void;
  retryPending: boolean;
}) {
  const gen = health.queues.generate;
  const queued = (gen.waiting ?? 0) + (gen.active ?? 0) + (gen.delayed ?? 0);
  const failed = gen.failed ?? 0;

  // Critical: configured generation provider is unreachable.
  if (!health.generation.ok) {
    return (
      <div className="mb-4 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <div className="font-semibold">
            Generation provider <code>{health.generation.providerId}</code> is unreachable
          </div>
          <div className="mt-0.5 text-xs">
            {health.generation.message ?? 'Check Settings → Models.'}
          </div>
        </div>
      </div>
    );
  }
  // Ollama-specific: required models not pulled.
  if (health.ollama.missingModels.length > 0) {
    return (
      <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <div className="font-semibold">
            Required Ollama model{health.ollama.missingModels.length > 1 ? 's' : ''} not pulled
          </div>
          <div className="mt-0.5 text-xs">
            Missing: <code>{health.ollama.missingModels.join(', ')}</code>. Pull from{' '}
            <Link to="/settings/models" className="underline">Settings → Models</Link>{' '}
            or run:
          </div>
          <pre className="mt-2 overflow-x-auto rounded bg-amber-100 p-2 text-[11px] dark:bg-amber-900/50">
            {health.ollama.missingModels.map((m) => `docker compose exec ollama ollama pull ${m}`).join('\n')}
          </pre>
          {stuckCount > 0 && (
            <button
              className="btn-secondary mt-2 text-xs"
              onClick={onRetryAll}
              disabled={retryPending}
            >
              <RefreshCw className={`h-3 w-3 ${retryPending ? 'animate-spin' : ''}`} />
              Retry {stuckCount} stuck email{stuckCount === 1 ? '' : 's'} after pulling
            </button>
          )}
        </div>
      </div>
    );
  }
  // Backlog warning.
  if (queued > 0 || stuckCount > 0) {
    return (
      <div className="mb-4 flex items-start gap-3 rounded-xl border border-ink-200 bg-ink-50 p-3 text-sm dark:border-ink-800 dark:bg-ink-900">
        <RefreshCw className={`mt-0.5 h-4 w-4 shrink-0 text-rose-500 ${queued > 0 ? 'animate-spin' : ''}`} />
        <div className="flex-1">
          <div>
            <span className="font-medium">{queued}</span> generation{queued === 1 ? '' : 's'} in flight
            {failed > 0 && (
              <>
                {' · '}
                <span className="font-medium text-red-600">{failed}</span> failed
              </>
            )}
            {stuckCount > 0 && queued === 0 && (
              <>
                {' · '}
                <span className="font-medium text-amber-700 dark:text-amber-400">
                  {stuckCount} stuck at "parsed"
                </span>
              </>
            )}
          </div>
          <div className="text-xs text-ink-500">
            Generating with{' '}
            <code>
              {health.generation.providerId}/{health.generation.model}
            </code>
            . CPU-only Ollama is slow (~30–60s per page); a GPU host or a cloud
            provider (configure in Settings → Models) is much faster.
          </div>
        </div>
        {(failed > 0 || (stuckCount > 0 && queued === 0)) && (
          <button
            className="btn-secondary text-xs"
            onClick={onRetryAll}
            disabled={retryPending}
          >
            <RefreshCw className={`h-3 w-3 ${retryPending ? 'animate-spin' : ''}`} />
            Retry all
          </button>
        )}
      </div>
    );
  }
  // All clear.
  return (
    <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100">
      <CheckCircle2 className="h-4 w-4 shrink-0" />
      Pipeline healthy — generation:{' '}
      <code>
        {health.generation.providerId}/{health.generation.model}
      </code>
      , embedding:{' '}
      <code>
        {health.embedding.providerId}/{health.embedding.model}
      </code>
      , no backlog.
    </div>
  );
}

function statusClass(s: string): string {
  const base = 'pill text-xs';
  if (s === 'generated') return base + ' !bg-emerald-100 !text-emerald-800 dark:!bg-emerald-900/30 dark:!text-emerald-300';
  if (s === 'failed') return base + ' !bg-red-100 !text-red-800 dark:!bg-red-900/30 dark:!text-red-300';
  if (s === 'parsed') return base + ' !bg-amber-100 !text-amber-800 dark:!bg-amber-900/30 dark:!text-amber-300';
  if (s === 'skipped') return base + ' !bg-ink-200 !text-ink-700 dark:!bg-ink-800 dark:!text-ink-300';
  return base;
}

function EmptyIngest() {
  return (
    <div className="card flex flex-col items-center gap-3 py-16 text-center">
      <FileText className="h-10 w-10 text-rose-500" />
      <div>
        <h3 className="font-semibold">No emails yet</h3>
        <p className="mt-1 text-sm text-ink-500">
          Connect a mail source to start ingesting. Each email flows
          through the worker into an article.
        </p>
      </div>
      <Link to="/settings/sources" className="btn-primary">
        Connect a source
      </Link>
    </div>
  );
}

/**
 * "Now processing" panel. Renders the generate-page jobs that are
 * actively running (with elapsed time) plus a short preview of the
 * next-up queue in priority order. The panel is the first thing the
 * user sees on the ingest page so a busy sync isn't a black box.
 */
function NowProcessingPanel({
  active,
  upNext,
}: {
  active: ActiveJob[];
  upNext: ActiveJob[];
}) {
  return (
    <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50/40 p-3 text-sm dark:border-rose-900/60 dark:bg-rose-950/20">
      {active.length > 0 ? (
        <>
          <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-rose-700 dark:text-rose-300">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Now processing · {active.length}
          </div>
          <ul className="space-y-1.5">
            {active.map((j) => (
              <ActiveJobRow key={j.id} job={j} live />
            ))}
          </ul>
        </>
      ) : (
        <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-ink-500">
          <Clock className="h-3.5 w-3.5" />
          Idle — nothing in flight
        </div>
      )}
      {upNext.length > 0 && (
        <>
          <div className="mt-3 mb-1 text-[10px] uppercase tracking-widest text-ink-500">
            Up next · {upNext.length}
          </div>
          <ul className="space-y-1">
            {upNext.slice(0, 5).map((j) => (
              <ActiveJobRow key={j.id} job={j} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ActiveJobRow({ job, live }: { job: ActiveJob; live?: boolean }) {
  const subject = job.subject || '(no subject)';
  const sender = job.fromName || job.from || 'unknown sender';
  const elapsed = live && job.processedOn
    ? Math.max(0, Math.floor((Date.now() - job.processedOn) / 1000))
    : null;
  const target = job.emailId ? `/e/${job.emailId}` : null;
  const inner = (
    <div className="flex items-center gap-2">
      <span
        className={
          'inline-flex h-1.5 w-1.5 shrink-0 rounded-full ' +
          (live ? 'animate-pulse bg-rose-500' : 'bg-ink-400')
        }
      />
      <span className="min-w-0 flex-1 truncate font-medium">{subject}</span>
      <span className="hidden truncate text-xs text-ink-500 sm:block">
        {sender}
      </span>
      {elapsed != null && (
        <span className="font-mono text-[10px] text-ink-500">
          {formatElapsed(elapsed)}
        </span>
      )}
    </div>
  );
  if (!target) {
    return <li className="rounded px-1 py-0.5">{inner}</li>;
  }
  return (
    <li>
      <Link
        to={target}
        className="block rounded px-1 py-0.5 hover:bg-rose-100/50 dark:hover:bg-rose-950/40"
      >
        {inner}
      </Link>
    </li>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}
