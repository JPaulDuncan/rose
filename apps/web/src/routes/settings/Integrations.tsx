import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Webhook,
  Plus,
  Trash2,
  Power,
  Copy,
  Eye,
  Send,
  Link2,
  Share2,
  ExternalLink,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';

type Subscription = {
  _id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  deliveryCount: number;
  failureCount: number;
  lastDeliveredAt: string | null;
  lastError: string | null;
  createdAt: string | null;
};

type ShareLink = {
  _id: string;
  slug: string;
  targetType: 'page' | 'tag' | 'category';
  targetId: string | null;
  targetTag: string | null;
  label: string;
  expiresAt: string | null;
  revokedAt: string | null;
  viewCount: number;
  indexable: boolean;
  createdAt: string;
};

export default function IntegrationsSettings() {
  return (
    <div className="space-y-6">
      <WebhooksCard />
      <ShareLinksCard />
    </div>
  );
}

function WebhooksCard() {
  const api = useApi();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['webhooks'],
    queryFn: () =>
      api.get<{ subscriptions: Subscription[]; events: string[] }>('/api/webhooks'),
  });
  const [creating, setCreating] = useState(false);

  const remove = useMutation({
    mutationFn: async (id: string) => api.del<{ ok: true }>(`/api/webhooks/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });
  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<Subscription>(`/api/webhooks/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  });
  const sendTest = useMutation({
    mutationFn: async (id: string) =>
      api.post<{ ok: true }>(`/api/webhooks/${id}/test`),
    onSuccess: () => toast.success('Test event queued'),
    onError: (e: Error) => toast.error(e.message),
  });
  const revealSecret = useMutation({
    mutationFn: async (id: string) =>
      api.get<{ secret: string }>(`/api/webhooks/${id}/secret`),
    onSuccess: (r) => {
      void navigator.clipboard.writeText(r.secret).catch(() => null);
      toast.success('Secret copied to clipboard');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const events = data?.events ?? [];
  const subs = data?.subscriptions ?? [];

  return (
    <div className="card">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Webhook className="h-5 w-5 text-rose-500" />
          <h2 className="font-semibold">Outbound webhooks</h2>
        </div>
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={() => setCreating(true)}
        >
          <Plus className="h-3.5 w-3.5" /> New webhook
        </button>
      </div>
      <p className="text-sm text-ink-500">
        Fire HTTP POSTs to your own endpoints when articles are
        created, updated, or flagged. Each delivery is HMAC-SHA256
        signed with the per-subscription secret in the
        <code className="ml-1 text-[11px]">X-Rose-Signature</code>
        {' '}header.
      </p>

      {creating && (
        <CreateWebhookForm
          events={events}
          onCancel={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ['webhooks'] });
          }}
        />
      )}

      {subs.length === 0 ? (
        <div className="mt-3 text-xs italic text-ink-500">
          No webhook subscriptions yet.
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {subs.map((s) => (
            <li
              key={s._id}
              className="rounded-lg border border-ink-200 p-3 text-sm dark:border-ink-800"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {s.name}
                    {!s.enabled && (
                      <span className="ml-2 rounded bg-ink-100 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-ink-500 dark:bg-ink-800 dark:text-ink-300">
                        paused
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-ink-500">{s.url}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {s.events.map((e) => (
                      <span
                        key={e}
                        className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] text-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
                      >
                        {e}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1 text-[10px] uppercase tracking-widest text-ink-400">
                    {s.deliveryCount} delivered · {s.failureCount} failed
                    {s.lastDeliveredAt &&
                      ` · last ${new Date(s.lastDeliveredAt).toLocaleString()}`}
                  </div>
                  {s.lastError && (
                    <div className="mt-1 text-xs text-red-600">last error: {s.lastError}</div>
                  )}
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() => sendTest.mutate(s._id)}
                  >
                    <Send className="h-3.5 w-3.5" /> Test
                  </button>
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() => revealSecret.mutate(s._id)}
                  >
                    <Eye className="h-3.5 w-3.5" /> Secret
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => toggle.mutate({ id: s._id, enabled: !s.enabled })}
                    title={s.enabled ? 'Pause' : 'Enable'}
                  >
                    <Power
                      className={
                        'h-3.5 w-3.5 ' +
                        (s.enabled ? 'text-emerald-600' : 'text-ink-400')
                      }
                    />
                  </button>
                  <button
                    type="button"
                    className="btn-ghost text-red-600"
                    onClick={() => {
                      if (confirm(`Delete webhook "${s.name}"?`)) remove.mutate(s._id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateWebhookForm({
  events,
  onCancel,
  onSaved,
}: {
  events: string[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [picked, setPicked] = useState<string[]>(['page.created']);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () =>
      api.post<{
        subscription: Subscription;
        secret: string;
        hint: string;
      }>('/api/webhooks', {
        name: name.trim(),
        url: url.trim(),
        events: picked,
      }),
    onSuccess: (r) => {
      setCreatedSecret(r.secret);
      toast.success(r.hint);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (createdSecret) {
    return (
      <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs dark:border-emerald-800 dark:bg-emerald-950/30">
        <div className="mb-1 font-semibold">Webhook created.</div>
        <div className="mb-2">
          Save this secret — it's shown only once. Use it to verify
          incoming HMAC signatures:
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded bg-white px-2 py-1 font-mono text-[11px] dark:bg-ink-950">
            {createdSecret}
          </code>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              void navigator.clipboard.writeText(createdSecret).catch(() => null);
              toast.success('Copied');
            }}
          >
            <Copy className="h-3 w-3" />
          </button>
        </div>
        <div className="mt-3 flex justify-end">
          <button type="button" className="btn-primary text-xs" onClick={onSaved}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="mt-3 space-y-3 rounded-lg border border-ink-200 p-3 dark:border-ink-800"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !url.trim() || picked.length === 0) {
          toast.error('Name, URL, and at least one event required');
          return;
        }
        create.mutate();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs">
          <span className="mb-1 block font-medium">Name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium">URL</span>
          <input
            className="input"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/hook"
            required
          />
        </label>
      </div>
      <fieldset>
        <legend className="mb-1 text-[11px] font-medium uppercase tracking-widest text-ink-500">
          Events
        </legend>
        <div className="flex flex-wrap gap-2">
          {events.map((ev) => (
            <label key={ev} className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={picked.includes(ev)}
                onChange={(e) =>
                  setPicked((arr) =>
                    e.target.checked ? [...arr, ev] : arr.filter((x) => x !== ev),
                  )
                }
              />
              <span>{ev}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex justify-end gap-2 text-xs">
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={create.isPending}>
          Create
        </button>
      </div>
    </form>
  );
}

function ShareLinksCard() {
  const api = useApi();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['share-links'],
    queryFn: () => api.get<{ links: ShareLink[] }>('/api/share'),
  });
  const revoke = useMutation({
    mutationFn: async (id: string) => api.del<{ ok: true }>(`/api/share/${id}`),
    onSuccess: () => {
      toast.success('Share link revoked');
      qc.invalidateQueries({ queryKey: ['share-links'] });
    },
  });

  const links = data?.links ?? [];
  return (
    <div className="card">
      <div className="mb-2 flex items-center gap-2">
        <Share2 className="h-5 w-5 text-rose-500" />
        <h2 className="font-semibold">Share links</h2>
      </div>
      <p className="text-sm text-ink-500">
        Public read-only links to articles. Create one from any article
        view via the Share button. Active links serve a stripped-down
        HTML page at <code>/share/&lt;slug&gt;</code>.
      </p>
      {links.length === 0 ? (
        <div className="mt-3 text-xs italic text-ink-500">No share links yet.</div>
      ) : (
        <ul className="mt-3 space-y-2 text-sm">
          {links.map((l) => {
            const url = `${window.location.origin}/share/${l.slug}`;
            const revoked = !!l.revokedAt;
            const expired = !!l.expiresAt && new Date(l.expiresAt) < new Date();
            return (
              <li
                key={l._id}
                className="flex items-center justify-between gap-2 rounded-lg border border-ink-200 p-2 text-xs dark:border-ink-800"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{l.label || l.slug}</div>
                  <div className="truncate text-[11px] text-ink-500">
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {url}
                    </a>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] uppercase tracking-widest text-ink-400">
                    <span>{l.viewCount} views</span>
                    <span>created {new Date(l.createdAt).toLocaleDateString()}</span>
                    {revoked && <span className="text-red-600">revoked</span>}
                    {expired && <span className="text-amber-600">expired</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      void navigator.clipboard.writeText(url).catch(() => null);
                      toast.success('Copied');
                    }}
                    title="Copy URL"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-ghost"
                    aria-label="Open"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  {!revoked && (
                    <button
                      type="button"
                      className="btn-ghost text-red-600"
                      onClick={() => {
                        if (confirm('Revoke this share link?')) revoke.mutate(l._id);
                      }}
                      title="Revoke"
                    >
                      <Link2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
