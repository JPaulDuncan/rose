import { useEffect } from 'react';
import { X } from 'lucide-react';

/**
 * Press `?` anywhere in the app to surface every keyboard shortcut.
 * The bindings live in Shell.tsx via `useHotkeys`; this just renders
 * a lookup that mirrors them. Source-of-truth duplication is
 * intentional: the hotkey map runs hot and shouldn't carry display
 * metadata, and a single lookup table here is easier to scan than
 * navigating the binding code.
 *
 * Add to KEYBOARD_SHORTCUTS whenever a new global hotkey lands in
 * Shell.tsx. The `g` prefix denotes go-to-page chords.
 */

type Shortcut = { keys: string; label: string; group: 'navigation' | 'actions' | 'misc' };

const KEYBOARD_SHORTCUTS: Shortcut[] = [
  { keys: '?', label: 'Show this help', group: 'misc' },
  { keys: '⌘K', label: 'Open command palette', group: 'misc' },
  { keys: '/', label: 'Focus search', group: 'misc' },

  { keys: 'g h', label: 'Home', group: 'navigation' },
  { keys: 'g i', label: 'Sources / ingest', group: 'navigation' },
  { keys: 'g a', label: 'Ask (chat)', group: 'navigation' },
  { keys: 'g c', label: 'Calendar', group: 'navigation' },
  { keys: 'g b', label: 'Codex', group: 'navigation' },
  { keys: 'g t', label: 'Codex → streams', group: 'navigation' },
  { keys: 'g x', label: 'Codex → categories', group: 'navigation' },
  { keys: 'g l', label: 'Library', group: 'navigation' },
  { keys: 'g k', label: 'Shipments', group: 'navigation' },
  { keys: 'g d', label: 'Promo codes', group: 'navigation' },
  { keys: 'g v', label: 'Topic watches', group: 'navigation' },
  { keys: 'g w', label: 'Weather', group: 'navigation' },
  { keys: 'g m', label: 'Moon', group: 'navigation' },
  { keys: 'g q', label: 'Quarantine', group: 'navigation' },
  { keys: 'g p', label: 'Promotions', group: 'navigation' },
  { keys: 'g s', label: 'Settings', group: 'navigation' },
  { keys: 'g e', label: 'Map', group: 'navigation' },
  { keys: 'g u', label: 'Products', group: 'navigation' },
  { keys: 'g z', label: 'Magazine layout', group: 'navigation' },
  { keys: 'g j', label: 'Triage queue', group: 'navigation' },
  { keys: 'g r', label: 'Report a bug / feature', group: 'misc' },

  { keys: 'n', label: 'New / connect a source', group: 'actions' },
  { keys: 'Esc', label: 'Close dialog / palette', group: 'actions' },

  { keys: 'j / k', label: 'Triage: next / previous email', group: 'actions' },
  { keys: 'a', label: 'Triage: archive', group: 'actions' },
  { keys: 's', label: 'Triage: mark sender as spam', group: 'actions' },
  { keys: 'b', label: 'Triage: block sender', group: 'actions' },
  { keys: 'p', label: 'Triage: page it (queue page generation)', group: 'actions' },
  { keys: 'd / D', label: 'Triage: defer 24h / 1 week', group: 'actions' },
  { keys: 'r', label: 'Triage: open reply composer', group: 'actions' },
  { keys: 'o / Enter', label: 'Triage: open the email', group: 'actions' },
];

const GROUP_TITLES: Record<Shortcut['group'], string> = {
  misc: 'General',
  navigation: 'Navigate',
  actions: 'Actions',
};

export function KeyboardHelp({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  // Esc closes; this duplicates the modal-style escape handling so
  // the help itself is dismissible without a mouse.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const groups = (['navigation', 'actions', 'misc'] as const).map((g) => ({
    group: g,
    title: GROUP_TITLES[g],
    items: KEYBOARD_SHORTCUTS.filter((s) => s.group === g),
  }));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="kbd-help-title"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
    >
      <div className="absolute inset-0 bg-ink-950/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg rounded-xl border border-ink-200 bg-white p-5 shadow-xl dark:border-ink-800 dark:bg-ink-950">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 text-ink-400 hover:text-ink-700 dark:hover:text-ink-200"
        >
          <X className="h-4 w-4" />
        </button>
        <h2 id="kbd-help-title" className="text-base font-semibold">
          Keyboard shortcuts
        </h2>
        <p className="mt-1 text-xs text-ink-500">
          Most pages use vim-style chords — tap each key in sequence (e.g. <kbd className="rounded bg-ink-100 px-1 dark:bg-ink-800">g</kbd> then <kbd className="rounded bg-ink-100 px-1 dark:bg-ink-800">h</kbd>).
        </p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {groups.map((g) => (
            <div key={g.group}>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-ink-400">
                {g.title}
              </div>
              <ul className="space-y-1 text-sm">
                {g.items.map((s) => (
                  <li key={s.keys} className="flex items-center justify-between gap-3">
                    <span className="text-ink-700 dark:text-ink-200">{s.label}</span>
                    <kbd className="rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-mono text-ink-700 dark:bg-ink-800 dark:text-ink-200">
                      {s.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
