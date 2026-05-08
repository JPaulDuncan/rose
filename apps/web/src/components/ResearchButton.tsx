import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi, humaniseError } from '../lib/api';
import { useConfirm } from './ConfirmModal';

/**
 * Topic-research trigger + status pill (web-integration Phase 1).
 *
 * Three visual states:
 *   • idle / failed — primary "Research" button. Click enqueues a
 *     run via POST /api/pages/:id/research. On 403 (web research
 *     disabled), nudges the user toward Settings → Daydream.
 *   • queued / running — disabled "Researching…" pill that polls
 *     GET /api/pages/:id/research every 5s while in flight, so the
 *     UI flips back to "Researched <relative time>" without a
 *     manual reload.
 *   • idle WITH lastResearchedAt — "Researched <time>" badge with
 *     refresh icon. Clicking it re-runs the research (same path
 *     as the initial trigger).
 *
 * The component is deliberately self-contained — invalidates the
 * page query on completion so the rest of the page picks up the
 * regenerated content + new externalSources without prop wiring.
 */

type ResearchState = {
  researchState: 'idle' | 'queued' | 'running' | 'failed';
  lastResearchedAt: string | null;
  lastResearchError: string | null;
  externalSources: { label: string; title: string; url: string }[];
  webDocuments: unknown[];
};

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.round((now - then) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86_400)} d ago`;
}

export function ResearchButton({
  pageId,
  pageTitle,
}: {
  pageId: string;
  pageTitle: string;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const confirm = useConfirm();

  const { data, refetch } = useQuery({
    queryKey: ['page-research', pageId],
    queryFn: () => api.get<ResearchState>(`/api/pages/${pageId}/research`),
    // While a run is in flight, poll. Otherwise let the cached
    // value sit until the user navigates away.
    refetchInterval: (q) => {
      const state = (q.state.data as ResearchState | undefined)?.researchState;
      return state === 'queued' || state === 'running' ? 5_000 : false;
    },
    // Keep stale data until the next poll lands so the pill doesn't
    // flicker when the queue moves the row through queued→running.
    staleTime: 4_000,
  });

  // When state transitions from in-flight to idle, invalidate the
  // page query so the body picks up the regenerated content.
  useEffect(() => {
    if (data?.researchState === 'idle' && data.lastResearchedAt) {
      qc.invalidateQueries({ queryKey: ['page'] });
    }
  }, [data?.researchState, data?.lastResearchedAt, qc]);

  const trigger = useMutation({
    mutationFn: () => api.post<{ researchState: string; topicLabel: string }>(
      `/api/pages/${pageId}/research`,
      {},
    ),
    onSuccess: (r) => {
      toast.success(`Researching "${r.topicLabel}" — page will update when complete.`);
      void refetch();
    },
    onError: async (e: Error & { details?: { error?: string; message?: string } }) => {
      // The API returns a structured 403 when the user hasn't opted in;
      // surface a useful nudge instead of the raw message.
      const code = (e as { status?: number }).status;
      if (code === 403) {
        const ok = await confirm.confirm({
          title: 'Topic research is off',
          body: 'Rose can pull current web sources on a topic and synthesise them with your mail. Enable it in Settings → Daydream → Topic research.',
          confirmLabel: 'Open settings',
        });
        if (ok) window.location.assign('/settings/daydream');
        return;
      }
      toast.error(humaniseError(e));
    },
  });

  const state = data?.researchState ?? 'idle';
  const inFlight = state === 'queued' || state === 'running';
  const last = data?.lastResearchedAt ?? null;

  if (inFlight) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-rose-300 bg-rose-50 px-3 py-1 text-xs font-medium text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200"
        title="Topic research in flight — page will update on completion"
      >
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        {state === 'queued' ? 'Queued…' : 'Researching…'}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => trigger.mutate()}
      disabled={trigger.isPending}
      className="inline-flex items-center gap-1.5 rounded-full border border-ink-300 px-3 py-1 text-xs font-medium text-ink-700 transition-colors hover:border-rose-400 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50 dark:border-ink-700 dark:text-ink-200 dark:hover:border-rose-700 dark:hover:bg-rose-950/30 dark:hover:text-rose-200"
      title={
        last
          ? `Last researched ${relativeTime(last)} — click to refresh`
          : `Pull current web sources on "${pageTitle}" and re-synthesise the page.`
      }
    >
      <Globe className="h-3.5 w-3.5" />
      {last ? `Researched ${relativeTime(last)}` : 'Research'}
    </button>
  );
}
