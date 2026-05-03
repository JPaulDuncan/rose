import { NavLink, Outlet } from 'react-router-dom';
import clsx from 'clsx';

const TABS = [
  { to: 'account', label: 'Account' },
  { to: 'newsletter', label: 'Newsletter' },
  { to: 'sources', label: 'Sources' },
  { to: 'instructions', label: 'Instructions' },
  { to: 'models', label: 'Models' },
  { to: 'spam', label: 'Spam' },
];

export default function SettingsLayout() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mb-6 text-sm text-ink-500">Configure how Rose ingests and writes.</p>
      <div className="mb-6 flex gap-1 border-b border-ink-200 dark:border-ink-800">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) =>
              clsx(
                'rounded-t-lg px-3 py-2 text-sm',
                isActive
                  ? 'border-b-2 border-rose-500 text-rose-700 dark:text-rose-300'
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
