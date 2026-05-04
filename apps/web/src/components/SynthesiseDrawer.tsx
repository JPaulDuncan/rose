import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Sparkles, X, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../lib/auth';

type LabelledPage = { label: string; _id: string; slug: string; title: string };

/**
 * Streaming drawer that synthesises a user-selected set of wiki
 * entries into a single meta-page. Hits POST /api/pages/synthesise
 * over SSE and shows tokens live; on completion offers a link to the
 * new page.
 */
export function SynthesiseDrawer({
  pageIds,
  defaultTitle,
  onClose,
}: {
  pageIds: string[];
  defaultTitle?: string;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [focus, setFocus] = useState('');
  const [title, setTitle] = useState(defaultTitle ?? '');
  const [streaming, setStreaming] = useState(false);
  const [buffer, setBuffer] = useState('');
  const [pages, setPages] = useState<LabelledPage[]>([]);
  const [created, setCreated] = useState<{ slug: string; pageId: string } | null>(null);

  async function run() {
    if (pageIds.length < 2) {
      toast.error('Pick at least 2 pages');
      return;
    }
    setStreaming(true);
    setBuffer('');
    setCreated(null);
    try {
      const res = await fetch('/api/pages/synthesise', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({ pageIds, focus: focus.trim() || undefined, title }),
      });
      if (!res.ok || !res.body) {
        const err = await res.text();
        throw new Error(err || `${res.status} ${res.statusText}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let leftover = '';
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        leftover += dec.decode(value, { stream: true });
        const lines = leftover.split('\n');
        leftover = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let payload: { type: string; [k: string]: unknown };
          try {
            payload = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (payload.type === 'pages') {
            setPages(payload.pages as LabelledPage[]);
          } else if (payload.type === 'token') {
            buf += (payload.delta as string) ?? '';
            setBuffer(buf);
          } else if (payload.type === 'completed') {
            setCreated({
              slug: payload.slug as string,
              pageId: payload.pageId as string,
            });
            toast.success('Synthesis saved');
          } else if (payload.type === 'error') {
            throw new Error(payload.message as string);
          }
        }
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/40 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-2xl space-y-3 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-rose-500" />
            <span className="font-semibold">
              Synthesise {pageIds.length} entries into one
            </span>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose}>
            <X className="h-4 w-4" />
          </button>
        </header>

        {!streaming && !created && (
          <>
            <label className="block text-xs">
              <span className="mb-1 block font-medium">Title (optional)</span>
              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Auto-derived if blank"
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block font-medium">Focus (optional)</span>
              <input
                className="input"
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                placeholder='e.g. "what changed week-over-week"'
              />
            </label>
            <div className="flex justify-end gap-2 text-xs">
              <button type="button" className="btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={run}
                disabled={pageIds.length < 2}
              >
                <Sparkles className="h-3.5 w-3.5" /> Synthesise
              </button>
            </div>
          </>
        )}

        {(streaming || buffer) && (
          <div className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-sm dark:border-ink-800 dark:bg-ink-900/40">
            <div className="mb-2 text-[10px] uppercase tracking-widest text-ink-500">
              Streaming
            </div>
            <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-relaxed">
              {buffer}
              {streaming && (
                <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-rose-500" />
              )}
            </pre>
            {pages.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1 text-[10px] uppercase tracking-widest text-ink-500">
                {pages.map((p) => (
                  <Link
                    key={p._id}
                    to={`/p/${p.slug}`}
                    className="rounded bg-rose-100 px-1.5 py-0.5 text-rose-800 hover:bg-rose-200 dark:bg-rose-950/40 dark:text-rose-200"
                    title={p.title}
                  >
                    {p.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}

        {created && (
          <div className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs dark:border-emerald-800 dark:bg-emerald-950/30">
            <span>Saved as a wiki page.</span>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                onClose();
                navigate(`/p/${created.slug}`);
              }}
            >
              Open <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
