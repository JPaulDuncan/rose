import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Sparkles,
  Plus,
  Trash2,
  Pencil,
  PlayCircle,
  AlertTriangle,
  Clock,
  CheckCircle2,
  X as XIcon,
  ExternalLink as ExternalLinkIcon,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';

type TopicWatch = {
  _id: string;
  name: string;
  topic: string;
  cron: string;
  timezone: string;
  targetWords: number;
  customPrompt: string | null;
  maxResultsPerSource: number;
  includeNewsSearch: boolean;
  /** Web-integration Phase 2 follow-up — when true, every fire
   *  enqueues a deeper topicResearch run after the snippet
   *  synthesis. Gated by the user's master webResearch toggle. */
  deepResearchAfter?: boolean;
  /** Slug of the Page this watch upserts on each run, or null when
   *  the watch hasn't fired successfully yet. */
  pageSlug: string | null;
  enabled: boolean;
  fireCount: number;
  errorCount: number;
  lastFiredAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
};

/**
 * Topic Watches surface. Lets a user say "every morning at 8am Eastern,
 * brief me on Spider-Man" without writing a cron string. The form is
 * deliberately stripped down — preset cadence chips + a timezone +
 * a topic — and each preset maps to a real cron pattern under the
 * hood. Power users can still drop into Settings → Recipes to edit
 * the underlying recipe directly.
 */
export default function TopicWatchesPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<TopicWatch | null>(null);
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['topic-watches'],
    queryFn: () =>
      api.get<{ watches: TopicWatch[] }>('/api/topic-watches'),
  });

  const create = useMutation({
    mutationFn: async (body: WatchFormValues) =>
      api.post<{ _id: string }>('/api/topic-watches', body),
    onSuccess: () => {
      toast.success('Watch created');
      setCreating(false);
      void qc.invalidateQueries({ queryKey: ['topic-watches'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: WatchFormValues }) =>
      api.patch<{ ok: true }>(`/api/topic-watches/${id}`, body),
    onSuccess: () => {
      toast.success('Watch saved');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['topic-watches'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) =>
      api.del<{ ok: true }>(`/api/topic-watches/${id}`),
    onSuccess: () => {
      toast.success('Watch removed');
      void qc.invalidateQueries({ queryKey: ['topic-watches'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleEnabled = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<{ ok: true }>(`/api/topic-watches/${id}`, { enabled }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['topic-watches'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runNow = useMutation({
    mutationFn: async (id: string) =>
      api.post<{ ok: true }>(`/api/topic-watches/${id}/run-now`, {}),
    onSuccess: () => {
      toast.success('Run queued — check the article in a minute');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const watches = data?.watches ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-8">
      <header>
        <div className="text-[10px] uppercase tracking-[0.25em] text-rose-600 dark:text-rose-300">
          Newsroom
        </div>
        <h1 className="mt-1 font-serif text-3xl font-black tracking-tight">
          Topic Watches
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-500">
          Tell Rose to research a topic on a schedule. Each watch fires at
          the cadence you pick, searches your enabled{' '}
          <Link to="/settings/daydream" className="underline hover:text-rose-600">
            Daydream sources
          </Link>{' '}
          (Wikipedia, news, Hacker News, …), and files a fresh briefing as
          an article you can find from Home and Search.
        </p>
      </header>

      {!creating && !editing && (
        <button
          type="button"
          className="btn-primary"
          onClick={() => setCreating(true)}
        >
          <Plus className="h-4 w-4" /> New watch
        </button>
      )}

      {creating && (
        <WatchForm
          onCancel={() => setCreating(false)}
          onSubmit={(values) => create.mutate(values)}
          submitting={create.isPending}
        />
      )}
      {editing && (
        <WatchForm
          initial={editing}
          onCancel={() => setEditing(null)}
          onSubmit={(values) => update.mutate({ id: editing._id, body: values })}
          submitting={update.isPending}
        />
      )}

      {!creating && !editing && (
        <div>
          {isLoading ? (
            <div className="card text-sm text-ink-500">Loading…</div>
          ) : watches.length === 0 ? (
            <div className="card flex flex-col items-center gap-3 py-12 text-center">
              <Sparkles className="h-10 w-10 text-rose-500" />
              <div>
                <h3 className="font-semibold">No watches yet</h3>
                <p className="mt-1 text-sm text-ink-500">
                  Click <strong>New watch</strong> to start. A good first
                  watch: a topic you already follow ("SpaceX", "Premier
                  League", a TV show you love) on a daily cadence.
                </p>
              </div>
            </div>
          ) : (
            <ul className="space-y-2">
              {watches.map((w) => (
                <li key={w._id} className="card">
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() =>
                        toggleEnabled.mutate({ id: w._id, enabled: !w.enabled })
                      }
                      className={
                        'mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded ' +
                        (w.enabled
                          ? 'bg-rose-500 text-white'
                          : 'bg-ink-200 text-ink-500 dark:bg-ink-700')
                      }
                      title={w.enabled ? 'Pause this watch' : 'Resume this watch'}
                    >
                      {w.enabled ? '✓' : '–'}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-semibold">{w.name}</span>
                        <span className="rounded-full bg-rose-100 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
                          {w.topic}
                        </span>
                      </div>
                      <div className="mt-0.5 text-xs text-ink-500">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {humanizeCron(w.cron, w.timezone)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-500">
                        <span>fired {w.fireCount}×</span>
                        {w.lastFiredAt && (
                          <span>
                            last {new Date(w.lastFiredAt).toLocaleString()}
                          </span>
                        )}
                        {w.errorCount > 0 ? (
                          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                            <AlertTriangle className="h-3 w-3" />
                            {w.errorCount} error{w.errorCount === 1 ? '' : 's'}
                          </span>
                        ) : (
                          w.fireCount > 0 && (
                            <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                              <CheckCircle2 className="h-3 w-3" /> healthy
                            </span>
                          )
                        )}
                      </div>
                      {w.lastErrorMessage && (
                        <div className="mt-1 truncate text-[11px] text-amber-700 dark:text-amber-300">
                          last error: <code>{w.lastErrorMessage}</code>
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {w.pageSlug && (
                        <Link
                          to={`/p/${w.pageSlug}`}
                          className="btn-ghost text-xs"
                          title="Open the article this watch is keeping current"
                        >
                          <ExternalLinkIcon className="h-3.5 w-3.5" /> Open
                        </Link>
                      )}
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        onClick={() => runNow.mutate(w._id)}
                        disabled={runNow.isPending}
                        title="Run this watch right now"
                      >
                        <PlayCircle className="h-3.5 w-3.5" /> Run now
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => setEditing(w)}
                        aria-label="Edit"
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="btn-ghost text-red-600"
                        onClick={() => {
                          if (confirm(`Delete "${w.name}"?`)) {
                            remove.mutate(w._id);
                          }
                        }}
                        aria-label="Delete"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Form ──────────────────────────────────────────────────────── */

type WatchFormValues = {
  name: string;
  topic: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  targetWords: number;
  customPrompt?: string;
  maxResultsPerSource: number;
  includeNewsSearch: boolean;
  deepResearchAfter?: boolean;
};

const PRESET_CADENCES: { id: string; label: string; cron: string; hint: string }[] = [
  { id: 'daily-morning', label: 'Daily at 8 AM', cron: '0 8 * * *', hint: 'Fires once a day at 8 AM in your selected timezone.' },
  { id: 'daily-noon', label: 'Daily at noon', cron: '0 12 * * *', hint: '12:00 every day.' },
  { id: 'daily-evening', label: 'Daily at 6 PM', cron: '0 18 * * *', hint: '6 PM every day — handy for end-of-day recaps.' },
  { id: 'weekday-morning', label: 'Weekdays at 8 AM', cron: '0 8 * * 1-5', hint: 'Mon–Fri at 8 AM. Skips weekends.' },
  { id: 'weekly-monday', label: 'Weekly Monday 9 AM', cron: '0 9 * * 1', hint: 'Mondays at 9 AM — week-ahead briefings.' },
  { id: 'twice-daily', label: 'Twice a day (8 AM + 6 PM)', cron: '0 8,18 * * *', hint: 'Morning + evening briefings.' },
  { id: 'hourly', label: 'Every hour', cron: '0 * * * *', hint: 'Heads up: this burns LLM tokens. Best for fast-moving stories.' },
];

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function WatchForm({
  initial,
  onCancel,
  onSubmit,
  submitting,
}: {
  initial?: TopicWatch;
  onCancel: () => void;
  onSubmit: (v: WatchFormValues) => void;
  submitting: boolean;
}) {
  const api = useApi();
  // Watch builder needs to know whether the user has Topic research
  // enabled at the master level. Without this lookup the
  // `deepResearchAfter` checkbox saves successfully but the worker
  // silently no-ops at run-time, leaving the user wondering why
  // the page never upgrades. Cached for the lifetime of the form
  // so opening the modal multiple times doesn't re-fetch.
  const { data: daydreamSettings } = useQuery({
    queryKey: ['daydream-settings'],
    queryFn: () =>
      api.get<{ webResearch?: { enabled?: boolean } }>('/api/daydream'),
    staleTime: 60_000,
  });
  const webResearchEnabled =
    daydreamSettings?.webResearch?.enabled === true;
  const [name, setName] = useState(initial?.name ?? '');
  const [topic, setTopic] = useState(initial?.topic ?? '');
  const initialPreset = initial
    ? PRESET_CADENCES.find((p) => p.cron === initial.cron)?.id ?? 'custom'
    : 'daily-morning';
  const [presetId, setPresetId] = useState<string>(initialPreset);
  const [customCron, setCustomCron] = useState(initial?.cron ?? '0 8 * * *');
  const [timezone, setTimezone] = useState(initial?.timezone ?? defaultTimezone());
  const [advanced, setAdvanced] = useState(false);
  const [targetWords, setTargetWords] = useState(initial?.targetWords ?? 400);
  const [customPrompt, setCustomPrompt] = useState(initial?.customPrompt ?? '');
  const [maxResultsPerSource, setMaxResultsPerSource] = useState(
    initial?.maxResultsPerSource ?? 5,
  );
  const [includeNewsSearch, setIncludeNewsSearch] = useState<boolean>(
    initial?.includeNewsSearch ?? true,
  );
  const [deepResearchAfter, setDeepResearchAfter] = useState<boolean>(
    initial?.deepResearchAfter ?? false,
  );

  const cron = useMemo(() => {
    if (presetId === 'custom') return customCron.trim();
    return PRESET_CADENCES.find((p) => p.id === presetId)?.cron ?? customCron;
  }, [presetId, customCron]);

  // Auto-suggest a name when the user types a topic and hasn't yet
  // edited the name. Avoids the "untitled watch" footgun.
  useEffect(() => {
    if (initial) return;
    if (name.trim() && name !== suggestName(topic)) return;
    if (topic.trim()) setName(suggestName(topic));
  }, [topic, name, initial]);

  const canSubmit = !!name.trim() && !!topic.trim() && !!cron && !!timezone;

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">
          {initial ? `Edit "${initial.name}"` : 'New watch'}
        </h3>
        <button type="button" className="btn-ghost text-xs" onClick={onCancel}>
          <XIcon className="h-3.5 w-3.5" /> Cancel
        </button>
      </div>

      <Field
        label="Topic"
        hint="What should Rose research? Specific is better — “Spider-Man (MCU)” beats just “Marvel”."
      >
        <input
          className="input"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="e.g. Spider-Man, SpaceX, Premier League"
          maxLength={200}
        />
      </Field>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 accent-rose-500"
          checked={includeNewsSearch}
          onChange={(e) => setIncludeNewsSearch(e.target.checked)}
        />
        <span>
          <span className="font-medium">Include news / web search</span>
          <span className="block text-[11px] text-ink-500">
            Pull from the federated search adapters (Marginalia, DuckDuckGo,
            and any keyed Brave / SearXNG you've set up) so the brief
            includes current news — not just encyclopedic context. Leave on
            for "what's new with X" topics; turn off for pure background
            briefs.
          </span>
        </span>
      </label>

      <label
        className={
          'flex items-start gap-2 text-sm ' +
          (!webResearchEnabled ? 'opacity-60' : '')
        }
      >
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 accent-rose-500 disabled:cursor-not-allowed"
          checked={deepResearchAfter && webResearchEnabled}
          disabled={!webResearchEnabled}
          onChange={(e) => setDeepResearchAfter(e.target.checked)}
          title={
            webResearchEnabled
              ? undefined
              : 'Enable Topic research in Settings → Daydream first'
          }
        />
        <span>
          <span className="font-medium">Deepen with web research</span>
          <span className="block text-[11px] text-ink-500">
            Re-synthesise the page with full citations after each fire.
          </span>
          {/* The cost / mechanism details are tucked into a details so
              the form stays scannable. UX-Review-2 §11. */}
          <details className="mt-1 text-[11px] text-ink-500">
            <summary className="cursor-pointer text-rose-600 hover:underline dark:text-rose-400">
              How it works
            </summary>
            <p className="mt-1">
              After each scheduled fire, Rose runs the full topic-research
              pipeline against the same page: SearXNG queries → fetch the
              top results past robots / rate-limit / paywall gates → bounded
              recursion one level into in-body links → embed + score against
              the topic centroid → re-synthesise the page from the top
              relevance-weighted documents with{' '}
              <code className="text-[10px]">[w?]</code> citations.
              Costs one extra LLM synthesis per fire on top of the watch's
              snippet brief.
            </p>
          </details>
          {!webResearchEnabled ? (
            // Save-time gate the worker would otherwise enforce silently:
            // without webResearch.enabled the deepResearch step no-ops
            // and the user never sees the upgrade. Surface it inline
            // so they don't save a watch that won't behave as expected.
            <span className="mt-1 block text-[11px]">
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                Disabled
              </span>{' '}
              <a
                href="/settings/daydream"
                className="text-rose-600 hover:underline dark:text-rose-400"
              >
                Enable Topic research in Settings → Daydream
              </a>{' '}
              to use this option.
            </span>
          ) : null}
        </span>
      </label>

      <Field label="Schedule">
        <div className="flex flex-wrap gap-1.5">
          {PRESET_CADENCES.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPresetId(p.id)}
              className={
                'rounded-full px-3 py-1 text-xs ' +
                (presetId === p.id
                  ? 'bg-rose-500 text-white'
                  : 'bg-ink-100 text-ink-600 hover:bg-ink-200 dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-ink-700')
              }
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPresetId('custom')}
            className={
              'rounded-full px-3 py-1 text-xs ' +
              (presetId === 'custom'
                ? 'bg-rose-500 text-white'
                : 'bg-ink-100 text-ink-600 hover:bg-ink-200 dark:bg-ink-800 dark:text-ink-300 dark:hover:bg-ink-700')
            }
          >
            Custom cron…
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-ink-500">
          {presetId === 'custom'
            ? 'Standard 5-field cron. e.g. "0 8 * * *" = daily at 8 AM.'
            : PRESET_CADENCES.find((p) => p.id === presetId)?.hint}
        </p>
        {presetId === 'custom' && (
          <input
            className="input mt-2 font-mono text-sm"
            value={customCron}
            onChange={(e) => setCustomCron(e.target.value)}
            placeholder="0 8 * * *"
          />
        )}
      </Field>

      <Field
        label="Timezone"
        hint="The schedule above is interpreted in this timezone."
      >
        <input
          className="input"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          placeholder="America/New_York"
          list="rose-timezones"
        />
        {/* Most-common tzs as datalist hints — not exhaustive. */}
        <datalist id="rose-timezones">
          <option value="UTC" />
          <option value="America/New_York" />
          <option value="America/Chicago" />
          <option value="America/Denver" />
          <option value="America/Los_Angeles" />
          <option value="Europe/London" />
          <option value="Europe/Paris" />
          <option value="Europe/Berlin" />
          <option value="Asia/Tokyo" />
          <option value="Asia/Shanghai" />
          <option value="Asia/Kolkata" />
          <option value="Australia/Sydney" />
        </datalist>
      </Field>

      <Field label="Watch name" hint="Shown in the watch list and the resulting article title.">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
        />
      </Field>

      <details
        open={advanced}
        onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}
        className="rounded-lg border border-ink-200 dark:border-ink-800"
      >
        <summary className="cursor-pointer select-none px-3 py-2 text-sm">
          Advanced
        </summary>
        <div className="space-y-3 px-3 pb-3">
          <Field
            label="Article length"
            hint="Loose hint passed to the LLM. The model usually lands within ±25%."
          >
            <input
              type="number"
              className="input"
              min={80}
              max={2000}
              step={50}
              value={targetWords}
              onChange={(e) => setTargetWords(Number(e.target.value))}
            />
          </Field>
          <Field
            label="Snippets per source"
            hint="How much context each Daydream source contributes. 5 is a good default."
          >
            <input
              type="number"
              className="input"
              min={1}
              max={10}
              value={maxResultsPerSource}
              onChange={(e) => setMaxResultsPerSource(Number(e.target.value))}
            />
          </Field>
          <Field
            label="Custom prompt template"
            hint='Optional override. Mustache vars: {{topic}}, {{date}}, {{snippets}}, {{targetWords}}. Leave empty for the default brief-writing prompt.'
          >
            <textarea
              className="input min-h-[120px] font-mono text-xs"
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              maxLength={4000}
              placeholder=""
            />
          </Field>
        </div>
      </details>

      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost text-xs" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!canSubmit || submitting}
          onClick={() =>
            onSubmit({
              name: name.trim(),
              topic: topic.trim(),
              cron,
              timezone: timezone.trim(),
              enabled: initial?.enabled ?? true,
              targetWords,
              maxResultsPerSource,
              includeNewsSearch,
              // The checkbox forces false when the master toggle is
              // off, but persist false explicitly to avoid stale `true`
              // from a prior save when the user has since disabled
              // webResearch globally.
              deepResearchAfter: deepResearchAfter && webResearchEnabled,
              ...(customPrompt.trim() ? { customPrompt: customPrompt.trim() } : {}),
            })
          }
        >
          {submitting ? 'Saving…' : initial ? 'Save changes' : 'Create watch'}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-ink-700 dark:text-ink-200">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-500">{hint}</span>}
    </label>
  );
}

function suggestName(topic: string): string {
  return topic.trim() ? `${topic.trim()} watch` : '';
}

/**
 * Best-effort English description of a 5-field cron string.
 * Matches the preset patterns first; falls back to the raw string
 * for power users editing custom crons.
 */
function humanizeCron(cron: string, timezone: string): string {
  const preset = PRESET_CADENCES.find((p) => p.cron === cron);
  if (preset) return `${preset.label} · ${timezone}`;
  return `${cron} · ${timezone}`;
}
