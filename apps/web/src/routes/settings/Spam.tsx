import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, Trash2, UserX, Tag as TagIcon, Ban, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import type { SpamPolicy } from '@rose/shared';
import { useApi } from '../../lib/api';

export default function SpamSettings() {
  const api = useApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['spam'],
    queryFn: () => api.get<SpamPolicy>('/api/spam'),
  });
  const [newSender, setNewSender] = useState('');
  const [newTag, setNewTag] = useState('');
  const [newWhitelist, setNewWhitelist] = useState('');

  const addSender = useMutation({
    mutationFn: async (address: string) =>
      api.post<{ pagesAffected: number }>('/api/spam/sender', { address }),
    onSuccess: (r) => {
      toast.success(
        `Blocked — ${r.pagesAffected} page${r.pagesAffected === 1 ? '' : 's'} marked as spam.`,
      );
      qc.invalidateQueries({ queryKey: ['spam'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
      setNewSender('');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeSender = useMutation({
    mutationFn: async (address: string) =>
      api.del<{ ok: true }>(`/api/spam/sender/${encodeURIComponent(address)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spam'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
    },
  });
  const addTag = useMutation({
    mutationFn: async (tag: string) =>
      api.post<{ pagesAffected: number }>('/api/spam/tag', { tag }),
    onSuccess: (r) => {
      toast.success(
        `Blocked — ${r.pagesAffected} page${r.pagesAffected === 1 ? '' : 's'} marked as spam.`,
      );
      qc.invalidateQueries({ queryKey: ['spam'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
      setNewTag('');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeTag = useMutation({
    mutationFn: async (tag: string) =>
      api.del<{ ok: true }>(`/api/spam/tag/${encodeURIComponent(tag)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spam'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
    },
  });
  const unblockSender = useMutation({
    mutationFn: async (address: string) =>
      api.del<{ ok: true }>(`/api/spam/block/${encodeURIComponent(address)}`),
    onSuccess: () => {
      toast.success('Unblocked — future mail will ingest normally.');
      qc.invalidateQueries({ queryKey: ['spam'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const addWhitelist = useMutation({
    mutationFn: async (address: string) =>
      api.post<{ ok: true }>('/api/spam/whitelist', { address }),
    onSuccess: () => {
      toast.success('Trusted — bypasses blocklist + classifier.');
      qc.invalidateQueries({ queryKey: ['spam'] });
      setNewWhitelist('');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeWhitelist = useMutation({
    mutationFn: async (address: string) =>
      api.del<{ ok: true }>(`/api/spam/whitelist/${encodeURIComponent(address)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['spam'] }),
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !data) {
    return <div className="card text-sm text-ink-500">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="mb-2 flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-red-500" />
          <h2 className="font-semibold">Spam policy</h2>
        </div>
        <p className="text-sm text-ink-500">
          Pages whose sender or tags match a rule below are flagged as spam,
          hidden from the home digest, and excluded from search by default.
          You can also mark individual pages as spam from the page view's
          ⋯ menu.
        </p>
      </div>

      <PromotionsToggle />
      <ReputationCard />
      <GlobalBlacklistCard />

      <div className="card">
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          <h3 className="font-semibold">Trusted senders (whitelist)</h3>
          <span className="ml-auto text-xs text-ink-500">
            {(data.whitelistedSenders ?? []).length}
          </span>
        </div>
        <p className="mb-3 text-xs text-ink-500">
          Senders here bypass the blocklist, the spam classifier, and the
          auto-quarantine sweep — useful for newsletters or transactional
          mail you trust despite spam-y signals. Add a full address
          (<code>alice@example.com</code>), a host
          (<code>updates.example.com</code>), or a bare domain
          (<code>example.com</code>) — eTLD+1 matching catches every
          subdomain. <strong>All <code>.gov</code> and <code>.edu</code>{' '}
          senders are trusted by default</strong> and don't need to be
          added here.
        </p>
        <form
          className="mb-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = newWhitelist.trim().toLowerCase();
            if (!v) return;
            if ((data.whitelistedSenders ?? []).includes(v)) {
              toast.error('Already trusted');
              return;
            }
            addWhitelist.mutate(v);
          }}
        >
          <input
            className="input"
            placeholder="address@example.com or example.com"
            value={newWhitelist}
            onChange={(e) => setNewWhitelist(e.target.value)}
          />
          <button className="btn-primary" disabled={addWhitelist.isPending}>
            Trust
          </button>
        </form>
        {(data.whitelistedSenders ?? []).length === 0 ? (
          <div className="text-xs text-ink-500">
            No custom trusted senders. <code>.gov</code> and{' '}
            <code>.edu</code> mail is already trusted automatically.
          </div>
        ) : (
          <ul className="space-y-1 text-sm">
            {(data.whitelistedSenders ?? []).map((s) => (
              <li
                key={s}
                className="flex items-center justify-between rounded-lg border border-ink-200 px-3 py-1.5 dark:border-ink-800"
              >
                <code className="truncate text-xs">{s}</code>
                <button
                  className="btn-ghost text-red-600"
                  onClick={() => removeWhitelist.mutate(s)}
                  aria-label={`Untrust ${s}`}
                  title="Remove from whitelist"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <div className="mb-3 flex items-center gap-2">
          <Ban className="h-4 w-4 text-red-600" />
          <h3 className="font-semibold">Blocked at ingest</h3>
          <span className="ml-auto text-xs text-ink-500">
            {data.blockedSenders.length}
          </span>
        </div>
        <p className="mb-3 text-xs text-ink-500">
          The strongest filter: future mail from these senders is dropped
          during ingest — no Email row, no article. Add new entries from
          an email's "Block sender" toolbar action.
        </p>
        {data.blockedSenders.length === 0 ? (
          <div className="text-xs text-ink-500">No blocked senders yet.</div>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.blockedSenders.map((s) => (
              <li
                key={s}
                className="flex items-center justify-between rounded-lg border border-ink-200 px-3 py-1.5 dark:border-ink-800"
              >
                <code className="truncate text-xs">{s}</code>
                <button
                  className="btn-ghost text-emerald-600"
                  onClick={() => unblockSender.mutate(s)}
                  aria-label={`Unblock ${s}`}
                  title="Unblock"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <div className="mb-3 flex items-center gap-2">
          <UserX className="h-4 w-4 text-rose-500" />
          <h3 className="font-semibold">Spam-marked senders</h3>
          <span className="ml-auto text-xs text-ink-500">{data.senders.length}</span>
        </div>
        <p className="mb-3 text-xs text-ink-500">
          Their existing pages are flagged as spam and hidden from the home
          digest, but new mail still ingests so you can rescue it from
          Quarantine if the heuristic was wrong. For something stronger that
          stops mail before it lands, use "Blocked at ingest" above.
        </p>
        <form
          className="mb-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = newSender.trim().toLowerCase();
            if (!v) return;
            if (data.senders.includes(v)) {
              toast.error('Already blocked');
              return;
            }
            addSender.mutate(v);
          }}
        >
          <input
            className="input"
            placeholder="address@example.com"
            value={newSender}
            onChange={(e) => setNewSender(e.target.value)}
            type="email"
          />
          <button className="btn-primary" disabled={addSender.isPending}>
            Block sender
          </button>
        </form>
        {data.senders.length === 0 ? (
          <div className="text-xs text-ink-500">No blocked senders yet.</div>
        ) : (
          <ul className="space-y-1 text-sm">
            {data.senders.map((s) => (
              <li
                key={s}
                className="flex items-center justify-between rounded-lg border border-ink-200 px-3 py-1.5 dark:border-ink-800"
              >
                <code className="truncate text-xs">{s}</code>
                <button
                  className="btn-ghost text-red-600"
                  onClick={() => removeSender.mutate(s)}
                  aria-label={`Unblock ${s}`}
                  title="Unblock"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <div className="mb-3 flex items-center gap-2">
          <TagIcon className="h-4 w-4 text-rose-500" />
          <h3 className="font-semibold">Blocked tags</h3>
          <span className="ml-auto text-xs text-ink-500">{data.tags.length}</span>
        </div>
        <form
          className="mb-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = newTag.trim().toLowerCase();
            if (!v) return;
            if (data.tags.includes(v)) {
              toast.error('Already blocked');
              return;
            }
            addTag.mutate(v);
          }}
        >
          <input
            className="input"
            placeholder="tag-name"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
          />
          <button className="btn-primary" disabled={addTag.isPending}>
            Block tag
          </button>
        </form>
        {data.tags.length === 0 ? (
          <div className="text-xs text-ink-500">No blocked tags yet.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {data.tags.map((t) => (
              <button
                key={t}
                className="pill text-xs hover:bg-red-100 hover:text-red-800 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                onClick={() => removeTag.mutate(t)}
                title={`Unblock #${t}`}
              >
                #{t} <Trash2 className="ml-1 inline h-3 w-3" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PromotionsToggle() {
  const api = useApi();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['me'],
    queryFn: () =>
      api.get<{ settings?: { hidePromotions?: boolean } }>('/api/me'),
  });
  const hidePromotions = data?.settings?.hidePromotions !== false;
  const save = useMutation({
    mutationFn: async (next: boolean) =>
      api.patch<unknown>('/api/me', {
        settings: { ...(data?.settings ?? {}), hidePromotions: next },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="card">
      <div className="mb-2 flex items-center gap-2">
        <TagIcon className="h-4 w-4 text-rose-500" />
        <h3 className="font-semibold">Promotions</h3>
      </div>
      <p className="mb-3 text-sm text-ink-500">
        Promotional content (newsletters, ads, sponsored mail) is hidden
        from the front page by default. You can still find these pages
        through Search and the Codex.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={hidePromotions}
          onChange={(e) => save.mutate(e.target.checked)}
        />
        <span>Hide promotional content from the home digest</span>
      </label>
    </div>
  );
}

type GlobalBlacklistEntry = {
  brandKey: string;
  domain: string | null;
  name: string;
  logoUrl: string | null;
  markedCount: number;
  rescuedCount: number;
  netReports: number;
  rank: 'high' | 'medium' | 'low';
  firstFlaggedAt: string | null;
  optedIn: boolean;
};

function GlobalBlacklistCard() {
  const api = useApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['spam', 'global'],
    queryFn: () =>
      api.get<{ blacklist: GlobalBlacklistEntry[] }>('/api/spam/global'),
    refetchOnWindowFocus: false,
  });
  const optIn = useMutation({
    mutationFn: async (brandKey: string) =>
      api.post<{ ok: true }>(`/api/spam/optin/${encodeURIComponent(brandKey)}`, {}),
    onSuccess: () => {
      toast.success('Receiving this brand again.');
      qc.invalidateQueries({ queryKey: ['spam', 'global'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const optOut = useMutation({
    mutationFn: async (brandKey: string) =>
      api.del<{ ok: true }>(`/api/spam/optin/${encodeURIComponent(brandKey)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['spam', 'global'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const entries = data?.blacklist ?? [];
  const rankClass: Record<GlobalBlacklistEntry['rank'], string> = {
    high: 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-200',
    medium: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
    low: 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200',
  };
  return (
    <div className="card">
      <div className="mb-2 flex items-center gap-2">
        <Ban className="h-4 w-4 text-red-500" />
        <h3 className="font-semibold">Global blacklist</h3>
        <span className="ml-auto text-xs text-ink-500">{entries.length}</span>
      </div>
      <p className="mb-3 text-xs text-ink-500">
        Once any user marks a brand as spam, it's flagged for everyone — pages
        from these brands auto-quarantine on arrival. The reputational rank
        reflects how many users have reported the brand. Click{' '}
        <strong>Receive anyway</strong> to opt yourself in to a brand's mail
        despite the global flag.
      </p>
      {isLoading ? (
        <div className="text-xs text-ink-500">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="text-xs text-ink-500">
          No globally-flagged brands yet.
        </div>
      ) : (
        <ul className="space-y-1 text-sm">
          {entries.map((e) => (
            <li
              key={e.brandKey}
              className="flex items-center gap-3 rounded-lg border border-ink-200 px-3 py-1.5 dark:border-ink-800"
            >
              {e.logoUrl ? (
                <img
                  src={e.logoUrl}
                  alt=""
                  className="h-6 w-6 shrink-0 rounded object-contain"
                  referrerPolicy="no-referrer"
                  onError={(ev) => {
                    (ev.currentTarget as HTMLImageElement).style.display = 'none';
                  }}
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-medium">{e.name}</span>
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${rankClass[e.rank]}`}
                    title={`${e.markedCount} reports · ${e.rescuedCount} rescues`}
                  >
                    {e.rank} · {e.netReports} report{e.netReports === 1 ? '' : 's'}
                  </span>
                  {e.optedIn && (
                    <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200">
                      receiving
                    </span>
                  )}
                </div>
                {e.domain && (
                  <code className="text-[11px] text-ink-500">{e.domain}</code>
                )}
              </div>
              {e.optedIn ? (
                <button
                  className="btn-ghost text-xs"
                  onClick={() => optOut.mutate(e.brandKey)}
                  disabled={optOut.isPending}
                  title="Re-honor the global flag"
                >
                  Stop
                </button>
              ) : (
                <button
                  className="btn-secondary text-xs"
                  onClick={() => optIn.mutate(e.brandKey)}
                  disabled={optIn.isPending}
                  title="Bypass the global flag for your inbox"
                >
                  Receive anyway
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReputationCard() {
  return (
    <div className="card">
      <div className="mb-2 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-500" />
        <h3 className="font-semibold">Sender reputation</h3>
      </div>
      <p className="text-sm text-ink-500">
        Marking pages as spam bumps their sender's reputation. After a
        few negative marks, future pages from that brand are
        automatically held for review in{' '}
        <a href="/quarantine" className="text-rose-600 hover:underline dark:text-rose-300">
          Quarantine
        </a>
        . Trust a sender from there to clear the auto-hold.
      </p>
    </div>
  );
}
