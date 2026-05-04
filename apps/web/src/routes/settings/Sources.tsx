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
  Clock,
  Rss,
  Hash,
  MessageCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';

type Source = {
  _id: string;
  type: 'imap' | 'webhook' | 'gmail' | 'upload' | 'rss' | 'slack' | 'discord' | 'gcal';
  name: string;
  status: string;
  pollIntervalMinutes?: number;
  lastSyncAt?: string;
  lastError?: string | null;
  rssFeedUrl?: string | null;
  rssFeedTitle?: string | null;
};

type RssConfig = {
  url: string;
  pollIntervalMinutes?: number;
  historicalBackfillDays: number;
  maxPerSync: number;
};

type RssFormValues = {
  name: string;
  url: string;
  pollIntervalMinutes: number;
  historicalBackfillDays: number;
  maxPerSync: number;
};

const DEFAULT_RSS: RssFormValues = {
  name: '',
  url: '',
  pollIntervalMinutes: 30,
  historicalBackfillDays: 14,
  maxPerSync: 100,
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

type SourceWithConfig = Source & { config: ImapConfig | RssConfig | null };

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
    | { kind: 'create-rss' }
    | { kind: 'edit-rss'; id: string }
    | { kind: 'create-slack' }
    | { kind: 'create-discord' }
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

  const setIntervalMut = useMutation({
    mutationFn: async ({ id, minutes }: { id: string; minutes: number }) =>
      api.patch<Source>(`/api/sources/${id}`, { pollIntervalMinutes: minutes }),
    onSuccess: (_data, vars) => {
      toast.success(`Polling every ${vars.minutes} minute${vars.minutes === 1 ? '' : 's'}`);
      qc.invalidateQueries({ queryKey: ['sources'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function promptForInterval(s: Source) {
    const current = s.pollIntervalMinutes ?? 5;
    const raw = window.prompt(
      `Polling interval for "${s.name}" (in minutes, 1–1440):`,
      String(current),
    );
    if (raw === null) return;
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1 || n > 1440) {
      toast.error('Enter a whole number between 1 and 1440');
      return;
    }
    if (n === current) return;
    setIntervalMut.mutate({ id: s._id, minutes: n });
  }

  return (
    <div className="space-y-6">
      <RssGlobalDefaults />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <button className="btn-secondary" onClick={() => setForm({ kind: 'create-imap' })}>
          <Mail className="h-4 w-4" /> Connect IMAP
        </button>
        <button className="btn-secondary" onClick={() => setForm({ kind: 'create-rss' })}>
          <Rss className="h-4 w-4" /> Add RSS feed
        </button>
        <button className="btn-secondary" onClick={() => setForm({ kind: 'create-slack' })}>
          <Hash className="h-4 w-4" /> Connect Slack
        </button>
        <button className="btn-secondary" onClick={() => setForm({ kind: 'create-discord' })}>
          <MessageCircle className="h-4 w-4" /> Connect Discord
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
      {form?.kind === 'create-rss' && (
        <RssForm
          mode="create"
          initial={DEFAULT_RSS}
          onCancel={() => setForm(null)}
          onSubmit={(values) => {
            const { name, ...config } = values;
            create.mutate({ type: 'rss', name, config });
          }}
        />
      )}
      {form?.kind === 'edit-rss' && (
        <EditRssForm
          id={form.id}
          onCancel={() => setForm(null)}
          onSubmit={(values) => {
            const { name, ...rssConfig } = values;
            update.mutate({ id: form.id, body: { name, rssConfig } });
          }}
        />
      )}
      {form?.kind === 'create-slack' && (
        <SlackForm
          onCancel={() => setForm(null)}
          onSubmit={(body) => create.mutate(body)}
        />
      )}
      {form?.kind === 'create-discord' && (
        <DiscordForm
          onCancel={() => setForm(null)}
          onSubmit={(body) => create.mutate(body)}
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
                  {s.type === 'rss' && s.rssFeedUrl && (
                    <div className="truncate text-xs text-ink-500">
                      <a
                        href={s.rssFeedUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {s.rssFeedUrl}
                      </a>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-x-2 text-xs text-ink-500">
                    <span>{s.status}</span>
                    <span>·</span>
                    <span>
                      last sync{' '}
                      {s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString() : 'never'}
                    </span>
                    {(s.type === 'imap' || s.type === 'gmail' || s.type === 'rss') && (
                      <>
                        <span>·</span>
                        <button
                          type="button"
                          onClick={() => promptForInterval(s)}
                          disabled={setIntervalMut.isPending}
                          className="inline-flex items-center gap-1 rounded bg-ink-100 px-1.5 py-0.5 font-medium text-ink-700 hover:bg-ink-200 disabled:opacity-50 dark:bg-ink-800 dark:text-ink-200 dark:hover:bg-ink-700"
                          title="Click to change polling interval"
                        >
                          <Clock className="h-3 w-3" />
                          every {s.pollIntervalMinutes ?? 5} min
                        </button>
                      </>
                    )}
                    {s.lastError && (
                      <>
                        <span>·</span>
                        <span className="text-red-600">error: {s.lastError}</span>
                      </>
                    )}
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
                  {s.type === 'rss' && (
                    <button
                      className="btn-ghost"
                      onClick={() => setForm({ kind: 'edit-rss', id: s._id })}
                      aria-label="Edit"
                      title="Edit"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                  )}
                  {(s.type === 'imap' || s.type === 'gmail' || s.type === 'rss') && (
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
  const cfg = data.config as ImapConfig | null;
  if (!cfg || !('host' in cfg)) {
    return <div className="card text-sm text-ink-500">This source isn’t editable here.</div>;
  }
  const initial: ImapFormValues = {
    name: data.name,
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    username: cfg.username,
    password: '',
    mailbox: cfg.mailbox,
    pollIntervalMinutes: cfg.pollIntervalMinutes,
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

      {/^imap\.(gmail|googlemail)\.com$/i.test(values.host) && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-100">
          <p className="font-medium">Gmail setup</p>
          <ol className="mt-1 list-decimal pl-4 text-[11px] leading-5">
            <li>
              Enable 2-Step Verification on your Google account if you haven't already.
            </li>
            <li>
              Generate an App Password at{' '}
              <a
                href="https://myaccount.google.com/apppasswords"
                target="_blank"
                rel="noreferrer"
                className="font-medium underline hover:no-underline"
              >
                myaccount.google.com/apppasswords
              </a>
              . Use that 16-character value below — your normal Google password
              will be rejected.
            </li>
            <li>
              Confirm IMAP is enabled in Gmail → Settings → Forwarding and POP/IMAP.
            </li>
          </ol>
        </div>
      )}

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
          hint={
            <>
              For Gmail this must be an{' '}
              <a
                href="https://myaccount.google.com/apppasswords"
                target="_blank"
                rel="noreferrer"
                className="text-rose-600 underline hover:text-rose-700"
              >
                App Password
              </a>
              {' '}— your normal account password will fail.
            </>
          }
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
  hint?: React.ReactNode;
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

function RssGlobalDefaults() {
  const api = useApi();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['me'],
    queryFn: () =>
      api.get<{ settings?: { rssPollIntervalMinutes?: number } }>('/api/me'),
  });
  const current = data?.settings?.rssPollIntervalMinutes ?? 30;
  const [value, setValue] = useState<number>(current);
  useEffect(() => {
    setValue(current);
  }, [current]);
  const save = useMutation({
    mutationFn: async (minutes: number) =>
      api.patch<unknown>('/api/me', {
        settings: { ...(data?.settings ?? {}), rssPollIntervalMinutes: minutes },
      }),
    onSuccess: () => {
      toast.success('Default RSS poll interval saved');
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
  return (
    <div className="card flex flex-wrap items-end gap-3">
      <div className="flex items-center gap-2 text-sm text-ink-700 dark:text-ink-200">
        <Rss className="h-4 w-4 text-rose-500" />
        <span className="font-medium">Default RSS poll interval</span>
      </div>
      <Field label="Minutes" hint="Applies to new feeds. Per-feed overrides win.">
        <input
          className="input w-32"
          type="number"
          min={5}
          max={1440}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
        />
      </Field>
      <button
        className="btn-secondary"
        onClick={() => save.mutate(value)}
        disabled={save.isPending || value === current}
      >
        Save
      </button>
    </div>
  );
}

function EditRssForm({
  id,
  onCancel,
  onSubmit,
}: {
  id: string;
  onCancel: () => void;
  onSubmit: (values: RssFormValues) => void;
}) {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['source', id],
    queryFn: () => api.get<SourceWithConfig>(`/api/sources/${id}`),
  });
  if (isLoading || !data) {
    return <div className="card text-sm text-ink-500">Loading feed…</div>;
  }
  const cfg = data.config as RssConfig | null;
  if (!cfg || !('url' in cfg)) {
    return <div className="card text-sm text-ink-500">This source isn’t editable here.</div>;
  }
  const initial: RssFormValues = {
    name: data.name,
    url: cfg.url,
    pollIntervalMinutes: cfg.pollIntervalMinutes ?? 30,
    historicalBackfillDays: cfg.historicalBackfillDays,
    maxPerSync: cfg.maxPerSync,
  };
  return <RssForm mode="edit" initial={initial} onCancel={onCancel} onSubmit={onSubmit} />;
}

function RssForm({
  mode,
  initial,
  onCancel,
  onSubmit,
}: {
  mode: 'create' | 'edit';
  initial: RssFormValues;
  onCancel: () => void;
  onSubmit: (values: RssFormValues) => void;
}) {
  const api = useApi();
  const [values, setValues] = useState<RssFormValues>(initial);
  const [testResult, setTestResult] = useState<
    | { state: 'idle' }
    | { state: 'pending' }
    | { state: 'ok'; feedTitle: string; sampleItems: { title: string; link: string | null }[] }
    | { state: 'fail'; message: string }
  >({ state: 'idle' });

  useEffect(() => {
    setValues(initial);
    setTestResult({ state: 'idle' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.url, mode]);

  function set<K extends keyof RssFormValues>(key: K, val: RssFormValues[K]) {
    setValues((v) => ({ ...v, [key]: val }));
  }

  async function runTest() {
    if (!values.url) {
      toast.error('Enter a feed URL first');
      return;
    }
    setTestResult({ state: 'pending' });
    try {
      const result = await api.post<
        | { ok: true; feedTitle: string; sampleItems: { title: string; link: string | null }[] }
        | { ok: false; message: string }
      >('/api/sources/test', { type: 'rss', config: { url: values.url } });
      if (result.ok) {
        setTestResult({
          state: 'ok',
          feedTitle: result.feedTitle,
          sampleItems: result.sampleItems,
        });
        toast.success(`Connected to "${result.feedTitle}"`);
        if (mode === 'create' && !values.name) {
          set('name', result.feedTitle);
        }
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
        if (!values.name) {
          toast.error('Give the feed a display name');
          return;
        }
        onSubmit(values);
      }}
    >
      <h3 className="font-semibold">
        {mode === 'create' ? 'Add an RSS or Atom feed' : `Edit "${initial.name}"`}
      </h3>
      <p className="text-xs text-ink-500">
        Feed entries become wiki pages grouped by topic. The LLM derives
        tags from each item, and matching topics roll up into the same page.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Feed URL" hint="The RSS or Atom URL.">
          <input
            className="input"
            value={values.url}
            onChange={(e) => set('url', e.target.value)}
            placeholder="https://example.com/feed.xml"
            required
          />
        </Field>
        <Field label="Display name" hint="Shown in the sources list.">
          <input
            className="input"
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
            required
          />
        </Field>
        <Field label="Poll interval (minutes)" hint="Minimum 5. Default 30.">
          <input
            className="input"
            type="number"
            min={5}
            max={1440}
            value={values.pollIntervalMinutes}
            onChange={(e) => set('pollIntervalMinutes', Number(e.target.value))}
            required
          />
        </Field>
        <Field
          label="Backfill days"
          hint="On first sync, ingest items posted within this many days."
        >
          <input
            className="input"
            type="number"
            min={1}
            max={365}
            value={values.historicalBackfillDays}
            onChange={(e) => set('historicalBackfillDays', Number(e.target.value))}
            required
          />
        </Field>
        <Field label="Max items per sync" hint="Upper bound on a single fetch.">
          <input
            className="input"
            type="number"
            min={1}
            max={500}
            value={values.maxPerSync}
            onChange={(e) => set('maxPerSync', Number(e.target.value))}
            required
          />
        </Field>
      </div>

      {testResult.state === 'ok' && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-medium">{testResult.feedTitle}</div>
              <ul className="mt-1 list-disc pl-4 text-xs">
                {testResult.sampleItems.map((it, i) => (
                  <li key={i} className="truncate">
                    {it.title}
                  </li>
                ))}
              </ul>
            </div>
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
          Test feed
        </button>
        <button type="submit" className="btn-primary">
          {mode === 'create' ? 'Add feed' : 'Save changes'}
        </button>
      </div>
    </form>
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

type ChannelOpt = { id: string; name: string; isPrivate?: boolean };

function SlackForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (body: unknown) => void;
}) {
  const api = useApi();
  const [name, setName] = useState('My workspace');
  const [token, setToken] = useState('');
  const [pollMin, setPollMin] = useState(60);
  const [cadence, setCadence] = useState<'daily' | 'weekly'>('daily');
  const [tested, setTested] = useState<
    | { state: 'idle' }
    | { state: 'pending' }
    | { state: 'ok'; workspaceName: string; channels: ChannelOpt[] }
    | { state: 'fail'; message: string }
  >({ state: 'idle' });
  const [picked, setPicked] = useState<Set<string>>(new Set());

  async function runTest() {
    if (!token.trim()) {
      toast.error('Paste a Slack token first');
      return;
    }
    setTested({ state: 'pending' });
    try {
      const r = await api.post<
        | { ok: true; workspaceName: string; channels: ChannelOpt[] }
        | { ok: false; message: string }
      >('/api/sources/test', { type: 'slack', config: { token: token.trim() } });
      if (r.ok) {
        setTested({ state: 'ok', workspaceName: r.workspaceName, channels: r.channels });
        if (!name || name === 'My workspace') setName(`Slack · ${r.workspaceName}`);
      } else {
        setTested({ state: 'fail', message: r.message });
        toast.error(r.message);
      }
    } catch (err) {
      const msg = (err as Error).message;
      setTested({ state: 'fail', message: msg });
      toast.error(msg);
    }
  }

  return (
    <form
      className="card space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (picked.size === 0) {
          toast.error('Pick at least one channel');
          return;
        }
        onSubmit({
          type: 'slack',
          name,
          config: {
            token: token.trim(),
            workspaceId: tested.state === 'ok' ? tested.workspaceName : undefined,
            watchedChannels: [...picked],
            cadence,
            pollIntervalMinutes: pollMin,
          },
        });
      }}
    >
      <h3 className="font-semibold">Connect a Slack workspace</h3>
      <p className="text-xs text-ink-500">
        Create a Slack app at{' '}
        <a
          href="https://api.slack.com/apps"
          target="_blank"
          rel="noreferrer"
          className="text-rose-600 hover:underline dark:text-rose-300"
        >
          api.slack.com/apps
        </a>{' '}
        with the read scopes <code>channels:history</code>,{' '}
        <code>groups:history</code>, <code>conversations.list</code>,{' '}
        <code>users:read</code>. Install it to your workspace, then paste the
        Bot User OAuth Token below.
      </p>

      <Field label="Display name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </Field>
      <Field label="Workspace token (xoxb-… or xoxp-…)">
        <input
          className="input"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="xoxb-…"
          autoComplete="off"
          required
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Poll interval (minutes)">
          <input
            className="input"
            type="number"
            min={15}
            max={1440}
            value={pollMin}
            onChange={(e) => setPollMin(Number(e.target.value))}
          />
        </Field>
        <Field label="Cadence">
          <select
            className="input"
            value={cadence}
            onChange={(e) => setCadence(e.target.value as 'daily' | 'weekly')}
          >
            <option value="daily">Daily digest per channel</option>
            <option value="weekly">Weekly digest per channel</option>
          </select>
        </Field>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={runTest}
          disabled={tested.state === 'pending'}
        >
          <PlugZap className={`h-3.5 w-3.5 ${tested.state === 'pending' ? 'animate-pulse' : ''}`} />
          Test + list channels
        </button>
        {tested.state === 'ok' && (
          <span className="text-[11px] uppercase tracking-widest text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="mr-1 inline-block h-3 w-3" /> {tested.workspaceName}
          </span>
        )}
        {tested.state === 'fail' && (
          <span className="text-[11px] text-red-600">
            <XCircle className="mr-1 inline-block h-3 w-3" /> {tested.message}
          </span>
        )}
      </div>

      {tested.state === 'ok' && (
        <fieldset className="rounded-lg border border-ink-200 p-3 dark:border-ink-800">
          <legend className="px-1 text-[10px] uppercase tracking-widest text-ink-500">
            Channels to digest ({tested.channels.length})
          </legend>
          <ul className="grid max-h-72 gap-1 overflow-y-auto sm:grid-cols-2">
            {tested.channels.map((c) => (
              <li key={c.id}>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={picked.has(c.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(c.id);
                      else next.delete(c.id);
                      setPicked(next);
                    }}
                  />
                  <span className="truncate">
                    #{c.name} {c.isPrivate && <span className="text-ink-400">(private)</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      <div className="flex justify-end gap-2 text-xs">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn-primary"
          disabled={tested.state !== 'ok' || picked.size === 0}
        >
          Connect
        </button>
      </div>
    </form>
  );
}

function DiscordForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (body: unknown) => void;
}) {
  const api = useApi();
  const [name, setName] = useState('My server');
  const [botToken, setBotToken] = useState('');
  const [guildId, setGuildId] = useState('');
  const [pollMin, setPollMin] = useState(60);
  const [cadence, setCadence] = useState<'daily' | 'weekly'>('daily');
  const [tested, setTested] = useState<
    | { state: 'idle' }
    | { state: 'pending' }
    | { state: 'ok'; workspaceName: string; channels: ChannelOpt[] }
    | { state: 'fail'; message: string }
  >({ state: 'idle' });
  const [picked, setPicked] = useState<Set<string>>(new Set());

  async function runTest() {
    if (!botToken.trim() || !guildId.trim()) {
      toast.error('Bot token + guild ID required');
      return;
    }
    setTested({ state: 'pending' });
    try {
      const r = await api.post<
        | { ok: true; workspaceName: string; channels: ChannelOpt[] }
        | { ok: false; message: string }
      >('/api/sources/test', {
        type: 'discord',
        config: { botToken: botToken.trim(), guildId: guildId.trim() },
      });
      if (r.ok) {
        setTested({ state: 'ok', workspaceName: r.workspaceName, channels: r.channels });
        if (!name || name === 'My server') setName(`Discord · ${r.workspaceName}`);
      } else {
        setTested({ state: 'fail', message: r.message });
        toast.error(r.message);
      }
    } catch (err) {
      const msg = (err as Error).message;
      setTested({ state: 'fail', message: msg });
      toast.error(msg);
    }
  }

  return (
    <form
      className="card space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (picked.size === 0) {
          toast.error('Pick at least one channel');
          return;
        }
        onSubmit({
          type: 'discord',
          name,
          config: {
            botToken: botToken.trim(),
            guildId: guildId.trim(),
            watchedChannels: [...picked],
            cadence,
            pollIntervalMinutes: pollMin,
          },
        });
      }}
    >
      <h3 className="font-semibold">Connect a Discord server</h3>
      <p className="text-xs text-ink-500">
        Create a Discord application at{' '}
        <a
          href="https://discord.com/developers/applications"
          target="_blank"
          rel="noreferrer"
          className="text-rose-600 hover:underline dark:text-rose-300"
        >
          discord.com/developers/applications
        </a>
        , add a bot, enable the <strong>Message Content Intent</strong>, and
        invite it to your server with <code>View Channels</code> +{' '}
        <code>Read Message History</code> permissions.
      </p>

      <Field label="Display name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bot token">
          <input
            className="input"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder="MTI…"
            autoComplete="off"
            required
          />
        </Field>
        <Field label="Guild (server) ID">
          <input
            className="input"
            value={guildId}
            onChange={(e) => setGuildId(e.target.value)}
            placeholder="123456789012345678"
            required
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Poll interval (minutes)">
          <input
            className="input"
            type="number"
            min={15}
            max={1440}
            value={pollMin}
            onChange={(e) => setPollMin(Number(e.target.value))}
          />
        </Field>
        <Field label="Cadence">
          <select
            className="input"
            value={cadence}
            onChange={(e) => setCadence(e.target.value as 'daily' | 'weekly')}
          >
            <option value="daily">Daily digest per channel</option>
            <option value="weekly">Weekly digest per channel</option>
          </select>
        </Field>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={runTest}
          disabled={tested.state === 'pending'}
        >
          <PlugZap className={`h-3.5 w-3.5 ${tested.state === 'pending' ? 'animate-pulse' : ''}`} />
          Test + list channels
        </button>
        {tested.state === 'ok' && (
          <span className="text-[11px] uppercase tracking-widest text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="mr-1 inline-block h-3 w-3" /> {tested.workspaceName}
          </span>
        )}
        {tested.state === 'fail' && (
          <span className="text-[11px] text-red-600">
            <XCircle className="mr-1 inline-block h-3 w-3" /> {tested.message}
          </span>
        )}
      </div>

      {tested.state === 'ok' && (
        <fieldset className="rounded-lg border border-ink-200 p-3 dark:border-ink-800">
          <legend className="px-1 text-[10px] uppercase tracking-widest text-ink-500">
            Channels to digest ({tested.channels.length})
          </legend>
          <ul className="grid max-h-72 gap-1 overflow-y-auto sm:grid-cols-2">
            {tested.channels.map((c) => (
              <li key={c.id}>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={picked.has(c.id)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(c.id);
                      else next.delete(c.id);
                      setPicked(next);
                    }}
                  />
                  <span className="truncate">#{c.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      <div className="flex justify-end gap-2 text-xs">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn-primary"
          disabled={tested.state !== 'ok' || picked.size === 0}
        >
          Connect
        </button>
      </div>
    </form>
  );
}
