import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useApi } from '../../lib/api';

const TABS = [
  { to: 'account', label: 'Account' },
  { to: 'newsletter', label: 'Newsletter' },
  { to: 'sources', label: 'Sources' },
  { to: 'ingest', label: 'Ingest' },
  { to: 'senders', label: 'Senders' },
  { to: 'rules', label: 'Rules' },
  { to: 'integrations', label: 'Integrations' },
  { to: 'instructions', label: 'Instructions' },
  { to: 'models', label: 'Models' },
  { to: 'daydream', label: 'Daydream' },
  { to: 'maps', label: 'Maps' },
  { to: 'tags', label: 'Tags' },
  { to: 'entities', label: 'Entities' },
  { to: 'library', label: 'Library' },
  { to: 'spam', label: 'Spam' },
];

export default function SettingsLayout() {
  const api = useApi();
  // Plan 16 — surface the Admin tab only to the user whose email
  // matches `ADMIN_EMAIL` server-side. Cheap (one cached query)
  // and the underlying endpoint is unauthenticated-safe (returns
  // `isAdmin: false` for non-admins).
  const { data: adminInfo } = useQuery({
    queryKey: ['admin-me'],
    queryFn: () => api.get<{ isAdmin: boolean }>('/api/admin/me'),
    staleTime: 5 * 60 * 1000,
  });
  const tabs = adminInfo?.isAdmin
    ? [...TABS, { to: 'admin', label: 'Admin' }]
    : TABS;
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mb-6 text-sm text-ink-500">Configure how Rose ingests and writes.</p>
      {/* Two-column layout: vertical tab list on the left, panel on
          the right. The list is sticky from below the top bar so a
          long settings panel doesn't take the navigation off-screen.
          On <md the tabs collapse to a horizontal scrollable strip
          (the original layout) so mobile doesn't waste vertical
          space. */}
      <div className="grid gap-6 md:grid-cols-[200px_1fr]">
        <nav
          className="flex gap-1 overflow-x-auto border-b border-ink-200 pb-2 md:sticky md:top-20 md:flex-col md:overflow-visible md:border-b-0 md:border-r md:pb-0 md:pr-3 dark:border-ink-800"
          aria-label="Settings sections"
        >
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              className={({ isActive }) =>
                clsx(
                  // Horizontal pill on mobile, full-width row on md+.
                  'shrink-0 rounded-lg px-3 py-2 text-sm transition-colors md:w-full md:text-left',
                  isActive
                    ? t.to === 'admin'
                      ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                      : 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
                    : t.to === 'admin'
                      ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/20'
                      : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-ink-800 dark:hover:text-ink-100',
                )
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
