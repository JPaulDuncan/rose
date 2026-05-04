/**
 * Tiny wrapper over the Slack Web API. We only need read scopes:
 *   conversations.list, conversations.history, conversations.replies,
 *   users.info, auth.test
 *
 * No SDK dependency — every call is just a token-authenticated POST
 * to https://slack.com/api/<method>. Slack returns JSON with
 * { ok: true, ... } or { ok: false, error: '...' }.
 */

const BASE = 'https://slack.com/api';

export async function slackCall<T>(
  token: string,
  method: string,
  params: Record<string, string | number | boolean | undefined> = {},
  signal?: AbortSignal,
): Promise<T> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    body.set(k, String(v));
  }
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
    signal,
  });
  if (!res.ok) throw new Error(`Slack ${method} HTTP ${res.status}`);
  const json = (await res.json()) as { ok?: boolean; error?: string } & T;
  if (!json.ok) throw new Error(`Slack ${method} error: ${json.error ?? 'unknown'}`);
  return json;
}

export type SlackChannel = {
  id: string;
  name: string;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
};

export type SlackMessage = {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
};

export type SlackUser = {
  id: string;
  real_name?: string;
  name?: string;
};

export async function authTest(token: string, signal?: AbortSignal) {
  return slackCall<{ team?: string; team_id?: string; user?: string }>(
    token,
    'auth.test',
    {},
    signal,
  );
}

export async function listChannels(
  token: string,
  signal?: AbortSignal,
): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  let cursor: string | undefined;
  // Cap at 4 pages (≈ 1000 channels) so we never hammer the API.
  for (let i = 0; i < 4; i += 1) {
    const r = await slackCall<{ channels?: SlackChannel[]; response_metadata?: { next_cursor?: string } }>(
      token,
      'conversations.list',
      {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 250,
        cursor,
      },
      signal,
    );
    out.push(...(r.channels ?? []));
    cursor = r.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

export async function fetchHistory(
  token: string,
  channelId: string,
  oldest: string,
  signal?: AbortSignal,
): Promise<SlackMessage[]> {
  const r = await slackCall<{ messages?: SlackMessage[] }>(
    token,
    'conversations.history',
    { channel: channelId, oldest, limit: 200, inclusive: false },
    signal,
  );
  return r.messages ?? [];
}

/** Resolve a set of user IDs to display names in one bulk call when
 *  possible. Slack's users.list scopes are heavier, so we call
 *  users.info per ID and cache aggressively in the worker. */
const userCache = new Map<string, { name: string; cachedAt: number }>();
const USER_TTL = 24 * 3600 * 1000;

export async function resolveUserName(
  token: string,
  userId: string,
  signal?: AbortSignal,
): Promise<string> {
  const cached = userCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < USER_TTL) return cached.name;
  try {
    const r = await slackCall<{ user?: SlackUser }>(
      token,
      'users.info',
      { user: userId },
      signal,
    );
    const name = r.user?.real_name ?? r.user?.name ?? userId;
    userCache.set(userId, { name, cachedAt: Date.now() });
    return name;
  } catch {
    return userId;
  }
}
