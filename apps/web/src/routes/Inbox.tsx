import { useEffect, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Upload, FileText } from 'lucide-react';
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
  createdAt: string;
};

type UploadResult =
  | { kind: 'created'; emailId: string; jobId: string; filename: string }
  | { kind: 'duplicate'; emailId: string; filename: string }
  | { kind: 'failed'; filename: string; error: string };

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

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { 'message/rfc822': ['.eml'], 'application/mbox': ['.mbox'] },
    onDrop: (files) => upload.mutate(files),
  });

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <span className="text-sm text-ink-500">{data?.emails.length ?? 0} emails</span>
      </div>

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
              <span className={statusClass(e.ingestStatus)}>{e.ingestStatus}</span>
              {e.pageSlug && (
                <Link to={`/p/${e.pageSlug}`} className="btn-ghost text-xs">
                  View page
                </Link>
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

function statusClass(s: string): string {
  const base = 'pill text-xs';
  if (s === 'generated') return base + ' !bg-emerald-100 !text-emerald-800 dark:!bg-emerald-900/30 dark:!text-emerald-300';
  if (s === 'failed') return base + ' !bg-red-100 !text-red-800 dark:!bg-red-900/30 dark:!text-red-300';
  if (s === 'parsed') return base + ' !bg-amber-100 !text-amber-800 dark:!bg-amber-900/30 dark:!text-amber-300';
  return base;
}

