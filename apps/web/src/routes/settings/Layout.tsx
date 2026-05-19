import { NavLink, Outlet } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { useApi } from '../../lib/api';

/**
 * Settings sidebar grouped into themed sections. Pre-cleanup the
 * nav was 17 unsorted tabs in a flat list — hard to find anything.
 * Grouping by purpose (Profile / Inputs / Organisation / Automation
 * / Maintenance / Admin) cuts the visual surface without removing
 * any individual tab. Future consolidation can collapse tabs
 * within a group (e.g. Memory + Entities → one "Knowledge"); for
 * now this just sorts the existing list into the right buckets.
 */
type TabDef = { to: string; label: string; admin?: boolean };

const SECTIONS: { label: string; tabs: TabDef[] }[] = [
  {
    label: 'Profile',
    tabs: [
      { to: 'account', label: 'Account' },
      { to: 'newsletter', label: 'Newsletter' },
    ],
  },
  {
    label: 'Inputs',
    tabs: [
      { to: 'sources', label: 'Sources' },
      { to: 'library', label: 'Library' },
      { to: 'ingest', label: 'Ingest' },
      { to: 'integrations', label: 'Integrations' },
    ],
  },
  {
    label: 'Organisation',
    tabs: [
      { to: 'desks', label: 'Desks' },
      { to: 'tags', label: 'Tags' },
      { to: 'entities', label: 'Entities' },
      { to: 'memory', label: 'Memory' },
      { to: 'maps', label: 'Maps' },
    ],
  },
  {
    label: 'Automation',
    tabs: [
      { to: 'recipes', label: 'Recipes' },
      { to: 'rules', label: 'Rules' },
      { to: 'daydream', label: 'Daydream' },
      { to: 'instructions', label: 'Instructions' },
    ],
  },
  {
    label: 'Maintenance',
    tabs: [
      { to: 'spam', label: 'Spam' },
      { to: 'storage', label: 'Storage' },
      { to: 'reports', label: 'Reports' },
    ],
  },
  {
    label: 'Admin',
    tabs: [
      { to: 'models', label: 'Models', admin: true },
      { to: 'admin', label: 'Admin', admin: true },
      { to: 'diagnostics', label: 'Diagnostics', admin: true },
    ],
  },
];

export default function SettingsLayout() {
  const api = useApi();
  const { data: adminInfo } = useQuery({
    queryKey: ['admin-me'],
    queryFn: () => api.get<{ isAdmin: boolean }>('/api/admin/me'),
    staleTime: 5 * 60 * 1000,
  });
  const isAdmin = adminInfo?.isAdmin ?? false;
  // Strip admin-only sections / tabs for non-admins. Keeps the
  // section ordering identical so the section labels don't shift
  // when admin status toggles in dev.
  const visibleSections = SECTIONS.map((s) => ({
    label: s.label,
    tabs: s.tabs.filter((t) => isAdmin || !t.admin),
  })).filter((s) => s.tabs.length > 0);

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mb-6 text-sm text-ink-500">Configure how Rose ingests and writes.</p>
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <nav
          className="flex gap-1 overflow-x-auto border-b border-ink-200 pb-2 md:sticky md:top-20 md:flex-col md:overflow-visible md:border-b-0 md:border-r md:pb-0 md:pr-3 dark:border-ink-800"
          aria-label="Settings sections"
        >
          {visibleSections.map((section) => (
            <div key={section.label} className="md:mb-2 md:flex md:flex-col">
              <div className="hidden md:block md:px-3 md:pb-1 md:pt-2 md:text-[10px] md:font-semibold md:uppercase md:tracking-widest md:text-ink-500">
                {section.label}
              </div>
              {section.tabs.map((t) => (
                <NavLink
                  key={t.to}
                  to={t.to}
                  className={({ isActive }) =>
                    clsx(
                      'shrink-0 rounded-lg px-3 py-2 text-sm transition-colors md:w-full md:text-left',
                      isActive
                        ? t.admin
                          ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                          : 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
                        : t.admin
                          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/20'
                          : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-ink-800 dark:hover:text-ink-100',
                    )
                  }
                >
                  {t.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
