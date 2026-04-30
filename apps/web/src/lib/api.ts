import { useAuth } from './auth';

const BASE = '';

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
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
