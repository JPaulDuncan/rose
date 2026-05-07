import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Search,
  Home as HomeIcon,
  Calendar as CalendarIcon,
  Settings,
  Sun,
  Moon,
  Command,
  LogOut,
  BookOpen,
  ShieldAlert,
  Megaphone,
  EyeOff,
  Sparkles,
  Bookmark,
  X,
  ChevronDown,
  Menu,
  Loader2,
} from 'lucide-react';
import clsx from 'clsx';
import { useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { CommandPalette } from './CommandPalette';
import { useHotkeys } from '../hooks/useHotkeys';

type NavItem = {
  to: string;
  label: string;
  icon: typeof HomeIcon;
  key: string;
};

// Primary destinations stay in the bar; secondary "filtered view"-style
// pages collapse into a More dropdown so the bar doesn't get crowded
// at small/medium widths.
const PRIMARY_NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: HomeIcon, key: 'g h' },
  { to: '/chat', label: 'Ask', icon: Sparkles, key: 'g a' },
  { to: '/calendar', label: 'Calendar', icon: CalendarIcon, key: 'g c' },
  { to: '/browse', label: 'Browse', icon: BookOpen, key: 'g b' },
];

const SECONDARY_NAV: NavItem[] = [
  { to: '/library', label: 'Library', icon: BookOpen, key: 'g l' },
  // Plan 12 (R6) — single landing page that surfaces totals across
  // quarantine + spam + promotions. The dedicated routes still exist
  // for bulk actions (and keep their hotkeys), but the user has one
  // entry point in the sidebar instead of three.
  { to: '/hidden', label: 'Hidden', icon: EyeOff, key: 'g q' },
];

export function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const searchInputRef = useRef<HTMLInputElement>(null);

  useHotkeys({
    'mod+k': () => setPaletteOpen(true),
    '/': (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      // Focus the inline search field when it's visible (sm+); otherwise
      // fall back to navigating to /search so the small-screen layout
      // still has a path in.
      if (searchInputRef.current && searchInputRef.current.offsetParent !== null) {
        searchInputRef.current.focus();
        searchInputRef.current.select();
      } else {
        navigate('/search');
      }
    },
    'g h': () => navigate('/'),
    'g i': () => navigate('/settings/ingest'),
    'g a': () => navigate('/chat'),
    'g c': () => navigate('/calendar'),
    'g b': () => navigate('/browse'),
    // Old hotkeys kept as muscle-memory shortcuts to specific Browse tabs.
    'g t': () => navigate('/browse?tab=streams'),
    'g x': () => navigate('/browse?tab=categories'),
    'g l': () => navigate('/library'),
    'g q': () => navigate('/quarantine'),
    'g p': () => navigate('/promotions'),
    'g s': () => navigate('/settings'),
    n: (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      navigate('/settings/ingest');
    },
  });

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="sticky top-0 z-30 border-b border-ink-200 bg-white/95 backdrop-blur dark:border-ink-800 dark:bg-ink-900/95">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-2 px-4">
          {/* Brand */}
          <NavLink to="/" className="flex shrink-0 items-center gap-2">
            <img src="/rose.svg" className="h-7 w-7" alt="" />
            <span className="text-lg font-semibold tracking-tight">Rose</span>
          </NavLink>

          {/* Primary nav — labels on lg, icons-only on md, hidden on sm */}
          <nav className="ml-4 hidden items-center gap-0.5 md:flex">
            {PRIMARY_NAV.map((n) => (
              <TopNavLink key={n.to} item={n} />
            ))}
            <MoreMenu items={SECONDARY_NAV} />
          </nav>

          {/* Right cluster */}
          <div className="ml-auto flex items-center gap-1">
            <TopSearchBar inputRef={searchInputRef} />
            <button
              type="button"
              className="hidden items-center gap-2 rounded-lg border border-ink-200 px-2.5 py-1.5 text-xs text-ink-500 hover:bg-ink-50 dark:border-ink-800 dark:hover:bg-ink-800 sm:flex"
              onClick={() => setPaletteOpen(true)}
              title="Command palette (⌘K)"
            >
              <Command className="h-3.5 w-3.5" />
              <span className="hidden lg:inline">Palette</span>
              <kbd className="rounded bg-ink-100 px-1 py-0.5 text-[10px] font-medium text-ink-500 dark:bg-ink-800">
                ⌘K
              </kbd>
            </button>
            <ActivityIndicator />
            <button
              type="button"
              className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle theme"
              title="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                clsx(
                  'rounded-lg p-1.5',
                  isActive
                    ? 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-200'
                    : 'text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800',
                )
              }
              aria-label="Settings"
              title="Settings (g s)"
            >
              <Settings className="h-4 w-4" />
            </NavLink>
            <UserMenu user={user} onLogout={logout} />
            {/* Mobile hamburger */}
            <button
              type="button"
              className="rounded-lg p-1.5 text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800 md:hidden"
              onClick={() => setMobileOpen((v) => !v)}
              aria-label="Toggle menu"
            >
              <Menu className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Pinned saved searches — second row, only renders when present */}
        <SavedSearchStrip />

        {/* Mobile menu drawer (open on hamburger click) */}
        {mobileOpen && (
          <div className="border-t border-ink-200 px-4 py-2 md:hidden dark:border-ink-800">
            <nav className="flex flex-col gap-0.5">
              {[...PRIMARY_NAV, ...SECONDARY_NAV].map((n) => (
                <NavLink
                  key={n.to}
                  to={n.to}
                  end={n.to === '/'}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center gap-3 rounded-lg px-3 py-2 text-sm',
                      isActive
                        ? 'bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-100'
                        : 'text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800',
                    )
                  }
                >
                  <n.icon className="h-4 w-4" />
                  <span>{n.label}</span>
                  <span className="ml-auto text-xs text-ink-400">{n.key}</span>
                </NavLink>
              ))}
            </nav>
          </div>
        )}
      </header>

      <main className="flex-1 overflow-y-auto">{children}</main>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

function TopNavLink({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors',
          isActive
            ? 'bg-rose-50 text-rose-900 dark:bg-rose-950/40 dark:text-rose-100'
            : 'text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800',
        )
      }
      title={`${item.label} (${item.key})`}
    >
      <item.icon className="h-4 w-4" />
      <span className="hidden lg:inline">{item.label}</span>
    </NavLink>
  );
}

/**
 * Lightweight click-outside dropdown — used for both More and the
 * user menu. Avoids pulling in a popover library for two simple
 * dropdowns that don't need full keyboard semantics (the command
 * palette covers that).
 */
function Dropdown({
  trigger,
  children,
  align = 'left',
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger(open, () => setOpen((v) => !v))}
      {open && (
        <div
          className={clsx(
            'absolute top-full z-40 mt-1 min-w-[180px] rounded-lg border border-ink-200 bg-white p-1 shadow-lg dark:border-ink-800 dark:bg-ink-950',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MoreMenu({ items }: { items: NavItem[] }) {
  const navigate = useNavigate();
  return (
    <Dropdown
      trigger={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          className={clsx(
            'flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors',
            open
              ? 'bg-ink-100 text-ink-900 dark:bg-ink-800 dark:text-ink-100'
              : 'text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800',
          )}
        >
          <span className="hidden lg:inline">More</span>
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      )}
    >
      {(close) =>
        items.map((n) => (
          <button
            key={n.to}
            type="button"
            onClick={() => {
              navigate(n.to);
              close();
            }}
            className="flex w-full items-center justify-between gap-3 rounded px-2.5 py-1.5 text-left text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
          >
            <span className="flex items-center gap-2">
              <n.icon className="h-4 w-4" />
              {n.label}
            </span>
            <span className="text-[10px] text-ink-400">{n.key}</span>
          </button>
        ))
      }
    </Dropdown>
  );
}

function UserMenu({
  user,
  onLogout,
}: {
  user: { displayName?: string; email?: string } | null;
  onLogout: () => void;
}) {
  const initial = (user?.displayName ?? user?.email ?? '?')
    .charAt(0)
    .toUpperCase();
  return (
    <Dropdown
      align="right"
      trigger={(_open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-rose-100 text-sm font-semibold text-rose-700 hover:bg-rose-200 dark:bg-rose-950/40 dark:text-rose-200"
          aria-label="User menu"
          title={user?.displayName ?? user?.email ?? 'Account'}
        >
          {initial}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="border-b border-ink-200 px-2.5 py-1.5 dark:border-ink-800">
            <div className="truncate text-sm font-medium">{user?.displayName}</div>
            <div className="truncate text-xs text-ink-500">{user?.email}</div>
          </div>
          <button
            type="button"
            onClick={() => {
              onLogout();
              close();
            }}
            className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-sm text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800"
          >
            <LogOut className="h-4 w-4" />
            Log out
          </button>
        </>
      )}
    </Dropdown>
  );
}

type SavedSearch = {
  id: string;
  name: string;
  query: string;
  pinned: boolean;
  /** Persisted filters from the saved-search model. The search page
   *  honours `tags` today; senders / priority / flag are stored on
   *  the model but not yet wired through `/api/search`. */
  filters?: {
    tags?: string[];
    senders?: string[];
    priority?: string[];
  };
};

/**
 * Build the URL for a saved-search smart-folder click. Includes the
 * query plus whatever filters the saved search has captured. Today
 * `/api/search` honours `tags`; future filter wiring can land here
 * without touching call-sites.
 */
function urlForSavedSearch(s: SavedSearch): string {
  const params = new URLSearchParams();
  if (s.query) params.set('q', s.query);
  const tags = (s.filters?.tags ?? []).filter(Boolean);
  if (tags.length) params.set('tags', tags.join(','));
  const qs = params.toString();
  return qs ? `/search?${qs}` : '/search';
}

/**
 * Pinned saved searches as a thin strip under the top bar — only
 * rendered when at least one is pinned, so the chrome stays at 56px
 * for users who haven't bookmarked anything.
 */
function SavedSearchStrip() {
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
    <div className="border-t border-ink-200 dark:border-ink-800">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-2 overflow-x-auto px-4 py-1.5">
        <Bookmark className="h-3 w-3 shrink-0 text-ink-400" />
        <span className="shrink-0 text-[10px] uppercase tracking-widest text-ink-500">
          Smart folders
        </span>
        {pinned.map((s) => (
          <div
            key={s.id}
            className="group flex shrink-0 items-center gap-1 rounded-full bg-ink-100 px-2.5 py-0.5 text-xs hover:bg-rose-100 hover:text-rose-700 dark:bg-ink-800 dark:hover:bg-rose-950/40 dark:hover:text-rose-200"
          >
            <button
              type="button"
              onClick={() => navigate(urlForSavedSearch(s))}
              className="truncate"
              title={
                [
                  s.query ? `q: ${s.query}` : null,
                  (s.filters?.tags ?? []).length
                    ? `tags: ${(s.filters?.tags ?? []).join(', ')}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'Open this saved search'
              }
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
    </div>
  );
}

/**
 * Inline search field in the top bar — submits to /search?q=… so the
 * user can search from anywhere without navigating to /search first.
 * Hidden below sm (where the palette button also collapses); on /search
 * itself the field stays empty so the page's own search box owns the
 * canonical query state.
 */
function TopSearchBar({
  inputRef,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
}) {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  return (
    <form
      className="relative hidden sm:block"
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        if (!q) return;
        navigate(`/search?q=${encodeURIComponent(q)}`);
        setValue('');
        inputRef.current?.blur();
      }}
      role="search"
    >
      <Search
        className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400"
        aria-hidden
      />
      <input
        ref={inputRef}
        type="search"
        className="w-44 rounded-lg border border-ink-200 bg-white py-1.5 pl-7 pr-2 text-sm placeholder:text-ink-400 focus:border-rose-300 focus:outline-none focus:ring-2 focus:ring-rose-100 dark:border-ink-800 dark:bg-ink-900 dark:focus:border-rose-700 dark:focus:ring-rose-950/40 lg:w-64"
        placeholder="Search…"
        aria-label="Search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setValue('');
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
      />
    </form>
  );
}

/**
 * Tiny "is the worker doing anything right now?" indicator that lives
 * between the palette button and the theme toggle. Polls a cheap
 * `/api/jobs/activity` endpoint every 5 seconds, renders a spinning
 * loader when something is in flight, and a faint resting dot when
 * idle so the slot doesn't visually shift.
 */
function ActivityIndicator() {
  const api = useApi();
  const { data } = useQuery({
    queryKey: ['jobs-activity'],
    queryFn: () =>
      api.get<{ active: number; waiting: number; busy: boolean }>(
        '/api/jobs/activity',
      ),
    refetchInterval: 5_000,
    staleTime: 4_000,
  });
  const busy = !!data?.busy;
  const total = (data?.active ?? 0) + (data?.waiting ?? 0);
  return (
    <span
      className={clsx(
        'flex h-7 w-7 items-center justify-center rounded-lg transition-colors',
        busy ? 'text-rose-500' : 'text-ink-300 dark:text-ink-700',
      )}
      title={
        busy
          ? `Ingesting / processing — ${total} job${total === 1 ? '' : 's'} in flight`
          : 'Idle — nothing in flight'
      }
      aria-live="polite"
      aria-label={busy ? 'Processing in progress' : 'Idle'}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-current" />
      )}
    </span>
  );
}
