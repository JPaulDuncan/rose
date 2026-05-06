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
      <div className="mb-6 flex gap-1 border-b border-ink-200 dark:border-ink-800">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) =>
              clsx(
                'rounded-t-lg px-3 py-2 text-sm',
                isActive
                  ? 'border-b-2 border-rose-500 text-rose-700 dark:text-rose-300'
                  : t.to === 'admin'
                    ? 'text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300'
                    : 'text-ink-500 hover:text-ink-900 dark:hover:text-ink-100',
              )
            }
          >
            {t.label}
          </NavLink>
        ))}
      </div>
      <Outlet />
    </div>
  );
}
