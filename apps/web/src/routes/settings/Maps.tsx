import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';
import { EgressAcknowledgement } from '../../components/EgressAcknowledgement';

type MapsSettings = {
  enabled: boolean;
  acknowledgedAt: string | null;
};

/**
 * Settings → Maps. Plan 11, Tier A.
 *
 * Master toggle controls whether the worker enriches generated pages
 * and parsed events with geocoded coordinates. First-time enable
 * shows an egress acknowledgement so the user explicitly opts in to
 * outbound HTTP requests against Nominatim and tile downloads from
 * CARTO. The server records `lastAcknowledgedAt` server-side; the
 * UI uses the `acknowledgedAt` field to decide whether to show the
 * note again.
 */
export default function MapsSettingsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const { data: settings, isLoading, isError, error } = useQuery({
    queryKey: ['maps-settings'],
    queryFn: () => api.get<MapsSettings>('/api/maps/settings'),
  });
  const [form, setForm] = useState<MapsSettings | null>(null);
  const [acceptedExplainer, setAcceptedExplainer] = useState(false);

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const save = useMutation({
    mutationFn: async (patch: { enabled?: boolean; acknowledge?: boolean }) =>
      api.patch<{ ok: true }>('/api/maps/settings', patch),
    onSuccess: () => {
      toast.success('Maps settings saved');
      qc.invalidateQueries({ queryKey: ['maps-settings'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isError) {
    return (
      <div className="card text-sm">
        <div className="font-medium text-red-600">Couldn't load Maps settings.</div>
        <div className="mt-1 text-xs text-ink-500">
          {(error as Error)?.message ?? 'Unknown error.'}
        </div>
      </div>
    );
  }
  if (isLoading || !form) {
    return <div className="card text-sm text-ink-500">Loading…</div>;
  }

  const dirty = form.enabled !== settings?.enabled;
  // Show the egress note when the user is enabling for the first
  // time — i.e. they're flipping from off → on AND they've never
  // acknowledged the note before. After they click "Got it" the
  // banner stays cleared for the rest of the session; persisting the
  // ack happens on save.
  const wantsToEnableForFirstTime =
    form.enabled &&
    !settings?.enabled &&
    !settings?.acknowledgedAt &&
    !acceptedExplainer;

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="mb-2 flex items-center gap-2">
          <MapPin className="h-5 w-5 text-rose-500" />
          <h2 className="font-semibold">Maps</h2>
        </div>
        <p className="text-sm text-ink-500">
          When enabled, the worker geocodes the locations it extracts
          from your incoming events and the named places it finds in
          your generated articles, and the UI renders small map
          insets in the home edition, calendar, and individual pages.
          Off by default; flipping it on doesn't backfill — only newly
          processed pages and events pick up coordinates.
        </p>

        <EgressAcknowledgement
          show={wantsToEnableForFirstTime}
          onAccept={() => setAcceptedExplainer(true)}
          bullets={[
            <>
              Geocoding queries (event locations + extracted place
              names) are sent to OpenStreetMap's Nominatim service
              with a 24-hour cache; one outbound request per
              previously-unseen place, throttled to 1 req/sec per
              Nominatim's usage policy.
            </>,
            <>
              Map tiles are loaded from CARTO's public Voyager
              basemap (OSM-attributed) directly by your browser when
              a map renders.
            </>,
            <>
              Place extraction itself is one extra LLM call per
              generated page against your configured generation
              provider.
            </>,
            <>
              Disable this toggle any time — extraction stops
              immediately and existing place data stays on the page
              until you delete it.
            </>,
          ]}
        />

        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          <span>Enable maps</span>
        </label>

        {settings?.acknowledgedAt && (
          <p className="mt-2 text-[11px] italic text-ink-400">
            Egress note acknowledged on{' '}
            {new Date(settings.acknowledgedAt).toLocaleString()}.
          </p>
        )}

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              if (
                form.enabled &&
                !settings?.enabled &&
                !settings?.acknowledgedAt &&
                !acceptedExplainer
              ) {
                toast.error('Acknowledge the maps egress notice first.');
                return;
              }
              const patch: { enabled?: boolean; acknowledge?: boolean } = {};
              if (dirty) patch.enabled = form.enabled;
              // Persist the acknowledgement the first time the user
              // opts in. Subsequent saves don't re-set it because the
              // server already has a timestamp on file.
              if (
                form.enabled &&
                !settings?.acknowledgedAt &&
                acceptedExplainer
              ) {
                patch.acknowledge = true;
              }
              if (Object.keys(patch).length === 0) return;
              save.mutate(patch);
            }}
            disabled={save.isPending || !dirty}
          >
            Save
          </button>
        </div>
      </div>

      <div className="card text-xs text-ink-500">
        <h3 className="mb-2 text-sm font-semibold text-ink-700 dark:text-ink-200">
          How it works
        </h3>
        <ul className="list-disc space-y-1 pl-4">
          <li>
            <strong>Events.</strong> When an email mentions a date and
            a location, the event extractor saves the location text and
            (with maps on) calls Nominatim once to resolve it to
            lat/lon. Failed lookups are cached so we don't keep
            asking.
          </li>
          <li>
            <strong>Articles.</strong> After an article generates, an
            LLM step pulls up to six named places out of the body and
            geocodes the new ones. The right-rail "Places" card on a
            page renders the result.
          </li>
          <li>
            <strong>Re-runs.</strong> Place extraction is keyed off a
            content hash, so re-publishing a page with the same body
            doesn't burn another LLM call. Geocoded entries are
            preserved across re-runs; failures aren't retried.
          </li>
        </ul>
      </div>
    </div>
  );
}
