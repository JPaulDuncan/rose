import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Map as MapIcon, Settings as SettingsIcon } from 'lucide-react';
import { useApi } from '../lib/api';
import { MapInset, type MapPin } from '../components/MapInset';

type PlaceEntry = {
  normKey: string;
  name: string;
  displayName: string | null;
  lat: number;
  lon: number;
  pageCount: number;
  pages: { slug: string; title: string }[];
};

type MapsSettings = {
  enabled: boolean;
  acknowledgedAt: string | null;
};

/**
 * Atlas of every geocoded place across the user's pages — one pin
 * per (normKey, rounded coord). Pins click through to the entity
 * page (/n/<normKey>) so the user can drill into the contributing
 * articles. Multi-pin Leaflet view; egress-gated on Settings → Maps
 * the same way the inline map insets are.
 */
export default function MapPage() {
  const api = useApi();
  const { data: settings } = useQuery({
    queryKey: ['maps-settings'],
    queryFn: () => api.get<MapsSettings>('/api/maps/settings'),
  });
  const enabled = !!settings?.enabled;
  const { data, isLoading } = useQuery({
    queryKey: ['map-places'],
    queryFn: () => api.get<{ places: PlaceEntry[] }>('/api/maps/places'),
    enabled,
    refetchOnWindowFocus: false,
  });

  const pins: MapPin[] = (data?.places ?? []).map((p) => ({
    lat: p.lat,
    lon: p.lon,
    label: `${p.displayName || p.name}${
      p.pageCount > 1 ? ` (${p.pageCount} pages)` : ''
    }`,
    href: `/n/${encodeURIComponent(p.normKey)}`,
  }));

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <div className="mb-6 flex items-center gap-3">
        <MapIcon className="h-6 w-6 text-rose-500" />
        <h1 className="text-2xl font-semibold tracking-tight">Map</h1>
        <span className="ml-auto text-sm text-ink-500">
          {data?.places.length ?? 0} place
          {(data?.places.length ?? 0) === 1 ? '' : 's'}
        </span>
      </div>

      {!enabled ? (
        <div className="card">
          <p className="text-sm text-ink-500">
            Maps are disabled. The atlas needs to load tiles from
            OpenStreetMap to render — turn the feature on in{' '}
            <Link
              to="/settings/maps"
              className="inline-flex items-center gap-1 text-rose-600 hover:underline dark:text-rose-300"
            >
              <SettingsIcon className="h-3.5 w-3.5" /> Settings → Maps
            </Link>{' '}
            to acknowledge the egress note.
          </p>
        </div>
      ) : isLoading ? (
        <div className="card text-sm text-ink-500">Loading places…</div>
      ) : pins.length === 0 ? (
        <div className="card text-sm text-ink-500">
          No geocoded places on your pages yet. As articles land that
          mention a city, building, or landmark, the worker geocodes
          them and they appear here.
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="card overflow-hidden p-0">
            <MapInset
              pins={pins}
              height="600px"
              className="overflow-hidden rounded-lg"
            />
          </div>
          <aside className="space-y-2 text-sm">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-ink-500">
              Places by mentions
            </h2>
            <ul className="space-y-1">
              {(data?.places ?? []).map((p) => (
                <li key={`${p.normKey}-${p.lat}-${p.lon}`}>
                  <Link
                    to={`/n/${encodeURIComponent(p.normKey)}`}
                    className="flex items-baseline justify-between gap-2 rounded px-2 py-1 hover:bg-rose-50 dark:hover:bg-rose-950/20"
                  >
                    <span className="truncate">
                      {p.displayName || p.name}
                    </span>
                    <span className="shrink-0 text-xs text-ink-500">
                      {p.pageCount}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      )}
    </div>
  );
}
