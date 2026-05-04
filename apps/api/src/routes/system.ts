import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Router } from 'express';
import { OllamaProvider } from '@rose/llm';
import { User } from '@rose/db';
import { userIdOf } from '../middleware/auth.js';
import { env } from '../lib/env.js';
import { resolveProviderForUser } from '../lib/providers.js';
import { logger } from '../lib/logger.js';

const execFileP = promisify(execFile);

export const systemRouter: Router = Router();

type GpuStat = {
  index: number;
  name: string;
  utilizationPct: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  temperatureC: number | null;
};

type LoadedModel = {
  name: string;
  sizeBytes: number | null;
  vramBytes: number | null;
  /** 'gpu' | 'cpu' | 'mixed' — derived from size_vram vs size. */
  processor: 'gpu' | 'cpu' | 'mixed';
  expiresAt: string | null;
};

type OllamaInstance = {
  /** 'default' | 'generation' | 'embedding' | 'vision' */
  role: string;
  baseUrl: string;
  ok: boolean;
  message?: string;
  loaded: LoadedModel[];
};

/**
 * Best-effort `nvidia-smi` shell-out. Returns an empty array when the
 * binary isn't present, the call times out, or the output can't be
 * parsed — the UI degrades gracefully to "no GPUs detected".
 */
async function readGpuStats(): Promise<GpuStat[]> {
  try {
    const { stdout } = await execFileP(
      'nvidia-smi',
      [
        '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 1500 },
    );
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [index, name, util, used, total, temp] = line.split(',').map((s) => s.trim());
        const num = (s?: string): number | null => {
          if (!s) return null;
          const n = Number(s);
          return Number.isFinite(n) ? n : null;
        };
        return {
          index: num(index) ?? 0,
          name: name ?? 'GPU',
          utilizationPct: num(util),
          memoryUsedMb: num(used),
          memoryTotalMb: num(total),
          temperatureC: num(temp),
        };
      });
  } catch {
    return [];
  }
}

/**
 * Container memory limit, when running under cgroups v2. Falls back to
 * Node's `os.totalmem()` (which on Linux is the host's RAM unless a
 * memory cgroup is active). Surfacing both lets the UI tell the user
 * whether they're seeing host or container numbers.
 */
async function readContainerMemory(): Promise<{
  limitBytes: number | null;
  currentBytes: number | null;
}> {
  try {
    const [limitRaw, currentRaw] = await Promise.all([
      fs.readFile('/sys/fs/cgroup/memory.max', 'utf8').catch(() => null),
      fs.readFile('/sys/fs/cgroup/memory.current', 'utf8').catch(() => null),
    ]);
    const parse = (s: string | null): number | null => {
      if (!s) return null;
      const t = s.trim();
      if (t === 'max' || t === '') return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    };
    return { limitBytes: parse(limitRaw), currentBytes: parse(currentRaw) };
  } catch {
    return { limitBytes: null, currentBytes: null };
  }
}

async function probeOllama(role: string, rawUrl: string): Promise<OllamaInstance> {
  const baseUrl = rawUrl.trim() || env.OLLAMA_URL;
  const provider = new OllamaProvider({ baseUrl });
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    let loaded: LoadedModel[] = [];
    try {
      const ps = await provider.psModels(ctrl.signal);
      loaded = ps.map((m) => {
        const size = m.size ?? null;
        const vram = m.sizeVram ?? null;
        let processor: LoadedModel['processor'] = 'cpu';
        if (vram && size) {
          if (vram >= size) processor = 'gpu';
          else if (vram > 0) processor = 'mixed';
        } else if (vram && vram > 0) {
          processor = 'gpu';
        }
        return {
          name: m.name,
          sizeBytes: size,
          vramBytes: vram,
          processor,
          expiresAt: m.expiresAt ?? null,
        };
      });
    } finally {
      clearTimeout(timer);
    }
    return { role, baseUrl, ok: true, loaded };
  } catch (err) {
    return { role, baseUrl, ok: false, message: (err as Error).message, loaded: [] };
  }
}

/**
 * Aggregate runtime telemetry for the Models settings tab:
 *   - Host CPU info + 1m/5m/15m load average (Unix; Windows reports 0)
 *   - RAM total / free / process RSS, plus container cgroup limit if any
 *   - GPU stats via nvidia-smi (best-effort; empty when unavailable)
 *   - Per-Ollama-instance loaded models with their VRAM/RAM footprint
 *
 * Polled by the SystemStats card every few seconds; cheap on idle (the
 * Ollama probes timeout at 2.5s individually so a hung instance can't
 * block the whole response for long).
 */
systemRouter.get('/stats', async (req, res) => {
  const userId = userIdOf(req);
  const user = await User.findById(userId).select('providers.ollama').lean();
  const ollama = (user?.providers?.ollama ?? {}) as {
    baseUrl?: string;
    generationBaseUrl?: string;
    embeddingBaseUrl?: string;
    visionBaseUrl?: string;
  };

  // Probe distinct URLs only — saves duplicate /api/ps calls when the
  // user hasn't set role-specific overrides.
  const roleUrls: { role: string; url: string }[] = [
    { role: 'default', url: ollama.baseUrl ?? '' },
    { role: 'generation', url: ollama.generationBaseUrl ?? '' },
    { role: 'embedding', url: ollama.embeddingBaseUrl ?? '' },
    { role: 'vision', url: ollama.visionBaseUrl ?? '' },
  ];
  const seen = new Map<string, string[]>();
  for (const { role, url } of roleUrls) {
    const resolved = (url.trim() || env.OLLAMA_URL).trim();
    const list = seen.get(resolved) ?? [];
    list.push(role);
    seen.set(resolved, list);
  }

  const [gpus, containerMem, ...instances] = await Promise.all([
    readGpuStats(),
    readContainerMemory(),
    ...[...seen.entries()].map(([url, roles]) => probeOllama(roles.join('+'), url)),
  ]);

  const cpus = os.cpus();
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const proc = process.memoryUsage();

  res.json({
    host: {
      platform: process.platform,
      arch: process.arch,
      uptimeSec: Math.round(process.uptime()),
      cpu: {
        model: cpus[0]?.model ?? 'unknown',
        cores: cpus.length,
        // os.loadavg() returns [0,0,0] on Windows.
        loadAvg: os.loadavg(),
      },
      memory: {
        totalBytes: memTotal,
        freeBytes: memFree,
        usedBytes: memTotal - memFree,
        processRssBytes: proc.rss,
        cgroupLimitBytes: containerMem.limitBytes,
        cgroupCurrentBytes: containerMem.currentBytes,
      },
    },
    gpus,
    ollama: instances,
  });
});

/**
 * Force-load each configured Ollama-backed role into memory so the user
 * doesn't have to wait for first-use latency. Useful right after a
 * worker restart or a Settings → Models change. Cloud providers
 * (Anthropic, OpenAI) are skipped — there's nothing to preload.
 *
 * Reports per-role results so the UI can show which models came up
 * and which failed. Capped at 60s per call so a missing model can't
 * stall the request indefinitely.
 */
systemRouter.post('/preload-models', async (req, res) => {
  const userId = userIdOf(req);
  type RoleResult = {
    role: 'generation' | 'embedding' | 'vision';
    provider: string;
    model: string;
    ok: boolean;
    elapsedMs: number;
    message?: string;
  };
  const roles: RoleResult['role'][] = ['generation', 'embedding', 'vision'];
  const results = await Promise.all(
    roles.map(async (role): Promise<RoleResult> => {
      const startedAt = Date.now();
      try {
        const r = await resolveProviderForUser(userId, role);
        // Cloud providers don't have a preload concept. Skip with a
        // friendly message rather than erroring.
        if (r.providerId !== 'ollama') {
          return {
            role,
            provider: r.providerId,
            model: r.model,
            ok: true,
            elapsedMs: 0,
            message: 'cloud provider — no preload needed',
          };
        }
        if (!(r.provider instanceof OllamaProvider)) {
          throw new Error('expected OllamaProvider instance');
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60_000);
        try {
          if (role === 'embedding') {
            // Embedding models load on first /api/embeddings call;
            // /api/generate with no prompt won't pull them in.
            await r.provider.embed(r.model, ' ', ctrl.signal);
          } else {
            await r.provider.preloadModel(r.model, ctrl.signal);
          }
        } finally {
          clearTimeout(timer);
        }
        return {
          role,
          provider: r.providerId,
          model: r.model,
          ok: true,
          elapsedMs: Date.now() - startedAt,
        };
      } catch (err) {
        const message = (err as Error).message;
        logger.warn({ err, role }, 'preload-models: role failed');
        return {
          role,
          provider: 'unknown',
          model: '',
          ok: false,
          elapsedMs: Date.now() - startedAt,
          message,
        };
      }
    }),
  );
  res.json({ results });
});
