import { useState } from 'react';
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
  fireCount: number;
  errorCount: number;
  lastFiredAt: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
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

      {!creating && !editing && (
        <button
          type="button"
          className="btn-primary"
          onClick={() => setCreating(true)}
        >
          <Plus className="h-4 w-4" /> New recipe
        </button>
      )}

      {creating && (
        <RecipeWizard
          onCancel={() => setCreating(false)}
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
                <li
                  key={r._id}
                  className="flex items-start gap-3 rounded-lg border border-ink-200 px-3 py-2 dark:border-ink-800"
                >
                  <button
                    type="button"
                    onClick={() => toggleEnabled.mutate({ id: r._id, enabled: !r.enabled })}
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
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium">{r.name}</span>
                      {r.importedFrom && (
                        <span className="rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                          imported · {r.importedFrom}
                        </span>
                      )}
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

