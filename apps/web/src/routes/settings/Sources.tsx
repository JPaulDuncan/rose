import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, Mail, Webhook, Inbox } from 'lucide-react';
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

export default function SourcesSettings() {
  const api = useApi();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['sources'],
    queryFn: () => api.get<{ sources: Source[] }>('/api/sources'),
  });

  const [form, setForm] = useState<'imap' | 'webhook' | null>(null);

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

  const remove = useMutation({
    mutationFn: async (id: string) => api.del<{ ok: true }>(`/api/sources/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sources'] });
    },
  });

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-2">
        <button className="btn-secondary" onClick={() => setForm('imap')}>
          <Mail className="h-4 w-4" /> Connect IMAP
        </button>
        <button className="btn-secondary" onClick={() => setForm('webhook')}>
          <Webhook className="h-4 w-4" /> Add Webhook
        </button>
        <button
          className="btn-secondary"
          onClick={() => toast('Set GOOGLE_CLIENT_ID/SECRET, then visit /api/auth/gmail/start')}
        >
          <Inbox className="h-4 w-4" /> Gmail OAuth
        </button>
      </div>

      {form === 'imap' && <ImapForm onSubmit={(b) => create.mutate(b)} />}
      {form === 'webhook' && <WebhookForm onSubmit={(b) => create.mutate(b)} />}

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
                <button
                  className="btn-ghost text-red-600"
                  onClick={() => remove.mutate(s._id)}
                  aria-label="Remove"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ImapForm({ onSubmit }: { onSubmit: (b: unknown) => void }) {
  const [name, setName] = useState('My mailbox');
  const [host, setHost] = useState('imap.gmail.com');
  const [port, setPort] = useState(993);
  const [secure, setSecure] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mailbox, setMailbox] = useState('INBOX');
  const [pollIntervalMinutes, setPoll] = useState(5);

  return (
    <form
      className="card grid grid-cols-2 gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          type: 'imap',
          name,
          config: { host, port, secure, username, password, mailbox, pollIntervalMinutes },
        });
      }}
    >
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      <input className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="Host" />
      <input
        className="input"
        type="number"
        value={port}
        onChange={(e) => setPort(Number(e.target.value))}
        placeholder="Port"
      />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={secure} onChange={(e) => setSecure(e.target.checked)} /> TLS
      </label>
      <input
        className="input col-span-2"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="Username"
      />
      <input
        className="input col-span-2"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password / app password"
      />
      <input className="input" value={mailbox} onChange={(e) => setMailbox(e.target.value)} placeholder="Mailbox" />
      <input
        className="input"
        type="number"
        value={pollIntervalMinutes}
        onChange={(e) => setPoll(Number(e.target.value))}
        placeholder="Poll minutes"
      />
      <button type="submit" className="btn-primary col-span-2">
        Connect
      </button>
    </form>
  );
}

function WebhookForm({ onSubmit }: { onSubmit: (b: unknown) => void }) {
  const [name, setName] = useState('Forwarding webhook');
  return (
    <form
      className="card flex items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ type: 'webhook', name });
      }}
    >
      <label className="flex-1 text-sm">
        <span className="mb-1 block text-ink-600 dark:text-ink-300">Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="submit" className="btn-primary">
        Create token
      </button>
    </form>
  );
}
