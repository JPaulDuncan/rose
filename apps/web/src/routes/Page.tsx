import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TiptapLink from '@tiptap/extension-link';
import { Save, History, Eye, Edit2, Trash2, Mail, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApi } from '../lib/api';

type Citation = {
  emailId: string;
  subject: string;
  from: string | null;
  date: string | null;
};

type PageDoc = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  contentMd: string;
  tags: string[];
  version: number;
  updatedAt: string;
  threadKey?: string | null;
  threadKeys?: string[];
  senderAddresses?: string[];
  subjectTemplates?: string[];
  groupingMode?: 'thread' | 'source-topic' | 'manual';
  citations?: Record<string, Citation>;
  sourceEmailIds?: string[];
};

type Revision = {
  _id: string;
  version: number;
  title: string;
  summary: string;
  contentMd: string;
  editor: 'user' | 'llm';
  createdAt: string;
};

export default function PageView() {
  const { slug } = useParams<{ slug: string }>();
  const api = useApi();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [showRevisions, setShowRevisions] = useState(false);

  const { data: page, isLoading } = useQuery({
    queryKey: ['page', slug],
    queryFn: () => api.get<PageDoc>(`/api/pages/by-slug/${slug}`),
    enabled: !!slug,
  });

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [tags, setTags] = useState('');

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Placeholder.configure({ placeholder: 'Write your wiki page in markdown…' }),
        TiptapLink.configure({ openOnClick: false }),
      ],
      content: '',
      editable: mode === 'edit',
    },
    [page?._id, mode],
  );

  useEffect(() => {
    if (!page || !editor) return;
    setTitle(page.title);
    setSummary(page.summary);
    setTags(page.tags.join(', '));
    editor.commands.setContent(mdToHtml(page.contentMd));
  }, [page, editor]);

  useEffect(() => {
    if (editor) editor.setEditable(mode === 'edit');
  }, [mode, editor]);

  const save = useMutation({
    mutationFn: async () => {
      if (!page) throw new Error('No page loaded');
      const contentMd = htmlToMd(editor?.getHTML() ?? '');
      return api.patch<PageDoc>(`/api/pages/${page._id}`, {
        title,
        summary,
        contentMd,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      });
    },
    onSuccess: (updated) => {
      toast.success('Saved');
      qc.invalidateQueries({ queryKey: ['page'] });
      qc.invalidateQueries({ queryKey: ['pages-recent'] });
      setMode('view');
      if (updated.slug !== slug) window.history.replaceState(null, '', `/p/${updated.slug}`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const del = useMutation({
    mutationFn: async () => api.del<{ ok: true }>(`/api/pages/${page!._id}`),
    onSuccess: () => {
      toast.success('Deleted');
      qc.invalidateQueries({ queryKey: ['pages-recent'] });
      window.location.href = '/';
    },
  });

  const { data: revisions } = useQuery({
    queryKey: ['revisions', page?._id],
    queryFn: () => api.get<{ revisions: Revision[] }>(`/api/pages/${page!._id}/revisions`),
    enabled: !!page && showRevisions,
  });

  if (isLoading || !page) {
    return <div className="px-6 py-10 text-ink-500">Loading…</div>;
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {mode === 'edit' ? (
            <input
              className="input text-2xl font-semibold"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          ) : (
            <h1 className="text-3xl font-semibold tracking-tight">{page.title}</h1>
          )}
          {mode === 'edit' ? (
            <textarea
              className="input mt-2 text-sm"
              rows={2}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Summary…"
            />
          ) : (
            <p className="mt-2 text-sm text-ink-500">{page.summary}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(mode === 'edit' ? tags.split(',').map((t) => t.trim()).filter(Boolean) : page.tags).map(
              (t) => (
                <span key={t} className="pill">
                  #{t}
                </span>
              ),
            )}
            <span className="text-xs text-ink-400">
              v{page.version} · {new Date(page.updatedAt).toLocaleString()}
            </span>
          </div>
          {mode === 'view' && <Attribution page={page} />}
          {mode === 'edit' && (
            <input
              className="input mt-2 text-xs"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="comma, separated, tags"
            />
          )}
        </div>
        <div className="flex gap-2">
          <button
            className="btn-ghost"
            onClick={() => setShowRevisions((s) => !s)}
            aria-label="Revisions"
          >
            <History className="h-4 w-4" />
          </button>
          {mode === 'view' ? (
            <button className="btn-secondary" onClick={() => setMode('edit')}>
              <Edit2 className="h-4 w-4" /> Edit
            </button>
          ) : (
            <button
              className="btn-primary"
              onClick={() => save.mutate()}
              disabled={save.isPending}
            >
              <Save className="h-4 w-4" /> {save.isPending ? 'Saving…' : 'Save'}
            </button>
          )}
          {mode === 'edit' && (
            <button className="btn-ghost" onClick={() => setMode('view')}>
              <Eye className="h-4 w-4" />
            </button>
          )}
          <button
            className="btn-ghost text-red-600"
            onClick={() => {
              if (confirm('Delete this page?')) del.mutate();
            }}
            aria-label="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <article className="card prose prose-rose max-w-none dark:prose-invert">
        {mode === 'view' ? (
          <MarkdownWithCitations
            md={page.contentMd}
            citations={page.citations ?? {}}
          />
        ) : (
          <EditorContent editor={editor} />
        )}
      </article>

      {mode === 'view' && (
        <SourcesSection
          citations={page.citations ?? {}}
          sourceEmailIds={page.sourceEmailIds ?? []}
        />
      )}

      {showRevisions && revisions && (
        <div className="card mt-6">
          <h3 className="mb-3 text-sm font-semibold">Revisions</h3>
          <ul className="space-y-1 text-sm">
            {revisions.revisions.map((r) => (
              <li key={r._id} className="flex items-center justify-between">
                <span>
                  v{r.version}{' '}
                  <span className="text-ink-500">
                    by {r.editor} · {new Date(r.createdAt).toLocaleString()}
                  </span>
                </span>
                <button
                  className="btn-ghost text-xs"
                  onClick={async () => {
                    await api.post(`/api/pages/${page._id}/revisions/${r.version}/restore`);
                    toast.success(`Restored v${r.version}`);
                    qc.invalidateQueries({ queryKey: ['page'] });
                  }}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Bare-bones markdown ↔ HTML conversion. We round-trip via TipTap which understands
 * HTML; full Markdown fidelity needs a server-side serializer (deferred).
 */
function mdToHtml(md: string): string {
  return md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .split(/\n{2,}/)
    .map((p) => {
      if (/^#\s/.test(p)) return `<h1>${p.replace(/^#\s/, '')}</h1>`;
      if (/^##\s/.test(p)) return `<h2>${p.replace(/^##\s/, '')}</h2>`;
      if (/^###\s/.test(p)) return `<h3>${p.replace(/^###\s/, '')}</h3>`;
      if (/^- /.test(p))
        return `<ul>${p
          .split('\n')
          .map((l) => `<li>${l.replace(/^- /, '')}</li>`)
          .join('')}</ul>`;
      return `<p>${p.replace(/\n/g, '<br/>')}</p>`;
    })
    .join('');
}

function htmlToMd(html: string): string {
  return html
    .replace(/<h1>(.*?)<\/h1>/g, '# $1\n\n')
    .replace(/<h2>(.*?)<\/h2>/g, '## $1\n\n')
    .replace(/<h3>(.*?)<\/h3>/g, '### $1\n\n')
    .replace(/<ul>(.*?)<\/ul>/gs, (_m, inner: string) =>
      inner.replace(/<li>(.*?)<\/li>/g, '- $1\n') + '\n',
    )
    .replace(/<p>(.*?)<\/p>/gs, '$1\n\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<strong>(.*?)<\/strong>/g, '**$1**')
    .replace(/<em>(.*?)<\/em>/g, '*$1*')
    .replace(/<code>(.*?)<\/code>/g, '`$1`')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

const CITATION_RE = /\[((?:e\d+\s*,\s*)*e\d+)\]/g;

/**
 * Render markdown with `[e1]` / `[e1, e2]` citation tokens replaced by
 * superscript footnote-style chips that link down to the Sources section.
 *
 * We hook ReactMarkdown's text renderer so plain text nodes inside paragraphs
 * and list items get walked for citation tokens. The rest of the markdown
 * (headings, lists, code, tables) goes through unchanged.
 */
function MarkdownWithCitations({
  md,
  citations,
}: {
  md: string;
  citations: Record<string, Citation>;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // ReactMarkdown passes raw text strings to this hook. We split on the
        // citation regex and emit a mix of plain text + JSX chips.
        p: ({ children }) => <p>{transformChildren(children, citations)}</p>,
        li: ({ children }) => <li>{transformChildren(children, citations)}</li>,
      }}
    >
      {md}
    </ReactMarkdown>
  );
}

function transformChildren(
  children: React.ReactNode,
  citations: Record<string, Citation>,
): React.ReactNode {
  return Array.from(toArray(children)).flatMap((child, idx) => {
    if (typeof child !== 'string') return [child];
    const parts: React.ReactNode[] = [];
    let lastIdx = 0;
    for (const match of child.matchAll(CITATION_RE)) {
      const start = match.index ?? 0;
      if (start > lastIdx) parts.push(child.slice(lastIdx, start));
      const labels = match[1]!.split(',').map((s) => s.trim()).filter((s) => /^e\d+$/.test(s));
      parts.push(
        <CitationChip key={`${idx}-${start}`} labels={labels} citations={citations} />,
      );
      lastIdx = start + match[0].length;
    }
    if (lastIdx < child.length) parts.push(child.slice(lastIdx));
    return parts.length ? parts : [child];
  });
}

function toArray(c: React.ReactNode): React.ReactNode[] {
  return Array.isArray(c) ? c : [c];
}

function CitationChip({
  labels,
  citations,
}: {
  labels: string[];
  citations: Record<string, Citation>;
}) {
  const resolved = labels.filter((l) => citations[l]);
  if (resolved.length === 0) return <>[{labels.join(', ')}]</>;
  const tooltip = resolved
    .map((l) => {
      const c = citations[l]!;
      const date = c.date ? new Date(c.date).toLocaleDateString() : '';
      return `[${l}] ${c.subject}${c.from ? ` — ${c.from}` : ''}${date ? ` (${date})` : ''}`;
    })
    .join('\n');
  return (
    <sup className="ml-0.5 inline-flex gap-0.5">
      {resolved.map((l) => (
        <a
          key={l}
          href={`#source-${l}`}
          title={tooltip}
          className="rounded bg-rose-100 px-1 text-[10px] font-semibold text-rose-700 no-underline hover:bg-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:hover:bg-rose-900/60"
          onClick={(e) => {
            const target = document.getElementById(`source-${l}`);
            if (target) {
              e.preventDefault();
              target.scrollIntoView({ behavior: 'smooth', block: 'center' });
              target.classList.add('ring-2', 'ring-rose-500');
              setTimeout(() => target.classList.remove('ring-2', 'ring-rose-500'), 1500);
            }
          }}
        >
          {l}
        </a>
      ))}
    </sup>
  );
}

type EmailMeta = {
  _id: string;
  subject?: string;
  from?: { name?: string; address?: string } | null;
  date?: string | null;
};

function SourcesSection({
  citations,
  sourceEmailIds,
}: {
  citations: Record<string, Citation>;
  sourceEmailIds: string[];
}) {
  const api = useApi();
  // Ids that aren't already represented in citations — we batch-fetch
  // metadata for these so the section is always populated, even when the
  // LLM didn't emit any [eN] tokens (thin emails, edited markdown, etc.).
  const citedIds = new Set(Object.values(citations).map((c) => c.emailId));
  const uncitedIds = sourceEmailIds.filter((id) => !citedIds.has(id));

  const { data } = useQuery({
    queryKey: ['emails-by-ids', uncitedIds],
    queryFn: () =>
      api.post<{ emails: EmailMeta[] }>('/api/emails/by-ids', { ids: uncitedIds }),
    enabled: uncitedIds.length > 0,
    staleTime: 30_000,
  });

  // Synthesize stable labels (s1, s2, …) for sources with no citation token.
  const synthesized: { label: string; data: Citation }[] = (data?.emails ?? []).map(
    (e, i) => ({
      label: `s${i + 1}`,
      data: {
        emailId: e._id,
        subject: e.subject ?? '',
        from: e.from?.name ?? e.from?.address ?? null,
        date: e.date ?? null,
      },
    }),
  );
  const cited: { label: string; data: Citation }[] = Object.entries(citations)
    .map(([label, c]) => ({ label, data: c }))
    .sort((a, b) => Number(a.label.slice(1)) - Number(b.label.slice(1)));

  const all = [...cited, ...synthesized];
  if (all.length === 0) return null;

  return (
    <section className="card mt-6">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Mail className="h-4 w-4 text-rose-500" />
        Sources ({all.length})
      </h2>
      <ol className="space-y-2 text-sm">
        {all.map(({ label, data: c }) => {
          const isCited = label.startsWith('e');
          return (
            <li
              key={label}
              id={`source-${label}`}
              className="rounded-lg border border-ink-200 p-2 transition-colors dark:border-ink-800"
            >
              <div className="flex items-start gap-2">
                {isCited ? (
                  <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
                    {label}
                  </span>
                ) : (
                  <span
                    className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-semibold text-ink-600 dark:bg-ink-800 dark:text-ink-300"
                    title="Source email — not directly cited in the body"
                  >
                    src
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{c.subject || '(no subject)'}</div>
                  <div className="text-xs text-ink-500">
                    {c.from ?? 'unknown sender'}
                    {c.date && (
                      <>
                        {' · '}
                        {new Date(c.date).toLocaleString()}
                      </>
                    )}
                  </div>
                </div>
                <Link
                  to={`/inbox?email=${c.emailId}`}
                  className="btn-ghost text-xs"
                  title="Show source email"
                >
                  <ExternalLink className="h-3 w-3" />
                </Link>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Header strip that explains why this page exists: senders, threads, mode. */
function Attribution({ page }: { page: PageDoc }) {
  const senders = page.senderAddresses ?? [];
  const threadCount = page.threadKeys?.length ?? 0;
  const emailCount = page.sourceEmailIds?.length ?? 0;
  const templateCount = page.subjectTemplates?.length ?? 0;
  const isStream = templateCount > 0 && emailCount >= 3 && templateCount <= 2;
  const mode = page.groupingMode ?? 'thread';
  const modeLabel = isStream
    ? 'Notification stream'
    : mode === 'thread'
      ? 'Grouped by thread'
      : mode === 'source-topic'
        ? 'Grouped by sender + topic'
        : 'Manually edited';

  // Pull the first/last citation date as a cheap "from … to …" range.
  const citations = Object.values(page.citations ?? {});
  const dates = citations
    .map((c) => (c.date ? new Date(c.date) : null))
    .filter((d): d is Date => !!d);
  let dateRange = '';
  if (dates.length) {
    const lo = new Date(Math.min(...dates.map((d) => d.getTime())));
    const hi = new Date(Math.max(...dates.map((d) => d.getTime())));
    const fmt = (d: Date) => d.toLocaleDateString();
    dateRange = fmt(lo) === fmt(hi) ? fmt(lo) : `${fmt(lo)} → ${fmt(hi)}`;
  }

  if (senders.length === 0 && emailCount === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-xs dark:border-ink-800 dark:bg-ink-900">
      <span
        className={
          isStream
            ? 'rounded bg-rose-100 px-1.5 py-0.5 font-medium text-rose-700 dark:bg-rose-950/50 dark:text-rose-300'
            : 'font-medium text-ink-600 dark:text-ink-300'
        }
      >
        {modeLabel}
      </span>
      {emailCount > 0 && (
        <span className="text-ink-500">
          · {emailCount} message{emailCount === 1 ? '' : 's'}
          {threadCount > 0 && (
            <>
              {' '}across {threadCount} thread{threadCount === 1 ? '' : 's'}
            </>
          )}
        </span>
      )}
      {dateRange && <span className="text-ink-500">· {dateRange}</span>}
      {senders.length > 0 && (
        <span className="flex flex-wrap items-center gap-1 text-ink-500">
          · From{' '}
          {senders.slice(0, 3).map((s) => (
            <code
              key={s}
              className="rounded bg-ink-100 px-1 py-0.5 text-[10px] dark:bg-ink-800"
            >
              {s}
            </code>
          ))}
          {senders.length > 3 && <span>+{senders.length - 3} more</span>}
        </span>
      )}
      {(page.version ?? 1) > 1 && (
        <span className="text-ink-500">· updated {page.version} times</span>
      )}
    </div>
  );
}
