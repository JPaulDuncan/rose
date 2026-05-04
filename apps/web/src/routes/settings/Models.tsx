import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  CheckCircle2,
  Cpu,
  Download,
  Eye,
  KeyRound,
  PlugZap,
  Trash2,
  XCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  PROVIDER_LABELS,
  type ProviderId,
  SUGGESTED_MODELS,
  type ProviderSettings,
  type ProviderTestResponse,
} from '@rose/shared';
import { useApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';

type OllamaModel = { name: string; size?: number; modifiedAt?: string };

export default function ModelsSettings() {
  const api = useApi();
  const qc = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ['provider-settings'],
    queryFn: () => api.get<ProviderSettings>('/api/providers'),
  });

  if (isLoading || !settings) {
    return <div className="card text-sm text-ink-500">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <RoleCard role="generation" settings={settings} qc={qc} />
      <RoleCard role="embedding" settings={settings} qc={qc} />
      <VisionCard />
      <ProviderCredsCard provider="anthropic" settings={settings} qc={qc} />
      <ProviderCredsCard provider="openai" settings={settings} qc={qc} />
      <OllamaCard settings={settings} qc={qc} />
    </div>
  );
}

type VisionCfg = {
  enabled?: boolean;
  model?: string;
  dailyCap?: number;
};

function VisionCard() {
  const api = useApi();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['me'],
    queryFn: () =>
      api.get<{ settings?: { vision?: VisionCfg } }>('/api/me'),
  });
  const cfg: VisionCfg = data?.settings?.vision ?? {};
  const [enabled, setEnabled] = useState(!!cfg.enabled);
  const [model, setModel] = useState(cfg.model ?? '');
  const [dailyCap, setDailyCap] = useState<number>(cfg.dailyCap ?? 30);

  useEffect(() => {
    if (!data) return;
    setEnabled(!!cfg.enabled);
    setModel(cfg.model ?? '');
    setDailyCap(cfg.dailyCap ?? 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const save = useMutation({
    mutationFn: async () =>
      api.patch<unknown>('/api/me', {
        settings: {
          ...(data?.settings ?? {}),
          vision: { ...cfg, enabled, model: model.trim() || undefined, dailyCap },
        },
      }),
    onSuccess: () => {
      toast.success('Vision settings saved');
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="card">
      <div className="mb-2 flex items-center gap-2">
        <Eye className="h-5 w-5 text-rose-500" />
        <h2 className="font-semibold">Vision (inline images)</h2>
      </div>
      <p className="text-sm text-ink-500">
        When enabled, the worker asks your generation provider's vision
        model to describe images embedded in emails — those descriptions
        flow through to the wiki page as enhanced alt text. Off by
        default because the cost profile differs from text generation.
        Defaults: Ollama <code>llava</code>, Anthropic Claude Haiku 4.5,
        OpenAI <code>gpt-4o-mini</code>.
      </p>
      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Describe inline images</span>
      </label>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-xs">
          <span className="mb-1 block font-medium">
            Vision model <span className="text-ink-400">(optional override)</span>
          </span>
          <input
            className="input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="llava | claude-haiku-4-5-20251001 | gpt-4o-mini"
          />
        </label>
        <label className="block text-xs">
          <span className="mb-1 block font-medium">Daily cap</span>
          <input
            className="input"
            type="number"
            min={1}
            max={1000}
            value={dailyCap}
            onChange={(e) => setDailyCap(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          className="btn-primary"
          onClick={() => save.mutate()}
          disabled={save.isPending}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function RoleCard({
  role,
  settings,
  qc,
}: {
  role: 'generation' | 'embedding';
  settings: ProviderSettings;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const api = useApi();
  const current = settings[role];
  const [provider, setProvider] = useState<ProviderId>(current.provider as ProviderId);
  const [model, setModel] = useState(current.model);

  // Keep local state in sync if the server settings change underneath us.
  useEffect(() => {
    setProvider(current.provider as ProviderId);
    setModel(current.model);
  }, [current.provider, current.model]);

  const allowedProviders =
    role === 'embedding'
      ? (['ollama', 'openai'] as const)
      : (['ollama', 'anthropic', 'openai'] as const);

  const suggestions = SUGGESTED_MODELS[provider]?.[role] ?? [];

  const save = useMutation({
    mutationFn: async () =>
      api.patch<{ ok: true }>('/api/providers', {
        [role]: { provider, model },
      }),
    onSuccess: () => {
      toast.success(`Saved — ${role} now uses ${provider}/${model}`);
      qc.invalidateQueries({ queryKey: ['provider-settings'] });
      qc.invalidateQueries({ queryKey: ['jobs-health'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const test = useMutation({
    mutationFn: async () =>
      api.post<ProviderTestResponse>('/api/providers/test', { role }),
    onSuccess: (r) => {
      if (r.ok) toast.success(`${r.provider}/${r.model} is reachable`);
      else toast.error(r.message ?? 'Test failed');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const Icon = role === 'generation' ? Bot : Cpu;

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="h-5 w-5 text-rose-500" />
        <h2 className="font-semibold capitalize">{role} provider</h2>
        <span className="ml-auto text-xs text-ink-500">
          Currently: <code>{current.provider}/{current.model}</code>
        </span>
      </div>
      <p className="text-xs text-ink-500">
        {role === 'generation'
          ? 'Used to draft wiki pages from emails.'
          : 'Used for semantic search. Anthropic does not offer embeddings — choose Ollama or OpenAI.'}
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Provider</span>
          <select
            className="input"
            value={provider}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
          >
            {allowedProviders.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Model</span>
          <input
            list={`suggested-${role}-${provider}`}
            className="input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="model name (free-form)"
          />
          <datalist id={`suggested-${role}-${provider}`}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => test.mutate()}
          disabled={test.isPending}
        >
          <PlugZap className={`h-4 w-4 ${test.isPending ? 'animate-pulse' : ''}`} />
          Test
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => save.mutate()}
          disabled={
            save.isPending ||
            (provider === current.provider && model === current.model)
          }
        >
          Save
        </button>
      </div>
    </div>
  );
}

function ProviderCredsCard({
  provider,
  settings,
  qc,
}: {
  provider: 'anthropic' | 'openai';
  settings: ProviderSettings;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const api = useApi();
  const cur = settings[provider];
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(cur.baseUrl);

  const save = useMutation({
    mutationFn: async (body: { apiKey?: string | null; baseUrl?: string }) =>
      api.patch<{ ok: true }>('/api/providers', { [provider]: body }),
    onSuccess: () => {
      toast.success(`${PROVIDER_LABELS[provider]} updated`);
      qc.invalidateQueries({ queryKey: ['provider-settings'] });
      setApiKey('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-rose-500" />
        <h2 className="font-semibold">{PROVIDER_LABELS[provider]}</h2>
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-ink-500">
          {cur.hasApiKey ? (
            <>
              <CheckCircle2 className="h-3 w-3 text-emerald-600" /> API key on file
            </>
          ) : (
            <>
              <XCircle className="h-3 w-3 text-ink-400" /> no API key
            </>
          )}
        </span>
      </div>
      <p className="text-xs text-ink-500">
        Keys are encrypted at rest with AES-256-GCM and never returned over the API.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block font-medium">
            API key {cur.hasApiKey ? '(leave blank to keep)' : ''}
          </span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder={cur.hasApiKey ? '••••••••' : 'sk-…'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block font-medium">Base URL (optional)</span>
          <input
            className="input"
            placeholder={
              provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com'
            }
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <span className="mt-1 block text-xs text-ink-500">
            Override for self-hosted gateways or OpenAI-compatible APIs.
          </span>
        </label>
      </div>
      <div className="flex justify-end gap-2">
        {cur.hasApiKey && (
          <button
            type="button"
            className="btn-ghost text-red-600"
            onClick={() => {
              if (confirm(`Clear stored ${PROVIDER_LABELS[provider]} API key?`))
                save.mutate({ apiKey: null });
            }}
          >
            <Trash2 className="h-4 w-4" /> Clear key
          </button>
        )}
        <button
          type="button"
          className="btn-primary"
          onClick={() =>
            save.mutate({
              ...(apiKey ? { apiKey } : {}),
              baseUrl: baseUrl ?? '',
            })
          }
          disabled={save.isPending || (!apiKey && baseUrl === cur.baseUrl)}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function OllamaCard({
  settings,
  qc,
}: {
  settings: ProviderSettings;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const api = useApi();
  const { token } = useAuth();
  const [baseUrl, setBaseUrl] = useState(settings.ollama.baseUrl);
  const [pullName, setPullName] = useState('');
  const [pullProgress, setPullProgress] = useState<{
    name: string;
    status: string;
    completed?: number;
    total?: number;
  } | null>(null);

  const { data: modelsData, isFetching } = useQuery({
    queryKey: ['ollama-models'],
    queryFn: () => api.get<{ models: OllamaModel[] }>('/api/models'),
    refetchInterval: 5000,
  });

  const saveBaseUrl = useMutation({
    mutationFn: async () =>
      api.patch<{ ok: true }>('/api/providers', { ollama: { baseUrl } }),
    onSuccess: () => {
      toast.success('Ollama URL saved');
      qc.invalidateQueries({ queryKey: ['provider-settings'] });
      qc.invalidateQueries({ queryKey: ['ollama-models'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: async (name: string) =>
      api.del<{ ok: true }>(`/api/models/${encodeURIComponent(name)}`),
    onSuccess: () => {
      toast.success('Model deleted');
      qc.invalidateQueries({ queryKey: ['ollama-models'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function startPull() {
    if (!pullName.trim() || !token) return;
    const name = pullName.trim();
    setPullProgress({ name, status: 'starting' });
    const url = `/api/models/pull/stream?name=${encodeURIComponent(name)}&access_token=${encodeURIComponent(token)}`;
    const es = new EventSource(url, { withCredentials: true });
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as {
          type: string;
          status?: string;
          completed?: number;
          total?: number;
          message?: string;
        };
        if (ev.type === 'progress') {
          setPullProgress({
            name,
            status: ev.status ?? 'pulling',
            completed: ev.completed,
            total: ev.total,
          });
        } else if (ev.type === 'completed') {
          setPullProgress(null);
          setPullName('');
          toast.success(`Pulled ${name}`);
          qc.invalidateQueries({ queryKey: ['ollama-models'] });
          es.close();
        } else if (ev.type === 'failed') {
          setPullProgress(null);
          toast.error(ev.message ?? 'Pull failed');
          es.close();
        }
      } catch {
        // ignore
      }
    };
    es.onerror = () => {
      setPullProgress(null);
      es.close();
    };
  }

  const pct = useMemo(() => {
    if (!pullProgress?.total || !pullProgress.completed) return null;
    return Math.min(100, Math.round((pullProgress.completed / pullProgress.total) * 100));
  }, [pullProgress]);

  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-2">
        <Cpu className="h-5 w-5 text-rose-500" />
        <h2 className="font-semibold">Ollama</h2>
      </div>

      <div>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Base URL</span>
          <input
            className="input"
            placeholder="http://ollama:11434 (compose default) or http://your-host:11434"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <span className="mt-1 block text-xs text-ink-500">
            Leave blank to use the docker-compose Ollama. Set to e.g.{' '}
            <code>http://host.docker.internal:11434</code> to use an Ollama running
            on your host machine.
          </span>
        </label>
        <div className="mt-2 flex justify-end">
          <button
            className="btn-secondary"
            onClick={() => saveBaseUrl.mutate()}
            disabled={baseUrl === settings.ollama.baseUrl || saveBaseUrl.isPending}
          >
            Save URL
          </button>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium">Pull a model</h3>
        <div className="flex gap-2">
          <input
            className="input"
            list="ollama-suggestions"
            placeholder="e.g. llama3.1:8b-instruct"
            value={pullName}
            onChange={(e) => setPullName(e.target.value)}
            disabled={!!pullProgress}
          />
          <datalist id="ollama-suggestions">
            {[
              ...SUGGESTED_MODELS.ollama.generation,
              ...SUGGESTED_MODELS.ollama.embedding,
            ].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <button
            className="btn-primary"
            onClick={startPull}
            disabled={!pullName.trim() || !!pullProgress}
          >
            <Download className="h-4 w-4" />
            Pull
          </button>
        </div>
        {pullProgress && (
          <div className="mt-2 rounded-lg border border-ink-200 bg-ink-50 p-2 text-xs dark:border-ink-800 dark:bg-ink-900">
            <div className="flex items-center justify-between">
              <span>
                <code>{pullProgress.name}</code> · {pullProgress.status}
              </span>
              {pct !== null && <span>{pct}%</span>}
            </div>
            {pct !== null && (
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink-200 dark:bg-ink-800">
                <div
                  className="h-full bg-rose-500 transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-medium">Installed models</h3>
          {isFetching && <span className="text-xs text-ink-500">refreshing…</span>}
        </div>
        {!modelsData?.models?.length ? (
          <div className="text-xs text-ink-500">
            None pulled yet — start with <code>llama3.1:8b-instruct</code> and{' '}
            <code>nomic-embed-text</code>.
          </div>
        ) : (
          <ul className="divide-y divide-ink-200 text-sm dark:divide-ink-800">
            {modelsData.models.map((m) => (
              <li key={m.name} className="flex items-center justify-between py-2">
                <div>
                  <code>{m.name}</code>
                  {m.size && (
                    <span className="ml-2 text-xs text-ink-500">{formatBytes(m.size)}</span>
                  )}
                </div>
                <button
                  className="btn-ghost text-red-600"
                  onClick={() => {
                    if (confirm(`Delete ${m.name} from Ollama?`)) remove.mutate(m.name);
                  }}
                  aria-label={`Delete ${m.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
