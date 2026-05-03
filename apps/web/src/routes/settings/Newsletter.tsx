import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudSun, MapPin, Trash2, Star, Plus, X, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';

type WeatherLocation = {
  lat: number;
  lon: number;
  label: string;
};

export default function NewsletterSettings() {
  return (
    <div className="space-y-6">
      <WeatherLocationCard />
      <FeaturedTagsCard />
      <PromptsCallout />
    </div>
  );
}

function WeatherLocationCard() {
  const api = useApi();
  const qc = useQueryClient();
  const [query, setQuery] = useState('');

  const { data } = useQuery({
    queryKey: ['weather-location'],
    queryFn: () =>
      api.get<{ location: WeatherLocation | null }>('/api/weather/location'),
  });

  const setLocation = useMutation({
    mutationFn: async (q: string) =>
      api.post<{ location: WeatherLocation }>('/api/weather/location', { query: q }),
    onSuccess: (r) => {
      toast.success(`Set location: ${r.location.label}`);
      qc.invalidateQueries({ queryKey: ['weather-location'] });
      qc.invalidateQueries({ queryKey: ['weather'] });
      setQuery('');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const clear = useMutation({
    mutationFn: async () => api.del<{ ok: true }>('/api/weather/location'),
    onSuccess: () => {
      toast.success('Cleared.');
      qc.invalidateQueries({ queryKey: ['weather-location'] });
      qc.invalidateQueries({ queryKey: ['weather'] });
    },
  });

  const refresh = useMutation({
    mutationFn: async () => api.get('/api/weather'),
    onSuccess: () => {
      toast.success('Forecast refreshed.');
      qc.invalidateQueries({ queryKey: ['weather'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const current = data?.location ?? null;

  return (
    <div className="card">
      <div className="mb-2 flex items-center gap-2">
        <CloudSun className="h-5 w-5 text-rose-500" />
        <h2 className="font-semibold">Weather location</h2>
      </div>
      <p className="text-sm text-ink-500">
        The forecast banner at the top of the newsletter pulls from the U.S.
        National Weather Service (NOAA), so this is U.S.-only. Geocoding via
        OpenStreetMap. The brief itself is rendered by the LLM using the{' '}
        <code>weather.brief</code> instruction — clone and tweak it from{' '}
        <Link to="/settings/instructions" className="text-rose-600 hover:underline dark:text-rose-300">
          Settings → Instructions
        </Link>
        .
      </p>

      {current?.label && (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-ink-200 px-3 py-2 text-sm dark:border-ink-800">
          <MapPin className="h-4 w-4 text-rose-500" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{current.label}</div>
            <div className="text-xs text-ink-500">
              <code>
                {current.lat.toFixed(3)}, {current.lon.toFixed(3)}
              </code>
            </div>
          </div>
          <button
            className="btn-ghost"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            aria-label="Refresh forecast"
            title="Refresh forecast"
          >
            <RefreshCw
              className={`h-4 w-4 ${refresh.isPending ? 'animate-spin' : ''}`}
            />
          </button>
          <button
            className="btn-ghost text-red-600"
            onClick={() => clear.mutate()}
            aria-label="Clear location"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const v = query.trim();
          if (!v) return;
          setLocation.mutate(v);
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
          disabled={setLocation.isPending || !query.trim()}
        >
          {setLocation.isPending ? 'Locating…' : 'Set location'}
        </button>
      </form>
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
