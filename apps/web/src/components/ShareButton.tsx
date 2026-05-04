import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Share2, Copy, X, Lock, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';

/** Inline Share-link creator for a single wiki page. Pops a small
 *  drawer with optional password / expiry / label, and on save shows
 *  the new public URL with a copy button. */
export function ShareButton({ pageId, pageTitle }: { pageId: string; pageTitle: string }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<string>('');
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<{ url: string; slug: string } | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const expiresAt =
        expiresInDays && Number(expiresInDays) > 0
          ? new Date(Date.now() + Number(expiresInDays) * 24 * 3600 * 1000).toISOString()
          : undefined;
      return api.post<{ slug: string; url: string }>('/api/share', {
        targetType: 'page',
        targetId: pageId,
        password: password.trim() || undefined,
        expiresAt,
        label: label.trim() || undefined,
      });
    },
    onSuccess: (r) => setCreated({ url: r.url, slug: r.slug }),
    onError: (e: Error) => toast.error(e.message),
  });

  if (!open) {
    return (
      <button
        type="button"
        className="btn-secondary"
        onClick={() => setOpen(true)}
      >
        <Share2 className="h-4 w-4" /> Share
      </button>
    );
  }

  return (
    <div className="card mt-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <Share2 className="h-4 w-4 text-rose-500" />
          <span className="font-semibold">Share "{pageTitle}"</span>
        </div>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            setOpen(false);
            setCreated(null);
            setPassword('');
            setLabel('');
            setExpiresInDays('');
          }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {created ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs dark:border-emerald-800 dark:bg-emerald-950/30">
          <div className="mb-2 font-semibold">Public link ready.</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-white px-2 py-1 font-mono text-[11px] dark:bg-ink-950">
              {created.url}
            </code>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                void navigator.clipboard.writeText(created.url).catch(() => null);
                toast.success('Copied');
              }}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            <a href={created.url} target="_blank" rel="noreferrer" className="btn-ghost">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
          <p className="mt-2 text-[11px] text-ink-500">
            Manage and revoke share links from Settings → Integrations.
          </p>
        </div>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label className="block text-xs">
            <span className="mb-1 block font-medium">Label (optional)</span>
            <input
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder='e.g. "for Alice"'
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs">
              <span className="mb-1 block font-medium">
                <Lock className="mr-1 inline h-3 w-3" />
                Password (optional)
              </span>
              <input
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block font-medium">Expires in days (optional)</span>
              <input
                className="input"
                type="number"
                min="1"
                max="365"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                placeholder="never"
              />
            </label>
          </div>
          <div className="flex justify-end gap-2 text-xs">
            <button type="submit" className="btn-primary" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create link'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
