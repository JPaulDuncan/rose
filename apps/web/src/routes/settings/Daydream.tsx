import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Globe, RotateCw, ExternalLink, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import type { DaydreamSettings as DaydreamSettingsT } from '@rose/shared';
import { useApi } from '../../lib/api';
import { adapterLabel } from '../../lib/sourceLabel';
import { EgressAcknowledgement } from '../../components/EgressAcknowledgement';

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
  /** Plan 15 — display name of the user whose pass first surfaced
   *  this subject. Empty string when missing. */
  contributedBy?: string;
};

export default function DaydreamSettings() {
  const api = useApi();
  const qc = useQueryClient();
  const { data: settings, isLoading, isError, error } = useQuery({
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
  const [acceptedExternalExplainer, setAcceptedExternalExplainer] = useState(false);
  // Brave subscription token is stored encrypted server-side and
  // never echoed back; we track the in-flight plaintext separately
  // so it can be sent on save then cleared.
  const [braveKey, setBraveKey] = useState('');

  useEffect(() => {
    if (settings) setForm(settings);
  }, [settings]);

  const save = useMutation({
    mutationFn: async (patch: Partial<DaydreamSettingsT>) =>
      api.patch<{ ok: true }>('/api/daydream', patch),
    onSuccess: () => {
      toast.success('Daydream settings saved');
      qc.invalidateQueries({ queryKey: ['daydream-settings'] });
      setBraveKey('');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Build the patch payload — most of the form passes through
  // verbatim, but the Brave key is a write-only field on
  // DaydreamSettingsUpdate (not on DaydreamSettings, which is the
  // GET shape with `hasApiKey`). Cast to the broader update shape
  // so we can splice the plaintext apiKey in when the user has
  // typed a new value.
  function buildSavePatch(f: DaydreamSettingsT): Record<string, unknown> {
    const patch: Record<string, unknown> = { ...f };
    if (braveKey) {
      const ext = (patch.externalSearch ?? f.externalSearch) as Record<string, unknown>;
      patch.externalSearch = {
        ...ext,
        brave: {
          ...((ext.brave as Record<string, unknown>) ?? {}),
          apiKey: braveKey,
        },
      };
    }
    return patch;
  }
  const forget = useMutation({
    mutationFn: async (id: string) =>
      api.del<{ ok: true }>(`/api/daydream/notes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['daydream-recent'] }),
  });

  if (isError) {
    return (
      <div className="card text-sm">
        <div className="font-medium text-red-600">
          Couldn't load Daydream settings.
        </div>
        <div className="mt-1 text-xs text-ink-500">
          {(error as Error)?.message ?? 'Unknown error.'}
        </div>
      </div>
    );
  }
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
          on your articles and synthesize a short "Background" panel
          using your configured generation model. Off by default; when
          on, runs only while there's no other work to do.
        </p>

        <EgressAcknowledgement
          show={wantsToEnableForFirstTime}
          onAccept={() => setAcceptedExplainer(true)}
          bullets={[
            <>
              Your worker will make outbound HTTP requests to the
              knowledge sources you tick below (Wikipedia by default).
            </>,
            <>
              Each researched subject is one extra LLM call against
              your configured generation provider. The daily cap below
              is a hard ceiling.
            </>,
            <>
              Daydream notes live in their own collection; they don't
              modify your existing articles.
            </>,
          ]}
        />

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
            <SourceToggle
              label="Wiktionary"
              hint="Definitions + etymologies for terms too narrow for Wikipedia. Single-word queries only."
              enabled={form.sources.wiktionary.enabled}
              onToggle={(v) =>
                setForm({
                  ...form,
                  sources: {
                    ...form.sources,
                    wiktionary: { ...form.sources.wiktionary, enabled: v },
                  },
                })
              }
              extra={
                <input
                  className="input w-20 text-xs"
                  value={form.sources.wiktionary.lang}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      sources: {
                        ...form.sources,
                        wiktionary: { ...form.sources.wiktionary, lang: e.target.value },
                      },
                    })
                  }
                  placeholder="en"
                  title="ISO language code"
                />
              }
            />
            <SourceToggle
              label="Crossref"
              hint="DOI metadata across 150M+ scholarly works. Best when OpenAlex doesn't have the record."
              enabled={form.sources.crossref.enabled}
              onToggle={(v) =>
                setForm({
                  ...form,
                  sources: {
                    ...form.sources,
                    crossref: { ...form.sources.crossref, enabled: v },
                  },
                })
              }
              extra={
                <input
                  className="input w-44 text-xs"
                  value={form.sources.crossref.mailto}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      sources: {
                        ...form.sources,
                        crossref: { ...form.sources.crossref, mailto: e.target.value },
                      },
                    })
                  }
                  placeholder="you@example.com"
                  title="Polite-pool email — bumps the rate limit. Optional."
                />
              }
            />
            <SourceToggle
              label="arXiv"
              hint="Pre-prints across math, CS, physics, statistics, and adjacent fields. No key, but ~1 query / 3 sec sustained."
              enabled={form.sources.arxiv.enabled}
              onToggle={(v) =>
                setForm({
                  ...form,
                  sources: {
                    ...form.sources,
                    arxiv: { ...form.sources.arxiv, enabled: v },
                  },
                })
              }
            />
            <SourceToggle
              label="Hacker News"
              hint="Discussion + commentary across HN's full archive (Algolia search)."
              enabled={form.sources.hackernews.enabled}
              onToggle={(v) =>
                setForm({
                  ...form,
                  sources: {
                    ...form.sources,
                    hackernews: { ...form.sources.hackernews, enabled: v },
                  },
                })
              }
            />
            <SourceToggle
              label="Stack Exchange"
              hint="Programming/technical Q&A. Comma-separated site keywords (stackoverflow, superuser, askubuntu, …). 300/day anon, 10K with key."
              enabled={form.sources.stackexchange.enabled}
              onToggle={(v) =>
                setForm({
                  ...form,
                  sources: {
                    ...form.sources,
                    stackexchange: { ...form.sources.stackexchange, enabled: v },
                  },
                })
              }
              extra={
                <input
                  className="input w-56 text-xs"
                  value={(form.sources.stackexchange.sites ?? []).join(', ')}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      sources: {
                        ...form.sources,
                        stackexchange: {
                          ...form.sources.stackexchange,
                          sites: e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        },
                      },
                    })
                  }
                  placeholder="stackoverflow, superuser"
                  title="Stack Exchange site keywords (comma-separated)."
                />
              }
            />
            <SourceToggle
              label="GitHub"
              hint="Public repo search. Description + stars + topics per hit. PAT bumps the rate limit from 60/h to 5K/h."
              enabled={form.sources.github.enabled}
              onToggle={(v) =>
                setForm({
                  ...form,
                  sources: {
                    ...form.sources,
                    github: { ...form.sources.github, enabled: v },
                  },
                })
              }
              extra={
                <input
                  className="input w-44 text-xs"
                  type="password"
                  autoComplete="new-password"
                  value={form.sources.github.token}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      sources: {
                        ...form.sources,
                        github: { ...form.sources.github, token: e.target.value },
                      },
                    })
                  }
                  placeholder="ghp_… (optional)"
                  title="Personal access token. Public repo search needs no scopes."
                />
              }
            />
            <p className="text-xs italic text-ink-400">
              Looking for federated web search? See the External
              search card below. Tier 1 stragglers (PubMed,
              MusicBrainz, OpenLibrary) ship as the user's domain
              dictates.
            </p>
          </div>
        </div>

        <ExternalSearchCard
          form={form}
          setForm={setForm}
          braveKey={braveKey}
          setBraveKey={setBraveKey}
          acceptedExternalExplainer={acceptedExternalExplainer}
          setAcceptedExternalExplainer={setAcceptedExternalExplainer}
          settingsHadExternalEnabled={!!settings?.externalSearch?.enabled}
        />

        {/*
         * Topic research (web-integration Phase 1). Sits below the
         * other external-egress toggles so the user has already seen
         * the "this fetches the open web" explainer up the page.
         * Independent toggle — daydream and topic research can be
         * enabled separately. Form persists via the same /api/daydream
         * patch handler.
         */}
        <section className="card mt-4">
          <h3 className="text-sm font-semibold">Topic research</h3>
          <p className="mt-1 text-xs text-ink-500">
            When you click <strong>Research</strong> on a wiki page, Rose
            queries SearXNG, fetches the top results, and synthesises a
            new version of the page that fuses your mail with current
            web context. Off by default. Citations link back to the
            original sources; we never bypass paywalls or follow links
            inside spam.
          </p>

          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.webResearch?.enabled ?? false}
              onChange={(e) =>
                setForm({
                  ...form,
                  webResearch: {
                    ...(form.webResearch ?? {
                      enabled: false,
                      dailyFetchBudget: 200,
                      perRunFetchBudget: 25,
                      perRunTimeoutMs: 5 * 60_000,
                      topicThreshold: 0.55,
                      denyHosts: [],
                    }),
                    enabled: e.target.checked,
                  },
                })
              }
            />
            <span>Enable topic research</span>
          </label>

          {form.webResearch?.enabled && (
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="block text-xs">
                <span className="mb-1 block font-medium">
                  Per-run fetch budget
                </span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  className="input"
                  value={form.webResearch?.perRunFetchBudget ?? 25}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      webResearch: {
                        ...form.webResearch!,
                        perRunFetchBudget: Math.max(
                          1,
                          Math.min(50, Number(e.target.value) || 25),
                        ),
                      },
                    })
                  }
                />
                <span className="mt-0.5 block text-[10px] text-ink-500">
                  Max URLs fetched in one research run.
                </span>
              </label>
              <label className="block text-xs">
                <span className="mb-1 block font-medium">Topic threshold</span>
                <input
                  type="number"
                  min={0.2}
                  max={0.95}
                  step={0.05}
                  className="input"
                  value={form.webResearch?.topicThreshold ?? 0.55}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      webResearch: {
                        ...form.webResearch!,
                        topicThreshold: Math.max(
                          0.2,
                          Math.min(0.95, Number(e.target.value) || 0.55),
                        ),
                      },
                    })
                  }
                />
                <span className="mt-0.5 block text-[10px] text-ink-500">
                  Cosine cutoff for keeping a fetched doc in the synthesis
                  corpus. Higher = stricter.
                </span>
              </label>
              <label className="block text-xs">
                <span className="mb-1 block font-medium">
                  Daily fetch budget
                </span>
                <input
                  type="number"
                  min={0}
                  max={2000}
                  className="input"
                  value={form.webResearch?.dailyFetchBudget ?? 200}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      webResearch: {
                        ...form.webResearch!,
                        dailyFetchBudget: Math.max(
                          0,
                          Math.min(2000, Number(e.target.value) || 200),
                        ),
                      },
                    })
                  }
                />
                <span className="mt-0.5 block text-[10px] text-ink-500">
                  Cap on outbound fetches per 24h, across every run.
                </span>
              </label>
            </div>
          )}
        </section>


        <div className="mt-5 flex justify-end">
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              if (form.enabled && !settings?.enabled && !acceptedExplainer) {
                toast.error('Acknowledge the daydream egress notice first.');
                return;
              }
              if (
                form.externalSearch.enabled &&
                !settings?.externalSearch?.enabled &&
                !acceptedExternalExplainer
              ) {
                toast.error('Acknowledge the external-search egress notice first.');
                return;
              }
              save.mutate(buildSavePatch(form));
            }}
            disabled={save.isPending || (!dirty && !braveKey)}
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
                          {adapterLabel(s.adapter, s.url)}
                          <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      ))}
                      {n.generatedAt && (
                        <span>· {new Date(n.generatedAt).toLocaleString()}</span>
                      )}
                      {n.contributedBy && (
                        <span
                          className="italic"
                          title="Daydream notes are shared. This shows whose research first surfaced the subject."
                        >
                          · contributed by {n.contributedBy}
                        </span>
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

/**
 * Tier 4 federated-search subsection. Lives as its own card so the
 * egress acknowledgement, BYO-key inputs, and master toggle don't
 * crowd the structured-knowledge sources above. Mutates the same
 * `form` state, so the main Save button at the top of the page
 * persists both card's changes in one PATCH.
 */
function ExternalSearchCard({
  form,
  setForm,
  braveKey,
  setBraveKey,
  acceptedExternalExplainer,
  setAcceptedExternalExplainer,
  settingsHadExternalEnabled,
}: {
  form: DaydreamSettingsT;
  setForm: (f: DaydreamSettingsT) => void;
  braveKey: string;
  setBraveKey: (k: string) => void;
  acceptedExternalExplainer: boolean;
  setAcceptedExternalExplainer: (v: boolean) => void;
  settingsHadExternalEnabled: boolean;
}) {
  const ext = form.externalSearch;
  const wantsToEnableExt =
    ext.enabled && !settingsHadExternalEnabled && !acceptedExternalExplainer;

  return (
    <div className="card">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-rose-500" />
        <h2 className="font-semibold">External search (opt-in)</h2>
      </div>
      <p className="text-sm text-ink-500">
        Federated web-search adapters. Unlike the structured-knowledge
        sources in the Daydream card above, these query the open web —
        your queries leave your network. Off by default; the master
        switch gates every adapter in this card regardless of its
        individual flag.
      </p>

      <EgressAcknowledgement
        show={wantsToEnableExt}
        onAccept={() => setAcceptedExternalExplainer(true)}
        bullets={[
          <>
            Your daydream queries (topics + entity names from your
            articles) will be sent to whichever adapters you tick
            below.
          </>,
          <>
            Marginalia and DuckDuckGo Instant Answer don't require a
            key; Brave and SearXNG are services you supply yourself.
            Rose never proxies or aggregates keys.
          </>,
          <>
            Disable the master switch any time — every adapter
            stops firing immediately.
          </>,
        ]}
      />

      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={ext.enabled}
          onChange={(e) =>
            setForm({
              ...form,
              externalSearch: { ...ext, enabled: e.target.checked },
            })
          }
        />
        <span>Enable external search adapters (master switch)</span>
      </label>

      <div
        className={`mt-3 space-y-2 text-sm ${ext.enabled ? '' : 'pointer-events-none opacity-60'}`}
      >
        <SourceToggle
          label="Marginalia"
          hint="Independent crawler focused on the small/independent web. No key, principled, free."
          enabled={ext.marginalia.enabled}
          onToggle={(v) =>
            setForm({
              ...form,
              externalSearch: {
                ...ext,
                marginalia: { ...ext.marginalia, enabled: v },
              },
            })
          }
        />
        <SourceToggle
          label="DuckDuckGo Instant Answer"
          hint="Curated 'instant answer' hits — high-quality when present, but covers only a few million topics. No key."
          enabled={ext.duckduckgo.enabled}
          onToggle={(v) =>
            setForm({
              ...form,
              externalSearch: {
                ...ext,
                duckduckgo: { ...ext.duckduckgo, enabled: v },
              },
            })
          }
        />
        <SourceToggle
          label="Brave Search"
          hint="Independent web index. Free tier 2K queries/month. Bring your own subscription token."
          enabled={ext.brave.enabled}
          onToggle={(v) =>
            setForm({
              ...form,
              externalSearch: { ...ext, brave: { ...ext.brave, enabled: v } },
            })
          }
          extra={
            <input
              className="input w-44 text-xs"
              type="password"
              autoComplete="new-password"
              value={braveKey}
              onChange={(e) => setBraveKey(e.target.value)}
              placeholder={ext.brave.hasApiKey ? '••••••••' : 'BSA…'}
              title="Brave Search subscription token. Stored AES-256-GCM encrypted; never echoed back."
            />
          }
        />
        <SourceToggle
          label="SearXNG (federated meta-search)"
          hint="Toggling this on uses the SearXNG instance that ships with Rose's docker-compose stack — no setup required. To point at your own SearXNG instead, paste its URL on the right (JSON output must be enabled in its settings.yml)."
          enabled={ext.searxng.enabled}
          onToggle={(v) =>
            setForm({
              ...form,
              externalSearch: {
                ...ext,
                searxng: { ...ext.searxng, enabled: v },
              },
            })
          }
          extra={
            <input
              className="input w-56 text-xs"
              value={ext.searxng.instanceUrl}
              onChange={(e) =>
                setForm({
                  ...form,
                  externalSearch: {
                    ...ext,
                    searxng: { ...ext.searxng, instanceUrl: e.target.value },
                  },
                })
              }
              placeholder="bundled (or your URL)"
              title="Override URL (leave blank to use the bundled instance)."
            />
          }
        />
        {ext.brave.hasApiKey && (
          <p className="text-[11px] text-ink-500">
            Brave key on file.{' '}
            <button
              type="button"
              className="text-rose-600 hover:underline"
              onClick={() => {
                if (
                  confirm('Clear the stored Brave Search subscription token?')
                ) {
                  setBraveKey('');
                  setForm({
                    ...form,
                    externalSearch: {
                      ...ext,
                      brave: { ...ext.brave, hasApiKey: false },
                    },
                  });
                }
              }}
            >
              Clear
            </button>
          </p>
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
