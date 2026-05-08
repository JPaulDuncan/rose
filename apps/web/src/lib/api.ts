import { useAuth } from './auth';

const BASE = '';

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

/**
 * Map an arbitrary thrown error into a user-presentable string.
 * `toast.error(humaniseError(e))` is the standard call site so the
 * UI never shows "TypeError: Failed to fetch" or a bare "503 Service
 * Unavailable" — both of which were widespread before this audit.
 *
 * Server-side errors that ship a `message` in the JSON body are
 * already friendly (the API curates them); fall through to those.
 * Network / 5xx / 401 get mapped to messages with concrete recovery
 * hints. Everything else falls back to `e.message`.
 */
export function humaniseError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Your session expired. Please sign in again.';
    if (err.status === 403) return "You don't have permission to do that.";
    if (err.status === 404) return "We couldn't find that.";
    if (err.status === 409) return err.message || 'That conflicts with the current state.';
    if (err.status === 413) return 'That payload is too large to upload.';
    if (err.status === 429) return 'Too many requests — give it a moment and try again.';
    if (err.status >= 500) return 'The server is having trouble. Try again in a moment.';
    return err.message || `Request failed (${err.status}).`;
  }
  if (err instanceof TypeError && /fetch/i.test(err.message)) {
    return "We couldn't reach the server. Check your connection and try again.";
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

async function request<T>(
  path: string,
  opts: RequestInit & { token?: string | null } = {},
): Promise<T> {
  const headers = new Headers(opts.headers ?? {});
  if (!headers.has('Content-Type') && !(opts.body instanceof FormData) && opts.body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);
  const res = await fetch(`${BASE}${path}`, { ...opts, headers, credentials: 'include' });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    const message =
      (body as { message?: string })?.message ?? `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, body);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export function useApi() {
  const { token, refresh, logout } = useAuth();
  return {
    get: <T,>(path: string) => withRefresh<T>(() => request<T>(path, { token, method: 'GET' }), refresh, logout),
    post: <T,>(path: string, body?: unknown) =>
      withRefresh<T>(
        () =>
          request<T>(path, {
            token,
            method: 'POST',
            body: body instanceof FormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
          }),
        refresh,
        logout,
      ),
    patch: <T,>(path: string, body?: unknown) =>
      withRefresh<T>(
        () =>
          request<T>(path, {
            token,
            method: 'PATCH',
            body: body !== undefined ? JSON.stringify(body) : undefined,
          }),
        refresh,
        logout,
      ),
    del: <T,>(path: string) =>
      withRefresh<T>(() => request<T>(path, { token, method: 'DELETE' }), refresh, logout),
  };
}

async function withRefresh<T>(
  fn: () => Promise<T>,
  refresh: () => Promise<boolean>,
  logout: () => void,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      const ok = await refresh();
      if (ok) return fn();
      logout();
    }
    throw err;
  }
}

export { request as rawRequest };
