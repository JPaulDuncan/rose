import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { streamJob } from '../lib/sse';

type Event =
  | { type: 'connected'; jobId: string }
  | { type: 'started'; jobId: string }
  | { type: 'token'; jobId: string; token: string }
  | { type: 'completed'; jobId: string; pageId?: string; returnvalue?: { pageId?: string; slug?: string } }
  | { type: 'failed'; jobId: string; error: string };

export function IngestionDrawer({
  jobId,
  token,
  onClose,
}: {
  jobId: string;
  token: string;
  onClose: () => void;
}) {
  const [stream, setStream] = useState('');
  const [done, setDone] = useState<{ pageId?: string; slug?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dispose = streamJob(jobId, token, (raw) => {
      const ev = raw as Event;
      if (ev.type === 'token') {
        setStream((s) => s + ev.token);
      } else if (ev.type === 'completed') {
        setDone({ pageId: ev.returnvalue?.pageId ?? ev.pageId, slug: ev.returnvalue?.slug });
      } else if (ev.type === 'failed') {
        setError(ev.error);
      }
    });
    return dispose;
  }, [jobId, token]);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [stream]);

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-[480px] max-w-full flex-col border-l border-ink-200 bg-white shadow-soft dark:border-ink-800 dark:bg-ink-900 animate-slide-up">
      <div className="flex items-center justify-between border-b border-ink-200 px-4 py-3 dark:border-ink-800">
        <div>
          <div className="text-sm font-semibold">Filing article…</div>
          <div className="text-xs text-ink-500">Job {jobId}</div>
        </div>
        <button className="btn-ghost" onClick={onClose} aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div ref={ref} className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed text-ink-700 dark:text-ink-200">
        {stream || <span className="text-ink-400">Waiting for first tokens…</span>}
      </div>
      <div className="border-t border-ink-200 p-3 dark:border-ink-800">
        {error ? (
          <div className="text-sm text-red-600">Failed: {error}</div>
        ) : done ? (
          <div className="flex items-center justify-between">
            <span className="text-sm text-emerald-600">Page generated.</span>
            {done.slug && (
              <Link to={`/p/${done.slug}`} className="btn-primary" onClick={onClose}>
                Open page
              </Link>
            )}
          </div>
        ) : (
          <div className="text-sm text-ink-500">Streaming from Ollama…</div>
        )}
      </div>
    </div>
  );
}
