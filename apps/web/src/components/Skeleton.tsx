import type { CSSProperties } from 'react';

/**
 * Tiny loading-state primitive. Replaces the `Loading…` text that was
 * scattered across Home / Page / Email / Search / Quarantine — each
 * of those routes has a known content shape, so a placeholder reads
 * as deliberately-loading rather than broken.
 *
 * Pulse animation is `animate-pulse` from Tailwind; respect
 * prefers-reduced-motion via the global preset (we already gate
 * animations there).
 */

type SkeletonProps = {
  className?: string;
  style?: CSSProperties;
};

export function Skeleton({ className = '', style }: SkeletonProps) {
  return (
    <div
      role="status"
      aria-label="Loading"
      style={style}
      className={
        'animate-pulse rounded bg-ink-200/70 dark:bg-ink-800/70 ' + className
      }
    />
  );
}

/** Stack of `count` lines at the same height — handy for body text. */
export function SkeletonLines({
  count = 3,
  className = '',
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={'space-y-2 ' + className}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton
          key={i}
          className={
            'h-3 ' + (i === count - 1 ? 'w-2/3' : 'w-full')
          }
        />
      ))}
    </div>
  );
}

/** Card-shaped placeholder for list rows — title line + meta line. */
export function SkeletonCard({ className = '' }: { className?: string }) {
  return (
    <div className={'card space-y-3 ' + className}>
      <Skeleton className="h-4 w-2/3" />
      <SkeletonLines count={2} />
    </div>
  );
}
