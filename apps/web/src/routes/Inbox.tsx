import { useEffect, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Upload,
  FileText,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Flame,
  ShieldAlert,
  Megaphone,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { IngestionDrawer } from '../components/IngestionDrawer';

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

type UploadResult =
  | { kind: 'created'; emailId: string; jobId: string; filename: string }
  | { kind: 'duplicate'; emailId: string; filename: string }
  | { kind: 'failed'; filename: string; error: string };

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

export default function InboxPage() {
  const api = useApi();
  const { token } = useAuth();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [activeJob, setActiveJob] = useState<string | null>(null);

  useEffect(() => {
    if (params.get('upload') === '1') {
      setParams({}, { replace: true });
    }
  }, [params, setParams]);

  const { data, isLoading } = useQuery({
    queryKey: ['emails'],
    queryFn: () => api.get<{ emails: EmailRow[] }>('/api/emails?limit=100'),
    refetchInterval: 5000,
  });

  const { data: health } = useQuery({
    queryKey: ['jobs-health'],
    queryFn: () => api.get<Health>('/api/jobs/health/summary'),
    refetchInterval: 5000,
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      return api.post<{ results: UploadResult[] }>('/api/emails/upload', fd);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['emails'] });
      const created = r.results.find((x) => x.kind === 'created') as
        | { kind: 'created'; jobId: string }
        | undefined;
      if (created?.jobId) setActiveJob(created.jobId);
      const dup = r.results.filter((x) => x.kind === 'duplicate').length;
      const fail = r.results.filter((x) => x.kind === 'failed').length;
      toast.success(
        `${r.results.length} processed${dup ? `, ${dup} duplicate${dup > 1 ? 's' : ''}` : ''}${fail ? `, ${fail} failed` : ''}`,
      );
    },
    onError: (err: Error) => toast.error(err.message),
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

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { 'message/rfc822': ['.eml'], 'application/mbox': ['.mbox'] },
    onDrop: (files) => upload.mutate(files),
  });

  const stuckCount = data?.emails.filter((e) => e.ingestStatus === 'parsed').length ?? 0;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <span className="text-sm text-ink-500">{data?.emails.length ?? 0} emails</span>
      </div>

      {health && <HealthBanner health={health} stuckCount={stuckCount} onRetryAll={() => regenerateAll.mutate()} retryPending={regenerateAll.isPending} />}

      <div
        {...getRootProps()}
        className={`mb-6 cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
          isDragActive
            ? 'border-rose-500 bg-rose-50 dark:bg-rose-950/20'
            : 'border-ink-300 dark:border-ink-700'
        }`}
      >
        <input {...getInputProps()} />
        <Upload className="mx-auto mb-2 h-8 w-8 text-ink-400" />
        <p className="text-sm font-medium">
          {isDragActive ? 'Drop to ingest' : 'Drop .eml files or click to upload'}
        </p>
        <p className="text-xs text-ink-500">Each email becomes a wiki draft via Ollama.</p>
      </div>

      {isLoading ? (
        <div className="text-ink-500">Loading…</div>
      ) : (data?.emails.length ?? 0) === 0 ? (
        <div className="card text-center text-ink-500">No emails yet. Upload one above.</div>
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
    </div>
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
