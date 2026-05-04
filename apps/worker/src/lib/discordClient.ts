/**
 * Tiny Discord REST API wrapper. Authenticates with a bot token; only
 * the read scopes we need (read message history, list channels in a
 * guild, resolve user names). Discord rate-limits aggressively; we
 * surface the rate-limit error to the caller and let BullMQ retry.
 */
const BASE = 'https://discord.com/api/v10';

async function discordCall<T>(
  botToken: string,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Rose/1.0 (+https://rose.local)',
      ...(init.headers ?? {}),
    },
    signal,
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') ?? '5');
    throw new Error(`Discord rate-limited; retry after ${retry}s`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord ${path} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export type DiscordChannel = {
  id: string;
  name: string;
  type: number; // 0=text, 5=announcement, 11/12=thread, etc.
};

export type DiscordMessage = {
  id: string;
  channel_id: string;
  content?: string;
  timestamp: string;
  author?: { id: string; username?: string; global_name?: string | null; bot?: boolean };
  type: number;
};

export async function getGuild(
  botToken: string,
  guildId: string,
  signal?: AbortSignal,
): Promise<{ name?: string }> {
  return discordCall(botToken, `/guilds/${guildId}`, {}, signal);
}

export async function listGuildChannels(
  botToken: string,
  guildId: string,
  signal?: AbortSignal,
): Promise<DiscordChannel[]> {
  const all = await discordCall<DiscordChannel[]>(
    botToken,
    `/guilds/${guildId}/channels`,
    {},
    signal,
  );
  // Keep text-bearing channels only.
  return all.filter((c) => [0, 5].includes(c.type));
}

/** Pull the most recent up-to-100 messages newer than `afterId`.
 *  Discord uses snowflake IDs (lexically time-orderable) as cursors. */
export async function fetchAfter(
  botToken: string,
  channelId: string,
  afterId: string,
  signal?: AbortSignal,
): Promise<DiscordMessage[]> {
  const path = `/channels/${channelId}/messages?limit=100${afterId ? `&after=${afterId}` : ''}`;
  return discordCall<DiscordMessage[]>(botToken, path, {}, signal);
}
