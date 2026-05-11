import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive as ArchiveIcon,
  Ban,
  Clock,
  FileText,
  Mail,
  Reply,
  ShieldAlert,
  Zap,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';

/**
 * Quick-triage mode. Keyboard-only review of unprocessed emails:
 * j/k to walk the queue, single-letter verbs to act, an instant
 * preview pane to the right of the list.
 *
 *   j / ↓     next
 *   k / ↑     previous
 *   o / ⏎     open the email's full view
 *   a         archive (skip into the soft-archive)
 *   s         mark sender as spam (auto-archives + cascades to pages)
 *   b         block sender (deletes existing pages / emails)
 *   p         page it (queue page generation)
 *   d         defer 24 hours
 *   D         defer 1 week
 *   r         open reply composer
 *
 * Actions are optimistic: the row disappears from the list
 * immediately, the cursor stays at the same index so the next
 * email slides into focus, and a toast confirms the side-effect
 * with an undo hint where appropriate.
 */

type TriageEmail = {
  _id: string;
  subject: string;
  from?: { address?: string; name?: string };
  date?: string | null;
  text?: string | null;
  snippet?: string | null;
  ingestStatus?: string;
  spamScore?: number;
  flags?: {
    hasLikelySpam?: boolean;
    hasMassMailing?: boolean;
    isPromotional?: boolean;
  };
  pageId?: string | null;
  pageSlug?: string | null;
};

export default function TriagePage() {
  const api = useApi();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [cursor, setCursor] = useState(0);
  // Local mutation queue: action endpoints are fire-and-forget so
  // the UI doesn't pause between keystrokes. We track in-flight
  // ids so a fast-typing user doesn't double-act on the same row.
  const inFlightRef = useRef<Set<string>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ['triage'],
    queryFn: () =>
      api.get<{ emails: TriageEmail[]; total: number }>(
        '/api/emails/triage?limit=100',
      ),
    refetchOnWindowFocus: false,
  });
  const emails = useMemo(() => data?.emails ?? [], [data?.emails]);

  // Clamp cursor when the list shrinks (e.g. after an action).
  useEffect(() => {
    if (cursor >= emails.length && emails.length > 0) {
      setCursor(emails.length - 1);
    }
  }, [emails.length, cursor]);

  const current = emails[cursor] ?? null;

  // Optimistic remove + advance. The queue invalidation refreshes
  // any related views (Ingest queue, Home digest counters) without
  // blocking the keystroke.
  const removeOne = useCallback(
    (id: string) => {
      qc.setQueryData<{ emails: TriageEmail[]; total: number }>(
        ['triage'],
        (prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            emails: prev.emails.filter((e) => e._id !== id),
            total: Math.max(0, prev.total - 1),
          };
        },
      );
      qc.invalidateQueries({ queryKey: ['emails'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
    },
    [qc],
  );

  const act = useCallback(
    async (
      verb: 'archive' | 'spam' | 'block' | 'page' | 'defer' | 'defer-long' | 'reply' | 'open',
    ) => {
      if (!current) return;
      const id = current._id;
      if (inFlightRef.current.has(id) && verb !== 'open' && verb !== 'reply') {
        return;
      }
      const fromAddr = current.from?.address ?? null;
      try {
        if (verb === 'open') {
          navigate(`/e/${id}`);
          return;
        }
        if (verb === 'reply') {
          // Email detail page exposes a reply composer; route there
          // with a hash so it can auto-open.
          navigate(`/e/${id}#reply`);
          return;
        }
        inFlightRef.current.add(id);
        // The bookkeeping for every "remove from queue" verb is
        // the same: optimistic remove, server call, on-error
        // re-invalidate. We split the routing inside the switch.
        removeOne(id);
        if (verb === 'archive') {
          await api.post(`/api/emails/${id}/archive`, {});
          toast.success('Archived');
        } else if (verb === 'spam') {
          if (!fromAddr) {
            toast.error('No sender address — archived instead.');
            await api.post(`/api/emails/${id}/archive`, {});
          } else {
            await api.post('/api/spam/sender', { address: fromAddr });
            await api.post(`/api/emails/${id}/archive`, {});
            toast.success(`Marked ${fromAddr} as spam`);
          }
        } else if (verb === 'block') {
          if (!fromAddr) {
            toast.error('No sender address — archived instead.');
            await api.post(`/api/emails/${id}/archive`, {});
          } else {
            await api.post('/api/spam/block', {
              address: fromAddr,
              removeExisting: true,
            });
            toast.success(`Blocked ${fromAddr}`);
          }
        } else if (verb === 'page') {
          await api.post(`/api/emails/${id}/regenerate`, {});
          toast.success('Queued for page generation');
        } else if (verb === 'defer') {
          await api.post(`/api/emails/${id}/defer`, { hours: 24 });
          toast.success('Deferred for 24 hours');
        } else if (verb === 'defer-long') {
          await api.post(`/api/emails/${id}/defer`, { hours: 24 * 7 });
          toast.success('Deferred for 1 week');
        }
      } catch (err) {
        // Roll back the optimistic remove on failure.
        toast.error((err as Error).message);
        qc.invalidateQueries({ queryKey: ['triage'] });
      } finally {
        inFlightRef.current.delete(id);
      }
    },
    [api, current, navigate, qc, removeOne],
  );

  // Keyboard handler — capture-phase + stopImmediatePropagation so
  // we run before the global Shell hotkey handler AND prevent it
  // from also firing. Without this, pressing `n` in the queue
  // would race the global "go to ingest" binding.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const handled = (cb: () => void) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        cb();
      };
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          handled(() => setCursor((c) => Math.min(emails.length - 1, c + 1)));
          break;
        case 'k':
        case 'ArrowUp':
          handled(() => setCursor((c) => Math.max(0, c - 1)));
          break;
        case 'o':
        case 'Enter':
          handled(() => void act('open'));
          break;
        case 'a':
          handled(() => void act('archive'));
          break;
        case 's':
          handled(() => void act('spam'));
          break;
        case 'b':
          handled(() => void act('block'));
          break;
        case 'p':
          handled(() => void act('page'));
          break;
        case 'd':
          handled(() =>
            void act(e.shiftKey ? 'defer-long' : 'defer'),
          );
          break;
        case 'D':
          handled(() => void act('defer-long'));
          break;
        case 'r':
          handled(() => void act('reply'));
          break;
        default:
          break;
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [emails.length, act]);

  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-8">
      <header className="mb-4 flex items-baseline gap-3">
        <Zap className="h-5 w-5 text-rose-500" />
        <h1 className="text-2xl font-semibold tracking-tight">Triage</h1>
        <span className="text-sm text-ink-500">
          {data?.total ?? 0} email{(data?.total ?? 0) === 1 ? '' : 's'} pending
        </span>
        <Link
          to="/settings/ingest"
          className="ml-auto text-xs text-ink-500 hover:underline"
        >
          Ingest queue →
        </Link>
      </header>

      {isLoading ? (
        <div className="card text-sm text-ink-500">Loading…</div>
      ) : emails.length === 0 ? (
        <div className="card text-center text-sm text-ink-500">
          <Mail className="mx-auto mb-2 h-6 w-6 text-rose-500" />
          Inbox zero. Nothing pending review — go reward yourself.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <ol className="space-y-1 overflow-hidden text-sm">
            {emails.map((e, i) => (
              <li key={e._id}>
                <button
                  type="button"
                  onClick={() => setCursor(i)}
                  className={
                    'flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors ' +
                    (i === cursor
                      ? 'border-rose-300 bg-rose-50 dark:border-rose-700 dark:bg-rose-950/20'
                      : 'border-ink-200 hover:border-rose-300 dark:border-ink-800 dark:hover:border-rose-800')
                  }
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-xs text-ink-500">
                        {e.from?.address ?? '—'}
                      </span>
                      {(e.flags?.hasLikelySpam || (e.spamScore ?? 0) > 0.5) && (
                        <span className="rounded bg-amber-100 px-1 text-[10px] uppercase text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                          spam-ish
                        </span>
                      )}
                      {e.flags?.isPromotional && (
                        <span className="rounded bg-ink-100 px-1 text-[10px] uppercase text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                          promo
                        </span>
                      )}
                    </div>
                    <div className="truncate font-medium">
                      {e.subject || '(no subject)'}
                    </div>
                    <div className="mt-0.5 text-[11px] text-ink-500">
                      {e.date ? new Date(e.date).toLocaleString() : ''}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ol>

          <PreviewPane email={current} />
        </div>
      )}

      <Keymap />
    </div>
  );
}

function PreviewPane({ email }: { email: TriageEmail | null }) {
  const api = useApi();
  const { data } = useQuery({
    queryKey: ['triage-detail', email?._id],
    queryFn: () => api.get<TriageEmail>(`/api/emails/${email?._id}`),
    enabled: !!email?._id,
  });
  const full = data ?? email;
  if (!email || !full) {
    return (
      <div className="card sticky top-20 text-sm text-ink-500">
        Pick an email to preview, or press <kbd>j</kbd>.
      </div>
    );
  }
  return (
    <div className="card sticky top-20 max-h-[calc(100vh-7rem)] overflow-auto">
      <header className="mb-3 border-b border-ink-200 pb-3 dark:border-ink-800">
        <h2 className="text-lg font-semibold">
          {full.subject || '(no subject)'}
        </h2>
        <div className="mt-1 text-xs text-ink-500">
          From <code>{full.from?.address ?? '—'}</code>
          {full.date && (
            <>
              {' · '}
              {new Date(full.date).toLocaleString()}
            </>
          )}
        </div>
      </header>
      <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
        {(full.text ?? full.snippet ?? '').slice(0, 8000)}
      </pre>
    </div>
  );
}

function Keymap() {
  const entries: { key: string; label: string; icon?: typeof ArchiveIcon }[] = [
    { key: 'j / k', label: 'next / prev' },
    { key: 'o / ↵', label: 'open', icon: Mail },
    { key: 'a', label: 'archive', icon: ArchiveIcon },
    { key: 's', label: 'sender spam', icon: ShieldAlert },
    { key: 'b', label: 'block sender', icon: Ban },
    { key: 'p', label: 'page it', icon: FileText },
    { key: 'd / D', label: 'defer 24h / 1wk', icon: Clock },
    { key: 'r', label: 'reply', icon: Reply },
  ];
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 border-t border-ink-200 bg-white/95 px-4 py-1.5 backdrop-blur dark:border-ink-800 dark:bg-ink-900/95">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-500">
        {entries.map((e) => (
          <span key={e.key} className="inline-flex items-center gap-1">
            <kbd className="rounded border border-ink-300 bg-ink-50 px-1 py-0.5 font-mono text-[10px] dark:border-ink-700 dark:bg-ink-800">
              {e.key}
            </kbd>
            {e.icon && <e.icon className="h-3 w-3" />}
            {e.label}
          </span>
        ))}
      </div>
    </div>
  );
}
