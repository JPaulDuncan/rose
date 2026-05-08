import { useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';

/**
 * Recipe wizard. Four steps: trigger → conditions → actions → name.
 * Generates the JSON shape the API expects. Constrained to the
 * Phase-1 surface (small set of triggers / conditions / actions).
 */

export type RecipeFormValues = {
  name: string;
  description: string;
  enabled: boolean;
  trigger: { kind: string; config: Record<string, unknown> };
  conditions: { kind: string; config: Record<string, unknown> }[];
  actions: { kind: string; config: Record<string, unknown> }[];
  cooldownSeconds: number;
  fireLimitPerHour: number;
};

const TRIGGERS: {
  kind: string;
  label: string;
  description: string;
  defaultConfig: Record<string, unknown>;
}[] = [
  {
    kind: 'email.ingested',
    label: 'When an email arrives',
    description:
      'Fires every time Rose ingests a new email. Optionally narrowed by sender / subject.',
    defaultConfig: {},
  },
  {
    kind: 'page.created',
    label: 'When an article is created',
    description: 'Fires the first time generation produces an article.',
    defaultConfig: {},
  },
  {
    kind: 'tag.applied',
    label: 'When a specific tag is applied',
    description: 'Fires when a page picks up the tag you specify.',
    defaultConfig: { tag: '' },
  },
  {
    kind: 'time.scheduled',
    label: 'On a schedule',
    description:
      'Fires on a cron schedule. Useful for daily / weekly recipes that run regardless of mail.',
    defaultConfig: { cron: '0 8 * * *', timezone: 'UTC' },
  },
];

const CONDITIONS: {
  kind: string;
  label: string;
  defaultConfig: Record<string, unknown>;
}[] = [
  { kind: 'tag.contains', label: 'Page is tagged …', defaultConfig: { tag: '' } },
  { kind: 'sender.brand', label: 'Sender brand is …', defaultConfig: { brandKey: '' } },
  {
    kind: 'priority.is',
    label: 'Priority is …',
    defaultConfig: { priority: 'high' },
  },
  {
    kind: 'subject.matches',
    label: 'Subject matches regex …',
    defaultConfig: { pattern: '' },
  },
];

const ACTIONS: {
  kind: string;
  label: string;
  defaultConfig: Record<string, unknown>;
  /** Email-shaped actions only run when the trigger is email.ingested.
   *  We still let the user configure them so they can compose from
   *  multiple recipes, but the wizard highlights the constraint. */
  requires?: 'email' | 'page';
}[] = [
  {
    kind: 'notify.push',
    label: 'Send a push notification',
    defaultConfig: {},
  },
  {
    kind: 'llm.run',
    label: 'Run an LLM prompt',
    defaultConfig: { prompt: '', output: 'push' },
  },
  {
    kind: 'email.archive',
    label: 'Archive the email',
    defaultConfig: {},
    requires: 'email',
  },
  {
    kind: 'email.delete',
    label: 'Delete the email (Rose only)',
    defaultConfig: {},
    requires: 'email',
  },
  {
    kind: 'email.deleteOnSource',
    label: 'Delete the email at source (IMAP/Gmail)',
    defaultConfig: { deleteLocal: true },
    requires: 'email',
  },
  {
    kind: 'email.markSpam',
    label: 'Mute the sender',
    defaultConfig: {},
    requires: 'email',
  },
  {
    kind: 'email.block',
    label: 'Block the sender',
    defaultConfig: { removeExisting: true },
    requires: 'email',
  },
  {
    kind: 'tag.add',
    label: 'Add a tag to the article',
    defaultConfig: { tag: '' },
    requires: 'page',
  },
  {
    kind: 'category.set',
    label: 'Set the article category',
    defaultConfig: { name: '' },
    requires: 'page',
  },
  {
    kind: 'webhook.post',
    label: 'POST to a webhook URL',
    defaultConfig: { url: '' },
  },
];

export function RecipeWizard({
  initial,
  onCancel,
  onSubmit,
  submitting,
}: {
  initial?: Partial<RecipeFormValues> & {
    _id?: string;
    name?: string;
    description?: string;
    enabled?: boolean;
    trigger?: { kind: string; config: Record<string, unknown> };
    conditions?: { kind: string; config: Record<string, unknown> }[];
    actions?: { kind: string; config: Record<string, unknown> }[];
    cooldownSeconds?: number;
    fireLimitPerHour?: number;
  };
  onCancel: () => void;
  onSubmit: (values: RecipeFormValues) => void;
  submitting: boolean;
}) {
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<RecipeFormValues>({
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    enabled: initial?.enabled ?? true,
    trigger: initial?.trigger ?? {
      kind: 'email.ingested',
      config: {},
    },
    conditions: initial?.conditions ?? [],
    actions: initial?.actions ?? [],
    cooldownSeconds: initial?.cooldownSeconds ?? 0,
    fireLimitPerHour: initial?.fireLimitPerHour ?? 60,
  });

  const isEdit = !!initial?._id;

  function pickTrigger(kind: string) {
    const t = TRIGGERS.find((x) => x.kind === kind)!;
    setValues((v) => ({
      ...v,
      trigger: { kind: t.kind, config: { ...t.defaultConfig } },
    }));
  }

  function setTriggerCfg(key: string, val: unknown) {
    setValues((v) => ({
      ...v,
      trigger: { ...v.trigger, config: { ...v.trigger.config, [key]: val } },
    }));
  }

  function addCondition() {
    const c = CONDITIONS[0]!;
    setValues((v) => ({
      ...v,
      conditions: [...v.conditions, { kind: c.kind, config: { ...c.defaultConfig } }],
    }));
  }
  function removeCondition(i: number) {
    setValues((v) => ({
      ...v,
      conditions: v.conditions.filter((_, j) => j !== i),
    }));
  }
  function setConditionKind(i: number, kind: string) {
    const c = CONDITIONS.find((x) => x.kind === kind)!;
    setValues((v) => ({
      ...v,
      conditions: v.conditions.map((x, j) =>
        j === i ? { kind: c.kind, config: { ...c.defaultConfig } } : x,
      ),
    }));
  }
  function setConditionCfg(i: number, key: string, val: unknown) {
    setValues((v) => ({
      ...v,
      conditions: v.conditions.map((x, j) =>
        j === i ? { ...x, config: { ...x.config, [key]: val } } : x,
      ),
    }));
  }

  function addAction() {
    const a = ACTIONS[0]!;
    setValues((v) => ({
      ...v,
      actions: [...v.actions, { kind: a.kind, config: { ...a.defaultConfig } }],
    }));
  }
  function removeAction(i: number) {
    setValues((v) => ({
      ...v,
      actions: v.actions.filter((_, j) => j !== i),
    }));
  }
  function setActionKind(i: number, kind: string) {
    const a = ACTIONS.find((x) => x.kind === kind)!;
    setValues((v) => ({
      ...v,
      actions: v.actions.map((x, j) =>
        j === i ? { kind: a.kind, config: { ...a.defaultConfig } } : x,
      ),
    }));
  }
  function setActionCfg(i: number, key: string, val: unknown) {
    setValues((v) => ({
      ...v,
      actions: v.actions.map((x, j) =>
        j === i ? { ...x, config: { ...x.config, [key]: val } } : x,
      ),
    }));
  }

  const canAdvance = (() => {
    if (step === 0) {
      if (values.trigger.kind === 'tag.applied') {
        return !!(values.trigger.config.tag as string)?.trim();
      }
      if (values.trigger.kind === 'time.scheduled') {
        return !!(values.trigger.config.cron as string)?.trim();
      }
      return true;
    }
    if (step === 2) return values.actions.length > 0;
    return true;
  })();

  function handleSubmit() {
    if (!values.name.trim()) {
      return;
    }
    if (values.actions.length === 0) {
      setStep(2);
      return;
    }
    onSubmit(values);
  }

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">
          {isEdit ? `Edit "${initial?.name}"` : 'New recipe'}
        </h3>
        <Stepper step={step} />
      </div>

      {step === 0 && (
        <TriggerStep
          values={values}
          pickTrigger={pickTrigger}
          setCfg={setTriggerCfg}
        />
      )}
      {step === 1 && (
        <ConditionsStep
          values={values}
          addCondition={addCondition}
          removeCondition={removeCondition}
          setKind={setConditionKind}
          setCfg={setConditionCfg}
        />
      )}
      {step === 2 && (
        <ActionsStep
          values={values}
          addAction={addAction}
          removeAction={removeAction}
          setKind={setActionKind}
          setCfg={setActionCfg}
        />
      )}
      {step === 3 && (
        <NameStep
          values={values}
          setValues={setValues}
        />
      )}

      <div className="flex items-center justify-between border-t border-ink-200 pt-3 dark:border-ink-800">
        <button type="button" className="btn-ghost text-xs" onClick={onCancel}>
          Cancel
        </button>
        <div className="flex gap-2">
          {step > 0 && (
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => setStep((s) => s - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </button>
          )}
          {step < 3 && (
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={() => setStep((s) => s + 1)}
              disabled={!canAdvance}
            >
              Next <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
          {step === 3 && (
            <button
              type="button"
              className="btn-primary text-xs"
              onClick={handleSubmit}
              disabled={
                submitting || !values.name.trim() || values.actions.length === 0
              }
            >
              {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Create recipe'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  const labels = ['Trigger', 'Conditions', 'Actions', 'Name'];
  return (
    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-ink-500">
      {labels.map((l, i) => (
        <span
          key={l}
          className={
            'rounded px-1.5 py-0.5 ' +
            (i === step
              ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
              : i < step
                ? 'text-ink-400'
                : 'text-ink-400')
          }
        >
          {i + 1}. {l}
        </span>
      ))}
    </div>
  );
}

function TriggerStep({
  values,
  pickTrigger,
  setCfg,
}: {
  values: RecipeFormValues;
  pickTrigger: (kind: string) => void;
  setCfg: (key: string, val: unknown) => void;
}) {
  const t = values.trigger;
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {TRIGGERS.map((opt) => (
          <button
            key={opt.kind}
            type="button"
            onClick={() => pickTrigger(opt.kind)}
            className={
              'rounded-lg border p-3 text-left text-sm transition-colors ' +
              (t.kind === opt.kind
                ? 'border-rose-300 bg-rose-50 dark:border-rose-700 dark:bg-rose-950/30'
                : 'border-ink-200 hover:border-rose-300 dark:border-ink-800 dark:hover:border-rose-800')
            }
          >
            <div className="font-medium">{opt.label}</div>
            <div className="mt-0.5 text-xs text-ink-500">{opt.description}</div>
          </button>
        ))}
      </div>

      {/* Per-trigger config inputs. */}
      {t.kind === 'email.ingested' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Sender contains (optional)" hint="Substring match against the email's From: address.">
            <input
              className="input"
              placeholder="e.g. linear.app"
              value={(t.config.senderContains as string) ?? ''}
              onChange={(e) => setCfg('senderContains', e.target.value)}
            />
          </Field>
          <Field label="Brand key (optional)" hint="Domain-root tag, lower-case (e.g. amctheatres).">
            <input
              className="input"
              value={(t.config.brandKey as string) ?? ''}
              onChange={(e) => setCfg('brandKey', e.target.value)}
            />
          </Field>
          <Field
            label="Subject contains (optional)"
            hint="Substring match against the subject line."
          >
            <input
              className="input"
              value={(t.config.subjectContains as string) ?? ''}
              onChange={(e) => setCfg('subjectContains', e.target.value)}
            />
          </Field>
        </div>
      )}
      {t.kind === 'tag.applied' && (
        <Field label="Tag" hint="Lower-case kebab-case tag the recipe watches for.">
          <input
            className="input"
            placeholder="e.g. invoices"
            value={(t.config.tag as string) ?? ''}
            onChange={(e) => setCfg('tag', e.target.value)}
            required
          />
        </Field>
      )}
      {t.kind === 'time.scheduled' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Cron"
            hint='Standard 5-field cron, e.g. "0 8 * * MON" for 8 AM Monday.'
          >
            <input
              className="input font-mono"
              value={(t.config.cron as string) ?? ''}
              onChange={(e) => setCfg('cron', e.target.value)}
              required
            />
          </Field>
          <Field label="Timezone" hint="IANA tz, e.g. America/Los_Angeles.">
            <input
              className="input"
              value={(t.config.timezone as string) ?? 'UTC'}
              onChange={(e) => setCfg('timezone', e.target.value)}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function ConditionsStep({
  values,
  addCondition,
  removeCondition,
  setKind,
  setCfg,
}: {
  values: RecipeFormValues;
  addCondition: () => void;
  removeCondition: (i: number) => void;
  setKind: (i: number, kind: string) => void;
  setCfg: (i: number, key: string, val: unknown) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-500">
        Optional. Each condition further narrows when actions fire — they're
        ANDed together. Leave empty to fire on every trigger match.
      </p>
      {values.conditions.map((c, i) => (
        <div
          key={i}
          className="rounded-lg border border-ink-200 p-3 dark:border-ink-800"
        >
          <div className="mb-2 flex items-center gap-2">
            <select
              className="input flex-1"
              value={c.kind}
              onChange={(e) => setKind(i, e.target.value)}
            >
              {CONDITIONS.map((opt) => (
                <option key={opt.kind} value={opt.kind}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-ghost text-red-600"
              onClick={() => removeCondition(i)}
              aria-label="Remove"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <ConditionConfig
            kind={c.kind}
            config={c.config}
            setCfg={(k, v) => setCfg(i, k, v)}
          />
        </div>
      ))}
      <button type="button" className="btn-secondary text-xs" onClick={addCondition}>
        <Plus className="h-3.5 w-3.5" /> Add condition
      </button>
    </div>
  );
}

function ConditionConfig({
  kind,
  config,
  setCfg,
}: {
  kind: string;
  config: Record<string, unknown>;
  setCfg: (key: string, val: unknown) => void;
}) {
  if (kind === 'tag.contains') {
    return (
      <input
        className="input"
        placeholder="tag name"
        value={(config.tag as string) ?? ''}
        onChange={(e) => setCfg('tag', e.target.value)}
      />
    );
  }
  if (kind === 'sender.brand') {
    return (
      <input
        className="input"
        placeholder="brand key (e.g. amctheatres)"
        value={(config.brandKey as string) ?? ''}
        onChange={(e) => setCfg('brandKey', e.target.value)}
      />
    );
  }
  if (kind === 'priority.is') {
    return (
      <select
        className="input"
        value={(config.priority as string) ?? 'high'}
        onChange={(e) => setCfg('priority', e.target.value)}
      >
        <option value="high">High</option>
        <option value="normal">Normal</option>
        <option value="low">Low</option>
      </select>
    );
  }
  if (kind === 'subject.matches') {
    return (
      <input
        className="input font-mono"
        placeholder="regex pattern (case-insensitive)"
        value={(config.pattern as string) ?? ''}
        onChange={(e) => setCfg('pattern', e.target.value)}
      />
    );
  }
  return null;
}

function ActionsStep({
  values,
  addAction,
  removeAction,
  setKind,
  setCfg,
}: {
  values: RecipeFormValues;
  addAction: () => void;
  removeAction: (i: number) => void;
  setKind: (i: number, kind: string) => void;
  setCfg: (i: number, key: string, val: unknown) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-500">
        At least one action is required. Actions run in order; if one fails,
        the rest still run and the error lands in the recipe's audit.
      </p>
      {values.actions.map((a, i) => (
        <div
          key={i}
          className="rounded-lg border border-ink-200 p-3 dark:border-ink-800"
        >
          <div className="mb-2 flex items-center gap-2">
            <select
              className="input flex-1"
              value={a.kind}
              onChange={(e) => setKind(i, e.target.value)}
            >
              {/* Actions that need an email object to act on (archive,
                  draft reply) only fire when the trigger is
                  email.ingested. Disable the incompatible options
                  in-line so the user can't compose an invalid recipe
                  in the first place. */}
              {ACTIONS.map((opt) => {
                const incompatible =
                  opt.requires === 'email' &&
                  values.trigger.kind !== 'email.ingested';
                return (
                  <option key={opt.kind} value={opt.kind} disabled={incompatible}>
                    {opt.label}
                    {incompatible ? ' — needs an email trigger' : ''}
                  </option>
                );
              })}
            </select>
            <button
              type="button"
              className="btn-ghost text-red-600"
              onClick={() => removeAction(i)}
              aria-label="Remove"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <ActionConfig
            kind={a.kind}
            config={a.config}
            setCfg={(k, v) => setCfg(i, k, v)}
          />
        </div>
      ))}
      <button type="button" className="btn-secondary text-xs" onClick={addAction}>
        <Plus className="h-3.5 w-3.5" /> Add action
      </button>
    </div>
  );
}

function ActionConfig({
  kind,
  config,
  setCfg,
}: {
  kind: string;
  config: Record<string, unknown>;
  setCfg: (key: string, val: unknown) => void;
}) {
  if (kind === 'notify.push') {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title (optional)" hint="Default depends on the trigger.">
          <input
            className="input"
            value={(config.title as string) ?? ''}
            onChange={(e) => setCfg('title', e.target.value)}
          />
        </Field>
        <Field label="Message (optional)" hint="Override the body. Default is the subject / page title.">
          <input
            className="input"
            value={(config.message as string) ?? ''}
            onChange={(e) => setCfg('message', e.target.value)}
          />
        </Field>
      </div>
    );
  }
  if (kind === 'tag.add') {
    return (
      <Field label="Tag" hint="Lower-case kebab-case. Only applies when the trigger has a page subject.">
        <input
          className="input"
          placeholder="e.g. invoices"
          value={(config.tag as string) ?? ''}
          onChange={(e) => setCfg('tag', e.target.value)}
        />
      </Field>
    );
  }
  if (kind === 'category.set') {
    return (
      <Field label="Category name" hint="Auto-created if it doesn't exist. Page-subject only.">
        <input
          className="input"
          placeholder="e.g. Personal Finance"
          value={(config.name as string) ?? ''}
          onChange={(e) => setCfg('name', e.target.value)}
        />
      </Field>
    );
  }
  if (kind === 'webhook.post') {
    return (
      <Field label="URL" hint="Public HTTPS URL. Private IPs are rejected.">
        <input
          className="input font-mono"
          placeholder="https://example.com/hook"
          value={(config.url as string) ?? ''}
          onChange={(e) => setCfg('url', e.target.value)}
        />
      </Field>
    );
  }
  if (kind === 'email.delete' || kind === 'email.archive' || kind === 'email.markSpam') {
    return (
      <p className="text-xs text-ink-500">
        No options. Runs against the email that triggered this recipe.
      </p>
    );
  }
  if (kind === 'email.deleteOnSource') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={(config.deleteLocal as boolean) ?? true}
          onChange={(e) => setCfg('deleteLocal', e.target.checked)}
          className="h-4 w-4 accent-rose-500"
        />
        <span>Also remove the local Rose copy after the source delete attempt.</span>
      </label>
    );
  }
  if (kind === 'email.block') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={(config.removeExisting as boolean) ?? true}
          onChange={(e) => setCfg('removeExisting', e.target.checked)}
          className="h-4 w-4 accent-rose-500"
        />
        <span>
          Also delete every existing email and article from this sender.
        </span>
      </label>
    );
  }
  if (kind === 'llm.run') {
    return (
      <div className="space-y-3">
        <Field
          label="Prompt"
          hint='Mustache vars: {{from}}, {{subject}}, {{body}} for emails; {{title}}, {{summary}}, {{body}}, {{tag}} for articles.'
        >
          <textarea
            className="input min-h-[80px] font-mono text-xs"
            placeholder="Summarize this email in one sentence: {{subject}} — {{body}}"
            value={(config.prompt as string) ?? ''}
            onChange={(e) => setCfg('prompt', e.target.value)}
            maxLength={4000}
          />
        </Field>
        <Field
          label="System prompt (optional)"
          hint="Tone or persona for the model. Falls back to a neutral assistant."
        >
          <input
            className="input"
            value={(config.system as string) ?? ''}
            onChange={(e) => setCfg('system', e.target.value)}
            maxLength={2000}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="Output"
            hint="Where the LLM's reply lands. push = notification, tag = page tags."
          >
            <select
              className="input"
              value={(config.output as string) ?? 'push'}
              onChange={(e) => setCfg('output', e.target.value)}
            >
              <option value="push">Push notification</option>
              <option value="tag">Add as tags (page only)</option>
              <option value="audit-only">Audit log only</option>
            </select>
          </Field>
          <Field label="Push title" hint="Used when output = push.">
            <input
              className="input"
              value={(config.pushTitle as string) ?? ''}
              onChange={(e) => setCfg('pushTitle', e.target.value)}
              maxLength={80}
            />
          </Field>
          <Field label="Max tokens" hint="Cap on reply length (1–4000).">
            <input
              className="input"
              type="number"
              min={1}
              max={4000}
              value={(config.maxTokens as number) ?? 400}
              onChange={(e) => setCfg('maxTokens', Number(e.target.value))}
            />
          </Field>
        </div>
      </div>
    );
  }
  return null;
}

function NameStep({
  values,
  setValues,
}: {
  values: RecipeFormValues;
  setValues: (next: RecipeFormValues | ((prev: RecipeFormValues) => RecipeFormValues)) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Name" hint="Shown in the recipes list.">
        <input
          className="input"
          value={values.name}
          onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
          required
          maxLength={120}
        />
      </Field>
      <Field label="Description (optional)">
        <input
          className="input"
          value={values.description}
          onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))}
          maxLength={500}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Cooldown (seconds)"
          hint="Minimum interval between fires for the same subject. 0 = no cooldown."
        >
          <input
            className="input"
            type="number"
            min={0}
            max={7 * 24 * 3600}
            value={values.cooldownSeconds}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                cooldownSeconds: Number(e.target.value),
              }))
            }
          />
        </Field>
        <Field
          label="Fire limit (per hour)"
          hint="Cap to catch runaway loops. Default 60."
        >
          <input
            className="input"
            type="number"
            min={1}
            max={1000}
            value={values.fireLimitPerHour}
            onChange={(e) =>
              setValues((v) => ({
                ...v,
                fireLimitPerHour: Number(e.target.value),
              }))
            }
          />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={values.enabled}
          onChange={(e) => setValues((v) => ({ ...v, enabled: e.target.checked }))}
          className="h-4 w-4 accent-rose-500"
        />
        <span>Enabled (recipe fires on matching events)</span>
      </label>
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
      <span className="mb-1 block font-medium text-ink-700 dark:text-ink-200">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}
    </label>
  );
}
