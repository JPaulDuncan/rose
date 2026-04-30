import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import type { AuthResponse } from '@rose/shared';
import { useAuth } from '../lib/auth';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const setSession = useAuth((s) => s.setSession);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        credentials: 'include',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? 'Login failed');
      }
      const data = (await res.json()) as AuthResponse;
      setSession({ token: data.accessToken, user: data.user });
      navigate('/');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="card w-full max-w-md">
        <div className="mb-6 flex items-center gap-3">
          <img src="/rose.svg" className="h-9 w-9" alt="" />
          <div>
            <h1 className="text-xl font-semibold">Welcome back to Rose</h1>
            <p className="text-sm text-ink-500">Sign in to your wiki.</p>
          </div>
        </div>
        <form className="space-y-3" onSubmit={submit}>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-600 dark:text-ink-300">Email</span>
            <input
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-ink-600 dark:text-ink-300">Password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button className="btn-primary w-full" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-ink-500">
          New here?{' '}
          <Link to="/register" className="text-rose-600 hover:underline">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
