import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';
import { useApi } from '../../lib/api';

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

      <DangerZone />

      <button className="btn-secondary" onClick={logout}>
        Sign out
      </button>
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
