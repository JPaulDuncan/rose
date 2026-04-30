import { create } from 'zustand';
import type { PublicUser } from '@rose/shared';

type AuthState = {
  token: string | null;
  user: PublicUser | null;
  ready: boolean;
  setSession: (s: { token: string; user: PublicUser }) => void;
  logout: () => void;
  refresh: () => Promise<boolean>;
  bootstrap: () => Promise<void>;
};

export const useAuth = create<AuthState>((set, get) => ({
  token: null,
  user: null,
  ready: false,
  setSession: ({ token, user }) => set({ token, user }),
  logout: () => {
    set({ token: null, user: null });
    void fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
  },
  refresh: async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!res.ok) return false;
      const data = (await res.json()) as { accessToken: string; user: PublicUser };
      set({ token: data.accessToken, user: data.user });
      return true;
    } catch {
      return false;
    }
  },
  bootstrap: async () => {
    if (get().ready) return;
    await get().refresh();
    set({ ready: true });
  },
}));
