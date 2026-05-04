import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Search,
  Inbox as InboxIcon,
  Home as HomeIcon,
  Calendar as CalendarIcon,
  Activity,
  Settings,
  Sun,
  Moon,
  Command,
  LogOut,
  BookOpen,
  ShieldAlert,
  Megaphone,
  Sparkles,
  Bookmark,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { CommandPalette } from './CommandPalette';
import { useHotkeys } from '../hooks/useHotkeys';

const NAV = [
  { to: '/', label: 'Home', icon: HomeIcon, key: 'g h' },
  { to: '/inbox', label: 'Inbox', icon: InboxIcon, key: 'g i' },
  { to: '/chat', label: 'Ask', icon: Sparkles, key: 'g a' },
  { to: '/search', label: 'Search', icon: Search, key: '/' },
  { to: '/calendar', label: 'Calendar', icon: CalendarIcon, key: 'g c' },
  { to: '/streams', label: 'Streams', icon: Activity, key: 'g t' },
  { to: '/codex', label: 'Codex', icon: BookOpen, key: 'g x' },
  { to: '/quarantine', label: 'Quarantine', icon: ShieldAlert, key: 'g q' },
  { to: '/promotions', label: 'Promotions', icon: Megaphone, key: 'g p' },
  { to: '/settings', label: 'Settings', icon: Settings, key: 'g s' },
];

export function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navigate = useNavigate();

  useHotkeys({
    'mod+k': () => setPaletteOpen(true),
    '/': (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      navigate('/search');
    },
    'g h': () => navigate('/'),
    'g i': () => navigate('/inbox'),
    'g a': () => navigate('/chat'),
    'g c': () => navigate('/calendar'),
    'g t': () => navigate('/streams'),
    'g x': () => navigate('/codex'),
    'g q': () => navigate('/quarantine'),
    'g p': () => navigate('/promotions'),
    'g s': () => navigate('/settings'),
    n: (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      navigate('/inbox');
    },
  });

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="hidden w-60 shrink-0 border-r border-ink-200 bg-white p-4 md:flex md:flex-col dark:border-ink-800 dark:bg-ink-900">
        <div className="mb-6 flex items-center gap-2">
          <img src="/rose.svg" className="h-7 w-7" alt="" />
          <span className="text-lg font-semibold tracking-tight">Rose</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) =>
                clsx(
                  'flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-100'
                    : 'text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800',
                )
              }
            >
              <span className="flex items-center gap-3">
                <n.icon className="h-4 w-4" />
                {n.label}
              </span>
              <span className="text-xs text-ink-400">{n.key}</span>
            </NavLink>
          ))}
          <SavedSearchRail />
        </nav>
        <button
          className="btn-ghost justify-start"
          onClick={() => setPaletteOpen(true)}
        >
          <Command className="h-4 w-4" /> Palette
          <span className="ml-auto text-xs text-ink-400">⌘K</span>
        </button>
        <div className="mt-3 flex items-center justify-between rounded-lg border border-ink-200 p-2 text-xs dark:border-ink-800">
          <div className="truncate">
            <div className="truncate font-medium">{user?.displayName}</div>
            <div className="truncate text-ink-500">{user?.email}</div>
          </div>
          <div className="flex items-center gap-1">
            <button
              className="btn-ghost"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button className="btn-ghost" onClick={logout} aria-label="Log out">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">{children}</div>
      </main>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

type SavedSearch = {
  id: string;
  name: string;
  query: string;
  pinned: boolean;
};

function SavedSearchRail() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ['saved-searches'],
    queryFn: () =>
      api.get<{ savedSearches: SavedSearch[] }>('/api/me/saved-searches'),
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      api.del<{ ok: true }>(`/api/me/saved-searches/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-searches'] }),
  });
  const pinned = (data?.savedSearches ?? []).filter((s) => s.pinned);
  if (pinned.length === 0) return null;
  return (
    <div className="mt-4 border-t border-ink-200 pt-3 dark:border-ink-800">
      <div className="mb-1 flex items-center gap-1 px-3 text-[10px] uppercase tracking-widest text-ink-500">
        <Bookmark className="h-3 w-3" />
        Smart folders
      </div>
      {pinned.map((s) => (
        <div
          key={s.id}
          className="group flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800"
        >
          <button
            type="button"
            onClick={() =>
              navigate(`/search?q=${encodeURIComponent(s.query ?? '')}`)
            }
            className="min-w-0 flex-1 truncate text-left"
            title={s.query}
          >
            {s.name}
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm(`Remove "${s.name}" from saved searches?`))
                remove.mutate(s.id);
            }}
            className="opacity-0 transition-opacity group-hover:opacity-100"
            aria-label="Remove"
          >
            <X className="h-3 w-3 text-ink-400 hover:text-red-600" />
          </button>
        </div>
      ))}
    </div>
  );
}
