import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Sparkles,
  Pencil,
  Lock,
  ExternalLink,
  Globe,
  AtSign,
  Mail,
  ScrollText,
  ArrowLeft,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';

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
  unsubscribeUrls: string[];
  stripAds?: boolean;
  spamMarkedCount?: number;
  rescuedCount?: number;
  autoQuarantine?: boolean;
};

type SenderDetail = {
  sender: Sender;
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

export default function SenderPage() {
  const { brandKey } = useParams<{ brandKey: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['sender', brandKey],
    queryFn: () =>
      api.get<SenderDetail>(`/api/senders/${encodeURIComponent(brandKey ?? '')}`),
    enabled: !!brandKey,
  });

  const refresh = useMutation({
    mutationFn: async () =>
      api.post<{ jobId: string }>(
        `/api/senders/${encodeURIComponent(brandKey ?? '')}/refresh`,
      ),
    onSuccess: () => {
      toast.success('Brief queued — refresh in a few seconds for the new copy');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return <div className="px-6 py-10 text-ink-500">Loading sender…</div>;
  }
  // Mutation lives at this scope so the toggle button below can hit it.
  const toggleStripAds = useMutation({
    mutationFn: async (next: boolean) =>
      api.patch<{ sender: Sender }>(
        `/api/senders/${encodeURIComponent(brandKey ?? '')}`,
        { stripAds: next },
      ),
    onSuccess: (_r, next) => {
      toast.success(next ? 'Ads will be stripped from this sender' : 'Strip-ads disabled');
      qc.invalidateQueries({ queryKey: ['sender', brandKey] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isError || !data) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="card text-center">
          <h2 className="font-serif text-xl">Sender not found</h2>
          <p className="mt-2 text-sm text-ink-500">
            We don't have an address-book entry for "{brandKey}" yet. As
            emails arrive from them, this page will populate.
          </p>
          <Link to="/codex" className="btn-secondary mt-4 inline-flex">
            <ArrowLeft className="h-4 w-4" /> Open the codex
          </Link>
        </div>
      </div>
    );
  }
  const s = data.sender;
  const dr =
    s.firstSeenAt && s.lastSeenAt
      ? `${new Date(s.firstSeenAt).toLocaleDateString()} – ${new Date(
          s.lastSeenAt,
        ).toLocaleDateString()}`
      : null;

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <Link
        to="/codex"
        className="mb-4 inline-flex items-center gap-1 text-xs uppercase tracking-widest text-ink-500 hover:text-ink-900 dark:hover:text-ink-100"
      >
        <ArrowLeft className="h-3 w-3" /> Back to codex
      </Link>

      <header className="flex items-start gap-5 border-b-2 border-ink-900 pb-6 dark:border-ink-100">
        <Portrait sender={s} />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-[0.25em] text-ink-500">
            Address book entry
          </div>
          <h1 className="mt-1 font-serif text-4xl font-black leading-none tracking-tight">
            {s.name}
          </h1>
          {s.domain && (
            <div className="mt-1 text-sm text-ink-500">{s.domain}</div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] uppercase tracking-widest text-ink-500">
            <span>
              {s.pageCount} {s.pageCount === 1 ? 'wiki entry' : 'wiki entries'}
            </span>
            <span>
              {s.emailCount} {s.emailCount === 1 ? 'message' : 'messages'}
            </span>
            {dr && <span>{dr}</span>}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <button
            className="btn-secondary text-xs"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {refresh.isPending ? 'Queued…' : 'Generate brief'}
          </button>
          <button
            className={
              s.stripAds
                ? 'btn-secondary text-xs text-rose-600 dark:text-rose-300'
                : 'btn-ghost text-xs'
            }
            onClick={() => toggleStripAds.mutate(!s.stripAds)}
            disabled={toggleStripAds.isPending}
            title={
              s.stripAds
                ? 'Strip-ads is on for this sender — body ads are removed before the LLM sees them.'
                : 'Run an aggressive ad-strip pass on this sender\'s mail before generation.'
            }
          >
            {s.stripAds ? '🚫 Strip ads · on' : 'Strip ads'}
          </button>
          <button className="btn-ghost text-xs" onClick={() => setEditing((v) => !v)}>
            <Pencil className="h-3.5 w-3.5" />
            {editing ? 'Close' : 'Edit'}
          </button>
        </div>
      </header>

      {editing && (
        <SenderEditPanel sender={s} onClose={() => setEditing(false)} />
      )}

      <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_240px]">
        <div className="space-y-8">
          {/* Summary */}
          <section>
            <h2 className="text-[10px] uppercase tracking-[0.25em] text-ink-500">
              Summary
            </h2>
            {s.summary ? (
              <p className="mt-2 text-base leading-relaxed first-letter:font-serif first-letter:text-3xl first-letter:font-bold first-letter:leading-none first-letter:mr-1 first-letter:float-left first-letter:mt-1">
                {s.summary}
              </p>
            ) : (
              <p className="mt-2 text-sm italic text-ink-500">
                No brief written yet. Click "Generate brief" to have the
                LLM compose one from this sender's metadata.
              </p>
            )}
          </section>

          {/* Wiki entries */}
          <section>
            <h2 className="border-b border-ink-200 pb-2 text-[10px] uppercase tracking-[0.25em] text-ink-500 dark:border-ink-800">
              Wiki entries
            </h2>
            {data.pages.length === 0 ? (
              <p className="mt-2 text-sm italic text-ink-500">
                No wiki pages yet for this sender.
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-ink-200 dark:divide-ink-800">
                {data.pages.map((p) => (
                  <li key={p._id} className="py-3">
                    <Link to={`/p/${p.slug}`} className="group block">
                      <h3 className="font-serif text-lg font-semibold leading-snug group-hover:text-rose-700 dark:group-hover:text-rose-300">
                        {p.title}
                      </h3>
                      {p.summary && (
                        <p className="mt-1 text-sm leading-relaxed text-ink-600 line-clamp-2 dark:text-ink-300">
                          {p.summary}
                        </p>
                      )}
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] uppercase tracking-widest text-ink-500">
                        <span>
                          {p.messageCount}{' '}
                          {p.messageCount === 1 ? 'message' : 'messages'}
                        </span>
                        <span>
                          updated {new Date(p.updatedAt).toLocaleDateString()}
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Recent messages */}
          {data.recentEmails.length > 0 && (
            <section>
              <h2 className="border-b border-ink-200 pb-2 text-[10px] uppercase tracking-[0.25em] text-ink-500 dark:border-ink-800">
                Recent messages
              </h2>
              <ul className="mt-3 space-y-2 text-sm">
                {data.recentEmails.map((e) => (
                  <li key={e._id}>
                    <Link
                      to={`/e/${e._id}`}
                      className="flex items-baseline gap-2 hover:text-rose-700 dark:hover:text-rose-300"
                    >
                      <Mail className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                      <span className="truncate">
                        {e.subject || '(no subject)'}
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] uppercase tracking-widest text-ink-500">
                        {new Date(e.date).toLocaleDateString()}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="space-y-4 text-sm">
          {s.addresses.length > 0 && (
            <SidebarBlock title="Addresses" icon={<AtSign className="h-3.5 w-3.5" />}>
              <ul className="space-y-1 text-xs">
                {s.addresses.map((a) => (
                  <li key={a} className="truncate font-mono text-ink-700 dark:text-ink-200">
                    {a}
                  </li>
                ))}
              </ul>
            </SidebarBlock>
          )}
          {s.websites.length > 0 && (
            <SidebarBlock title="Websites" icon={<Globe className="h-3.5 w-3.5" />}>
              <ul className="space-y-1 text-xs">
                {s.websites.map((w) => (
                  <li key={w}>
                    <a
                      href={`https://${w}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-rose-600 hover:underline dark:text-rose-300"
                    >
                      {w}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </li>
                ))}
              </ul>
            </SidebarBlock>
          )}
          {s.unsubscribeUrls.length > 0 && (
            <SidebarBlock
              title="Unsubscribe"
              icon={<ScrollText className="h-3.5 w-3.5" />}
            >
              <ul className="space-y-1 text-xs">
                {s.unsubscribeUrls.map((u) => (
                  <li key={u}>
                    <a
                      href={u}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-ink-600 hover:underline dark:text-ink-300"
                    >
                      Unsubscribe link
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </li>
                ))}
              </ul>
            </SidebarBlock>
          )}
        </aside>
      </div>
    </div>
  );
}

function SidebarBlock({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-ink-200 p-3 dark:border-ink-800">
      <div className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-ink-500">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function Portrait({ sender }: { sender: Sender }) {
  if (sender.logoUrl) {
    return (
      <img
        src={sender.logoUrl}
        alt={sender.name}
        className="h-20 w-20 shrink-0 rounded-lg bg-white object-contain ring-1 ring-ink-200 dark:ring-ink-700"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    );
  }
  return (
    <span className="inline-flex h-20 w-20 shrink-0 items-center justify-center rounded-lg bg-rose-50 font-serif text-3xl font-bold text-rose-700 ring-1 ring-rose-100 dark:bg-rose-950/40 dark:text-rose-200 dark:ring-rose-900/60">
      {sender.name.charAt(0).toUpperCase()}
    </span>
  );
}

function SenderEditPanel({
  sender,
  onClose,
}: {
  sender: Sender;
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
        { name, logoUrl: logoUrl.trim() || null, summary },
      ),
    onSuccess: () => {
      toast.success('Sender saved');
      qc.invalidateQueries({ queryKey: ['sender', sender.brandKey] });
      qc.invalidateQueries({ queryKey: ['senders'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
      qc.invalidateQueries({ queryKey: ['codex'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <form
      className="card mt-4 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label className="block text-xs">
        <span className="mb-1 block font-medium text-ink-700 dark:text-ink-200">
          Display name
        </span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </label>
      <label className="block text-xs">
        <span className="mb-1 block font-medium text-ink-700 dark:text-ink-200">
          Logo URL
        </span>
        <input
          className="input"
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          placeholder="https://example.com/logo.svg"
        />
      </label>
      <label className="block text-xs">
        <span className="mb-1 block font-medium text-ink-700 dark:text-ink-200">
          "Who is this" summary
        </span>
        <textarea
          className="input min-h-[100px]"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          maxLength={600}
        />
      </label>
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
