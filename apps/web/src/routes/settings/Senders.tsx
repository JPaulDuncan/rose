import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Sparkles,
  Trash2,
  Pencil,
  Lock,
  ExternalLink,
  Globe,
  AtSign,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';

type Sender = {
  _id: string;
  brandKey: string;
  name: string;
  domain: string | null;
  addresses: string[];
  websites: string[];
  logoUrl: string | null;
  logoConfidence: number;
  summary: string;
  summaryGeneratedAt: string | null;
  pageCount: number;
  emailCount: number;
  lastSeenAt: string | null;
  firstSeenAt: string | null;
};

type SenderDetail = {
  sender: Sender & { unsubscribeUrls: string[] };
  pages: {
    _id: string;
    slug: string;
    title: string;
    summary: string;
    heroImageUrl: string | null;
    tags: string[];
    topics: string[];
    updatedAt: string;
    messageCount: number;
  }[];
  recentEmails: {
    _id: string;
    subject: string;
    date: string;
    fromName: string | null;
    fromAddress: string | null;
  }[];
};

export default function SendersSettings() {
  const api = useApi();
  const [sort, setSort] = useState<'recent' | 'pages' | 'emails' | 'name'>('recent');
  const [openKey, setOpenKey] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['senders', sort],
    queryFn: () => api.get<{ senders: Sender[] }>(`/api/senders?sort=${sort}&limit=200`),
  });

  return (
    <div className="space-y-4">
      <div className="card">
        <p className="text-sm text-ink-500">
          The address book Rose builds as it learns about each sender:
          logos, websites referenced, an AI-written "who is this" brief,
          and what they've contributed to your wiki. Edit a sender to
          override its logo or summary; Rose will respect your override.
        </p>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink-700 dark:text-ink-200">
          {data ? `${data.senders.length} senders` : 'Loading…'}
        </h2>
        <div className="flex gap-1 rounded-lg border border-ink-200 p-0.5 text-xs dark:border-ink-800">
          {(
            [
              ['recent', 'Recent'],
              ['pages', 'Pages'],
              ['emails', 'Emails'],
              ['name', 'A–Z'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSort(key)}
              className={
                'rounded px-2 py-1 ' +
                (sort === key
                  ? 'bg-rose-500 text-white'
                  : 'text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800')
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {!data?.senders.length ? (
        <div className="card text-sm text-ink-500">
          No senders yet. As emails arrive and get turned into wiki pages,
          their senders show up here.
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.senders.map((s) => (
            <SenderCard
              key={s._id}
              sender={s}
              isOpen={openKey === s.brandKey}
              onToggle={() => setOpenKey(openKey === s.brandKey ? null : s.brandKey)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SenderCard({
  sender,
  isOpen,
  onToggle,
}: {
  sender: Sender;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="rounded-xl border border-ink-200 bg-white p-3 dark:border-ink-800 dark:bg-ink-900">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 text-left"
      >
        <SenderLogo sender={sender} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{sender.name}</span>
            {sender.domain && (
              <span className="truncate text-xs text-ink-500">{sender.domain}</span>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-ink-500">
            <span>
              {sender.pageCount} page{sender.pageCount === 1 ? '' : 's'}
            </span>
            <span>·</span>
            <span>
              {sender.emailCount} email{sender.emailCount === 1 ? '' : 's'}
            </span>
            {sender.lastSeenAt && (
              <>
                <span>·</span>
                <span>last {new Date(sender.lastSeenAt).toLocaleDateString()}</span>
              </>
            )}
          </div>
          {sender.summary && (
            <p className="mt-2 line-clamp-3 text-xs text-ink-600 dark:text-ink-300">
              {sender.summary}
            </p>
          )}
        </div>
      </button>
      {isOpen && <SenderDetailPanel brandKey={sender.brandKey} />}
    </li>
  );
}

function SenderLogo({
  sender,
  size,
}: {
  sender: { name: string; logoUrl: string | null };
  size: 'lg' | 'md';
}) {
  const cls = size === 'lg' ? 'h-10 w-10 text-sm' : 'h-7 w-7 text-xs';
  if (sender.logoUrl) {
    return (
      <img
        src={sender.logoUrl}
        alt={sender.name}
        className={`${cls} shrink-0 rounded-md bg-white object-contain ring-1 ring-ink-200 dark:ring-ink-700`}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }
  return (
    <span
      className={`${cls} inline-flex shrink-0 items-center justify-center rounded-md bg-rose-50 font-semibold text-rose-700 ring-1 ring-rose-100 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900/60`}
    >
      {sender.name.charAt(0).toUpperCase()}
    </span>
  );
}

function SenderDetailPanel({ brandKey }: { brandKey: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['sender', brandKey],
    queryFn: () => api.get<SenderDetail>(`/api/senders/${encodeURIComponent(brandKey)}`),
  });
  const [edit, setEdit] = useState(false);
  const refresh = useMutation({
    mutationFn: async () =>
      api.post<{ jobId: string }>(`/api/senders/${encodeURIComponent(brandKey)}/refresh`),
    onSuccess: () => {
      toast.success('Summary refresh queued — refresh the panel in a few seconds');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: async () =>
      api.del<{ ok: true }>(`/api/senders/${encodeURIComponent(brandKey)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['senders'] });
      toast.success('Sender removed');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !data) {
    return <div className="mt-3 text-xs text-ink-500">Loading…</div>;
  }
  const s = data.sender;
  return (
    <div className="mt-3 space-y-3 border-t border-ink-200 pt-3 text-sm dark:border-ink-800">
      {edit ? (
        <SenderEditForm sender={s} onClose={() => setEdit(false)} />
      ) : (
        <>
          {s.summary ? (
            <p className="text-sm leading-snug text-ink-700 dark:text-ink-200">
              {s.summary}
            </p>
          ) : (
            <p className="text-xs italic text-ink-500">
              No summary yet. Click "Generate brief" to have the LLM write one
              from the address-book metadata.
            </p>
          )}

          <div className="flex flex-wrap gap-1.5">
            {s.addresses.map((a) => (
              <span
                key={a}
                className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-xs text-ink-700 dark:bg-ink-800 dark:text-ink-200"
              >
                <AtSign className="h-3 w-3" />
                {a}
              </span>
            ))}
          </div>

          {s.websites.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {s.websites.slice(0, 6).map((w) => (
                <a
                  key={w}
                  href={`https://${w}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-0.5 text-xs text-rose-800 hover:underline dark:bg-rose-950/40 dark:text-rose-200"
                >
                  <Globe className="h-3 w-3" />
                  {w}
                </a>
              ))}
            </div>
          )}

          {data.pages.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-500">
                Wiki pages
              </div>
              <ul className="space-y-1">
                {data.pages.slice(0, 5).map((p) => (
                  <li key={p._id}>
                    <Link
                      to={`/p/${p.slug}`}
                      className="inline-flex items-center gap-1 text-xs text-rose-600 hover:underline dark:text-rose-300"
                    >
                      {p.title}
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                    <span className="ml-1 text-[10px] text-ink-500">
                      ({p.messageCount} msg)
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              className="btn-secondary text-xs"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {refresh.isPending ? 'Queueing…' : 'Generate brief'}
            </button>
            <button className="btn-ghost text-xs" onClick={() => setEdit(true)}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
            <button
              className="btn-ghost text-xs text-red-600"
              onClick={() => {
                if (confirm(`Remove "${s.name}" from the address book?`)) remove.mutate();
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function SenderEditForm({
  sender,
  onClose,
}: {
  sender: SenderDetail['sender'];
  onClose: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [name, setName] = useState(sender.name);
  const [logoUrl, setLogoUrl] = useState(sender.logoUrl ?? '');
  const [summary, setSummary] = useState(sender.summary ?? '');

  const save = useMutation({
    mutationFn: async () =>
      api.patch<{ sender: Sender }>(
        `/api/senders/${encodeURIComponent(sender.brandKey)}`,
        {
          name,
          logoUrl: logoUrl.trim() || null,
          summary,
        },
      ),
    onSuccess: () => {
      toast.success('Sender saved');
      qc.invalidateQueries({ queryKey: ['senders'] });
      qc.invalidateQueries({ queryKey: ['sender', sender.brandKey] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Display name">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </Field>
      <Field
        label="Logo URL"
        hint="Lock the logo by setting it manually. Clear to reset."
      >
        <input
          className="input"
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          placeholder="https://example.com/logo.svg"
        />
      </Field>
      <Field label='"Who is this" summary' hint="Saving locks this so the worker won't overwrite.">
        <textarea
          className="input min-h-[90px]"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          maxLength={600}
        />
      </Field>
      <div className="flex justify-end gap-2 text-xs">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={save.isPending}>
          <Lock className="h-3.5 w-3.5" />
          {save.isPending ? 'Saving…' : 'Save + lock'}
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
    <label className="block text-xs">
      <span className="mb-1 block font-medium text-ink-700 dark:text-ink-200">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-500">{hint}</span>}
    </label>
  );
}
