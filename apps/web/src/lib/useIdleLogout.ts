import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from './auth';

/**
 * Default idle timeout when nothing is configured. Five minutes
 * matches the spec; production deployments override via the
 * `VITE_IDLE_TIMEOUT_MINUTES` env var read at build time.
 */
const DEFAULT_MINUTES = 5;

/**
 * Storage key for the cross-tab "last activity" timestamp. Reading
 * this on every tick lets a long-idle tab notice that the user is
 * active in another tab and reset the countdown. Avoids the
 * "wrong tab logs everyone out" failure mode without needing a
 * BroadcastChannel.
 */
const LAST_ACTIVITY_KEY = 'rose.lastActivityAt';

/**
 * Throttle for storage writes. Mousemove fires at ~60Hz; writing
 * localStorage that often is wasteful and triggers a `storage`
 * event in every other tab on every frame. Once a second is enough
 * to keep cross-tab freshness while staying cheap.
 */
const STORAGE_WRITE_THROTTLE_MS = 1000;

function configuredTimeoutMs(): number {
  const raw = import.meta.env.VITE_IDLE_TIMEOUT_MINUTES;
  const minutes = raw != null && raw !== '' ? Number(raw) : DEFAULT_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    // Fall back to default for malformed values rather than disabling
    // idle logout — silently failing closed is the safer default for
    // a security feature.
    return DEFAULT_MINUTES * 60_000;
  }
  return Math.round(minutes * 60_000);
}

/**
 * Idle-timeout hook. Mounted inside `ProtectedShell` so it only
 * runs for authenticated users; bails out cleanly when the user
 * logs in / out by keying the effect on `user?.id`.
 *
 * Activity is detected via mousemove / mousedown / keydown / scroll /
 * touchstart on `document` (passive listeners). The hook keeps an
 * in-memory `lastActivityAt` ref AND mirrors it into localStorage
 * (throttled) so other tabs can see fresh activity. On every tick
 * we take the max of the in-memory and storage values — that's the
 * "any tab counts" semantic.
 *
 * When the elapsed idle exceeds the timeout the hook fires once:
 * shows a toast, calls `useAuth.logout()`, navigates to /login.
 */
export function useIdleLogout(): void {
  const logout = useAuth((s) => s.logout);
  const userId = useAuth((s) => s.user?.id ?? null);
  const navigate = useNavigate();

  const lastActivityRef = useRef<number>(Date.now());
  const lastStorageWriteRef = useRef<number>(0);
  const firedRef = useRef<boolean>(false);

  useEffect(() => {
    if (!userId) return;
    firedRef.current = false;
    const timeoutMs = configuredTimeoutMs();

    // Seed from any prior cross-tab activity so a freshly mounted
    // tab doesn't immediately fire if it loaded after a real
    // session of activity elsewhere.
    try {
      const seed = Number(localStorage.getItem(LAST_ACTIVITY_KEY) ?? '');
      if (Number.isFinite(seed) && seed > 0) {
        lastActivityRef.current = seed;
      } else {
        lastActivityRef.current = Date.now();
      }
    } catch {
      lastActivityRef.current = Date.now();
    }

    const recordActivity = () => {
      const now = Date.now();
      lastActivityRef.current = now;
      // Throttled storage write so we don't pay the cost on every
      // mousemove. The 1s window is well below the minimum useful
      // idle-timeout granularity.
      if (now - lastStorageWriteRef.current >= STORAGE_WRITE_THROTTLE_MS) {
        lastStorageWriteRef.current = now;
        try {
          localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
        } catch {
          /* private mode / quota — non-fatal, in-memory ref still works */
        }
      }
    };

    const events: Array<keyof DocumentEventMap> = [
      'mousemove',
      'mousedown',
      'keydown',
      'scroll',
      'touchstart',
    ];
    for (const ev of events) {
      document.addEventListener(ev, recordActivity, { passive: true });
    }

    // Cross-tab: another tab's `localStorage.setItem` fires a
    // `storage` event here. Pull the value into our in-memory ref
    // so the next tick uses the freshest activity.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LAST_ACTIVITY_KEY || !e.newValue) return;
      const v = Number(e.newValue);
      if (Number.isFinite(v) && v > lastActivityRef.current) {
        lastActivityRef.current = v;
      }
    };
    window.addEventListener('storage', onStorage);

    let timer: number | null = null;
    const tick = () => {
      if (firedRef.current) return;
      // Recompute against both sources so a tab that came back from
      // background (where `storage` events fire but the timer paused)
      // sees the freshest activity.
      let last = lastActivityRef.current;
      try {
        const stored = Number(localStorage.getItem(LAST_ACTIVITY_KEY) ?? '');
        if (Number.isFinite(stored) && stored > last) last = stored;
      } catch {
        /* ignore */
      }
      const elapsed = Date.now() - last;
      if (elapsed >= timeoutMs) {
        firedRef.current = true;
        toast('Logged out for inactivity', { icon: '⏰', duration: 6000 });
        void logout().finally(() => {
          navigate('/login', { replace: true });
        });
        return;
      }
      // Schedule the next check for exactly when we'd fire (plus a
      // small safety margin so timer drift doesn't undershoot).
      const wait = Math.max(1000, timeoutMs - elapsed + 250);
      timer = window.setTimeout(tick, wait);
    };
    timer = window.setTimeout(tick, timeoutMs);

    return () => {
      for (const ev of events) {
        document.removeEventListener(ev, recordActivity);
      }
      window.removeEventListener('storage', onStorage);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [userId, logout, navigate]);
}
