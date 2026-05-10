import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bug, Lightbulb, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';
import { ReportModal } from '../../components/ReportModal';

type Report = {
  _id: string;
  userId: string;
  kind: 'bug' | 'feature';
  title: string;
  body: string;
  route: string | null;
  userAgent: string | null;
  screen: { width?: number; height?: number; devicePixelRatio?: number } | null;
  locale: string | null;
  timezone: string | null;
  appVersion: string | null;
  status: 'open' | 'in-progress' | 'closed';
  adminNote: string;
  createdAt: string | null;
  updatedAt: string | null;
};

const STATUS_CLASS: Record<Report['status'], string> = {
  open: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  'in-progress':
    'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200',
  closed:
    'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
};

/**
 * Settings → Reports. Lists the user's own bug reports + feature
 * requests with status. Admin gets an additional "All users" tab
 * listing every user's reports plus an inline status / note editor
 * — same admin-aware tab pattern as Recipes / Rules.
 */
export default function ReportsSettings() {
  const api = useApi();
  const qc = useQueryClient();
  const { data: adminInfo } = useQuery({
    queryKey: ['admin-me'],
    queryFn: () => api.get<{ isAdmin: boolean }>('/api/admin/me'),
    staleTime: 60_000,
  });
  const isAdmin = adminInfo?.isAdmin ?? false;
  const [tab, setTab] = useState<'mine' | 'all'>('mine');
  const [createOpen, setCreateOpen] = useState(false);

  const queryKey = tab === 'all' ? ['reports', 'all'] : ['reports'];
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: () =>
      api.get<{ reports: Report[] }>(
        tab === 'all' ? '/api/reports?scope=all' : '/api/reports',
      ),
    enabled: tab === 'mine' || isAdmin,
    refetchInterval: 30_000,
  });

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: ['reports'] });
    qc.invalidateQueries({ queryKey: ['reports', 'all'] });
  }

  const remove = useMutation({
    mutationFn: async (id: string) => api.del<{ ok: true }>(`/api/reports/${id}`),
    onSuccess: () => {
      toast.success('Report deleted');
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reports = data?.reports ?? [];

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="mb-2 flex items-center gap-2">
          <Bug className="h-5 w-5 text-rose-500" />
          <h2 className="font-semibold">Reports</h2>
          <button
            type="button"
            className="ml-auto btn-primary text-xs"
            onClick={() => setCreateOpen(true)}
          >
            New report
          </button>
        </div>
        <p className="text-sm text-ink-500">
          Bugs and feature requests you've filed. The admin moves them
          through <strong>open → in&nbsp;progress → closed</strong> and
          can leave a follow-up note that shows up here.
        </p>
        {isAdmin && (
          <div className="mt-3 inline-flex rounded-md border border-ink-200 p-0.5 text-xs dark:border-ink-800">
            <button
              type="button"
              className={
                'rounded px-3 py-1 ' +
                (tab === 'mine'
                  ? 'bg-rose-500 text-white'
                  : 'text-ink-600 dark:text-ink-300')
              }
              onClick={() => setTab('mine')}
            >
              My reports
            </button>
            <button
              type="button"
              className={
                'rounded px-3 py-1 ' +
                (tab === 'all'
                  ? 'bg-rose-500 text-white'
                  : 'text-ink-600 dark:text-ink-300')
              }
              onClick={() => setTab('all')}
              title="Every user's reports"
            >
              All users (admin)
            </button>
          </div>
        )}
      </div>

      <div className="card">
        {isLoading ? (
          <div className="text-sm text-ink-500">Loading…</div>
        ) : reports.length === 0 ? (
          <div className="py-6 text-center text-sm text-ink-500">
            {tab === 'all'
              ? 'No reports across the deployment.'
              : "You haven't filed anything yet. Click New report to start."}
          </div>
        ) : (
          <ul className="space-y-3 text-sm">
            {reports.map((r) => (
              <ReportRow
                key={r._id}
                report={r}
                isAdmin={isAdmin}
                onDelete={() => remove.mutate(r._id)}
                onChanged={invalidateAll}
              />
            ))}
          </ul>
        )}
      </div>

      <ReportModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function ReportRow({
  report,
  isAdmin,
  onDelete,
  onChanged,
}: {
  report: Report;
  isAdmin: boolean;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(report.status);
  const [note, setNote] = useState(report.adminNote);

  const save = useMutation({
    mutationFn: async () =>
      api.patch<Report>(`/api/reports/${report._id}`, { status, adminNote: note }),
    onSuccess: () => {
      toast.success('Updated');
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const Icon = report.kind === 'bug' ? Bug : Lightbulb;
  return (
    <li className="rounded-lg border border-ink-200 px-3 py-2 dark:border-ink-800">
      <div className="flex items-start gap-3">
        <Icon className="mt-1 h-4 w-4 shrink-0 text-rose-500" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <button
              type="button"
              className="text-left font-medium hover:underline"
              onClick={() => setOpen((o) => !o)}
            >
              {report.title}
            </button>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${STATUS_CLASS[report.status]}`}
            >
              {report.status}
            </span>
            <span className="rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-ink-600 dark:bg-ink-800 dark:text-ink-300">
              {report.kind}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-ink-500">
            {report.createdAt &&
              new Date(report.createdAt).toLocaleString()}
            {report.route && (
              <>
                {' · '}
                <code>{report.route}</code>
              </>
            )}
          </div>
          {open && (
            <div className="mt-2 space-y-2">
              <pre className="whitespace-pre-wrap rounded bg-ink-50 p-2 text-[11px] dark:bg-ink-900/60">
                {report.body}
              </pre>
              {(report.userAgent || report.locale || report.appVersion) && (
                <details className="text-[11px] text-ink-500">
                  <summary className="cursor-pointer">Browser details</summary>
                  <ul className="mt-1 space-y-0.5">
                    {report.userAgent && (
                      <li>
                        <strong>UA:</strong>{' '}
                        <code className="break-all">{report.userAgent}</code>
                      </li>
                    )}
                    {report.screen && (
                      <li>
                        <strong>Viewport:</strong> {report.screen.width}×
                        {report.screen.height}
                        {report.screen.devicePixelRatio
                          ? ` @ ${report.screen.devicePixelRatio}x`
                          : ''}
                      </li>
                    )}
                    <li>
                      <strong>Locale / TZ:</strong> {report.locale ?? '—'} /{' '}
                      {report.timezone ?? '—'}
                    </li>
                    {report.appVersion && (
                      <li>
                        <strong>App version:</strong>{' '}
                        <code>{report.appVersion}</code>
                      </li>
                    )}
                  </ul>
                </details>
              )}
              {report.adminNote && (
                <div className="rounded border border-rose-200 bg-rose-50/50 p-2 text-[11px] dark:border-rose-900/60 dark:bg-rose-950/20">
                  <div className="mb-1 font-medium text-rose-700 dark:text-rose-300">
                    Admin note
                  </div>
                  {report.adminNote}
                </div>
              )}
              {isAdmin && (
                <div className="rounded border border-ink-200 p-2 dark:border-ink-800">
                  <div className="mb-1 text-[10px] font-medium uppercase tracking-widest text-ink-500">
                    Admin actions
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className="input text-xs"
                      value={status}
                      onChange={(e) =>
                        setStatus(e.target.value as Report['status'])
                      }
                    >
                      <option value="open">open</option>
                      <option value="in-progress">in-progress</option>
                      <option value="closed">closed</option>
                    </select>
                    <input
                      className="input flex-1 text-xs"
                      placeholder="Internal note (visible to reporter)"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      maxLength={2000}
                    />
                    <button
                      type="button"
                      className="btn-primary text-xs"
                      disabled={save.isPending}
                      onClick={() => save.mutate()}
                    >
                      Save
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          className="btn-ghost text-red-600"
          onClick={() => {
            if (confirm('Delete this report?')) onDelete();
          }}
          aria-label="Delete"
          title="Delete"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}
