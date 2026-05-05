import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Globe, RotateCw, ExternalLink, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import type { DaydreamSettings as DaydreamSettingsT } from '@rose/shared';
import { useApi } from '../../lib/api';

type RecentNote = {
  _id: string;
  kind: 'topic' | 'sender' | 'tag' | 'entity';
  subjectKey: string;
  displayName: string;
  summary: string;
  sources: { adapter: string; url: string; title: string }[];
  confidence: 'low' | 'medium' | 'high';
  model: string | null;
  generatedAt: string | null;
  failed: boolean;
  failureReason: string | null;
};

export default function DaydreamSettings() {
  const api = useApi();
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['daydream-settings'],
    queryFn: () => api.get<DaydreamSettingsT>('/api/daydream'),
  });
  const { data: recent } = useQuery({
    queryKey: ['daydream-recent'],
    queryFn: () => api.get<{ notes: RecentNote[] }>('/api/daydream/recent?limit=50'),
    refetchInterval: 15_000,
  });
  const [form, setForm] = useState<DaydreamSettingsT | null>(null);
  const [acceptedExplainer, setAcceptedExplainer] = useState(false);

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const save = useMutation({
    mutationFn: async (patch: Partial<DaydreamSettingsT>) =>
      api.patch<{ ok: true }>('/api/daydream', patch),
    onSuccess: () => {
      toast.success('Daydream settings saved');
      qc.invalidateQueries({ queryKey: ['daydream-settings'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const forget = useMutation({
    mutationFn: async (id: string) =>
      api.del<{ ok: true }>(`/api/daydream/notes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['daydream-recent'] }),
  });

  if (isLoading || !form) {
    return <div className="card text-sm text-ink-500">Loading…</div>;
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(settings);

  // First-time enable shows an egress explainer so the user knows the
  // worker is going to start making outbound HTTP requests on their
  // behalf.
  const wantsToEnableForFirstTime =
    form.enabled && !settings?.enabled && !acceptedExplainer;

  return (
    <div className="space-y-6">
      <div className="card">
        <div className="mb-2 flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-rose-500" />
          <h2 className="font-semibold">Daydream</h2>
        </div>
        <p className="text-sm text-ink-500">
          When the rest of the pipeline is idle, the worker can quietly
          fetch encyclopedic context for the topics, senders, and tags
          on your wiki pages and synthesise a short "Background" panel
          using your configured generation model. Off by default; when
          on, runs only while there's no other work to do.
        </p>

        {wantsToEnableForFirstTime && (
          <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
            <div className="font-medium">Heads-up before you enable</div>
            <ul className="mt-1 list-disc pl-4">
              <li>
                Your worker will make outbound HTTP requests to the
                knowledge sources you tick below (Wikipedia by default).
              </li>
              <li>
                Each researched subject is one extra LLM call against
                your configured generation provider. The daily cap below
                is a hard ceiling.
              </li>
              <li>
                Daydream notes live in their own collection; they don't
                modify your existing wiki pages.
              </li>
            </ul>
            <button
              type="button"
              className="btn-secondary mt-2 text-xs"
              onClick={() => setAcceptedExplainer(true)}
            >
              Got it
            </button>
          </div>
        )}

        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          <span>Enabled</span>
        </label>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="block text-xs">
            <span className="mb-1 block font-medium">Schedule</span>
            <select
              className="input"
              value={form.schedule}
              onChange={(e) =>
                setForm({ ...form, schedule: e.target.value as DaydreamSettingsT['schedule'] })
              }
            >
              <option value="idle">When idle (recommended)</option>
              <option value="daily">Once daily</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium">Daily call cap</span>
            <input
              className="input"
              type="number"
              min={1}
              max={500}
              value={form.dailyCallCap}
              onChange={(e) =>
                setForm({ ...form, dailyCallCap: Number(e.target.value) })
              }
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium">Per-page subjects</span>
            <input
              className="input"
              type="number"
              min={1}
              max={20}
              value={form.perPageMaxSubjects}
              onChange={(e) =>
                setForm({ ...form, perPageMaxSubjects: Number(e.target.value) })
              }
            />
          </label>
          {form.schedule === 'daily' && (
            <>
              <label className="block text-xs">
                <span className="mb-1 block font-medium">Time of day (local)</span>
                <input
                  className="input"
                  type="time"
                  value={form.dailyAtLocal}
                  onChange={(e) =>
                    setForm({ ...form, dailyAtLocal: e.target.value })
                  }
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block font-medium">Timezone</span>
                <input
                  className="input"
                  value={form.timezone}
                  onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                  placeholder="America/Chicago"
                />
              </label>
            </>
          )}
          <label className="block text-xs">
            <span className="mb-1 block font-medium">Re-research after (days)</span>
            <input
              className="input"
              type="number"
              min={1}
              max={365}
              value={form.refreshAfterDays}
              onChange={(e) =>
                setForm({ ...form, refreshAfterDays: Number(e.target.value) })
              }
            />
          </label>
        </div>

        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-ink-500">
            Sources
          </h3>
          <div className="space-y-2 text-sm">
            <SourceToggle
              label="Wikipedia"
              hint="Free, open, no API key. Encyclopedic articles."
              enabled={form.sources.wikipedia.enabled}
              onToggle={(v) =>
                setForm({
                  ...form,
                  sources: {
                    ...form.sources,
                    wikipedia: { ...form.sources.wikipedia, enabled: v },
                  },
                })
              }
              extra={
                <input
                  className="input w-20 text-xs"
                  value={form.sources.wikipedia.lang}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      sources: {
                        ...form.sources,
                        wikipedia: {
                          ...form.sources.wikipedia,
                          lang: e.target.value,
                        },
                      },
                    })
                  }
                  placeholder="en"
                  title="ISO language code"
                />
              }
            />
            <SourceToggle
              label="Wikidata"
              hint="Every entity Wikipedia covers + ~100M more (orgs, niche works, abstract concepts). Better coverage for things WP has no article on."
              enabled={form.sources.wikidata.enabled}
              onToggle={(v) =>
                setForm({
                  ...form,
                  sources: {
                    ...form.sources,
                    wikidata: { ...form.sources.wikidata, enabled: v },
                  },
                })
              }
              extra={
                <input
                  className="input w-20 text-xs"
                  value={form.sources.wikidata.lang}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      sources: {
                        ...form.sources,
                        wikidata: {
                          ...form.sources.wikidata,
                          lang: e.target.value,
                        },
                      },
                    })
                  }
                  placeholder="en"
                  title="ISO language code"
                />
              }
            />
            <SourceToggle
              label="OpenAlex"
              hint="250M+ scholarly works, abstracts, authors, citations. Best for research-leaning subjects."
              enabled={form.sources.openalex.enabled}
              onToggle={(v) =>
                setForm({
                  ...form,
                  sources: {
                    ...form.sources,
                    openalex: { ...form.sources.openalex, enabled: v },
                  },
                })
              }
              extra={
                <input
                  className="input w-44 text-xs"
                  value={form.sources.openalex.mailto}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      sources: {
                        ...form.sources,
                        openalex: {
                          ...form.sources.openalex,
                          mailto: e.target.value,
                        },
                      },
                    })
                  }
                  placeholder="you@example.com"
                  title="Polite-pool email — bumps the rate limit. Optional."
                />
              }
            />
            <SourceToggle
              label="Your link graph"
              hint="Walks the URLs your own emails have linked to find pages your corpus already vouched for. No external fetch."
              enabled={form.sources.linkGraph.enabled}
              onToggle={(v) =>
                setForm({
                  ...form,
                  sources: {
                    ...form.sources,
                    linkGraph: { ...form.sources.linkGraph, enabled: v },
                  },
                })
              }
              extra={
                <input
                  className="input w-20 text-xs"
                  type="number"
                  min={1}
                  max={10}
                  value={form.sources.linkGraph.minHostCount}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      sources: {
                        ...form.sources,
                        linkGraph: {
                          ...form.sources.linkGraph,
                          minHostCount: Number(e.target.value),
                        },
                      },
                    })
                  }
                  placeholder="2"
                  title="Minimum number of distinct pages a host must appear on before it's surfaced. Higher = stricter."
                />
              }
            />
            <p className="text-xs italic text-ink-400">
              Wiktionary, Stack Exchange, arXiv, Hacker News, and a
              user-curated Library are coming in subsequent passes per
              plan 10.
            </p>
          </div>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              if (form.enabled && !settings?.enabled && !acceptedExplainer) {
                toast.error('Acknowledge the egress notice first.');
                return;
              }
              save.mutate(form);
            }}
            disabled={save.isPending || !dirty}
          >
            Save
          </button>
        </div>
      </div>

      <div className="card">
        <div className="mb-3 flex items-center gap-2">
          <RotateCw className="h-5 w-5 text-rose-500" />
          <h2 className="font-semibold">Recent activity</h2>
          <span className="ml-auto text-xs text-ink-500">
            {recent?.notes.length ?? 0} notes
          </span>
        </div>
        {(recent?.notes.length ?? 0) === 0 ? (
          <p className="text-sm italic text-ink-500">
            No daydream activity yet. Once enabled, the sweeper picks
            pages while the rest of the pipeline is idle and writes
            encyclopedic context here.
          </p>
        ) : (
          <ul className="divide-y divide-ink-200 text-sm dark:divide-ink-800">
            {recent!.notes.map((n) => (
              <li key={n._id} className="flex items-start gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs italic text-ink-500">{n.kind}</span>
                    <code className="truncate text-xs">{n.displayName || n.subjectKey}</code>
                    {n.failed ? (
                      <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300">
                        failed
                      </span>
                    ) : (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                        ok
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-500">
                    {n.failed
                      ? n.failureReason ?? 'no source returned content'
                      : n.summary.slice(0, 140)}
                  </div>
                  {n.sources.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-ink-500">
                      {n.sources.map((s) => (
                        <a
                          key={s.url}
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 hover:text-rose-600"
                        >
                          <Globe className="h-2.5 w-2.5" />
                          {s.adapter}
                          <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      ))}
                      {n.generatedAt && (
                        <span>· {new Date(n.generatedAt).toLocaleString()}</span>
                      )}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Forget "${n.displayName || n.subjectKey}"?`))
                      forget.mutate(n._id);
                  }}
                  className="btn-ghost text-xs text-ink-400 hover:text-red-600"
                  aria-label="Forget"
                  title="Forget — daydream may re-research it later"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SourceToggle({
  label,
  hint,
  enabled,
  onToggle,
  extra,
}: {
  label: string;
  hint: string;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  extra?: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-3 rounded border border-ink-200 px-3 py-2 dark:border-ink-800">
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        <div className="text-xs text-ink-500">{hint}</div>
      </div>
      {extra}
    </label>
  );
}
