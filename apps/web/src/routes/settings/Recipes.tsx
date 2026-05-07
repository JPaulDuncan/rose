import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Trash2,
  Edit3,
  AlertCircle,
  Zap,
  CheckCircle2,
  Pause,
  Play,
  Sparkles,
  Bell,
  ShoppingBag,
  Truck,
  Archive,
  Ban,
  Webhook,
  Activity,
  ChevronDown,
  ChevronRight,
  PlayCircle,
  XCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';
import { RecipeWizard, type RecipeFormValues } from '../../components/RecipeWizard';

type Recipe = {
  _id: string;
  name: string;
  description: string;
  enabled: boolean;
  trigger: { kind: string; config: Record<string, unknown> };
  conditions: { kind: string; config: Record<string, unknown> }[];
  actions: { kind: string; config: Record<string, unknown> }[];
  cooldownSeconds: number;
  fireLimitPerHour: number;
  importedFrom: string | null;
  importedFromId?: string | null;
  fireCount: number;
  errorCount: number;
  lastFiredAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  /** Set on synthetic rows generated from spam-policy entries —
   *  read-only on the client, no edit/delete affordance. */
  virtual?: boolean;
};

/**
 * Settings → Recipes. List all of the user's recipes with quick
 * enable/disable, plus a 4-step wizard (trigger → conditions →
 * actions → name) for creating + editing.
 */
export default function RecipesSettings() {
  const api = useApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['recipes'],
    queryFn: () => api.get<{ recipes: Recipe[] }>('/api/recipes'),
  });
  const [editing, setEditing] = useState<Recipe | null>(null);
  const [creating, setCreating] = useState(false);
  const [browsingTemplates, setBrowsingTemplates] = useState(false);
  const [templateInitial, setTemplateInitial] = useState<RecipeFormValues | null>(
    null,
  );
  const [openAuditId, setOpenAuditId] = useState<string | null>(null);

  const toggleEnabled = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<Recipe>(`/api/recipes/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recipes'] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => api.del<{ ok: true }>(`/api/recipes/${id}`),
    onSuccess: () => {
      toast.success('Recipe deleted');
      qc.invalidateQueries({ queryKey: ['recipes'] });
    },
  });
  const create = useMutation({
    mutationFn: async (body: RecipeFormValues) =>
      api.post<Recipe>('/api/recipes', body),
    onSuccess: () => {
      toast.success('Recipe created');
      setCreating(false);
      qc.invalidateQueries({ queryKey: ['recipes'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const update = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: RecipeFormValues }) =>
      api.patch<Recipe>(`/api/recipes/${id}`, body),
    onSuccess: () => {
      toast.success('Recipe updated');
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['recipes'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const recipes = data?.recipes ?? [];

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="mb-2 flex items-center gap-2">
          <Zap className="h-5 w-5 text-rose-500" />
          <h2 className="font-semibold">Recipes</h2>
        </div>
        <p className="text-sm text-ink-500">
          IFTTT-style automations: pick a trigger, optionally narrow with
          conditions, then pick the actions Rose should take. Phase 1
          covers email-arrives / page-created / tag-applied / scheduled
          triggers and the four most common actions (push, tag, category,
          webhook).
        </p>
      </div>

      {!creating && !editing && !browsingTemplates && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setTemplateInitial(null);
              setCreating(true);
            }}
          >
            <Plus className="h-4 w-4" /> New recipe
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setBrowsingTemplates(true)}
          >
            <Sparkles className="h-4 w-4" /> Start from a template
          </button>
        </div>
      )}

      {browsingTemplates && (
        <TemplatesGallery
          onCancel={() => setBrowsingTemplates(false)}
          onPick={(values) => {
            setTemplateInitial(values);
            setBrowsingTemplates(false);
            setCreating(true);
          }}
        />
      )}

      {creating && (
        <RecipeWizard
          initial={templateInitial ?? undefined}
          onCancel={() => {
            setCreating(false);
            setTemplateInitial(null);
          }}
          onSubmit={(values) => create.mutate(values)}
          submitting={create.isPending}
        />
      )}
      {editing && (
        <RecipeWizard
          initial={editing}
          onCancel={() => setEditing(null)}
          onSubmit={(values) => update.mutate({ id: editing._id, body: values })}
          submitting={update.isPending}
        />
      )}

      {!creating && !editing && (
        <div className="card">
          {isLoading ? (
            <div className="text-sm text-ink-500">Loading…</div>
          ) : recipes.length === 0 ? (
            <div className="py-6 text-center text-sm text-ink-500">
              No recipes yet. Click <strong>New recipe</strong> to add one.
            </div>
          ) : (
            <ul className="space-y-2 text-sm">
              {recipes.map((r) => (
                <Fragment key={r._id}>
                <li
                  className={
                    'flex items-start gap-3 rounded-lg border px-3 py-2 ' +
                    (r.virtual
                      ? 'border-dashed border-ink-300 bg-ink-50/50 dark:border-ink-700 dark:bg-ink-900/40'
                      : 'border-ink-200 dark:border-ink-800')
                  }
                >
                  {r.virtual ? (
                    <span
                      className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-amber-500/80 text-white"
                      title="Read-only — owned by Settings → Spam"
                    >
                      <AlertCircle className="h-3 w-3" />
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        toggleEnabled.mutate({ id: r._id, enabled: !r.enabled })
                      }
                      className={
                        'mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded ' +
                        (r.enabled
                          ? 'bg-rose-500 text-white'
                          : 'bg-ink-200 text-ink-500 dark:bg-ink-700')
                      }
                      title={r.enabled ? 'Disable' : 'Enable'}
                    >
                      {r.enabled ? (
                        <Play className="h-3 w-3" />
                      ) : (
                        <Pause className="h-3 w-3" />
                      )}
                    </button>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium">{r.name}</span>
                      {r.virtual ? (
                        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                          spam policy
                        </span>
                      ) : r.importedFrom ? (
                        <span className="rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                          imported · {r.importedFrom}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-500">
                      <code>{r.trigger.kind}</code>
                      {r.conditions.length > 0 && (
                        <span> · {r.conditions.length} condition{r.conditions.length === 1 ? '' : 's'}</span>
                      )}
                      <span>
                        {' '}· {r.actions.length} action{r.actions.length === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-500">
                      <span>fired {r.fireCount}×</span>
                      {r.lastFiredAt && (
                        <span>last {new Date(r.lastFiredAt).toLocaleString()}</span>
                      )}
                      {r.errorCount > 0 && (
                        <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
                          <AlertCircle className="h-3 w-3" />
                          {r.errorCount} error{r.errorCount === 1 ? '' : 's'}
                        </span>
                      )}
                      {r.errorCount === 0 && r.fireCount > 0 && (
                        <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                          <CheckCircle2 className="h-3 w-3" /> healthy
                        </span>
                      )}
                    </div>
                    {r.lastErrorMessage && (
                      <div className="mt-1 truncate text-[11px] text-amber-700 dark:text-amber-300">
                        last error: <code>{r.lastErrorMessage}</code>
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {r.virtual ? (
                      <a
                        href="/settings/spam"
                        className="btn-ghost text-xs"
                        title="Edit in Settings → Spam"
                      >
                        Manage
                      </a>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() =>
                            setOpenAuditId((cur) => (cur === r._id ? null : r._id))
                          }
                          aria-label="Audit"
                          title="Audit & dry-run"
                        >
                          <Activity className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => setEditing(r)}
                          aria-label="Edit"
                          title="Edit"
                        >
                          <Edit3 className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          className="btn-ghost text-red-600"
                          onClick={() => {
                            if (confirm(`Delete recipe "${r.name}"?`)) {
                              remove.mutate(r._id);
                            }
                          }}
                          aria-label="Delete"
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </div>
                </li>
                {openAuditId === r._id && !r.virtual && (
                  <li className="rounded-lg border border-rose-200 bg-rose-50/40 p-3 dark:border-rose-900/60 dark:bg-rose-950/20">
                    <RecipeAuditPanel recipe={r} />
                  </li>
                )}
                </Fragment>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Templates gallery ────────────────────────────────────────── */

const TEMPLATE_ICONS: Record<string, typeof Plus> = {
  Bell,
  ShoppingBag,
  Truck,
  Archive,
  Ban,
  Sparkles,
  Webhook,
};

type Template = {
  id: string;
  title: string;
  description: string;
  category: string;
  icon: string;
  recipe: RecipeFormValues;
};

function TemplatesGallery({
  onCancel,
  onPick,
}: {
  onCancel: () => void;
  onPick: (values: RecipeFormValues) => void;
}) {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['recipe-templates'],
    queryFn: () => api.get<{ templates: Template[] }>('/api/recipes/templates'),
    staleTime: 5 * 60 * 1000,
  });
  return (
    <div className="card space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Pick a starting point</h3>
        <button type="button" className="btn-ghost text-xs" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="text-xs text-ink-500">
        Each template pre-fills the wizard. You can tweak everything before
        saving — placeholders like <code>boss@example.com</code> or sample
        webhook URLs are meant to be replaced.
      </p>
      {isLoading ? (
        <div className="text-sm text-ink-500">Loading…</div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {(data?.templates ?? []).map((t) => {
            const Icon = TEMPLATE_ICONS[t.icon] ?? Sparkles;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onPick(t.recipe)}
                className="rounded-lg border border-ink-200 p-3 text-left text-sm transition-colors hover:border-rose-300 hover:bg-rose-50/40 dark:border-ink-800 dark:hover:border-rose-800 dark:hover:bg-rose-950/20"
              >
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-rose-500" />
                  <span className="font-medium">{t.title}</span>
                  <span className="ml-auto rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                    {t.category}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-500">{t.description}</p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Audit + dry-run panel ────────────────────────────────────── */

type AuditRow = {
  _id: string;
  fired: boolean;
  reason: string | null;
  subjectKey: string | null;
  firedAt: string;
  results: { actionKind: string; ok: boolean; error?: string | null; durationMs: number }[];
  evidence: Record<string, unknown>;
};

type DryRunCandidate = {
  label: string;
  subjectKey: string;
  subjectUrl: string | null;
  verdict:
    | { match: true }
    | { match: false; reason: string; conditionKind?: string };
};

function RecipeAuditPanel({ recipe }: { recipe: Recipe }) {
  const api = useApi();
  const audit = useQuery({
    queryKey: ['recipe-audit', recipe._id],
    queryFn: () =>
      api.get<{ audit: AuditRow[] }>(`/api/recipes/${recipe._id}/audit?limit=25`),
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<{
    total: number;
    matched: number;
    candidates: DryRunCandidate[];
  } | null>(null);
  const runDryRun = useMutation({
    mutationFn: async () =>
      api.post<{
        total: number;
        matched: number;
        candidates: DryRunCandidate[];
      }>(`/api/recipes/${recipe._id}/dry-run`, { limit: 100 }),
    onSuccess: (r) => {
      setDryRun(r);
      toast.success(`${r.matched} of ${r.total} would fire`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold">
          <Activity className="h-3.5 w-3.5 text-rose-500" />
          Audit & dry-run
        </div>
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={() => runDryRun.mutate()}
          disabled={runDryRun.isPending}
        >
          <PlayCircle
            className={'h-3.5 w-3.5' + (runDryRun.isPending ? ' animate-pulse' : '')}
          />{' '}
          Replay last 100
        </button>
      </div>

      {dryRun && (
        <div className="rounded-lg border border-ink-200 p-2 dark:border-ink-800">
          <div className="mb-1 font-medium">
            Would fire on {dryRun.matched} of {dryRun.total} recent items.
          </div>
          <ul className="max-h-60 space-y-1 overflow-y-auto">
            {dryRun.candidates.slice(0, 50).map((c) => (
              <li key={c.subjectKey} className="flex items-start gap-2">
                {c.verdict.match ? (
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                ) : (
                  <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-ink-400" />
                )}
                <div className="min-w-0 flex-1">
                  {c.subjectUrl ? (
                    <a
                      href={c.subjectUrl}
                      className="block truncate hover:underline"
                    >
                      {c.label}
                    </a>
                  ) : (
                    <span className="block truncate">{c.label}</span>
                  )}
                  {!c.verdict.match && (
                    <div className="text-[10px] text-ink-500">
                      {c.verdict.reason}
                      {c.verdict.conditionKind
                        ? `: ${c.verdict.conditionKind}`
                        : ''}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <div className="mb-1 font-medium">Recent evaluations</div>
        {audit.isLoading ? (
          <div className="text-ink-500">Loading…</div>
        ) : (audit.data?.audit ?? []).length === 0 ? (
          <div className="text-ink-500">
            No evaluations yet. Once an event matches the trigger, every fire (and skipped fire) is recorded here for 30 days.
          </div>
        ) : (
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {(audit.data?.audit ?? []).map((row) => {
              const isOpen = expanded === row._id;
              return (
                <li
                  key={row._id}
                  className="rounded-lg border border-ink-200 dark:border-ink-800"
                >
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : row._id)}
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
                  >
                    {isOpen ? (
                      <ChevronDown className="h-3 w-3 text-ink-400" />
                    ) : (
                      <ChevronRight className="h-3 w-3 text-ink-400" />
                    )}
                    {row.fired ? (
                      <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                    ) : (
                      <XCircle className="h-3 w-3 text-ink-400" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {row.subjectKey ?? '(no subject)'}
                    </span>
                    <span className="text-[10px] text-ink-500">
                      {new Date(row.firedAt).toLocaleString()}
                    </span>
                    {!row.fired && row.reason && (
                      <span className="rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                        {row.reason}
                      </span>
                    )}
                  </button>
                  {isOpen && (
                    <div className="space-y-2 border-t border-ink-200 px-2 py-2 dark:border-ink-800">
                      {row.results.length > 0 && (
                        <div>
                          <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-500">
                            Action results
                          </div>
                          <ul className="space-y-0.5">
                            {row.results.map((r, i) => (
                              <li
                                key={i}
                                className="flex items-center gap-2 font-mono text-[11px]"
                              >
                                {r.ok ? (
                                  <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                                ) : (
                                  <XCircle className="h-3 w-3 text-red-600" />
                                )}
                                <span>{r.actionKind}</span>
                                <span className="text-ink-400">{r.durationMs}ms</span>
                                {r.error && (
                                  <span className="truncate text-red-600">
                                    {r.error}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <div>
                        <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-500">
                          Evidence
                        </div>
                        <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-ink-50 p-2 text-[10px] dark:bg-ink-900/50">
                          {JSON.stringify(row.evidence, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

