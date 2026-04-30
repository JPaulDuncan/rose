import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Trash2,
  Mail,
  Webhook,
  Inbox,
  RefreshCw,
  Pencil,
  PlugZap,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';

type Source = {
  _id: string;
  type: 'imap' | 'webhook' | 'gmail' | 'upload';
  name: string;
  status: string;
  lastSyncAt?: string;
  lastError?: string | null;
};

type ImapConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  mailbox: string;
  pollIntervalMinutes: number;
};

type SourceWithConfig = Source & { config: ImapConfig | null };

type ImapFormValues = ImapConfig & { name: string };

const DEFAULT_IMAP: ImapFormValues = {
  name: 'My mailbox',
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  username: '',
  password: '',
  mailbox: 'INBOX',
  pollIntervalMinutes: 5,
};

export default function SourcesSettings() {
  const api = useApi();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api.get<{ sources: Source[] }>('/api/sources'),
  });

  const [form, setForm] = useState<
    | { kind: 'create-imap' }
    | { kind: 'edit-imap'; id: string }
    | { kind: 'webhook' }
    | null
  >(null);

  const create = useMutation({
    mutationFn: async (body: unknown) => api.post<unknown>('/api/sources', body),
    onSuccess: (resp) => {
      toast.success('Source created');
      qc.invalidateQueries({ queryKey: ['sources'] });
      setForm(null);
      const tok = (resp as { token?: string })?.token;
      if (tok) {
        navigator.clipboard.writeText(tok).catch(() => null);
        toast.success(`Token copied: ${tok.slice(0, 12)}…`);
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const update = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: unknown }) =>
      api.patch<Source>(`/api/sources/${id}`, body),
    onSuccess: () => {
      toast.success('Source updated');
      qc.invalidateQueries({ queryKey: ['sources'] });
      setForm(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => api.del<{ ok: true }>(`/api/sources/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sources'] }),
  });

  const syncNow = useMutation({
    mutationFn: async (id: string) =>
      api.post<{ jobId: string }>(`/api/sources/${id}/sync`),
    onSuccess: () => {
      toast.success('Sync queued — new mail will appear in the inbox shortly');
      qc.invalidateQueries({ queryKey: ['sources'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-2">
        <button className="btn-secondary" onClick={() => setForm({ kind: 'create-imap' })}>
          <Mail className="h-4 w-4" /> Connect IMAP
        </button>
        <button className="btn-secondary" onClick={() => setForm({ kind: 'webhook' })}>
          <Webhook className="h-4 w-4" /> Add Webhook
        </button>
        <button
          className="btn-secondary"
          onClick={() => toast('Set GOOGLE_CLIENT_ID/SECRET, then visit /api/auth/gmail/start')}
        >
          <Inbox className="h-4 w-4" /> Gmail OAuth
        </button>
      </div>

      {form?.kind === 'create-imap' && (
        <ImapForm
          mode="create"
          initial={DEFAULT_IMAP}
          onCancel={() => setForm(null)}
          onSubmit={(values) => {
            const { name, ...config } = values;
            create.mutate({ type: 'imap', name, config });
          }}
        />
      )}
      {form?.kind === 'edit-imap' && (
        <EditImapForm
          id={form.id}
          onCancel={() => setForm(null)}
          onSubmit={(values, isPasswordChanged) => {
            const { name, password, ...rest } = values;
            const config: Partial<ImapConfig> = { ...rest };
            if (isPasswordChanged && password) config.password = password;
            update.mutate({ id: form.id, body: { name, config } });
          }}
        />
      )}
      {form?.kind === 'webhook' && (
        <WebhookForm
          onCancel={() => setForm(null)}
          onSubmit={(b) => create.mutate(b)}
        />
      )}

      <div className="card">
        <h2 className="mb-3 font-semibold">Connected sources</h2>
        {!data?.sources.length ? (
          <div className="text-sm text-ink-500">No sources yet.</div>
        ) : (
          <ul className="space-y-2 text-sm">
            {data.sources.map((s) => (
              <li
                key={s._id}
                className="flex items-center justify-between rounded-lg border border-ink-200 px-3 py-2 dark:border-ink-800"
              >
                <div>
                  <div className="font-medium">
                    {s.name} <span className="text-xs text-ink-500">({s.type})</span>
                  </div>
                  <div className="text-xs text-ink-500">
                    {s.status} · last sync{' '}
                    {s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : 'never'}
                    {s.lastError ? ` · error: ${s.lastError}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {s.type === 'imap' && (
                    <button
                      className="btn-ghost"
                      onClick={() => setForm({ kind: 'edit-imap', id: s._id })}
                      aria-label="Edit"
                      title="Edit"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                  {(s.type === 'imap' || s.type === 'gmail') && (
                    <button
                      className="btn-ghost"
                      onClick={() => syncNow.mutate(s._id)}
                      disabled={syncNow.isPending}
                      aria-label="Sync now"
                      title="Sync now"
                    >
                      <RefreshCw
                        className={`h-4 w-4 ${syncNow.isPending ? 'animate-spin' : ''}`}
                      />
                    </button>
                  )}
                  <button
                    className="btn-ghost text-red-600"
                    onClick={() => {
                      if (confirm(`Remove "${s.name}"? Stored credentials are deleted.`))
                        remove.mutate(s._id);
                    }}
                    aria-label="Remove"
                    title="Remove"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Wraps ImapForm to fetch the current source config and prefill it. */
function EditImapForm({
  id,
  onCancel,
  onSubmit,
}: {
  id: string;
  onCancel: () => void;
  onSubmit: (values: ImapFormValues, isPasswordChanged: boolean) => void;
}) {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['source', id],
    queryFn: () => api.get<SourceWithConfig>(`/api/sources/${id}`),
  });
  if (isLoading || !data) {
    return <div className="card text-sm text-ink-500">Loading source…</div>;
  }
  if (!data.config) {
    return <div className="card text-sm text-ink-500">This source isn’t editable here.</div>;
  }
  const initial: ImapFormValues = {
    name: data.name,
    host: data.config.host,
    port: data.config.port,
    secure: data.config.secure,
    username: data.config.username,
    password: '',
    mailbox: data.config.mailbox,
    pollIntervalMinutes: data.config.pollIntervalMinutes,
  };
  return (
    <ImapForm
      mode="edit"
      initial={initial}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  );
}

function ImapForm({
  mode,
  initial,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initial: ImapFormValues;
  onCancel: () => void;
  onSubmit: (values: ImapFormValues, isPasswordChanged: boolean) => void;
}) {
  const api = useApi();
  const [values, setValues] = useState<ImapFormValues>(initial);
  const [pwTouched, setPwTouched] = useState(false);
  const [testResult, setTestResult] = useState<
    | { state: 'idle' }
    | { state: 'pending' }
    | { state: 'ok'; mailboxes: string[] }
    | { state: 'fail'; message: string }
  >({ state: 'idle' });

  // Reset state when switching between sources
  useEffect(() => {
    setValues(initial);
    setPwTouched(false);
    setTestResult({ state: 'idle' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.username, initial.host, mode]);

  function set<K extends keyof ImapFormValues>(key: K, val: ImapFormValues[K]) {
    setValues((v) => ({ ...v, [key]: val }));
  }

  async function runTest() {
    if (mode === 'edit' && !pwTouched) {
      toast.error('Re-enter the password to test the connection.');
      return;
    }
    setTestResult({ state: 'pending' });
    try {
      const { name: _name, ...config } = values;
      const result = await api.post<
        | { ok: true; mailboxes: string[] }
        | { ok: false; message: string }
      >('/api/sources/test', { type: 'imap', config });
      if (result.ok) {
        setTestResult({ state: 'ok', mailboxes: result.mailboxes });
        toast.success(`Connected — ${result.mailboxes.length} mailbox(es) visible`);
      } else {
        setTestResult({ state: 'fail', message: result.message });
        toast.error(result.message);
      }
    } catch (err) {
      const msg = (err as Error).message;
      setTestResult({ state: 'fail', message: msg });
      toast.error(msg);
    }
  }

  return (
    <form
      className="card space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(values, pwTouched);
      }}
    >
      <h3 className="font-semibold">
        {mode === 'create' ? 'Connect a mailbox via IMAP' : `Edit "${initial.name}"`}
      </h3>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Display name" hint="Shown in the sidebar and inbox.">
          <input
            className="input"
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
            required
          />
        </Field>
        <Field label="Mailbox" hint='Folder to poll, usually "INBOX".'>
          <input
            className="input"
            value={values.mailbox}
            onChange={(e) => set('mailbox', e.target.value)}
            required
          />
        </Field>
        <Field label="IMAP host" hint="e.g. imap.gmail.com">
          <input
            className="input"
            value={values.host}
            onChange={(e) => set('host', e.target.value)}
            required
          />
        </Field>
        <Field label="Port" hint="993 for IMAPS, 143 for plaintext+STARTTLS.">
          <input
            className="input"
            type="number"
            min={1}
            max={65535}
            value={values.port}
            onChange={(e) => set('port', Number(e.target.value))}
            required
          />
        </Field>
        <Field label="Username" hint="Usually your full email address.">
          <input
            className="input"
            autoComplete="username"
            value={values.username}
            onChange={(e) => set('username', e.target.value)}
            required
          />
        </Field>
        <Field
          label={mode === 'edit' ? 'Password (leave blank to keep)' : 'Password / app password'}
          hint="For Gmail this is an app password, not your account password."
        >
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={values.password}
            onChange={(e) => {
              set('password', e.target.value);
              setPwTouched(true);
            }}
            required={mode === 'create'}
          />
        </Field>
        <Field label="Use TLS" hint="Required by all major providers.">
          <label className="flex h-[38px] items-center gap-2 rounded-lg border border-ink-200 px-3 dark:border-ink-700">
            <input
              type="checkbox"
              checked={values.secure}
              onChange={(e) => set('secure', e.target.checked)}
            />
            <span className="text-sm">Encrypted (IMAPS)</span>
          </label>
        </Field>
        <Field label="Poll interval (minutes)" hint="How often Rose checks for new mail.">
          <input
            className="input"
            type="number"
            min={1}
            max={1440}
            value={values.pollIntervalMinutes}
            onChange={(e) => set('pollIntervalMinutes', Number(e.target.value))}
            required
          />
        </Field>
      </div>

      {testResult.state === 'ok' && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            Connection succeeded. Visible folders:{' '}
            <span className="font-mono text-xs">
              {testResult.mailboxes.slice(0, 6).join(', ')}
              {testResult.mailboxes.length > 6 ? ', …' : ''}
            </span>
          </div>
        </div>
      )}
      {testResult.state === 'fail' && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>{testResult.message}</div>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={runTest}
          disabled={testResult.state === 'pending'}
        >
          <PlugZap
            className={`h-4 w-4 ${testResult.state === 'pending' ? 'animate-pulse' : ''}`}
          />
          Test connection
        </button>
        <button type="submit" className="btn-primary">
          {mode === 'create' ? 'Connect' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-ink-700 dark:text-ink-200">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}
    </label>
  );
}

function WebhookForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (b: unknown) => void;
}) {
  const [name, setName] = useState('Forwarding webhook');
  return (
    <form
      className="card flex items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ type: 'webhook', name });
      }}
    >
      <Field label="Name" hint="Helps you remember what this webhook is for.">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </Field>
      <button type="button" className="btn-ghost" onClick={onCancel}>
        Cancel
      </button>
      <button type="submit" className="btn-primary">
        Create token
      </button>
    </form>
  );
}
