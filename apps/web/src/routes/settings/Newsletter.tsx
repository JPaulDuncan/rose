import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudSun, MapPin, Trash2, Star, Plus, X, RefreshCw, Send, Mail, BookOpen } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';

type WeatherLocation = {
  id: string;
  lat: number;
  lon: number;
  label: string;
  primary: boolean;
  setAt: string | null;
};

export default function NewsletterSettings() {
  return (
    <div className="space-y-6">
      <DigestEmailCard />
      <BriefingCard />
      <WeatherLocationCard />
      <FeaturedTagsCard />
      <PromptsCallout />
    </div>
  );
}

type BriefingSettings = {
  enabled?: boolean;
  cadence?: 'weekly' | 'monthly';
  timeOfDayLocal?: string;
  dayOfWeek?: number;
  timezone?: string;
  lastGeneratedAt?: string | null;
  lastError?: string | null;
};

function BriefingCard() {
  const api = useApi();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['me'],
    queryFn: () =>
      api.get<{
        settings?: { briefing?: BriefingSettings };
      }>('/api/me'),
  });
  const cfg: BriefingSettings = data?.settings?.briefing ?? {};
  const [enabled, setEnabled] = useState(!!cfg.enabled);
  const [cadence, setCadence] = useState<'weekly' | 'monthly'>(cfg.cadence ?? 'weekly');
  const [timeOfDayLocal, setTimeOfDayLocal] = useState(cfg.timeOfDayLocal ?? '08:00');
  const [dayOfWeek, setDayOfWeek] = useState(cfg.dayOfWeek ?? 1);
  const [timezone, setTimezone] = useState(
    cfg.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  );

  useEffect(() => {
    if (!data) return;
    setEnabled(!!cfg.enabled);
    setCadence(cfg.cadence ?? 'weekly');
    setTimeOfDayLocal(cfg.timeOfDayLocal ?? '08:00');
    setDayOfWeek(cfg.dayOfWeek ?? 1);
    setTimezone(
      cfg.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const save = useMutation({
    mutationFn: async () =>
      api.patch<unknown>('/api/me', {
        settings: {
          ...(data?.settings ?? {}),
          briefing: { ...cfg, enabled, cadence, timeOfDayLocal, dayOfWeek, timezone },
        },
      }),
    onSuccess: () => {
      toast.success('Briefing settings saved');
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const generateNow = useMutation({
    mutationFn: async () =>
      api.post<{ jobId: string }>('/api/me/briefing/generate-now'),
    onSuccess: () =>
      toast.success(
        'Briefing queued — show up in the wiki under groupingMode "briefing" in a moment',
      ),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="card">
      <div className="mb-2 flex items-center gap-2">
        <BookOpen className="h-5 w-5 text-rose-500" />
        <h2 className="font-semibold">Narrative briefing</h2>
      </div>
      <p className="text-sm text-ink-500">
        On a configurable cadence, the LLM writes a short narrative
        editor's note over your recent wiki entries — clusters them
        into themes and produces a 3–5 paragraph briefing that lives as
        a wiki page (groupingMode <code>briefing</code>) and is
        linkable from anywhere.
      </p>
      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Generate automatically</span>
      </label>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs">
          <span className="mb-1 block font-medium">Cadence</span>
          <select
            className="input"
            value={cadence}
            onChange={(e) => setCadence(e.target.value as 'weekly' | 'monthly')}
          >
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium">Time (local)</span>
          <input
            className="input"
            type="time"
            value={timeOfDayLocal}
            onChange={(e) => setTimeOfDayLocal(e.target.value)}
          />
        </label>
        {cadence === 'weekly' && (
          <label className="block text-xs">
            <span className="mb-1 block font-medium">Day of week</span>
            <select
              className="input"
              value={dayOfWeek}
              onChange={(e) => setDayOfWeek(Number(e.target.value))}
            >
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block text-xs sm:col-span-2">
          <span className="mb-1 block font-medium">Timezone (IANA)</span>
          <input
            className="input"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
        </label>
      </div>
      {cfg.lastGeneratedAt && (
        <div className="mt-3 text-[11px] uppercase tracking-widest text-ink-500">
          Last generated {new Date(cfg.lastGeneratedAt).toLocaleString()}
        </div>
      )}
      {cfg.lastError && (
        <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
          Last note: {cfg.lastError}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => generateNow.mutate()}
          disabled={generateNow.isPending}
        >
          <Send className="h-3.5 w-3.5" /> Generate now
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => save.mutate()}
          disabled={save.isPending}
        >
          Save
        </button>
      </div>
    </div>
  );
}

type DigestSettings = {
  enabled?: boolean;
  toAddress?: string | null;
  cadence?: 'daily' | 'weekly';
  timeOfDayLocal?: string;
  weeklyDay?: number;
  timezone?: string;
  lastSentAt?: string | null;
  lastError?: string | null;
};

function DigestEmailCard() {
  const api = useApi();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['me'],
    queryFn: () =>
      api.get<{
        email: string;
        settings?: { digestEmail?: DigestSettings };
      }>('/api/me'),
  });

  const cfg: DigestSettings = data?.settings?.digestEmail ?? {};
  const [enabled, setEnabled] = useState(!!cfg.enabled);
  const [toAddress, setToAddress] = useState(cfg.toAddress ?? '');
  const [cadence, setCadence] = useState<'daily' | 'weekly'>(cfg.cadence ?? 'daily');
  const [timeOfDayLocal, setTimeOfDayLocal] = useState(cfg.timeOfDayLocal ?? '08:00');
  const [weeklyDay, setWeeklyDay] = useState(cfg.weeklyDay ?? 1);
  const [timezone, setTimezone] = useState(
    cfg.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  );

  // Re-hydrate when /api/me responds (initial state can be stale).
  useEffect(() => {
    if (!data) return;
    setEnabled(!!cfg.enabled);
    setToAddress(cfg.toAddress ?? '');
    setCadence(cfg.cadence ?? 'daily');
    setTimeOfDayLocal(cfg.timeOfDayLocal ?? '08:00');
    setWeeklyDay(cfg.weeklyDay ?? 1);
    setTimezone(
      cfg.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const save = useMutation({
    mutationFn: async () =>
      api.patch<unknown>('/api/me', {
        settings: {
          ...(data?.settings ?? {}),
          digestEmail: {
            ...cfg,
            enabled,
            toAddress: toAddress.trim() || null,
            cadence,
            timeOfDayLocal,
            weeklyDay,
            timezone,
          },
        },
      }),
    onSuccess: () => {
      toast.success('Digest settings saved');
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const sendNow = useMutation({
    mutationFn: async () =>
      api.post<{ jobId: string }>('/api/me/digest-email/send-now'),
    onSuccess: () => toast.success('Digest queued — check your inbox in a moment'),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="card">
      <div className="mb-2 flex items-center gap-2">
        <Mail className="h-5 w-5 text-rose-500" />
        <h2 className="font-semibold">Email this edition</h2>
      </div>
      <p className="text-sm text-ink-500">
        Mail the front-page digest to yourself (or anyone else) on a
        configurable cadence. Goes out through your first active outbound
        source — Gmail OAuth preferred, IMAP-derived SMTP otherwise.
      </p>
      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Send the digest automatically</span>
      </label>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs">
          <span className="mb-1 block font-medium">To address</span>
          <input
            className="input"
            type="email"
            value={toAddress}
            onChange={(e) => setToAddress(e.target.value)}
            placeholder={data?.email ?? 'you@example.com'}
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium">Cadence</span>
          <select
            className="input"
            value={cadence}
            onChange={(e) => setCadence(e.target.value as 'daily' | 'weekly')}
          >
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium">Time (local)</span>
          <input
            className="input"
            type="time"
            value={timeOfDayLocal}
            onChange={(e) => setTimeOfDayLocal(e.target.value)}
          />
        </label>
        {cadence === 'weekly' && (
          <label className="block text-xs">
            <span className="mb-1 block font-medium">Day of week</span>
            <select
              className="input"
              value={weeklyDay}
              onChange={(e) => setWeeklyDay(Number(e.target.value))}
            >
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block text-xs sm:col-span-2">
          <span className="mb-1 block font-medium">Timezone (IANA)</span>
          <input
            className="input"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="America/Chicago"
          />
        </label>
      </div>

      {cfg.lastSentAt && (
        <div className="mt-3 text-[11px] uppercase tracking-widest text-ink-500">
          Last sent {new Date(cfg.lastSentAt).toLocaleString()}
        </div>
      )}
      {cfg.lastError && (
        <div className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
          Last error: {cfg.lastError}
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => sendNow.mutate()}
          disabled={sendNow.isPending}
        >
          <Send className="h-3.5 w-3.5" /> Send now
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => save.mutate()}
          disabled={save.isPending}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function WeatherLocationCard() {
  const api = useApi();
  const qc = useQueryClient();
  const [query, setQuery] = useState('');

  const { data } = useQuery({
    queryKey: ['weather-locations'],
    queryFn: () =>
      api.get<{ locations: WeatherLocation[] }>('/api/weather/locations'),
  });

  const addLocation = useMutation({
    mutationFn: async (q: string) =>
      api.post<{ location: WeatherLocation }>('/api/weather/locations', { query: q }),
    onSuccess: (r) => {
      toast.success(`Added: ${r.location.label}`);
      qc.invalidateQueries({ queryKey: ['weather-locations'] });
      qc.invalidateQueries({ queryKey: ['weather'] });
      setQuery('');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeLocation = useMutation({
    mutationFn: async (id: string) =>
      api.del<{ ok: true }>(`/api/weather/locations/${id}`),
    onSuccess: () => {
      toast.success('Removed.');
      qc.invalidateQueries({ queryKey: ['weather-locations'] });
      qc.invalidateQueries({ queryKey: ['weather'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setPrimary = useMutation({
    mutationFn: async (id: string) =>
      api.post<{ ok: true }>(`/api/weather/locations/${id}/primary`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['weather-locations'] });
      qc.invalidateQueries({ queryKey: ['weather'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const refresh = useMutation({
    mutationFn: async () => api.get('/api/weather'),
    onSuccess: () => {
      toast.success('Forecast refreshed.');
      qc.invalidateQueries({ queryKey: ['weather'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const locations = data?.locations ?? [];

  return (
    <div className="card">
      <div className="mb-2 flex items-center gap-2">
        <CloudSun className="h-5 w-5 text-rose-500" />
        <h2 className="font-semibold">Weather locations</h2>
      </div>
      <p className="text-sm text-ink-500">
        Save one or more locations. The home page shows your primary first
        and lets you switch between the rest. NOAA covers U.S. forecasts only;
        geocoding is via OpenStreetMap.
      </p>

      {locations.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {locations.map((loc) => (
            <li
              key={loc.id}
              className="flex items-center gap-3 rounded-lg border border-ink-200 px-3 py-2 text-sm dark:border-ink-800"
            >
              <MapPin
                className={`h-4 w-4 ${loc.primary ? 'text-rose-500' : 'text-ink-400'}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{loc.label}</span>
                  {loc.primary && (
                    <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">
                      Primary
                    </span>
                  )}
                </div>
                <div className="text-xs text-ink-500">
                  <code>
                    {loc.lat.toFixed(3)}, {loc.lon.toFixed(3)}
                  </code>
                </div>
              </div>
              {!loc.primary && (
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setPrimary.mutate(loc.id)}
                  disabled={setPrimary.isPending}
                  aria-label="Make primary"
                  title="Make primary"
                >
                  <Star className="h-4 w-4" />
                </button>
              )}
              <button
                type="button"
                className="btn-ghost text-red-600"
                onClick={() => removeLocation.mutate(loc.id)}
                disabled={removeLocation.isPending}
                aria-label="Remove"
                title="Remove"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const v = query.trim();
          if (!v) return;
          addLocation.mutate(v);
        }}
      >
        <input
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='e.g. "Charlotte, NC" or "Seattle"'
          autoComplete="off"
        />
        <button
          className="btn-primary"
          type="submit"
          disabled={addLocation.isPending || !query.trim()}
        >
          <Plus className="h-4 w-4" />
          {addLocation.isPending ? 'Locating…' : 'Add'}
        </button>
      </form>

      {locations.length > 0 && (
        <button
          type="button"
          className="btn-ghost mt-2 text-xs"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refresh.isPending ? 'animate-spin' : ''}`} />
          Refresh forecasts
        </button>
      )}

      <p className="mt-3 text-xs text-ink-500">
        The brief is rendered by the LLM using the{' '}
        <code>weather.brief</code> instruction — clone and tweak it from{' '}
        <Link to="/settings/instructions" className="text-rose-600 hover:underline dark:text-rose-300">
          Settings → Instructions
        </Link>
        .
      </p>
    </div>
  );
}

function FeaturedTagsCard() {
  const api = useApi();
  const qc = useQueryClient();
  const [input, setInput] = useState('');

  const { data } = useQuery({
    queryKey: ['featured-tags'],
    queryFn: () => api.get<{ tags: string[] }>('/api/featured-tags'),
  });
  const { data: directory } = useQuery({
    queryKey: ['tag-directory'],
    queryFn: () => api.get<{ tags: { tag: string; pageCount: number }[] }>('/api/tags'),
  });

  const add = useMutation({
    mutationFn: async (tag: string) =>
      api.post<{ tags: string[] }>('/api/featured-tags', { tag }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['featured-tags'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
      setInput('');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: async (tag: string) =>
      api.del<{ tags: string[] }>(`/api/featured-tags/${encodeURIComponent(tag)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['featured-tags'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
    },
  });

  const featuredTags = data?.tags ?? [];
  const suggestions =
    directory?.tags
      ?.filter((d) => !featuredTags.includes(d.tag))
      ?.slice(0, 12) ?? [];

  return (
    <div className="card">
      <div className="mb-2 flex items-center gap-2">
        <Star className="h-5 w-5 text-rose-500" />
        <h2 className="font-semibold">Featured topics</h2>
      </div>
      <p className="text-sm text-ink-500">
        Each pinned tag becomes a named section in your newsletter. Pin tags
        you want to track at a glance.
      </p>

      {featuredTags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {featuredTags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
            >
              #{t}
              <button
                type="button"
                onClick={() => remove.mutate(t)}
                aria-label={`Unpin ${t}`}
                className="-mr-1 ml-0.5 rounded-full p-0.5 hover:bg-rose-200 dark:hover:bg-rose-900/60"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = input.trim().toLowerCase();
          if (!v) return;
          if (featuredTags.includes(v)) {
            toast.error('Already featured');
            return;
          }
          add.mutate(v);
        }}
        className="mt-3 flex gap-2"
      >
        <input
          className="input"
          list="featured-tag-suggestions-settings"
          placeholder="add a tag…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <datalist id="featured-tag-suggestions-settings">
          {suggestions.map((s) => (
            <option key={s.tag} value={s.tag}>
              {s.pageCount} pages
            </option>
          ))}
        </datalist>
        <button
          className="btn-primary"
          type="submit"
          disabled={add.isPending || !input.trim()}
        >
          <Plus className="h-4 w-4" />
        </button>
      </form>

      {suggestions.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-400">
            Suggestions
          </div>
          <div className="flex flex-wrap gap-1">
            {suggestions.slice(0, 10).map((s) => (
              <button
                key={s.tag}
                type="button"
                onClick={() => add.mutate(s.tag)}
                className="pill text-[10px] hover:bg-rose-100 hover:text-rose-800 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
                title={`${s.pageCount} pages`}
              >
                #{s.tag}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PromptsCallout() {
  return (
    <div className="card text-sm">
      <p className="text-ink-500">
        The newsletter weather brief, page generation, categorization, and
        every other LLM-driven prompt are user-editable. Clone any system
        instruction and tune it from{' '}
        <Link
          to="/settings/instructions"
          className="font-medium text-rose-600 hover:underline dark:text-rose-300"
        >
          Settings → Instructions
        </Link>
        .
      </p>
    </div>
  );
}
