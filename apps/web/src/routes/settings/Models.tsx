import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Bot,
  CheckCircle2,
  Cpu,
  Download,
  Eye,
  HardDrive,
  KeyRound,
  PlugZap,
  Trash2,
  XCircle,
  Zap,
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

  // Surface installed Ollama models in every selector so the user can pick
  // from what's actually pulled, not just our static suggestions list.
  const { data: ollamaModelsData } = useQuery({
    queryKey: ['ollama-models'],
    queryFn: () => api.get<{ models: OllamaModel[] }>('/api/models'),
    refetchInterval: 10_000,
  });
  const installedOllama = (ollamaModelsData?.models ?? []).map((m) => m.name);

  if (isLoading || !settings) {
    return <div className="card text-sm text-ink-500">Loading…</div>;
  }

  return (
    <div className="space-y-6">
      <SystemStatsCard />
      <RoleCard role="generation" settings={settings} qc={qc} installedOllama={installedOllama} />
      <RoleCard role="embedding" settings={settings} qc={qc} installedOllama={installedOllama} />
      <VisionCard installedOllama={installedOllama} />
      <ProviderCredsCard provider="anthropic" settings={settings} qc={qc} />
      <ProviderCredsCard provider="openai" settings={settings} qc={qc} />
      <OllamaCard settings={settings} qc={qc} />
    </div>
  );
}

type SystemStats = {
  host: {
    platform: string;
    arch: string;
    uptimeSec: number;
    cpu: { model: string; cores: number; loadAvg: number[] };
    memory: {
      totalBytes: number;
      freeBytes: number;
      usedBytes: number;
      processRssBytes: number;
      cgroupLimitBytes: number | null;
      cgroupCurrentBytes: number | null;
    };
  };
  gpus: {
    index: number;
    name: string;
    utilizationPct: number | null;
    memoryUsedMb: number | null;
    memoryTotalMb: number | null;
    temperatureC: number | null;
  }[];
  gpuProbe: {
    binary: string | null;
    ok: boolean;
    message?: string;
  };
  ollama: {
    role: string;
    baseUrl: string;
    ok: boolean;
    message?: string;
    loaded: {
      name: string;
      sizeBytes: number | null;
      vramBytes: number | null;
      processor: 'gpu' | 'cpu' | 'mixed';
      expiresAt: string | null;
    }[];
  }[];
};

type PreloadResult = {
  role: 'generation' | 'embedding' | 'vision';
  provider: string;
  model: string;
  ok: boolean;
  elapsedMs: number;
  message?: string;
};

function SystemStatsCard() {
  const api = useApi();
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['system-stats'],
    queryFn: () => api.get<SystemStats>('/api/system/stats'),
    refetchInterval: 3000,
  });

  const preload = useMutation({
    mutationFn: () =>
      api.post<{ results: PreloadResult[] }>('/api/system/preload-models'),
    onSuccess: ({ results }) => {
      const okCount = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        toast.success(`Preloaded ${okCount} model${okCount === 1 ? '' : 's'}`);
      } else {
        toast.error(
          `Preloaded ${okCount}/${results.length}; failed: ${failed
            .map((r) => `${r.role} (${r.message ?? 'unknown'})`)
            .join(', ')}`,
        );
      }
      qc.invalidateQueries({ queryKey: ['system-stats'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <div className="card text-sm text-ink-500">Loading system stats…</div>
    );
  }
  if (isError || !data) {
    return (
      <div className="card text-sm text-red-600">
        Couldn't read system stats.
      </div>
    );
  }

  // Show the cgroup memory if present (we're in a container with a
  // memory limit), otherwise the host RAM. Surfacing both would confuse
  // most users.
  const memTotal =
    data.host.memory.cgroupLimitBytes ?? data.host.memory.totalBytes;
  const memUsed =
    data.host.memory.cgroupCurrentBytes ?? data.host.memory.usedBytes;
  const memPct = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;
  const isContainerLimited = data.host.memory.cgroupLimitBytes != null;

  // 1m load average normalized to per-core so 100% means "fully loaded".
  const load1m = data.host.cpu.loadAvg[0] ?? 0;
  const cpuPct = Math.min(
    999,
    Math.round((load1m / Math.max(1, data.host.cpu.cores)) * 100),
  );

  return (
    <div className="card space-y-4">
      <div className="flex items-center gap-2">
        <Activity className="h-5 w-5 text-rose-500" />
        <h2 className="font-semibold">System</h2>
        <span className="ml-auto text-xs text-ink-500">
          {data.host.platform}/{data.host.arch} · up {formatUptime(data.host.uptimeSec)}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <StatBlock
          icon={<Cpu className="h-4 w-4" />}
          label="CPU"
          headline={`${data.host.cpu.cores} core${data.host.cpu.cores === 1 ? '' : 's'}`}
          sub={data.host.cpu.model}
          fillPct={cpuPct}
          fillLabel={`load ${load1m.toFixed(2)} (${cpuPct}% per core)`}
        />
        <StatBlock
          icon={<HardDrive className="h-4 w-4" />}
          label={isContainerLimited ? 'RAM (container)' : 'RAM (host)'}
          headline={`${formatBytes(memUsed)} / ${formatBytes(memTotal)}`}
          sub={`API process: ${formatBytes(data.host.memory.processRssBytes)}`}
          fillPct={memPct}
          fillLabel={`${memPct}% used`}
        />
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <Zap className="h-4 w-4 text-rose-500" />
          <h3 className="text-sm font-medium">GPUs</h3>
          <span className="text-xs text-ink-500">
            {data.gpus.length > 0
              ? `${data.gpus.length} found`
              : data.gpuProbe.ok
                ? 'none detected'
                : 'unavailable'}
          </span>
        </div>
        {data.gpus.length === 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200">
            <div className="font-medium">nvidia-smi probe</div>
            <div className="mt-0.5">
              {data.gpuProbe.binary ? (
                <>
                  Tried <code>{data.gpuProbe.binary}</code> —{' '}
                  {data.gpuProbe.message ?? 'failed'}
                </>
              ) : (
                data.gpuProbe.message
              )}
            </div>
            <div className="mt-1 text-amber-800 dark:text-amber-300">
              Fix: install <code>nvidia-container-toolkit</code> on the host,
              run <code>nvidia-ctk runtime configure --runtime=docker</code>,
              restart Docker, then{' '}
              <code>docker compose up -d --force-recreate api</code>.
            </div>
          </div>
        )}
        {data.gpus.length > 0 && (
          <ul className="space-y-2">
            {data.gpus.map((g) => {
              const memPct =
                g.memoryUsedMb != null && g.memoryTotalMb && g.memoryTotalMb > 0
                  ? Math.round((g.memoryUsedMb / g.memoryTotalMb) * 100)
                  : null;
              return (
                <li
                  key={g.index}
                  className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs dark:border-ink-800 dark:bg-ink-900"
                >
                  <div className="flex items-center justify-between font-medium">
                    <span>
                      GPU {g.index} · {g.name}
                    </span>
                    {g.temperatureC != null && (
                      <span className="text-ink-500">{g.temperatureC}°C</span>
                    )}
                  </div>
                  <div className="mt-1 grid gap-2 sm:grid-cols-2">
                    <Bar
                      label={`Compute ${g.utilizationPct ?? 0}%`}
                      pct={g.utilizationPct ?? 0}
                    />
                    {memPct != null && (
                      <Bar
                        label={`VRAM ${g.memoryUsedMb}/${g.memoryTotalMb} MB`}
                        pct={memPct}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Loaded Ollama models</h3>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => preload.mutate()}
            disabled={preload.isPending}
            title="POST /api/generate with empty prompt for each role's model so Ollama loads them all into memory"
          >
            <Download
              className={`h-3 w-3 ${preload.isPending ? 'animate-pulse' : ''}`}
            />
            {preload.isPending ? 'Preloading…' : 'Preload models'}
          </button>
        </div>
        {data.ollama.length === 0 ? (
          <div className="text-xs text-ink-500">No Ollama instances configured.</div>
        ) : (
          <ul className="space-y-2">
            {data.ollama.map((inst) => (
              <li
                key={inst.baseUrl}
                className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs dark:border-ink-800 dark:bg-ink-900"
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-mono text-[11px]">{inst.baseUrl}</span>
                  <span className="text-ink-500">{inst.role}</span>
                </div>
                {!inst.ok ? (
                  <div className="text-red-600">
                    unreachable{inst.message ? ` — ${inst.message}` : ''}
                  </div>
                ) : inst.loaded.length === 0 ? (
                  <div className="text-ink-500">No models currently loaded.</div>
                ) : (
                  <ul className="space-y-1">
                    {inst.loaded.map((m) => (
                      <li key={m.name} className="flex items-center justify-between">
                        <span>
                          <code>{m.name}</code>
                          <span
                            className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${
                              m.processor === 'gpu'
                                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                                : m.processor === 'mixed'
                                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                                  : 'bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300'
                            }`}
                          >
                            {m.processor.toUpperCase()}
                          </span>
                        </span>
                        <span className="text-ink-500">
                          {m.sizeBytes ? formatBytes(m.sizeBytes) : '—'}
                          {m.vramBytes && m.sizeBytes && m.vramBytes < m.sizeBytes && (
                            <> ({formatBytes(m.vramBytes)} VRAM)</>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatBlock({
  icon,
  label,
  headline,
  sub,
  fillPct,
  fillLabel,
}: {
  icon: React.ReactNode;
  label: string;
  headline: string;
  sub: string;
  fillPct: number;
  fillLabel: string;
}) {
  return (
    <div className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs dark:border-ink-800 dark:bg-ink-900">
      <div className="mb-1 flex items-center gap-1 font-medium">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-sm font-semibold">{headline}</div>
      <div className="mt-0.5 truncate text-ink-500" title={sub}>
        {sub}
      </div>
      <Bar pct={Math.min(100, fillPct)} label={fillLabel} />
    </div>
  );
}

function Bar({ pct, label }: { pct: number; label: string }) {
  // Clamp to 0–100 for the visual; the textual label can show >100% load.
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="mt-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-200 dark:bg-ink-800">
        <div
          className={`h-full transition-all ${
            clamped > 90
              ? 'bg-red-500'
              : clamped > 70
                ? 'bg-amber-500'
                : 'bg-rose-500'
          }`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="mt-0.5 text-[10px] text-ink-500">{label}</div>
    </div>
  );
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

type VisionCfg = {
  enabled?: boolean;
  model?: string;
  dailyCap?: number;
};

function VisionCard({ installedOllama }: { installedOllama: string[] }) {
  const api = useApi();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['me'],
    queryFn: () =>
      api.get<{ settings?: { vision?: VisionCfg } }>('/api/me'),
  });
  const saved: VisionCfg = data?.settings?.vision ?? {};
  const [enabled, setEnabled] = useState(!!saved.enabled);
  const [model, setModel] = useState(saved.model ?? '');
  const [dailyCap, setDailyCap] = useState<number>(saved.dailyCap ?? 30);

  useEffect(() => {
    if (!data) return;
    setEnabled(!!saved.enabled);
    setModel(saved.model ?? '');
    setDailyCap(saved.dailyCap ?? 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const save = useMutation({
    mutationFn: async () =>
      // Send only the vision subtree. The server merges into existing
      // settings (it now patches `settings.vision` rather than replacing
      // the whole settings doc), so siblings like digestEmail are safe.
      api.patch<unknown>('/api/me', {
        settings: {
          vision: { enabled, model: model.trim(), dailyCap },
        },
      }),
    onSuccess: () => {
      toast.success('Vision settings saved');
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Combine Ollama installed models, generic vision suggestions across
  // providers, and the currently-saved value so the dropdown reflects
  // whatever the user can pick from right now.
  const suggestionSet = new Set<string>([
    ...installedOllama,
    ...SUGGESTED_MODELS.ollama.vision,
    ...SUGGESTED_MODELS.anthropic.vision,
    ...SUGGESTED_MODELS.openai.vision,
  ]);
  if (saved.model) suggestionSet.add(saved.model);
  const suggestions = [...suggestionSet];

  const dirty =
    enabled !== !!saved.enabled ||
    (model.trim() || '') !== (saved.model ?? '') ||
    dailyCap !== (saved.dailyCap ?? 30);

  return (
    <div className="card">
      <div className="mb-2 flex items-center gap-2">
        <Eye className="h-5 w-5 text-rose-500" />
        <h2 className="font-semibold">Vision (inline images)</h2>
        <span className="ml-auto text-xs text-ink-500">
          Saved:{' '}
          <code>
            {saved.enabled ? `on / ${saved.model || '(default)'} / cap ${saved.dailyCap ?? 30}` : 'off'}
          </code>
        </span>
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
            list="vision-model-suggestions"
            className="input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="llava | claude-haiku-4-5 | gpt-4o-mini"
          />
          <datalist id="vision-model-suggestions">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
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
          disabled={save.isPending || !dirty}
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
  installedOllama,
}: {
  role: 'generation' | 'embedding';
  settings: ProviderSettings;
  qc: ReturnType<typeof useQueryClient>;
  installedOllama: string[];
}) {
  const api = useApi();
  const current = settings[role];
  const [provider, setProvider] = useState<ProviderId>(current.provider as ProviderId);
  const [model, setModel] = useState(current.model);
  const [device, setDevice] = useState<'auto' | 'gpu' | 'cpu'>(
    ((current as { device?: 'auto' | 'gpu' | 'cpu' }).device ?? 'auto'),
  );

  // Per-task default the worker uses when the user hasn't overridden.
  // Surfaced in placeholders so the user knows what they're tuning.
  const taskDefaults: Record<string, number | string> = {
    temperature: 0.2,
    maxTokens: 4096,
    topP: '—',
    topK: '—',
    repeatPenalty: '—',
    numCtx: 8192,
  };

  // Sampler overrides — generation role only. `null` = "use the
  // worker's default for the task that called the LLM".
  const savedParams = (
    role === 'generation' ? (current as { params?: Record<string, number | null> }).params : undefined
  ) ?? {
    temperature: null,
    maxTokens: null,
    topP: null,
    topK: null,
    repeatPenalty: null,
    numCtx: null,
  };
  const [params, setParams] = useState<Record<string, number | null>>(savedParams);

  // Keep local state in sync if the server settings change underneath us.
  useEffect(() => {
    setProvider(current.provider as ProviderId);
    setModel(current.model);
    setParams(savedParams);
    setDevice(
      ((current as { device?: 'auto' | 'gpu' | 'cpu' }).device ?? 'auto'),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.provider, current.model, JSON.stringify(savedParams)]);

  const allowedProviders =
    role === 'embedding'
      ? (['ollama', 'openai'] as const)
      : (['ollama', 'anthropic', 'openai'] as const);

  // For Ollama, surface the actually-installed models first (so the user
  // sees `llama3.1:8b-instruct` without having to remember the tag), then
  // append any static suggestions they haven't pulled yet.
  const staticSuggestions = SUGGESTED_MODELS[provider]?.[role] ?? [];
  const suggestions =
    provider === 'ollama'
      ? [...new Set([...installedOllama, ...staticSuggestions])]
      : staticSuggestions;

  const save = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { provider, model, device };
      if (role === 'generation') body.params = params;
      return api.patch<{ ok: true }>('/api/providers', { [role]: body });
    },
    onSuccess: () => {
      toast.success(`Saved — ${role} now uses ${provider}/${model}`);
      qc.invalidateQueries({ queryKey: ['provider-settings'] });
      qc.invalidateQueries({ queryKey: ['jobs-health'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const paramsDirty =
    role === 'generation' && JSON.stringify(params) !== JSON.stringify(savedParams);
  const savedDevice =
    ((current as { device?: 'auto' | 'gpu' | 'cpu' }).device ?? 'auto');
  const deviceDirty = device !== savedDevice;
  const dirty =
    provider !== current.provider || model !== current.model || paramsDirty || deviceDirty;

  const setParam = (key: string, raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      setParams({ ...params, [key]: null });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    setParams({ ...params, [key]: n });
  };

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

      {provider === 'ollama' && (
        <div>
          <span className="mb-1 block text-sm font-medium">Device</span>
          <div
            role="radiogroup"
            aria-label="Where to run this model"
            className="inline-flex rounded-lg border border-ink-200 p-0.5 text-xs dark:border-ink-800"
          >
            {(
              [
                ['auto', 'Auto', 'Let Ollama decide based on free VRAM (default).'],
                ['gpu', 'GPU only', 'Force every layer onto the GPU. Fastest, but consumes the most VRAM.'],
                [
                  'cpu',
                  'CPU only',
                  role === 'embedding'
                    ? 'Runs the embedding model on CPU so it doesn\'t share VRAM with your generation model. Slower per call but keeps the GPU free for chat / page generation. Good pick when your gen model is already large (≥7B).'
                    : 'Runs every layer on CPU. Slow but uses no VRAM at all — useful if you\'re sharing the GPU with another app.',
                ],
              ] as const
            ).map(([key, label, hint]) => (
              <button
                key={key}
                type="button"
                onClick={() => setDevice(key)}
                aria-checked={device === key}
                role="radio"
                title={hint}
                className={
                  'rounded-md px-3 py-1 transition-colors ' +
                  (device === key
                    ? 'bg-rose-600 text-white'
                    : 'text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800')
                }
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink-500">
            {device === 'auto' &&
              'Ollama loads as many layers onto the GPU as VRAM allows.'}
            {device === 'gpu' &&
              'Pinned to GPU. If the model is bigger than free VRAM the call may fail — fall back to Auto.'}
            {device === 'cpu' &&
              role === 'embedding' &&
              'Pinned to CPU. Recommended on a 12 GB GPU when running a 14B+ generation model — frees ~1 GB of VRAM.'}
            {device === 'cpu' &&
              role === 'generation' &&
              'Pinned to CPU. Generation will be much slower; use only if you need the GPU for something else.'}
          </p>
        </div>
      )}

      {role === 'generation' && (
        <details className="rounded border border-ink-200 bg-ink-50 px-3 py-2 dark:border-ink-800 dark:bg-ink-900">
          <summary className="cursor-pointer text-sm font-medium text-ink-600 hover:text-rose-600 dark:text-ink-300">
            Advanced sampling (temperature, top-p, num_ctx, …)
          </summary>
          <p className="mt-2 text-xs text-ink-500">
            Leave a field blank to use the per-task default the worker
            applies (<code>0.2</code> for JSON-mode wiki generation,{' '}
            <code>0.4</code> for the narrative briefing). <strong>Heads up:</strong>{' '}
            temperatures above ~0.4 noticeably increase the rate of
            malformed JSON, which makes generate-page jobs fail with{' '}
            <code>LLM returned invalid JSON</code>.
          </p>
          <p className="mt-1 text-xs text-ink-500">
            <code>topK</code>, <code>repeatPenalty</code>, and{' '}
            <code>numCtx</code> are Ollama-specific — Anthropic and
            OpenAI silently ignore them.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {(
              [
                ['temperature', 'Temperature', '0–2'],
                ['topP', 'top_p', '0–1'],
                ['topK', 'top_k', '1–200 (Ollama)'],
                ['repeatPenalty', 'repeat_penalty', '~1.1 (Ollama)'],
                ['maxTokens', 'max_tokens', 'integer'],
                ['numCtx', 'num_ctx', '512–131072 (Ollama)'],
              ] as const
            ).map(([key, label, hint]) => (
              <label key={key} className="block text-xs">
                <span className="mb-1 block font-medium">
                  {label} <span className="font-normal text-ink-400">({hint})</span>
                </span>
                <input
                  className="input"
                  type="number"
                  step="any"
                  placeholder={`default ${taskDefaults[key]}`}
                  value={params[key] == null ? '' : String(params[key])}
                  onChange={(e) => setParam(key, e.target.value)}
                />
              </label>
            ))}
          </div>
        </details>
      )}

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
          disabled={save.isPending || !dirty}
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
  const [genUrl, setGenUrl] = useState(settings.ollama.generationBaseUrl ?? '');
  const [embedUrl, setEmbedUrl] = useState(settings.ollama.embeddingBaseUrl ?? '');
  const [visionUrl, setVisionUrl] = useState(settings.ollama.visionBaseUrl ?? '');
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
      api.patch<{ ok: true }>('/api/providers', {
        ollama: {
          baseUrl,
          generationBaseUrl: genUrl,
          embeddingBaseUrl: embedUrl,
          visionBaseUrl: visionUrl,
        },
      }),
    onSuccess: () => {
      toast.success('Ollama URLs saved');
      qc.invalidateQueries({ queryKey: ['provider-settings'] });
      qc.invalidateQueries({ queryKey: ['ollama-models'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const urlsDirty =
    baseUrl !== settings.ollama.baseUrl ||
    genUrl !== (settings.ollama.generationBaseUrl ?? '') ||
    embedUrl !== (settings.ollama.embeddingBaseUrl ?? '') ||
    visionUrl !== (settings.ollama.visionBaseUrl ?? '');

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
        <a
          href="https://canirun.ai"
          target="_blank"
          rel="noreferrer"
          className="ml-auto text-xs text-rose-600 hover:underline dark:text-rose-300"
          title="Check whether your hardware can run a given local model"
        >
          Hardware check ↗
        </a>
      </div>
      <p className="text-xs text-ink-500">
        Not sure which models your hardware can run? Try{' '}
        <a
          href="https://canirun.ai"
          target="_blank"
          rel="noreferrer"
          className="text-rose-600 hover:underline dark:text-rose-300"
        >
          canirun.ai
        </a>{' '}
        — paste in your CPU/GPU/RAM and it tells you which Ollama
        models will fit and how fast they'll go.
      </p>

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
        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-medium text-ink-600 hover:text-rose-600 dark:text-ink-300">
            Per-role overrides (optional — run a dedicated Ollama per role)
          </summary>
          <p className="mt-2 text-xs text-ink-500">
            Point each role at a separate Ollama instance to keep a slow
            generation call from blocking embeddings, or to pin each model to
            its own GPU. Leave blank to fall back to the Base URL above.
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-3">
            <label className="block text-xs">
              <span className="mb-1 block font-medium">Generation URL</span>
              <input
                className="input"
                placeholder={baseUrl || 'http://ollama:11434'}
                value={genUrl}
                onChange={(e) => setGenUrl(e.target.value)}
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block font-medium">Embedding URL</span>
              <input
                className="input"
                placeholder={baseUrl || 'http://ollama-embed:11434'}
                value={embedUrl}
                onChange={(e) => setEmbedUrl(e.target.value)}
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block font-medium">Vision URL</span>
              <input
                className="input"
                placeholder={baseUrl || 'http://ollama-vision:11434'}
                value={visionUrl}
                onChange={(e) => setVisionUrl(e.target.value)}
              />
            </label>
          </div>
        </details>
        <div className="mt-2 flex justify-end">
          <button
            className="btn-secondary"
            onClick={() => saveBaseUrl.mutate()}
            disabled={!urlsDirty || saveBaseUrl.isPending}
          >
            Save URLs
          </button>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium">Pull a model</h3>
        <p className="mb-2 text-xs text-ink-500">
          Ollama refs (<code>llama3.1:8b-instruct</code>) or Hugging Face GGUF
          (<code>unsloth/Qwen3.5-9B-GGUF</code> — auto-prefixed with{' '}
          <code>hf.co/</code>).
        </p>
        <div className="flex gap-2">
          <input
            className="input"
            list="ollama-suggestions"
            placeholder="llama3.1:8b-instruct or owner/repo-GGUF"
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
