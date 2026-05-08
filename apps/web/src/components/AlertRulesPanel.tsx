import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi, humaniseError } from '../lib/api';
import { useConfirm } from './ConfirmModal';

/**
 * Alert rule editor (Phase D follow-on). Embedded in Settings →
 * Diagnostics so the operator can manage rules alongside the live
 * metrics they're watching.
 *
 * Three rule kinds, each with sensible defaults:
 *   queue-failed   — fires when any queue's failed count >=
 *                    threshold (default 1).
 *   queue-backlog  — fires when any queue's waiting count >=
 *                    threshold (default 100).
 *   collscan       — fires when system.profile contains a
 *                    COLLSCAN entry within the last sweep
 *                    window (default 1; any collscan trips it).
 *
 * The sweeper itself runs in worker-bg mode every 60s and pushes
 * via the existing pushToUser plumbing.
 */

type AlertKind = 'queue-failed' | 'queue-backlog' | 'collscan';

type AlertRule = {
  _id: string;
  kind: AlertKind;
  name: string;
  enabled: boolean;
  threshold: number;
  cooldownMin: number;
  queueName: string;
  lastFiredAt: string | null;
  lastEvaluatedAt: string | null;
  lastValue: number;
  createdAt: string;
};

const KIND_LABELS: Record<AlertKind, string> = {
  'queue-failed': 'Queue failed jobs',
  'queue-backlog': 'Queue backlog (waiting)',
  collscan: 'Mongo collection scan',
};

const KIND_DEFAULTS: Record<AlertKind, { threshold: number; cooldown: number }> = {
  'queue-failed': { threshold: 1, cooldown: 60 },
  'queue-backlog': { threshold: 100, cooldown: 60 },
  collscan: { threshold: 1, cooldown: 60 },
};

function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86_400)} d ago`;
}

export function AlertRulesPanel() {
  const api = useApi();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);

  const { data } = useQuery({
    queryKey: ['alert-rules'],
    queryFn: () => api.get<{ rules: AlertRule[] }>('/api/alerts'),
    refetchInterval: 30_000,
  });

  const create = useMutation({
    mutationFn: (
      payload: Pick<AlertRule, 'kind' | 'name' | 'threshold' | 'cooldownMin' | 'queueName'>,
    ) => api.post<{ ok: true; _id: string }>('/api/alerts', payload),
    onSuccess: () => {
      toast.success('Rule added');
      setAdding(false);
      qc.invalidateQueries({ queryKey: ['alert-rules'] });
    },
    onError: (e: Error) => toast.error(humaniseError(e)),
  });

  const patch = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<AlertRule> }) =>
      api.patch<{ ok: true }>(`/api/alerts/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules'] }),
    onError: (e: Error) => toast.error(humaniseError(e)),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/api/alerts/${id}`),
    onSuccess: () => {
      toast.success('Rule deleted');
      qc.invalidateQueries({ queryKey: ['alert-rules'] });
    },
    onError: (e: Error) => toast.error(humaniseError(e)),
  });

  const rules = data?.rules ?? [];

  return (
    <section className="card">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Bell className="h-4 w-4 text-rose-500" /> Alert rules ({rules.length})
        </h3>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="btn-ghost text-xs"
          >
            <Plus className="h-3.5 w-3.5" /> Add rule
          </button>
        )}
      </div>

      {rules.length === 0 && !adding && (
        <p className="mt-2 text-xs text-ink-500">
          Push notifications fire when these rules trip. Add one to be told
          when the worker can't keep up rather than discovering it on the
          next visit here.
        </p>
      )}

      {adding && (
        <NewRuleForm
          onCancel={() => setAdding(false)}
          onSubmit={(p) => create.mutate(p)}
          submitting={create.isPending}
        />
      )}

      {rules.length > 0 && (
        <ul className="mt-3 space-y-2">
          {rules.map((r) => {
            const triggered = r.lastValue >= r.threshold;
            return (
              <li
                key={r._id}
                className={
                  'rounded border p-2 text-xs ' +
                  (triggered
                    ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20'
                    : 'border-ink-200 dark:border-ink-800')
                }
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) =>
                      patch.mutate({ id: r._id, patch: { enabled: e.target.checked } })
                    }
                    className="mt-0.5 h-3.5 w-3.5 accent-rose-500"
                    title={r.enabled ? 'Disable rule' : 'Enable rule'}
                  />
                  <span className="font-mono font-semibold">
                    {KIND_LABELS[r.kind]}
                  </span>
                  {r.queueName && (
                    <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] dark:bg-ink-800">
                      {r.queueName.replace(/^rose\./, '')}
                    </span>
                  )}
                  <span className="text-ink-500">
                    threshold ≥ {r.threshold} · cooldown {r.cooldownMin}m
                  </span>
                  <span className="text-ink-500">
                    last value{' '}
                    <span
                      className={
                        triggered
                          ? 'font-semibold text-amber-700 dark:text-amber-300'
                          : 'font-mono'
                      }
                    >
                      {r.lastValue}
                    </span>
                  </span>
                  <span className="text-ink-500">
                    fired {relTime(r.lastFiredAt)}
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      const ok = await confirm.confirm({
                        title: 'Delete this alert rule?',
                        body: 'No further notifications will fire from this rule. You can recreate it any time.',
                        confirmLabel: 'Delete',
                        destructive: true,
                      });
                      if (ok) del.mutate(r._id);
                    }}
                    className="ml-auto btn-ghost text-[10px] text-red-700 dark:text-red-300"
                    aria-label="Delete rule"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
                {r.name && (
                  <div className="mt-1 text-[11px] italic text-ink-500">
                    {r.name}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function NewRuleForm({
  onCancel,
  onSubmit,
  submitting,
}: {
  onCancel: () => void;
  onSubmit: (p: {
    kind: AlertKind;
    name: string;
    threshold: number;
    cooldownMin: number;
    queueName: string;
  }) => void;
  submitting: boolean;
}) {
  const [kind, setKind] = useState<AlertKind>('queue-failed');
  const [name, setName] = useState('');
  const [threshold, setThreshold] = useState<number>(KIND_DEFAULTS['queue-failed'].threshold);
  const [cooldownMin, setCooldownMin] = useState<number>(60);
  const [queueName, setQueueName] = useState('');

  // When kind changes, snap threshold to that kind's default so the
  // user doesn't trigger on a stale value from a different kind.
  function changeKind(next: AlertKind) {
    setKind(next);
    setThreshold(KIND_DEFAULTS[next].threshold);
  }

  return (
    <div className="mt-3 rounded border border-ink-200 p-3 dark:border-ink-800">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs">
          <span className="mb-1 block font-medium">Kind</span>
          <select
            className="input"
            value={kind}
            onChange={(e) => changeKind(e.target.value as AlertKind)}
          >
            {(Object.keys(KIND_LABELS) as AlertKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium">Display name (optional)</span>
          <input
            type="text"
            className="input"
            value={name}
            placeholder="e.g. Ingest stalling"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium">Threshold</span>
          <input
            type="number"
            min={1}
            className="input"
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value) || 1)}
          />
          <span className="mt-0.5 block text-[10px] text-ink-500">
            {kind === 'queue-failed' && 'Fire when failed jobs ≥ this count.'}
            {kind === 'queue-backlog' && 'Fire when waiting jobs ≥ this count.'}
            {kind === 'collscan' && 'Fire when COLLSCAN entries ≥ this count in the last sweep window.'}
          </span>
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium">Cooldown (minutes)</span>
          <input
            type="number"
            min={1}
            max={1440}
            className="input"
            value={cooldownMin}
            onChange={(e) => setCooldownMin(Number(e.target.value) || 60)}
          />
          <span className="mt-0.5 block text-[10px] text-ink-500">
            Minimum time between successive fires of this rule.
          </span>
        </label>
        {(kind === 'queue-failed' || kind === 'queue-backlog') && (
          <label className="block text-xs sm:col-span-2">
            <span className="mb-1 block font-medium">
              Queue name (optional)
            </span>
            <input
              type="text"
              className="input"
              value={queueName}
              placeholder="e.g. rose.generate-page (leave blank for any)"
              onChange={(e) => setQueueName(e.target.value)}
            />
          </label>
        )}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="btn-ghost text-xs" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary text-xs"
          disabled={submitting}
          onClick={() =>
            onSubmit({
              kind,
              name: name.trim(),
              threshold: Math.max(1, threshold),
              cooldownMin: Math.max(1, cooldownMin),
              queueName: queueName.trim(),
            })
          }
        >
          {submitting ? 'Saving…' : 'Add rule'}
        </button>
      </div>
    </div>
  );
}
