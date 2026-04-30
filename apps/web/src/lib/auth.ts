import { create } from 'zustand';
import type { PublicUser } from '@rose/shared';

type AuthState = {
  token: string | null;
  user: PublicUser | null;
  ready: boolean;
  setSession: (s: { token: string; user: PublicUser }) => void;
  logout: () => Promise<void>;
  refresh: () => Promise<boolean>;
  bootstrap: () => Promise<void>;
};

/**
 * Single in-flight refresh promise. Multiple concurrent 401s would otherwise
 * each call /auth/refresh, but a refresh-token rotation invalidates the
 * previous one — the second caller would race itself into a logout.
 */
let inflightRefresh: Promise<boolean> | null = null;

export const useAuth = create<AuthState>((set, get) => ({
  token: null,
  user: null,
  ready: false,
  setSession: ({ token, user }) => set({ token, user }),
  logout: async () => {
    set({ token: null, user: null });
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // logout is best-effort; the access token is already cleared client-side
    }
  },
  refresh: async () => {
    if (inflightRefresh) return inflightRefresh;
    inflightRefresh = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
        });
        if (!res.ok) return false;
        const data = (await res.json()) as { accessToken: string; user: PublicUser };
        set({ token: data.accessToken, user: data.user });
        return true;
      } catch {
        return false;
      } finally {
        inflightRefresh = null;
      }
    })();
    return inflightRefresh;
  },
  bootstrap: async () => {
    if (get().ready) return;
    await get().refresh();
    set({ ready: true });
  },
}));
