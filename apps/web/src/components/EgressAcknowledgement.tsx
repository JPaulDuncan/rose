import type { ReactNode } from 'react';

/**
 * Amber "Heads-up before you enable" banner. Plan 13 (D5) folded
 * the same component out of `Settings → Daydream` and `Settings →
 * Maps`; both used to render the exact same wrapper + button with
 * different bullet contents.
 *
 * Render the banner once per opt-in feature with `show` flipping
 * to true exactly when the user clicks Enable for the first time
 * (i.e. is about to send something outbound). `onAccept` flips the
 * caller's "I've acknowledged" state, which the caller then ANDs
 * into the Save guard so the user can't bypass the note.
 */
export function EgressAcknowledgement({
  show,
  onAccept,
  bullets,
}: {
  show: boolean;
  onAccept: () => void;
  /** Each bullet is a fragment / string. */
  bullets: ReactNode[];
}) {
  if (!show) return null;
  return (
    <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
      <div className="font-medium">Heads-up before you enable</div>
      <ul className="mt-1 list-disc pl-4">
        {bullets.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>
      <button
        type="button"
        className="btn-secondary mt-2 text-xs"
        onClick={onAccept}
      >
        Got it
      </button>
    </div>
  );
}
