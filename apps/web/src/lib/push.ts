/**
 * WebPush helpers — service-worker registration, key fetch,
 * subscribe / unsubscribe. Returns plain objects the React layer can
 * ferry into TanStack mutations.
 */

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushSupport =
  | { ok: true; permission: NotificationPermission }
  | { ok: false; reason: string };

export function checkPushSupport(): PushSupport {
  if (typeof window === 'undefined') return { ok: false, reason: 'no window' };
  if (!('serviceWorker' in navigator)) return { ok: false, reason: 'no serviceWorker' };
  if (!('PushManager' in window)) return { ok: false, reason: 'no PushManager' };
  if (!('Notification' in window)) return { ok: false, reason: 'no Notification API' };
  return { ok: true, permission: Notification.permission };
}

export async function ensureRegistration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register('/push-sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  return reg;
}

export async function subscribePush(
  vapidPublicKey: string,
): Promise<PushSubscriptionJSON> {
  const reg = await ensureRegistration();
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing.toJSON();
  const key = urlBase64ToUint8Array(vapidPublicKey);
  // Cast to BufferSource — narrower TS lib types want a vanilla
  // ArrayBuffer, but PushManager.subscribe accepts any Uint8Array view.
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key.buffer.slice(
      key.byteOffset,
      key.byteOffset + key.byteLength,
    ) as ArrayBuffer,
  });
  return sub.toJSON();
}

export async function unsubscribePush(): Promise<string | null> {
  const reg = await ensureRegistration();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}

export async function currentEndpoint(): Promise<string | null> {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) return null;
  const sub = await reg.pushManager.getSubscription();
  return sub?.endpoint ?? null;
}
