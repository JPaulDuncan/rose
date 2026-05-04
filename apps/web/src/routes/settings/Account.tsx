import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bell, BellOff, RefreshCw, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';
import { useApi } from '../../lib/api';
import {
  checkPushSupport,
  currentEndpoint,
  subscribePush,
  unsubscribePush,
} from '../../lib/push';

type ResetResponse = {
  ok: true;
  pagesDeleted: number;
  revisionsDeleted: number;
  eventsDeleted: number;
  emails: { deleted: number; reset: number };
  categoriesDeleted: number;
  requeued: number;
};

export default function AccountSettings() {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();

  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="mb-2 font-semibold">Profile</h2>
        <div className="text-sm">
          <div>
            <span className="text-ink-500">Email:</span> {user?.email}
          </div>
          <div>
            <span className="text-ink-500">Name:</span> {user?.displayName}
          </div>
        </div>
      </div>

      <div className="card">
        <h2 className="mb-2 font-semibold">Theme</h2>
        <div className="flex gap-2">
          {(['light', 'dark', 'system'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTheme(t)}
              className={theme === t ? 'btn-primary' : 'btn-secondary'}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      <PushCard />
      <ReadTrackingCard />

      <DangerZone />

      <button className="btn-secondary" onClick={logout}>
        Sign out
      </button>
    </div>
  );
}

type NotificationRule = {
  _id: string;
  kind: 'priority-high' | 'tag' | 'sender' | 'event-soon';
  match: { tag?: string; brandKey?: string; hoursAhead?: number };
  enabled: boolean;
};

function PushCard() {
  const api = useApi();
  const qc = useQueryClient();
  const support = checkPushSupport();
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: keyResp } = useQuery({
    queryKey: ['push-key'],
    queryFn: () => api.get<{ publicKey: string | null }>('/api/push/key'),
  });
  const { data: rulesResp } = useQuery({
    queryKey: ['notification-rules'],
    queryFn: () => api.get<{ rules: NotificationRule[] }>('/api/push/rules'),
  });

  useEffect(() => {
    void currentEndpoint().then(setEndpoint);
  }, []);

  const subscribed = !!endpoint;

  async function enable() {
    if (!keyResp?.publicKey) {
      toast.error('Push not configured by the operator yet');
      return;
    }
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        toast.error('Notifications blocked');
        return;
      }
      const sub = await subscribePush(keyResp.publicKey);
      const keys = sub.keys ?? {};
      await api.post('/api/push/subscribe', {
        endpoint: sub.endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        userAgent: navigator.userAgent,
      });
      setEndpoint(sub.endpoint ?? null);
      toast.success('Push notifications enabled');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const ep = await unsubscribePush();
      if (ep) await api.post('/api/push/unsubscribe', { endpoint: ep });
      setEndpoint(null);
      toast.success('Disabled');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const addRule = useMutation({
    mutationFn: async (body: Omit<NotificationRule, '_id' | 'enabled'>) =>
      api.post<NotificationRule>('/api/push/rules', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-rules'] }),
  });
  const removeRule = useMutation({
    mutationFn: async (id: string) =>
      api.del<{ ok: true }>(`/api/push/rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-rules'] }),
  });

  return (
    <div className="card">
      <div className="mb-2 flex items-center gap-2">
        {subscribed ? (
          <Bell className="h-5 w-5 text-rose-500" />
        ) : (
          <BellOff className="h-5 w-5 text-ink-400" />
        )}
        <h2 className="font-semibold">Push notifications</h2>
      </div>
      {!support.ok ? (
        <p className="text-sm text-ink-500">
          Your browser doesn't support WebPush ({support.reason}). On Safari,
          install Rose to your Home Screen and try again.
        </p>
      ) : !keyResp?.publicKey ? (
        <p className="text-sm text-ink-500">
          The operator hasn't configured VAPID keys for this deployment yet.
          The worker will generate and persist a keypair on its next boot;
          refresh after that.
        </p>
      ) : (
        <>
          <p className="text-sm text-ink-500">
            Get a browser notification when a high-priority page lands, a
            tag you follow gets a new entry, or an extracted calendar event
            is coming up soon.
          </p>
          <div className="mt-3 flex gap-2">
            {subscribed ? (
              <button className="btn-ghost" onClick={disable} disabled={busy}>
                <BellOff className="h-4 w-4" /> Disable on this device
              </button>
            ) : (
              <button className="btn-primary" onClick={enable} disabled={busy}>
                <Bell className="h-4 w-4" /> Enable on this device
              </button>
            )}
          </div>

          <NotificationRulesList
            rules={rulesResp?.rules ?? []}
            onAdd={(r) => addRule.mutate(r)}
            onRemove={(id) => removeRule.mutate(id)}
          />
        </>
      )}
    </div>
  );
}

function NotificationRulesList({
  rules,
  onAdd,
  onRemove,
}: {
  rules: NotificationRule[];
  onAdd: (r: Omit<NotificationRule, '_id' | 'enabled'>) => void;
  onRemove: (id: string) => void;
}) {
  const [tag, setTag] = useState('');
  const [brand, setBrand] = useState('');
  const hasPriority = rules.some((r) => r.kind === 'priority-high');
  const hasEventSoon = rules.some((r) => r.kind === 'event-soon');
  return (
    <div className="mt-4 space-y-3">
      <div className="text-[10px] uppercase tracking-widest text-ink-500">
        Tell me about
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={hasPriority}
            onChange={() => {
              if (hasPriority) {
                const r = rules.find((x) => x.kind === 'priority-high');
                if (r) onRemove(r._id);
              } else {
                onAdd({ kind: 'priority-high', match: {} });
              }
            }}
          />
          High-priority pages
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={hasEventSoon}
            onChange={() => {
              if (hasEventSoon) {
                const r = rules.find((x) => x.kind === 'event-soon');
                if (r) onRemove(r._id);
              } else {
                onAdd({ kind: 'event-soon', match: { hoursAhead: 6 } });
              }
            }}
          />
          Calendar events within 6 hours
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const v = tag.trim().toLowerCase();
            if (!v) return;
            onAdd({ kind: 'tag', match: { tag: v } });
            setTag('');
          }}
        >
          <input
            className="input text-xs"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="follow tag…"
          />
          <button className="btn-secondary text-xs" type="submit">
            Add
          </button>
        </form>
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const v = brand.trim().toLowerCase();
            if (!v) return;
            onAdd({ kind: 'sender', match: { brandKey: v } });
            setBrand('');
          }}
        >
          <input
            className="input text-xs"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            placeholder="follow sender brand…"
          />
          <button className="btn-secondary text-xs" type="submit">
            Add
          </button>
        </form>
      </div>

      {rules.filter((r) => r.kind === 'tag' || r.kind === 'sender').length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {rules
            .filter((r) => r.kind === 'tag' || r.kind === 'sender')
            .map((r) => (
              <li
                key={r._id}
                className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs text-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
              >
                {r.kind === 'tag' ? `#${r.match.tag}` : `@${r.match.brandKey}`}
                <button
                  type="button"
                  onClick={() => onRemove(r._id)}
                  className="-mr-1 ml-0.5 rounded-full p-0.5 hover:bg-rose-200 dark:hover:bg-rose-900/60"
                  aria-label="Remove"
                >
                  ×
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function ReadTrackingCard() {
  const api = useApi();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['me'],
    queryFn: () =>
      api.get<{ settings?: { trackReads?: boolean } }>('/api/me'),
  });
  const enabled = !!data?.settings?.trackReads;
  const save = useMutation({
    mutationFn: async (next: boolean) =>
      api.patch<unknown>('/api/me', {
        settings: { ...(data?.settings ?? {}), trackReads: next },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="card">
      <h2 className="mb-2 font-semibold">Track which pages I've read</h2>
      <p className="text-sm text-ink-500">
        Off by default. When on, Rose remembers which wiki pages you've
        opened so unread items can be highlighted in lists. Doesn't
        affect anything else; favorites work either way.
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => save.mutate(e.target.checked)}
        />
        <span>Enable read tracking</span>
      </label>
    </div>
  );
}

function DangerZone() {
  const api = useApi();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState('');
  const [alsoRequeue, setAlsoRequeue] = useState(true);
  const [alsoEmails, setAlsoEmails] = useState(false);
  const [alsoCategories, setAlsoCategories] = useState(false);

  const reset = useMutation({
    mutationFn: async () =>
      api.post<ResetResponse>('/api/me/reset-wiki', {
        alsoRequeue,
        alsoEmails,
        alsoCategories,
      }),
    onSuccess: (r) => {
      toast.success(
        `Deleted ${r.pagesDeleted} page${r.pagesDeleted === 1 ? '' : 's'}` +
          (r.eventsDeleted
            ? `, ${r.eventsDeleted} calendar event${r.eventsDeleted === 1 ? '' : 's'}`
            : '') +
          (r.emails.deleted ? `, ${r.emails.deleted} email(s)` : '') +
          (r.emails.reset ? `, reset ${r.emails.reset} email(s)` : '') +
          (r.requeued ? `, requeued ${r.requeued}` : ''),
      );
      qc.invalidateQueries();
      setConfirm('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const armed = confirm.trim().toUpperCase() === 'RESET';

  return (
    <div className="card border-red-200 dark:border-red-900/60">
      <div className="mb-3 flex items-center gap-2">
        <AlertTriangle className="h-5 w-5 text-red-500" />
        <h2 className="font-semibold text-red-700 dark:text-red-300">Danger zone</h2>
      </div>
      <p className="text-sm text-ink-500">
        Reset your wiki. By default this deletes every page + revision and
        marks every ingested email as <code>parsed</code> so the worker can
        rebuild the wiki under the current grouping rules. Toggle the boxes
        below to extend the scope.
      </p>

      <div className="mt-4 space-y-2 text-sm">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={alsoRequeue}
            onChange={(e) => setAlsoRequeue(e.target.checked)}
            disabled={alsoEmails}
          />
          <span>
            <span className="font-medium">Re-queue generation immediately</span>{' '}
            <span className="text-ink-500">
              — kicks off a regenerate job for every email right after the reset.
              Disabled when "Delete source emails too" is on.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={alsoCategories}
            onChange={(e) => setAlsoCategories(e.target.checked)}
          />
          <span>
            <span className="font-medium">Also drop auto-created categories</span>{' '}
            <span className="text-ink-500">— useful if the LLM made messy ones.</span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={alsoEmails}
            onChange={(e) => {
              setAlsoEmails(e.target.checked);
              if (e.target.checked) setAlsoRequeue(false);
            }}
          />
          <span>
            <span className="font-medium text-red-700 dark:text-red-300">
              Delete source emails too (full nuke)
            </span>{' '}
            <span className="text-ink-500">
              — drops every Email document. You'll need to re-sync from your
              IMAP / Gmail / webhook source to get them back.
            </span>
          </span>
        </label>
      </div>

      <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/60 dark:bg-red-950/30">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-red-800 dark:text-red-200">
            Type <code>RESET</code> to confirm
          </span>
          <input
            className="input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="RESET"
          />
        </label>
        <button
          className="btn mt-3 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
          disabled={!armed || reset.isPending}
          onClick={() => {
            if (
              confirm.trim().toUpperCase() !== 'RESET' ||
              !window.confirm(
                alsoEmails
                  ? 'This deletes pages, revisions, AND your ingested emails. Continue?'
                  : 'This deletes every page and revision and resets every email. Continue?',
              )
            )
              return;
            reset.mutate();
          }}
        >
          {alsoEmails ? <Trash2 className="h-4 w-4" /> : <RefreshCw className={`h-4 w-4 ${reset.isPending ? 'animate-spin' : ''}`} />}
          {reset.isPending ? 'Resetting…' : alsoEmails ? 'Delete pages + emails' : 'Reset wiki pages'}
        </button>
      </div>
    </div>
  );
}
