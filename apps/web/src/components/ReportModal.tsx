import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Bug, Lightbulb, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';

/**
 * Modal that lets a user file a bug or feature request from
 * anywhere in the app. Bug reports auto-collect the current route +
 * a small set of browser vitals so the admin reviewing has enough
 * context to reproduce without back-and-forth. The user can opt out
 * of attaching the metadata via the "Include browser details"
 * checkbox — Rose's "egress is opt-in" hygiene applies to bug
 * reports too.
 */
export function ReportModal({
  open,
  onClose,
  initialKind = 'bug',
}: {
  open: boolean;
  onClose: () => void;
  initialKind?: 'bug' | 'feature';
}) {
  const api = useApi();
  const location = useLocation();
  const [kind, setKind] = useState<'bug' | 'feature'>(initialKind);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [includeMeta, setIncludeMeta] = useState(true);

  // Reset on open so a previously-cancelled report doesn't leak.
  useEffect(() => {
    if (!open) return;
    setKind(initialKind);
    setTitle('');
    setBody('');
    setIncludeMeta(true);
  }, [open, initialKind]);

  // Snapshot the metadata at modal-open time. Recomputed when
  // route changes so reopening the modal reflects the new context.
  const metadata = useMemo(() => {
    if (typeof window === 'undefined') return null;
    return {
      route: location.pathname + location.search,
      userAgent: navigator.userAgent.slice(0, 500),
      screen: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      locale: navigator.language ?? null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
      // Vite injects this when VITE_APP_VERSION is set at build
      // time. Falls through to null so dev builds don't lie about
      // the version.
      appVersion:
        (import.meta as unknown as { env?: { VITE_APP_VERSION?: string } })
          .env?.VITE_APP_VERSION ?? null,
    };
  }, [location.pathname, location.search]);

  const submit = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        kind,
        title: title.trim(),
        body: body.trim(),
      };
      // Attach metadata only when the user opted in AND the kind
      // is 'bug'. Feature requests don't need browser vitals.
      if (kind === 'bug' && includeMeta && metadata) {
        Object.assign(payload, metadata);
      }
      return api.post<{ _id: string }>('/api/reports', payload);
    },
    onSuccess: () => {
      toast.success(
        kind === 'bug'
          ? 'Bug filed — thanks. Track status in Settings → Reports.'
          : 'Feature request filed — thanks!',
      );
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-16"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl rounded-xl bg-white p-5 shadow-2xl dark:bg-ink-900">
        <div className="mb-3 flex items-center gap-2">
          <span className="text-base font-semibold">Report an issue</span>
          <button
            type="button"
            className="ml-auto btn-ghost"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-3 inline-flex rounded-md border border-ink-200 p-0.5 text-xs dark:border-ink-800">
          <button
            type="button"
            className={
              'inline-flex items-center gap-1 rounded px-3 py-1 ' +
              (kind === 'bug'
                ? 'bg-rose-500 text-white'
                : 'text-ink-600 dark:text-ink-300')
            }
            onClick={() => setKind('bug')}
          >
            <Bug className="h-3.5 w-3.5" /> Bug
          </button>
          <button
            type="button"
            className={
              'inline-flex items-center gap-1 rounded px-3 py-1 ' +
              (kind === 'feature'
                ? 'bg-rose-500 text-white'
                : 'text-ink-600 dark:text-ink-300')
            }
            onClick={() => setKind('feature')}
          >
            <Lightbulb className="h-3.5 w-3.5" /> Feature
          </button>
        </div>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim() || !body.trim()) return;
            submit.mutate();
          }}
        >
          <label className="block text-xs">
            <span className="mb-1 block font-medium">
              {kind === 'bug' ? 'What went wrong?' : "What's the idea?"}
            </span>
            <input
              className="input"
              autoFocus
              maxLength={200}
              placeholder={
                kind === 'bug'
                  ? 'Short summary'
                  : 'One-line title for the request'
              }
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium">Details</span>
            <textarea
              className="input min-h-[140px] font-mono text-xs"
              maxLength={10_000}
              placeholder={
                kind === 'bug'
                  ? 'Steps to reproduce, what you expected, what happened.'
                  : "Describe the problem the feature solves and how you'd like it to work."
              }
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
            />
          </label>

          {kind === 'bug' && metadata && (
            <div className="rounded-lg border border-ink-200 bg-ink-50/40 p-3 text-xs dark:border-ink-800 dark:bg-ink-900/40">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={includeMeta}
                  onChange={(e) => setIncludeMeta(e.target.checked)}
                  className="h-3.5 w-3.5 accent-rose-500"
                />
                <span className="font-medium">Include browser details</span>
              </label>
              {includeMeta && (
                <ul className="mt-2 space-y-0.5 text-[11px] text-ink-500">
                  <li>
                    <strong>Page:</strong> <code>{metadata.route}</code>
                  </li>
                  <li>
                    <strong>Viewport:</strong>{' '}
                    {metadata.screen.width}×{metadata.screen.height}
                    {metadata.screen.devicePixelRatio
                      ? ` @ ${metadata.screen.devicePixelRatio}x`
                      : ''}
                  </li>
                  <li>
                    <strong>Browser:</strong>{' '}
                    <code className="break-all">{metadata.userAgent}</code>
                  </li>
                  <li>
                    <strong>Locale / TZ:</strong> {metadata.locale ?? '—'}
                    {' / '}
                    {metadata.timezone ?? '—'}
                  </li>
                  {metadata.appVersion && (
                    <li>
                      <strong>App version:</strong>{' '}
                      <code>{metadata.appVersion}</code>
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary text-xs"
              disabled={
                submit.isPending || !title.trim() || !body.trim()
              }
            >
              {submit.isPending ? 'Sending…' : 'Submit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
