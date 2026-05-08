import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ExternalLink,
  Flame,
  ShieldAlert,
  Megaphone,
  Paperclip,
  Tag as TagIcon,
  LinkIcon,
  Mail,
  AtSign,
  Calendar,
  FileText,
  Code2,
  Reply as ReplyIcon,
  Trash2,
  Ban,
  ShieldOff,
  ShieldCheck,
  ChevronDown,
  Zap,
  Sparkles,
  X as XIcon,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';
import { DraftReply } from '../components/DraftReply';
import { RecipeWizard, type RecipeFormValues } from '../components/RecipeWizard';
import { LinksCard, CountedSection } from '../components/LinksCard';

type EmailDetail = {
  _id: string;
  subject: string;
  from?: { name?: string; address?: string } | null;
  to?: { name?: string; address?: string }[];
  cc?: { name?: string; address?: string }[];
  date?: string | null;
  text?: string;
  rawText?: string;
  html?: string | null;
  attachments?: { filename: string; contentType: string; size: number }[];
  priority?: 'high' | 'normal' | 'low';
  topics?: string[];
  links?: { url: string; text?: string | null }[];
  spamScore?: number;
  spamSignals?: string[];
  isMassMailing?: boolean;
  ingestStatus?: string;
  pageId?: string | null;
  threadKey?: string | null;
  subjectTemplate?: string | null;
  createdAt?: string;
  draftReply?: string | null;
  draftReplyMeta?: {
    model?: string | null;
    generatedAt?: string | null;
    edits?: number;
  } | null;
  sourceId?: string | null;
  messageId?: string | null;
  unsubscribeUrls?: string[];
};

type SpamPolicy = {
  senders: string[];
  tags: string[];
  blockedSenders: string[];
  whitelistedSenders?: string[];
};

export default function EmailView() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [replyOpen, setReplyOpen] = useState(false);
  const [recipeSeed, setRecipeSeed] = useState<RecipeFormValues | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['email', id],
    queryFn: () => api.get<EmailDetail>(`/api/emails/${id}`),
    enabled: !!id,
  });

  // Look up the article slug if this email contributed to one.
  const { data: pageInfo } = useQuery({
    queryKey: ['email-page', data?.pageId],
    queryFn: () =>
      api.get<{ slug: string; title: string }>(`/api/pages/${data!.pageId}`),
    enabled: !!data?.pageId,
  });

  const { data: spamPolicy } = useQuery({
    queryKey: ['spam-policy'],
    queryFn: () => api.get<SpamPolicy>('/api/spam'),
  });
  const senderAddr = data?.from?.address?.toLowerCase() ?? '';
  const isSpamMarked = !!senderAddr && (spamPolicy?.senders ?? []).includes(senderAddr);
  const isBlocked = !!senderAddr && (spamPolicy?.blockedSenders ?? []).includes(senderAddr);
  const isWhitelisted =
    !!senderAddr && (spamPolicy?.whitelistedSenders ?? []).includes(senderAddr);

  const deleteLocal = useMutation({
    mutationFn: async () => api.del<{ ok: true }>(`/api/emails/${id}`),
    onSuccess: () => {
      toast.success('Removed from your inbox');
      qc.invalidateQueries({ queryKey: ['emails'] });
      navigate(pageInfo ? `/p/${pageInfo.slug}` : '/settings/ingest');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const deleteOnSource = useMutation({
    mutationFn: async () =>
      api.post<{ ok: true; deletedOnSource: boolean; message?: string }>(
        `/api/emails/${id}/delete-on-source`,
      ),
    onSuccess: (r) => {
      if (r.deletedOnSource) {
        toast.success('Removed from the source mailbox');
      } else {
        toast.success(r.message ?? 'Removed locally only');
      }
      qc.invalidateQueries({ queryKey: ['emails'] });
      navigate(pageInfo ? `/p/${pageInfo.slug}` : '/settings/ingest');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const markSpam = useMutation({
    mutationFn: async () =>
      api.post<{ ok: true; pagesAffected: number }>('/api/spam/sender', {
        address: senderAddr,
      }),
    onSuccess: (r) => {
      toast.success(
        `Marked ${senderAddr} as spam${r.pagesAffected ? ` · ${r.pagesAffected} page(s) hidden` : ''}`,
      );
      qc.invalidateQueries({ queryKey: ['spam-policy'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const unmarkSpam = useMutation({
    mutationFn: async () =>
      api.del<{ ok: true }>(`/api/spam/sender/${encodeURIComponent(senderAddr)}`),
    onSuccess: () => {
      toast.success('Unmarked');
      qc.invalidateQueries({ queryKey: ['spam-policy'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const blockSender = useMutation({
    mutationFn: async () =>
      api.post<{
        ok: true;
        emailsDeleted: number;
        pagesDeleted: number;
        pagesPruned: number;
      }>('/api/spam/block', { address: senderAddr, removeExisting: true }),
    onSuccess: (r) => {
      toast.success(
        `Blocked ${senderAddr} · removed ${r.emailsDeleted} email(s), ${r.pagesDeleted} page(s)`,
      );
      qc.invalidateQueries({ queryKey: ['spam-policy'] });
      qc.invalidateQueries({ queryKey: ['emails'] });
      navigate('/settings/ingest');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const unblockSender = useMutation({
    mutationFn: async () =>
      api.del<{ ok: true }>(`/api/spam/block/${encodeURIComponent(senderAddr)}`),
    onSuccess: () => {
      toast.success('Unblocked — future mail from this sender will ingest normally');
      qc.invalidateQueries({ queryKey: ['spam-policy'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const whitelistSender = useMutation({
    mutationFn: async () =>
      api.post<{ ok: true }>('/api/spam/whitelist', { address: senderAddr }),
    onSuccess: () => {
      toast.success('Trusted — bypasses blocklist + classifier');
      qc.invalidateQueries({ queryKey: ['spam-policy'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const unwhitelistSender = useMutation({
    mutationFn: async () =>
      api.del<{ ok: true }>(`/api/spam/whitelist/${encodeURIComponent(senderAddr)}`),
    onSuccess: () => {
      toast.success('Removed from trusted senders');
      qc.invalidateQueries({ queryKey: ['spam-policy'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Default to HTML when present (it's almost always the most useful render
  // for marketing/notification mail); fall back to plain text otherwise.
  const initialView: 'text' | 'html' | 'raw' = data?.html
    ? 'html'
    : data?.text || data?.rawText
      ? 'text'
      : 'raw';
  const [viewOverride, setViewOverride] = useState<'text' | 'html' | 'raw' | null>(null);
  const view = viewOverride ?? initialView;
  const setView = (v: 'text' | 'html' | 'raw') => setViewOverride(v);

  if (isLoading || !data) {
    if (error) {
      return (
        <div className="mx-auto max-w-6xl px-6 py-10 text-sm text-red-600">
          Couldn't load email: {(error as Error).message}
        </div>
      );
    }
    return <div className="px-6 py-10 text-ink-500">Loading email…</div>;
  }

  const fromLabel = data.from?.name
    ? `${data.from.name} <${data.from.address ?? '?'}>`
    : data.from?.address ?? 'unknown sender';
  const toList = (data.to ?? []).map((a) => a.address).filter(Boolean) as string[];
  const ccList = (data.cc ?? []).map((a) => a.address).filter(Boolean) as string[];
  const date = data.date ? new Date(data.date) : data.createdAt ? new Date(data.createdAt) : null;

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link
        to={pageInfo ? `/p/${pageInfo.slug}` : '/settings/ingest'}
        className="mb-4 inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-900 dark:hover:text-ink-100"
      >
        <ArrowLeft className="h-3 w-3" /> {pageInfo ? `Back to “${pageInfo.title}”` : 'Back to ingest queue'}
      </Link>

      <header className="mb-6 border-b border-ink-200 pb-4 dark:border-ink-800">
        <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-rose-500">
          <Mail className="h-3.5 w-3.5" />
          Original email
        </div>
        <h1 className="mt-1 break-words text-2xl font-semibold tracking-tight">
          {data.subject || '(no subject)'}
        </h1>

        <div className="mt-3 grid gap-1 text-sm sm:grid-cols-[100px_1fr]">
          <span className="text-ink-500">From</span>
          <code className="text-xs">{fromLabel}</code>
          {toList.length > 0 && (
            <>
              <span className="text-ink-500">To</span>
              <code className="text-xs">{toList.join(', ')}</code>
            </>
          )}
          {ccList.length > 0 && (
            <>
              <span className="text-ink-500">Cc</span>
              <code className="text-xs">{ccList.join(', ')}</code>
            </>
          )}
          {date && (
            <>
              <span className="text-ink-500">Date</span>
              <span className="inline-flex items-center gap-1 text-xs">
                <Calendar className="h-3 w-3" />
                {date.toLocaleString()}
              </span>
            </>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {data.priority === 'high' && (
            <Badge tone="rose" icon={<Flame className="h-3 w-3" />}>
              High priority
            </Badge>
          )}
          {(data.spamScore ?? 0) >= 0.5 && (
            <Badge
              tone="red"
              icon={<ShieldAlert className="h-3 w-3" />}
              title={data.spamSignals?.join('; ')}
            >
              Likely spam · {Math.round((data.spamScore ?? 0) * 100)}%
            </Badge>
          )}
          {data.isMassMailing && (data.spamScore ?? 0) < 0.5 && (
            <Badge tone="ink" icon={<Megaphone className="h-3 w-3" />}>
              Bulk mail
            </Badge>
          )}
          {data.attachments && data.attachments.length > 0 && (
            <Badge tone="ink" icon={<Paperclip className="h-3 w-3" />}>
              {data.attachments.length} attachment
              {data.attachments.length === 1 ? '' : 's'}
            </Badge>
          )}
          {data.ingestStatus && (
            <Badge tone="ink">status: {data.ingestStatus}</Badge>
          )}
          {pageInfo && (
            <Link
              to={`/p/${pageInfo.slug}`}
              className="ml-auto inline-flex items-center gap-1 rounded-full border border-rose-300 px-2 py-0.5 font-medium text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/30"
            >
              Open article <ExternalLink className="h-3 w-3" />
            </Link>
          )}
        </div>
      </header>

      <EmailActionsBar
        canDeleteOnSource={!!data.sourceId && !!data.messageId}
        unsubscribeUrl={data.unsubscribeUrls?.[0] ?? null}
        senderAddr={senderAddr}
        subject={data.subject ?? ''}
        isSpamMarked={isSpamMarked}
        isBlocked={isBlocked}
        isWhitelisted={isWhitelisted}
        onAddToRecipe={(kind) =>
          setRecipeSeed(seedFromEmail(kind, senderAddr, data.subject ?? ''))
        }
        onReply={() => setReplyOpen(true)}
        onWhitelist={() => whitelistSender.mutate()}
        onUnwhitelist={() => unwhitelistSender.mutate()}
        onDeleteLocal={() => {
          if (confirm('Remove this email from your inbox? It stays on the source mailbox.')) {
            deleteLocal.mutate();
          }
        }}
        onDeleteOnSource={() => {
          if (
            confirm(
              'Delete this message from the source mailbox (e.g. Gmail / IMAP)? This is moved to the source\'s Trash where possible — recoverable from the mail provider, not from Rose.',
            )
          ) {
            deleteOnSource.mutate();
          }
        }}
        onMarkSpam={() => markSpam.mutate()}
        onUnmarkSpam={() => unmarkSpam.mutate()}
        onBlock={() => {
          if (
            confirm(
              `Block ${senderAddr}?\n\n• Future mail from this sender is dropped during ingest (no Email row, no article).\n• Existing emails from this sender are deleted; articles where they were the only contributor are deleted too.\n• Reversible — unblock from Settings → Spam.`,
            )
          ) {
            blockSender.mutate();
          }
        }}
        onUnblock={() => unblockSender.mutate()}
        busy={
          deleteLocal.isPending ||
          deleteOnSource.isPending ||
          markSpam.isPending ||
          unmarkSpam.isPending ||
          blockSender.isPending ||
          unblockSender.isPending ||
          whitelistSender.isPending ||
          unwhitelistSender.isPending
        }
      />

      {/* Two-column layout below the toolbar — body + attachments
          on the left, reference rail (Topics → Links → Routing) on
          the right. `minmax(0, …fr)` rather than bare `fr` so a
          long unbreakable token in the rail can't squeeze the body
          column. */}
      <div className="mt-2 grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
        <div className="min-w-0 space-y-4">
          <BodyTabs view={view} setView={setView} hasHtml={!!data.html} hasRaw={!!data.rawText} />
          <div>
            {view === 'text' && <TextBody text={data.text || data.rawText || ''} />}
            {view === 'html' && data.html && <HtmlBody html={data.html} />}
            {view === 'raw' && <TextBody text={data.rawText || data.text || ''} mono />}
          </div>

          {replyOpen && (
            <DraftReply email={data} open={replyOpen} onOpenChange={setReplyOpen} />
          )}
          {recipeSeed && (
            <AddToRecipePanel seed={recipeSeed} onClose={() => setRecipeSeed(null)} />
          )}

          {data.attachments && data.attachments.length > 0 && (
            <Section
              title={`Attachments (${data.attachments.length})`}
              icon={<Paperclip className="h-4 w-4 text-rose-500" />}
            >
              <ul className="space-y-1.5 text-sm">
                {data.attachments.map((a, i) => (
                  <li key={`${a.filename}-${i}`} className="flex items-center gap-2">
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                    <span className="min-w-0 flex-1 truncate font-medium">{a.filename}</span>
                    <span className="shrink-0 text-xs text-ink-500">{a.contentType}</span>
                    <span className="shrink-0 text-xs text-ink-400">{formatBytes(a.size)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          {data.topics && data.topics.length > 0 && (
            <CountedSection
              icon={<TagIcon className="h-4 w-4 text-rose-500" />}
              title="Topics"
              count={data.topics.length}
              collapseAt={20}
            >
              <div className="flex flex-wrap gap-1.5">
                {data.topics.map((t) => (
                  <Link
                    key={t}
                    to={`/t/${encodeURIComponent(t)}`}
                    className="pill hover:bg-rose-100 hover:text-rose-800 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
                  >
                    {t}
                  </Link>
                ))}
              </div>
            </CountedSection>
          )}

          {data.links && data.links.length > 0 && (
            <LinksCard links={data.links.map((l) => ({ url: l.url, text: l.text }))} />
          )}

          <CountedSection
            icon={<AtSign className="h-4 w-4 text-rose-500" />}
            title="Routing"
            count={
              1 +
              (data.threadKey ? 1 : 0) +
              (data.subjectTemplate ? 1 : 0)
            }
            collapseAt={2}
          >
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-ink-500">Email ID</dt>
              <dd className="min-w-0 truncate">
                <code className="text-[11px]">{data._id}</code>
              </dd>
              {data.threadKey && (
                <>
                  <dt className="text-ink-500">Thread key</dt>
                  <dd className="min-w-0 break-all">
                    <code className="text-[11px]">{data.threadKey}</code>
                  </dd>
                </>
              )}
              {data.subjectTemplate && (
                <>
                  <dt className="text-ink-500">Subject template</dt>
                  <dd className="min-w-0 break-words">
                    <code className="text-[11px]">{data.subjectTemplate}</code>
                  </dd>
                </>
              )}
            </dl>
          </CountedSection>
        </aside>
      </div>
    </div>
  );
}

/**
 * Toolbar above the body view. Reply / delete (locally or on the source
 * mailbox) / mark-or-block sender / unsubscribe. The "Delete" control
 * is a split button: the safe default is local-only ("Remove from
 * Rose"); the dropdown reveals "Delete on source" which actually
 * touches the upstream mailbox (IMAP move-to-trash, Gmail trash via
 * API). Disabled when the email has no source we can reach.
 */
function EmailActionsBar({
  canDeleteOnSource,
  unsubscribeUrl,
  senderAddr,
  subject,
  isSpamMarked,
  isBlocked,
  isWhitelisted,
  onReply,
  onDeleteLocal,
  onDeleteOnSource,
  onMarkSpam,
  onUnmarkSpam,
  onBlock,
  onUnblock,
  onWhitelist,
  onUnwhitelist,
  onAddToRecipe,
  busy,
}: {
  canDeleteOnSource: boolean;
  unsubscribeUrl: string | null;
  senderAddr: string;
  subject: string;
  isSpamMarked: boolean;
  isBlocked: boolean;
  isWhitelisted: boolean;
  onReply: () => void;
  onDeleteLocal: () => void;
  onDeleteOnSource: () => void;
  onMarkSpam: () => void;
  onUnmarkSpam: () => void;
  onBlock: () => void;
  onUnblock: () => void;
  onWhitelist: () => void;
  onUnwhitelist: () => void;
  onAddToRecipe: (kind: 'sender' | 'subject') => void;
  busy: boolean;
}) {
  const [deleteMenu, setDeleteMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  const deleteRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  // Close popovers on outside click.
  useEffect(() => {
    if (!deleteMenu && !moreMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (deleteMenu && !deleteRef.current?.contains(e.target as Node)) setDeleteMenu(false);
      if (moreMenu && !moreRef.current?.contains(e.target as Node)) setMoreMenu(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [deleteMenu, moreMenu]);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-ink-200 bg-ink-50 p-2 dark:border-ink-800 dark:bg-ink-900/50">
      <button
        type="button"
        className="btn-primary text-xs"
        onClick={onReply}
        disabled={busy}
        title="Open the LLM-drafted reply panel"
      >
        <Sparkles className="h-3.5 w-3.5" /> Draft reply
      </button>

      {/* Split delete: primary action is local-only; dropdown adds
          "delete on source" (IMAP / Gmail). */}
      <div ref={deleteRef} className="relative inline-flex">
        <button
          type="button"
          className="btn-secondary rounded-r-none text-xs"
          onClick={onDeleteLocal}
          disabled={busy}
          title="Remove from your Rose inbox; the message stays on the source mailbox."
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove
        </button>
        <button
          type="button"
          className="btn-secondary -ml-px rounded-l-none px-1.5 text-xs"
          onClick={() => setDeleteMenu((v) => !v)}
          disabled={busy}
          aria-label="More delete options"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
        {deleteMenu && (
          <div className="absolute left-0 top-full z-30 mt-1 min-w-[240px] rounded-lg border border-ink-200 bg-white p-1 text-xs shadow-lg dark:border-ink-800 dark:bg-ink-950">
            <button
              type="button"
              onClick={() => {
                setDeleteMenu(false);
                onDeleteLocal();
              }}
              className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-ink-100 dark:hover:bg-ink-800"
            >
              <Trash2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-500" />
              <span>
                <span className="font-medium">Remove from Rose</span>
                <span className="block text-[11px] text-ink-500">
                  Stays on the source mailbox.
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setDeleteMenu(false);
                onDeleteOnSource();
              }}
              disabled={!canDeleteOnSource}
              className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-300 dark:hover:bg-red-950/30"
            >
              <Trash2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <span className="font-medium">Delete on source</span>
                <span className="block text-[11px] opacity-80">
                  Moves the message to your source's Trash (IMAP / Gmail).
                  {!canDeleteOnSource && ' Not available — no upstream source.'}
                </span>
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Mark / unmark sender as spam. Toggle. */}
      {senderAddr && (
        isSpamMarked ? (
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={onUnmarkSpam}
            disabled={busy}
            title={`Unmark ${senderAddr} as spam`}
          >
            <ShieldCheck className="h-3.5 w-3.5" /> Unmark spam
          </button>
        ) : (
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={onMarkSpam}
            disabled={busy}
            title={`Mark ${senderAddr} as spam — hides existing pages from this sender and biases the spam classifier.`}
          >
            <ShieldAlert className="h-3.5 w-3.5" /> Mark sender spam
          </button>
        )
      )}

      {/* Block / unblock sender. Stronger than spam. */}
      {senderAddr && (
        isBlocked ? (
          <button
            type="button"
            className="btn-ghost text-xs text-emerald-700 dark:text-emerald-300"
            onClick={onUnblock}
            disabled={busy}
            title={`Unblock ${senderAddr}`}
          >
            <ShieldOff className="h-3.5 w-3.5" /> Unblock
          </button>
        ) : (
          <button
            type="button"
            className="btn-ghost text-xs text-red-700 dark:text-red-300"
            onClick={onBlock}
            disabled={busy}
            title={`Block ${senderAddr} — drops future messages at ingest and removes existing ones.`}
          >
            <Ban className="h-3.5 w-3.5" /> Block sender
          </button>
        )
      )}

      {/* Whitelist / un-whitelist sender. Counterpart to Block: forces
          this sender past the spam classifier even if the heuristics
          would otherwise flag them. */}
      {senderAddr && (
        isWhitelisted ? (
          <button
            type="button"
            className="btn-ghost text-xs text-ink-600 dark:text-ink-300"
            onClick={onUnwhitelist}
            disabled={busy}
            title={`Remove ${senderAddr} from your trusted-senders list.`}
          >
            <ShieldOff className="h-3.5 w-3.5" /> Untrust
          </button>
        ) : (
          <button
            type="button"
            className="btn-ghost text-xs text-emerald-700 dark:text-emerald-300"
            onClick={onWhitelist}
            disabled={busy}
            title={`Whitelist ${senderAddr} — always accept their mail past the spam filter.`}
          >
            <ShieldCheck className="h-3.5 w-3.5" /> Trust sender
          </button>
        )
      )}

      {/* Bonus actions tucked into a "More" popover so the bar stays
          tight on narrow screens. */}
      <div ref={moreRef} className="relative ml-auto">
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => setMoreMenu((v) => !v)}
          disabled={busy}
        >
          More <ChevronDown className="h-3 w-3" />
        </button>
        {moreMenu && (
          <div className="absolute right-0 top-full z-30 mt-1 min-w-[220px] rounded-lg border border-ink-200 bg-white p-1 text-xs shadow-lg dark:border-ink-800 dark:bg-ink-950">
            {unsubscribeUrl ? (
              <a
                href={unsubscribeUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setMoreMenu(false)}
                className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-ink-100 dark:hover:bg-ink-800"
              >
                <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-500" />
                <span>
                  <span className="font-medium">Unsubscribe</span>
                  <span className="block text-[11px] text-ink-500 truncate">
                    Opens the sender's unsubscribe URL in a new tab.
                  </span>
                </span>
              </a>
            ) : (
              <div className="px-2 py-1.5 text-[11px] text-ink-500">
                No unsubscribe URL in this email.
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setMoreMenu(false);
                navigator.clipboard
                  .writeText(window.location.href)
                  .then(() => toast.success('Link copied'))
                  .catch(() => toast.error('Copy failed'));
              }}
              className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-ink-100 dark:hover:bg-ink-800"
            >
              <LinkIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-500" />
              <span>
                <span className="font-medium">Copy link</span>
                <span className="block text-[11px] text-ink-500">
                  This email's URL.
                </span>
              </span>
            </button>
            <div className="my-1 border-t border-ink-200 dark:border-ink-800" />
            <button
              type="button"
              onClick={() => {
                setMoreMenu(false);
                onAddToRecipe('sender');
              }}
              disabled={!senderAddr}
              className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-ink-100 disabled:opacity-50 dark:hover:bg-ink-800"
            >
              <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />
              <span>
                <span className="font-medium">Add recipe — match this sender</span>
                <span className="block text-[11px] text-ink-500 truncate">
                  Pre-fills a recipe trigger on{' '}
                  <code className="text-[10px]">{senderAddr || '(no sender)'}</code>.
                </span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                setMoreMenu(false);
                onAddToRecipe('subject');
              }}
              disabled={!subject}
              className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-ink-100 disabled:opacity-50 dark:hover:bg-ink-800"
            >
              <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />
              <span>
                <span className="font-medium">Add recipe — match this subject</span>
                <span className="block text-[11px] text-ink-500 truncate">
                  Pre-fills a recipe trigger on the subject text.
                </span>
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function BodyTabs({
  view,
  setView,
  hasHtml,
  hasRaw,
}: {
  view: 'text' | 'html' | 'raw';
  setView: (v: 'text' | 'html' | 'raw') => void;
  hasHtml: boolean;
  hasRaw: boolean;
}) {
  return (
    <div className="flex gap-1 border-b border-ink-200 dark:border-ink-800">
      {hasHtml && (
        <TabButton active={view === 'html'} onClick={() => setView('html')}>
          <Code2 className="h-3.5 w-3.5" /> HTML
        </TabButton>
      )}
      <TabButton active={view === 'text'} onClick={() => setView('text')}>
        <FileText className="h-3.5 w-3.5" /> Plain text
      </TabButton>
      {hasRaw && (
        <TabButton active={view === 'raw'} onClick={() => setView('raw')}>
          Raw
        </TabButton>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'inline-flex items-center gap-1 px-3 py-1.5 text-sm border-b-2 -mb-px ' +
        (active
          ? 'border-rose-500 font-medium text-rose-700 dark:text-rose-300'
          : 'border-transparent text-ink-500 hover:text-ink-900 dark:hover:text-ink-100')
      }
    >
      {children}
    </button>
  );
}

function TextBody({ text, mono }: { text: string; mono?: boolean }) {
  if (!text.trim()) {
    return (
      <div className="card text-sm text-ink-500">No plain-text body for this email.</div>
    );
  }
  return (
    <pre
      className={
        'card whitespace-pre-wrap break-words text-sm leading-relaxed ' +
        (mono ? 'font-mono text-xs' : 'font-sans')
      }
    >
      {text}
    </pre>
  );
}

/**
 * HTML email renderer. We sandbox in an iframe so untrusted markup can't
 * touch the rest of the SPA, and we do a defensive strip of script/style
 * tags before injecting. The iframe gets `sandbox` (no scripts, no
 * top-navigation) and a `srcdoc` with the cleaned HTML.
 */
function HtmlBody({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const cleaned = useMemo(() => sanitizeHtml(html), [html]);
  const [tall, setTall] = useState(600);
  return (
    <div className="card !p-0 overflow-hidden">
      <iframe
        ref={ref}
        title="Email HTML body"
        srcDoc={cleaned}
        sandbox=""
        className="block w-full bg-white"
        style={{ height: tall }}
        onLoad={() => {
          try {
            const doc = ref.current?.contentDocument;
            const h = doc?.body?.scrollHeight ?? 600;
            setTall(Math.min(2000, Math.max(400, h + 16)));
          } catch {
            // sandbox may block inspection; keep default
          }
        }}
      />
    </div>
  );
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?<\/embed>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '#blocked-js:');
}

function Section({
  title,
  icon,
  muted,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={'card mt-4 ' + (muted ? 'opacity-70' : '')}>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Badge({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'rose' | 'red' | 'ink';
  icon?: React.ReactNode;
  title?: string;
  children: React.ReactNode;
}) {
  const cls =
    tone === 'rose'
      ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
      : tone === 'red'
        ? 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-200'
        : 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${cls}`}
      title={title}
    >
      {icon}
      {children}
    </span>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

/* ─── Add-to-recipe ─────────────────────────────────────────────── */

/**
 * Build a wizard-shaped seed from an email so the user lands in the
 * trigger-and-conditions step with the right filter pre-filled. The
 * returned shape matches RecipeFormValues so the wizard can drop
 * straight into edit mode.
 */
function seedFromEmail(
  kind: 'sender' | 'subject',
  senderAddr: string,
  subject: string,
): RecipeFormValues {
  const sender = senderAddr.trim();
  const subj = subject.trim();
  const config: Record<string, unknown> = {};
  if (kind === 'sender' && sender) {
    config.senderContains = sender;
  }
  if (kind === 'subject' && subj) {
    // Take the first 80 chars so the regex stays sane; the user can
    // still edit it down before saving.
    config.subjectContains = subj.slice(0, 80);
  }
  return {
    name:
      kind === 'sender'
        ? `Sender: ${sender || 'unknown'}`
        : `Subject: ${subj.slice(0, 40) || 'unknown'}`,
    description:
      kind === 'sender'
        ? 'Created from an email — match this sender.'
        : 'Created from an email — match this subject.',
    enabled: true,
    trigger: { kind: 'email.ingested', config },
    conditions: [],
    actions: [],
    cooldownSeconds: 0,
    fireLimitPerHour: 60,
  };
}

/**
 * Inline RecipeWizard host. Posts to /api/recipes on save and links
 * out to /settings/recipes for further editing. Slots into the email
 * detail view so the user never has to leave the message they were
 * looking at to author the rule.
 */
function AddToRecipePanel({
  seed,
  onClose,
}: {
  seed: RecipeFormValues;
  onClose: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: async (body: RecipeFormValues) =>
      api.post<{ _id: string }>('/api/recipes', body),
    onSuccess: () => {
      toast.success('Recipe created');
      void qc.invalidateQueries({ queryKey: ['recipes'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50/40 p-3 dark:border-rose-900/60 dark:bg-rose-950/20">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Zap className="h-4 w-4 text-rose-500" />
          Add to recipe
        </div>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={onClose}
          aria-label="Cancel"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <RecipeWizard
        initial={seed}
        onCancel={onClose}
        onSubmit={(values) => create.mutate(values)}
        submitting={create.isPending}
      />
    </div>
  );
}
