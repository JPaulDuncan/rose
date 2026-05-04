import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Trash2,
  Pencil,
  Play,
  RefreshCw,
  Power,
  ChevronUp,
  ChevronDown,
  Workflow,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';

type Condition = { field: string; op: string; value: unknown };
type Action = { kind: string; params: Record<string, unknown> };

type Rule = {
  _id: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
  conditions: Condition[];
  actions: Action[];
  matchCount: number;
  lastMatchedAt: string | null;
  createdAt: string;
};

const CONDITION_FIELDS: { value: string; label: string; ops: string[]; valueLabel: string }[] = [
  { value: 'from.address', label: 'From address', ops: ['equals', 'endsWith', 'matches'], valueLabel: 'address or regex' },
  { value: 'from.domain', label: 'From domain', ops: ['equals', 'in'], valueLabel: 'medium.com or comma list' },
  { value: 'subject', label: 'Subject', ops: ['contains', 'matches'], valueLabel: 'text or regex' },
  { value: 'body', label: 'Body', ops: ['contains', 'matches'], valueLabel: 'text or regex' },
  { value: 'topic', label: 'Topic', ops: ['in'], valueLabel: 'comma list' },
  { value: 'spamScore', label: 'Spam score', ops: ['>=', '<'], valueLabel: '0..1' },
  { value: 'isPromotional', label: 'Is promotional', ops: ['is'], valueLabel: 'true/false' },
  { value: 'auth.spf', label: 'SPF', ops: ['equals'], valueLabel: 'pass/fail/…' },
  { value: 'auth.dkim', label: 'DKIM', ops: ['equals'], valueLabel: 'pass/fail/…' },
  { value: 'auth.dmarc', label: 'DMARC', ops: ['equals'], valueLabel: 'pass/fail/…' },
  { value: 'attachment.contentType', label: 'Attachment type', ops: ['matches'], valueLabel: 'mime regex' },
  { value: 'size', label: 'Size (bytes)', ops: ['>=', '<'], valueLabel: 'integer' },
];

const ACTION_KINDS: { kind: string; label: string; paramHint: string }[] = [
  { kind: 'tag.add', label: 'Add tag(s)', paramHint: 'tags: comma list' },
  { kind: 'tag.remove', label: 'Remove tag(s)', paramHint: 'tags: comma list' },
  { kind: 'priority.set', label: 'Set priority', paramHint: 'priority: high/normal/low' },
  { kind: 'flag.set', label: 'Set flag', paramHint: 'name: flag name' },
  { kind: 'route.topicPage', label: 'Route to topic page', paramHint: 'primaryTopic: tag name' },
  { kind: 'assign.category', label: 'Assign category', paramHint: 'name: category name' },
  { kind: 'archive', label: 'Archive (skip generation)', paramHint: '—' },
  { kind: 'quarantine', label: 'Quarantine the page', paramHint: '—' },
  { kind: 'halt', label: 'Stop further rules', paramHint: '—' },
];

export default function RulesSettings() {
  const api = useApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['rules'],
    queryFn: () => api.get<{ rules: Rule[] }>('/api/rules'),
  });
  const [editing, setEditing] = useState<Rule | null>(null);
  const [creating, setCreating] = useState(false);

  const remove = useMutation({
    mutationFn: async (id: string) => api.del<{ ok: true }>(`/api/rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });
  const togglePower = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<Rule>(`/api/rules/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });
  const reorder = useMutation({
    mutationFn: async (order: string[]) =>
      api.post<{ ok: true }>('/api/rules/reorder', { order }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });

  const rules = data?.rules ?? [];

  function move(idx: number, dir: -1 | 1) {
    const next = [...rules];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target]!, next[idx]!];
    reorder.mutate(next.map((r) => r._id));
  }

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="mb-2 flex items-center gap-2">
          <Workflow className="h-5 w-5 text-rose-500" />
          <h2 className="font-semibold">Automation rules</h2>
        </div>
        <p className="text-sm text-ink-500">
          When an incoming email matches all of a rule's conditions, its
          actions run in order. Rules fire after parse and before page
          generation, so they can change tags, priority, category, or
          even archive the message.
        </p>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          className="btn-primary"
          onClick={() => {
            setCreating(true);
            setEditing(null);
          }}
        >
          <Plus className="h-4 w-4" /> New rule
        </button>
      </div>

      {(creating || editing) && (
        <RuleEditor
          initial={editing ?? newRule()}
          onCancel={() => {
            setEditing(null);
            setCreating(false);
          }}
          onSaved={() => {
            setEditing(null);
            setCreating(false);
            qc.invalidateQueries({ queryKey: ['rules'] });
          }}
        />
      )}

      {isLoading ? (
        <div className="card text-sm text-ink-500">Loading…</div>
      ) : rules.length === 0 ? (
        <div className="card text-sm text-ink-500">
          No rules yet. Add one to start automating how mail flows
          through your wiki.
        </div>
      ) : (
        <ul className="space-y-2">
          {rules.map((r, i) => (
            <li
              key={r._id}
              className="flex items-start gap-2 rounded-xl border border-ink-200 p-3 dark:border-ink-800"
            >
              <div className="flex flex-col gap-0.5 pt-1">
                <button
                  type="button"
                  className="text-ink-400 hover:text-ink-700 dark:hover:text-ink-200"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label="Move up"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="text-ink-400 hover:text-ink-700 dark:hover:text-ink-200"
                  onClick={() => move(i, 1)}
                  disabled={i === rules.length - 1}
                  aria-label="Move down"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  <span className="text-[10px] uppercase tracking-widest text-ink-400">
                    pri {r.priority}
                  </span>
                  {!r.enabled && (
                    <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-ink-500 dark:bg-ink-800 dark:text-ink-300">
                      paused
                    </span>
                  )}
                </div>
                <div className="mt-0.5 truncate text-xs text-ink-500">
                  {summariseRule(r)}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] uppercase tracking-widest text-ink-400">
                  <span>{r.matchCount} matches</span>
                  {r.lastMatchedAt && (
                    <span>last {new Date(r.lastMatchedAt).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => togglePower.mutate({ id: r._id, enabled: !r.enabled })}
                  title={r.enabled ? 'Pause' : 'Enable'}
                >
                  <Power
                    className={
                      'h-3.5 w-3.5 ' +
                      (r.enabled ? 'text-emerald-600' : 'text-ink-400')
                    }
                  />
                </button>
                <ReplayButton ruleId={r._id} />
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => {
                    setEditing(r);
                    setCreating(false);
                  }}
                  title="Edit"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="btn-ghost text-red-600"
                  onClick={() => {
                    if (confirm(`Delete "${r.name}"?`)) remove.mutate(r._id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function newRule(): Rule {
  return {
    _id: '',
    name: '',
    description: '',
    enabled: true,
    priority: 100,
    conditions: [],
    actions: [],
    matchCount: 0,
    lastMatchedAt: null,
    createdAt: '',
  };
}

function summariseRule(r: Rule): string {
  const cs = r.conditions
    .map((c) => `${shortField(c.field)} ${c.op} ${displayValue(c.value)}`)
    .join(' AND ');
  const as = r.actions.map((a) => a.kind).join(' · ');
  return cs ? `${cs} → ${as}` : `(no conditions) → ${as}`;
}

function shortField(f: string): string {
  return f.replace('from.', '').replace('auth.', '').replace('attachment.', 'attach ');
}

function displayValue(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function ReplayButton({ ruleId }: { ruleId: string }) {
  const api = useApi();
  const replay = useMutation({
    mutationFn: async () =>
      api.post<{ matched: number; requeued: number }>(
        `/api/rules/${ruleId}/replay`,
        { sinceDays: 30 },
      ),
    onSuccess: (r) =>
      toast.success(
        `Replayed — ${r.matched} matches, ${r.requeued} regenerations queued`,
      ),
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <button
      type="button"
      className="btn-ghost"
      onClick={() => {
        if (
          confirm(
            'Replay against the past 30 days? Each match re-queues page generation.',
          )
        )
          replay.mutate();
      }}
      title="Replay against existing mail"
    >
      <RefreshCw
        className={'h-3.5 w-3.5 ' + (replay.isPending ? 'animate-spin' : '')}
      />
    </button>
  );
}

function RuleEditor({
  initial,
  onCancel,
  onSaved,
}: {
  initial: Rule;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const api = useApi();
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const [enabled, setEnabled] = useState(initial.enabled);
  const [conditions, setConditions] = useState<Condition[]>(initial.conditions);
  const [actions, setActions] = useState<Action[]>(initial.actions);
  const [testResult, setTestResult] = useState<{ total: number; sample: { _id: string; subject: string; from: string | null }[] } | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        enabled,
        priority: initial.priority || 100,
        conditions,
        actions,
      };
      if (initial._id) {
        return api.patch<Rule>(`/api/rules/${initial._id}`, payload);
      }
      return api.post<Rule>('/api/rules', payload);
    },
    onSuccess: () => {
      toast.success('Rule saved');
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const test = useMutation({
    mutationFn: async () =>
      api.post<{ total: number; sample: { _id: string; subject: string; from: string | null }[] }>(
        `/api/rules/${initial._id || 'preview'}/test`,
        { conditions, sinceDays: 30, limit: 25 },
      ),
    onSuccess: (r) => setTestResult(r),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <form
      className="card space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) {
          toast.error('Name required');
          return;
        }
        if (actions.length === 0) {
          toast.error('At least one action required');
          return;
        }
        save.mutate();
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">
          {initial._id ? `Edit "${initial.name}"` : 'New rule'}
        </h3>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs">
          <span className="mb-1 block font-medium">Name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Enabled</span>
        </label>
      </div>
      <label className="block text-xs">
        <span className="mb-1 block font-medium">Description</span>
        <input
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>

      <fieldset className="space-y-2 rounded-lg border border-ink-200 p-3 dark:border-ink-800">
        <legend className="px-1 text-[10px] uppercase tracking-widest text-ink-500">
          When ALL of these match
        </legend>
        {conditions.map((c, i) => (
          <ConditionRow
            key={i}
            cond={c}
            onChange={(next) =>
              setConditions((arr) => arr.map((x, j) => (j === i ? next : x)))
            }
            onRemove={() => setConditions((arr) => arr.filter((_, j) => j !== i))}
          />
        ))}
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() =>
            setConditions((arr) => [
              ...arr,
              { field: 'from.domain', op: 'equals', value: '' },
            ])
          }
        >
          <Plus className="h-3.5 w-3.5" /> Add condition
        </button>
      </fieldset>

      <fieldset className="space-y-2 rounded-lg border border-ink-200 p-3 dark:border-ink-800">
        <legend className="px-1 text-[10px] uppercase tracking-widest text-ink-500">
          Then run these actions
        </legend>
        {actions.map((a, i) => (
          <ActionRow
            key={i}
            action={a}
            onChange={(next) => setActions((arr) => arr.map((x, j) => (j === i ? next : x)))}
            onRemove={() => setActions((arr) => arr.filter((_, j) => j !== i))}
          />
        ))}
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() =>
            setActions((arr) => [...arr, { kind: 'tag.add', params: { tag: '' } }])
          }
        >
          <Plus className="h-3.5 w-3.5" /> Add action
        </button>
      </fieldset>

      {testResult && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs dark:border-emerald-800 dark:bg-emerald-950/30">
          <div className="font-semibold">
            {testResult.total} match{testResult.total === 1 ? '' : 'es'} in the last 30 days
          </div>
          {testResult.sample.length > 0 && (
            <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-5 text-[11px]">
              {testResult.sample.slice(0, 12).map((s) => (
                <li key={s._id} className="truncate">
                  {s.subject || '(no subject)'}{' '}
                  <span className="text-ink-500">— {s.from ?? 'unknown'}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={() => test.mutate()}
          disabled={test.isPending || conditions.length === 0}
        >
          <Play className="h-3.5 w-3.5" />
          Test against last 30 days
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : initial._id ? 'Save changes' : 'Create rule'}
        </button>
      </div>
    </form>
  );
}

function ConditionRow({
  cond,
  onChange,
  onRemove,
}: {
  cond: Condition;
  onChange: (c: Condition) => void;
  onRemove: () => void;
}) {
  const def = CONDITION_FIELDS.find((f) => f.value === cond.field) ?? CONDITION_FIELDS[0]!;
  return (
    <div className="grid gap-1.5 sm:grid-cols-[160px_120px_1fr_auto]">
      <select
        className="input"
        value={cond.field}
        onChange={(e) => onChange({ ...cond, field: e.target.value, op: CONDITION_FIELDS.find((f) => f.value === e.target.value)?.ops[0] ?? 'equals' })}
      >
        {CONDITION_FIELDS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        className="input"
        value={cond.op}
        onChange={(e) => onChange({ ...cond, op: e.target.value })}
      >
        {def.ops.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <input
        className="input"
        placeholder={def.valueLabel}
        value={typeof cond.value === 'string' ? cond.value : displayValue(cond.value)}
        onChange={(e) => onChange({ ...cond, value: parseValue(cond.field, cond.op, e.target.value) })}
      />
      <button
        type="button"
        className="btn-ghost text-red-600"
        onClick={onRemove}
        aria-label="Remove condition"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function parseValue(field: string, op: string, raw: string): unknown {
  if (op === 'in' || (field === 'from.domain' && op === 'in')) {
    return raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (field === 'spamScore' || field === 'size') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (field === 'isPromotional') {
    return raw === 'true';
  }
  return raw;
}

function ActionRow({
  action,
  onChange,
  onRemove,
}: {
  action: Action;
  onChange: (a: Action) => void;
  onRemove: () => void;
}) {
  const def = ACTION_KINDS.find((k) => k.kind === action.kind) ?? ACTION_KINDS[0]!;
  return (
    <div className="grid gap-1.5 sm:grid-cols-[200px_1fr_auto]">
      <select
        className="input"
        value={action.kind}
        onChange={(e) => onChange({ ...action, kind: e.target.value, params: {} })}
      >
        {ACTION_KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </select>
      <input
        className="input"
        placeholder={def.paramHint}
        value={paramsToString(action)}
        onChange={(e) => onChange({ ...action, params: stringToParams(action.kind, e.target.value) })}
      />
      <button
        type="button"
        className="btn-ghost text-red-600"
        onClick={onRemove}
        aria-label="Remove action"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function paramsToString(a: Action): string {
  if (a.kind === 'tag.add' || a.kind === 'tag.remove') {
    const list = Array.isArray(a.params.tags)
      ? a.params.tags
      : a.params.tag
        ? [a.params.tag]
        : [];
    return (list as string[]).join(', ');
  }
  if (a.kind === 'priority.set') return String(a.params.priority ?? '');
  if (a.kind === 'flag.set') return String(a.params.name ?? '');
  if (a.kind === 'route.topicPage') return String(a.params.primaryTopic ?? '');
  if (a.kind === 'assign.category') return String(a.params.name ?? '');
  return '';
}

function stringToParams(kind: string, raw: string): Record<string, unknown> {
  if (kind === 'tag.add' || kind === 'tag.remove') {
    return {
      tags: raw
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }
  if (kind === 'priority.set') return { priority: raw.trim() };
  if (kind === 'flag.set') return { name: raw.trim(), value: true };
  if (kind === 'route.topicPage') return { primaryTopic: raw.trim().toLowerCase() };
  if (kind === 'assign.category') return { name: raw.trim() };
  return {};
}
