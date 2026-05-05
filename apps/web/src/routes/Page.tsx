import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TiptapLink from '@tiptap/extension-link';
import {
  Save,
  History,
  Eye,
  Edit2,
  Trash2,
  Mail,
  ExternalLink,
  Flame,
  ShieldAlert,
  Megaphone,
  LinkIcon,
  Paperclip,
  Tag as TagIcon,
  ImageIcon,
  MoreHorizontal,
  Ban,
  UserX,
  TagIcon as TagXIcon,
  CheckSquare,
  ChevronDown,
} from 'lucide-react';
import toast from 'react-hot-toast';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApi } from '../lib/api';
import { ShareButton } from '../components/ShareButton';
import { FavoriteButton } from '../components/FavoriteButton';

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
  groupingMode?: 'thread' | 'source-topic' | 'topic' | 'manual' | 'briefing' | 'synthesis';
  citations?: Record<string, Citation>;
  sourceEmailIds?: string[];
  synthesisOf?: string[];
  generationModel?: string | null;
  generatedAt?: string | null;
  generatedBy?: 'llm' | 'synth' | 'briefing' | 'human' | null;
  priority?: 'high' | 'normal' | 'low';
  topics?: string[];
  pageLinks?: { url: string; text?: string | null; count: number }[];
  pageImages?: {
    url: string;
    alt?: string | null;
    description?: string | null;
    count: number;
    fromEmailId?: string;
  }[];
  heroImageUrl?: string | null;
  pageAttachments?: { filename: string; contentType: string; size: number; fromEmailId: string }[];
  spamScore?: number;
  flags?: {
    hasLikelySpam?: boolean;
    hasMassMailing?: boolean;
    isSparse?: boolean;
    userMarkedSpam?: boolean;
    isNotificationStream?: boolean;
  };
  senderBrands?: Record<
    string,
    { brandKey: string; name: string; logoUrl: string | null }
  >;
};

type Revision = {
  _id: string;
  version: number;
  title: string;
  summary: string;
  contentMd: string;
  editor: 'user' | 'llm' | 'synth' | 'briefing';
  model?: string | null;
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

  // Mark this page read on view. The endpoint silently no-ops when
  // the user hasn't enabled read tracking, so we don't gate here.
  useEffect(() => {
    if (!page?._id) return;
    void api.post(`/api/pages/${page._id}/read`, { read: true }).catch(() => null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?._id]);

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
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
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
              (t) =>
                mode === 'edit' ? (
                  <span key={t} className="pill">
                    #{t}
                  </span>
                ) : (
                  <Link
                    key={t}
                    to={`/t/${encodeURIComponent(t)}`}
                    className="pill hover:bg-rose-100 hover:text-rose-800 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
                  >
                    #{t}
                  </Link>
                ),
            )}
            <span className="text-xs text-ink-400">
              v{page.version} · {new Date(page.updatedAt).toLocaleString()}
            </span>
          </div>
          {mode === 'view' && <Attribution page={page} />}
          {mode === 'view' && <PageBanners page={page} />}
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
          {mode === 'view' && page && <FavoriteButton pageId={page._id} />}
          {mode === 'view' && page && <ShareButton pageId={page._id} pageTitle={page.title} />}
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
          <SpamMenu page={page} />
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

      {mode === 'view' && page.heroImageUrl && (
        <HeroImage url={page.heroImageUrl} alt={page.title} />
      )}

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

      {mode === 'view' && <TopicsBlock topics={page.topics ?? []} />}
      {mode === 'view' && (
        <ImagesBlock images={page.pageImages ?? []} heroUrl={page.heroImageUrl ?? null} />
      )}
      {mode === 'view' && (
        <LinksBlock links={page.pageLinks ?? []} />
      )}
      {mode === 'view' && (
        <AttachmentsBlock attachments={page.pageAttachments ?? []} />
      )}
      {mode === 'view' && (
        <SourcesSection
          citations={page.citations ?? {}}
          sourceEmailIds={page.sourceEmailIds ?? []}
        />
      )}
      {mode === 'view' && <Provenance page={page} />}

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
                    {r.model && (
                      <>
                        {' '}·{' '}
                        <code className="rounded bg-ink-100 px-1 text-[10px] dark:bg-ink-800">
                          {r.model}
                        </code>
                      </>
                    )}
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

  // Group consecutive sources from the same sender into a single
  // expandable row. On a notification-stream page where 25/26
  // messages come from "Acme Marketing" this collapses 25 nearly-
  // identical entries into one "25 messages from Acme (May 1 –
  // May 5)" row, with the individual subjects available on click.
  // Cited sources (the ones the LLM linked into the body) are
  // never collapsed — those are footnote references and need to
  // remain individually addressable for [eN] anchors to resolve.
  type Group = {
    sender: string;
    cited: { label: string; data: Citation }[];
    uncited: { label: string; data: Citation }[];
  };
  const groups: Group[] = [];
  for (const item of all) {
    const sender = item.data.from ?? 'unknown sender';
    const last = groups[groups.length - 1];
    const isCited = item.label.startsWith('e');
    if (last && last.sender === sender) {
      (isCited ? last.cited : last.uncited).push(item);
    } else {
      groups.push({
        sender,
        cited: isCited ? [item] : [],
        uncited: isCited ? [] : [item],
      });
    }
  }

  return (
    <CountedSection
      icon={<Mail className="h-4 w-4 text-rose-500" />}
      title="Sources"
      count={all.length}
      collapseAt={8}
    >
      <ol className="space-y-2 text-sm">
        {groups.map((g, idx) => (
          <SourceGroup key={`${g.sender}-${idx}`} group={g} />
        ))}
      </ol>
    </CountedSection>
  );
}

function SourceGroup({
  group,
}: {
  group: {
    sender: string;
    cited: { label: string; data: Citation }[];
    uncited: { label: string; data: Citation }[];
  };
}) {
  const totalUncited = group.uncited.length;
  const dates = group.uncited
    .map((s) => (s.data.date ? new Date(s.data.date) : null))
    .filter((d): d is Date => !!d);
  let dateRange = '';
  if (dates.length) {
    const lo = new Date(Math.min(...dates.map((d) => d.getTime())));
    const hi = new Date(Math.max(...dates.map((d) => d.getTime())));
    const fmt = (d: Date) => d.toLocaleDateString();
    dateRange = fmt(lo) === fmt(hi) ? fmt(lo) : `${fmt(lo)} – ${fmt(hi)}`;
  }

  return (
    <>
      {/* Cited rows always render expanded — they're footnote anchors. */}
      {group.cited.map(({ label, data: c }) => (
        <SourceRow key={label} label={label} data={c} />
      ))}
      {/* Uncited rows: roll up runs of >2 from the same sender. */}
      {totalUncited > 2 ? (
        <li className="rounded-lg border border-ink-200 dark:border-ink-800">
          <details>
            <summary className="flex cursor-pointer items-center gap-2 p-2 hover:bg-ink-50 dark:hover:bg-ink-900">
              <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-semibold text-ink-600 dark:bg-ink-800 dark:text-ink-300">
                ×{totalUncited}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{group.sender}</div>
                {dateRange && (
                  <div className="text-xs text-ink-500">{dateRange}</div>
                )}
              </div>
              <ChevronDown className="h-4 w-4 text-ink-400 transition-transform [details[open]_&]:rotate-180" />
            </summary>
            <ol className="space-y-2 px-2 pb-2 pt-1">
              {group.uncited.map(({ label, data: c }) => (
                <SourceRow key={label} label={label} data={c} hideSender />
              ))}
            </ol>
          </details>
        </li>
      ) : (
        group.uncited.map(({ label, data: c }) => (
          <SourceRow key={label} label={label} data={c} />
        ))
      )}
    </>
  );
}

function SourceRow({
  label,
  data: c,
  hideSender = false,
}: {
  label: string;
  data: Citation;
  hideSender?: boolean;
}) {
  const isCited = label.startsWith('e');
  return (
    <li
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
          {!hideSender && (
            <div className="text-xs text-ink-500">
              {c.from ?? 'unknown sender'}
              {c.date && (
                <>
                  {' · '}
                  {new Date(c.date).toLocaleString()}
                </>
              )}
            </div>
          )}
          {hideSender && c.date && (
            <div className="text-xs text-ink-500">{new Date(c.date).toLocaleString()}</div>
          )}
        </div>
        <Link
          to={`/e/${c.emailId}`}
          className="btn-ghost text-xs"
          title="Open the original email"
        >
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
    </li>
  );
}

/**
 * Provenance footer — credits the LLM that produced the current contentMd
 * (provider:model + when), notes contributing source counts, and links to
 * any pages the entry was synthesised from. Always rendered for transparency
 * about data lineage even on hand-edited pages (the badge flips to "Human").
 */
function Provenance({ page }: { page: PageDoc }) {
  const by = page.generatedBy ?? null;
  const model = page.generationModel ?? null;
  const at = page.generatedAt ?? page.updatedAt;
  const sourceCount = page.sourceEmailIds?.length ?? 0;
  const synthCount = page.synthesisOf?.length ?? 0;

  // Friendly labels per author kind. Falls back to a generic "AI-generated"
  // for legacy rows where we don't yet know who wrote it.
  const label =
    by === 'llm'
      ? 'Generated by'
      : by === 'synth'
        ? 'Synthesised by'
        : by === 'briefing'
          ? 'Briefing written by'
          : by === 'human'
            ? 'Last edited by you'
            : 'AI-generated';

  const badgeClass =
    by === 'human'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
      : 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300';

  return (
    <aside className="mt-6 rounded-lg border border-ink-200 bg-ink-50 px-4 py-3 text-xs dark:border-ink-800 dark:bg-ink-900">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 font-medium ${badgeClass}`}>
          {label}
        </span>
        {model && by !== 'human' && (
          <code className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] dark:bg-ink-800">
            {model}
          </code>
        )}
        {at && (
          <span className="text-ink-500">
            on {new Date(at).toLocaleString()}
          </span>
        )}
        <span className="text-ink-500">· v{page.version ?? 1}</span>
      </div>
      <div className="text-ink-500">
        {sourceCount > 0 && (
          <>
            Drew from {sourceCount} email{sourceCount === 1 ? '' : 's'}
          </>
        )}
        {sourceCount > 0 && synthCount > 0 && ' · '}
        {synthCount > 0 && (
          <>
            Synthesised from {synthCount} other page{synthCount === 1 ? '' : 's'}
          </>
        )}
        {sourceCount === 0 && synthCount === 0 && (
          <>No upstream sources recorded.</>
        )}
      </div>
      <p className="mt-1 italic text-ink-500">
        Always verify AI-generated information against the original sources before
        relying on it.
      </p>
    </aside>
  );
}

/** Header strip that explains why this page exists: senders, threads, mode. */
function Attribution({ page }: { page: PageDoc }) {
  const senders = page.senderAddresses ?? [];
  const threadCount = page.threadKeys?.length ?? 0;
  const emailCount = page.sourceEmailIds?.length ?? 0;
  const templateCount = page.subjectTemplates?.length ?? 0;
  // Prefer the persisted flag from the worker; fall back to the heuristic
  // for pages that pre-date the flag.
  const isStream =
    page.flags?.isNotificationStream === true ||
    (templateCount > 0 && emailCount >= 3 && templateCount <= 2);
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
          {senders.slice(0, 3).map((s) => {
            const brand = page.senderBrands?.[s];
            const label = brand?.name ?? s;
            const inner = (
              <>
                {brand?.logoUrl && (
                  <img
                    src={brand.logoUrl}
                    alt=""
                    className="h-3 w-3 rounded-sm bg-white object-contain ring-1 ring-ink-200 dark:ring-ink-700"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                    }}
                  />
                )}
                <span>{label}</span>
              </>
            );
            return brand ? (
              <Link
                key={s}
                to={`/s/${encodeURIComponent(brand.brandKey)}`}
                className="inline-flex items-center gap-1 rounded bg-ink-100 px-1 py-0.5 text-[10px] hover:bg-rose-100 hover:text-rose-700 dark:bg-ink-800 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
                title={`Open ${label}'s address-book entry`}
              >
                {inner}
              </Link>
            ) : (
              <code
                key={s}
                className="rounded bg-ink-100 px-1 py-0.5 text-[10px] dark:bg-ink-800"
              >
                {s}
              </code>
            );
          })}
          {senders.length > 3 && <span>+{senders.length - 3} more</span>}
        </span>
      )}
      {(page.version ?? 1) > 1 && (
        <span className="text-ink-500">· updated {page.version} times</span>
      )}
    </div>
  );
}

function PageBanners({ page }: { page: PageDoc }) {
  const flags = page.flags ?? {};
  const score = page.spamScore ?? 0;
  return (
    <div className="mt-2 flex flex-wrap gap-2 text-xs">
      {page.priority === 'high' && (
        <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 font-medium text-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
          <Flame className="h-3 w-3" /> High priority
        </span>
      )}
      {flags.userMarkedSpam && (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-800 dark:bg-red-950/40 dark:text-red-200"
          title="You marked this page as spam — hidden from the digest."
        >
          <Ban className="h-3 w-3" /> Marked spam
        </span>
      )}
      {flags.hasLikelySpam && !flags.userMarkedSpam && (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-800 dark:bg-red-950/40 dark:text-red-200"
          title={`Likely-spam score: ${Math.round(score * 100)}%`}
        >
          <ShieldAlert className="h-3 w-3" /> Likely spam · {Math.round(score * 100)}%
        </span>
      )}
      {flags.hasMassMailing && !flags.hasLikelySpam && (
        <span className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-ink-700 dark:bg-ink-800 dark:text-ink-200">
          <Megaphone className="h-3 w-3" /> Bulk mail
        </span>
      )}
      {flags.isSparse && (
        <span
          className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          title="Source emails had little or no body content; this page is metadata-only."
        >
          metadata-only
        </span>
      )}
    </div>
  );
}

function TopicsBlock({ topics }: { topics: string[] }) {
  if (!topics.length) return null;
  return (
    <section className="card mt-6">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <TagIcon className="h-4 w-4 text-rose-500" />
        Topics
      </h2>
      <div className="flex flex-wrap gap-1.5">
        {topics.map((t) => (
          <Link
            key={t}
            to={`/t/${encodeURIComponent(t)}`}
            className="pill hover:bg-rose-100 hover:text-rose-800 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
          >
            {t}
          </Link>
        ))}
      </div>
    </section>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Card-shaped section with a count badge that auto-collapses into a
 * `<details>` when item count crosses `collapseAt`. Replaces the
 * previous "every reference section is visually equal-weighted"
 * layout — a 3-topic page no longer renders the same surface area as
 * a 30-source notification stream.
 */
function CountedSection({
  icon,
  title,
  count,
  collapseAt,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  collapseAt: number;
  children: React.ReactNode;
}) {
  const collapsed = count > collapseAt;
  const header = (
    <span className="flex items-center gap-2 text-sm font-semibold">
      {icon}
      {title} ({count})
    </span>
  );
  if (!collapsed) {
    return (
      <section className="card mt-6">
        <h2 className="mb-3">{header}</h2>
        {children}
      </section>
    );
  }
  return (
    <section className="card mt-6">
      <details>
        <summary className="flex cursor-pointer items-center justify-between text-sm font-semibold hover:text-rose-700 dark:hover:text-rose-300">
          {header}
          <ChevronDown className="h-4 w-4 transition-transform [details[open]_&]:rotate-180" />
        </summary>
        <div className="mt-3">{children}</div>
      </details>
    </section>
  );
}

/**
 * Hosts that almost always represent tracking, click-redirects, or
 * unsubscribe plumbing rather than the article/content URL the user
 * cares about. Match is on hostname, not the full URL — works for
 * both `t.co/abc` and `r.email.acme.com/click/...`. Demoting these
 * into a secondary bucket reclaims the Links list for actual content.
 */
const TRACKING_HOST_PATTERNS: RegExp[] = [
  /^t\.co$/,
  /^bit\.ly$/,
  /^tinyurl\.com$/,
  /^lnkd\.in$/,
  /^ow\.ly$/,
  /^buff\.ly$/,
  /^mailchi\.mp$/,
  /^mandrillapp\.com$/,
  /(^|\.)sendgrid\.net$/,
  /(^|\.)sg\.send$/,
  /(^|\.)mktoresp\.com$/,
  /(^|\.)hsforms\.com$/,
  /(^|\.)hubspotemail\.net$/,
  /^r\..+\..+/,
  /^link\..+\..+/,
  /^click\..+\..+/,
  /^track(ing)?\..+\..+/,
  /^ct\..+\..+/,
  /^email\..+\..+/,
  /^e\..+\..+/,
];

function isTrackingHost(host: string): boolean {
  const h = host.toLowerCase();
  return TRACKING_HOST_PATTERNS.some((re) => re.test(h));
}

function isUnsubscribeUrl(url: string): boolean {
  return /\b(unsubscribe|opt[-_]?out|preferences|email[-_]?settings)\b/i.test(url);
}

type LinkRow = { url: string; text?: string | null; count: number };

/**
 * Group a flat link list by hostname so 12 separate "example.com/foo"
 * rows from one tracking-template digest collapse into a single
 * `example.com (×12)` group with the per-URL rows nested underneath.
 * Sorts groups by total count desc so the heaviest hosts surface first.
 */
function groupByHost(links: LinkRow[]): { host: string; total: number; rows: LinkRow[] }[] {
  const map = new Map<string, LinkRow[]>();
  for (const l of links) {
    const h = hostOf(l.url);
    const arr = map.get(h) ?? [];
    arr.push(l);
    map.set(h, arr);
  }
  return [...map.entries()]
    .map(([host, rows]) => ({
      host,
      total: rows.reduce((s, r) => s + r.count, 0),
      rows: rows.sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.total - a.total);
}

function LinkLi({ link }: { link: LinkRow }) {
  return (
    <li className="flex items-start gap-2">
      <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-400" />
      <a
        href={link.url}
        target="_blank"
        rel="noreferrer"
        className="min-w-0 flex-1 truncate text-rose-600 hover:underline dark:text-rose-400"
        title={link.url}
      >
        {link.text || link.url}
      </a>
      {link.count > 1 && (
        <span
          className="shrink-0 rounded bg-ink-100 px-1 text-[10px] text-ink-600 dark:bg-ink-800 dark:text-ink-300"
          title={`Appeared in ${link.count} source emails`}
        >
          ×{link.count}
        </span>
      )}
    </li>
  );
}

function LinksBlock({ links }: { links: LinkRow[] }) {
  if (!links.length) return null;

  // Two-bucket split: content links surface, tracking/unsubscribe
  // links go into a collapsed sub-list at the bottom. The user's
  // complaint was that mailing-list infrastructure URLs drown out
  // real content links; this is the fix.
  const content: LinkRow[] = [];
  const utility: LinkRow[] = [];
  for (const l of links) {
    const host = hostOf(l.url);
    if (isTrackingHost(host) || isUnsubscribeUrl(l.url)) utility.push(l);
    else content.push(l);
  }
  const contentGroups = groupByHost(content);

  return (
    <CountedSection
      icon={<LinkIcon className="h-4 w-4 text-rose-500" />}
      title="Links"
      count={links.length}
      collapseAt={5}
    >
      <ul className="space-y-3 text-sm">
        {contentGroups.map((g) => (
          <li key={g.host}>
            <div className="mb-1 flex items-center gap-2 text-xs uppercase tracking-wider text-ink-500">
              <span>{g.host}</span>
              {g.rows.length > 1 && (
                <span className="rounded bg-ink-100 px-1 text-[10px] dark:bg-ink-800">
                  {g.rows.length} link{g.rows.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <ul className="space-y-1 pl-1">
              {g.rows.slice(0, 8).map((r) => (
                <LinkLi key={r.url} link={r} />
              ))}
              {g.rows.length > 8 && (
                <li className="pl-5 text-xs italic text-ink-500">
                  +{g.rows.length - 8} more on {g.host}
                </li>
              )}
            </ul>
          </li>
        ))}
      </ul>

      {utility.length > 0 && (
        <details className="mt-4 border-t border-ink-200 pt-3 dark:border-ink-800">
          <summary className="cursor-pointer text-xs text-ink-500 hover:text-rose-600 dark:hover:text-rose-300">
            Tracking & utility links ({utility.length})
          </summary>
          <ul className="mt-2 space-y-1 text-xs">
            {utility.slice(0, 50).map((l) => (
              <li key={l.url} className="flex items-start gap-2">
                <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-ink-400" />
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-ink-500 hover:text-rose-600 dark:hover:text-rose-300"
                  title={l.url}
                >
                  {hostOf(l.url)}
                  {isUnsubscribeUrl(l.url) ? ' · unsubscribe' : ''}
                </a>
                {l.count > 1 && (
                  <span className="shrink-0 text-[10px] text-ink-400">×{l.count}</span>
                )}
              </li>
            ))}
            {utility.length > 50 && (
              <li className="text-ink-400">+{utility.length - 50} more</li>
            )}
          </ul>
        </details>
      )}
    </CountedSection>
  );
}

function formatBytesPg(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

function AttachmentsBlock({
  attachments,
}: {
  attachments: { filename: string; contentType: string; size: number; fromEmailId: string }[];
}) {
  if (!attachments.length) return null;
  return (
    <CountedSection
      icon={<Paperclip className="h-4 w-4 text-rose-500" />}
      title="Attachments"
      count={attachments.length}
      collapseAt={5}
    >
      <ul className="space-y-1.5 text-sm">
        {attachments.map((a, i) => (
          <li key={`${a.fromEmailId}-${a.filename}-${i}`} className="flex items-center gap-2">
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-ink-400" />
            <span className="min-w-0 flex-1 truncate font-medium">{a.filename}</span>
            <span className="shrink-0 text-xs text-ink-500">{a.contentType}</span>
            <span className="shrink-0 text-xs text-ink-400">{formatBytesPg(a.size)}</span>
            <Link
              to={`/e/${a.fromEmailId}`}
              className="btn-ghost text-xs"
              title="Open the original email"
            >
              <ExternalLink className="h-3 w-3" />
            </Link>
          </li>
        ))}
      </ul>
    </CountedSection>
  );
}

function SpamMenu({ page }: { page: PageDoc }) {
  const api = useApi();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const isMarked = !!page.flags?.userMarkedSpam;

  const markPage = useMutation({
    mutationFn: async () =>
      api.post<{ ok: true }>(`/api/spam/page/${page._id}`),
    onSuccess: () => {
      toast.success('Page marked as spam — hidden from the digest.');
      qc.invalidateQueries({ queryKey: ['page'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const unmarkPage = useMutation({
    mutationFn: async () =>
      api.del<{ ok: true }>(`/api/spam/page/${page._id}`),
    onSuccess: () => {
      toast.success('Page unmarked.');
      qc.invalidateQueries({ queryKey: ['page'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const blockSender = useMutation({
    mutationFn: async (address: string) =>
      api.post<{ pagesAffected: number }>('/api/spam/sender', { address }),
    onSuccess: (r) => {
      toast.success(
        `Blocked sender — ${r.pagesAffected} page${r.pagesAffected === 1 ? '' : 's'} marked as spam.`,
      );
      qc.invalidateQueries({ queryKey: ['page'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
      qc.invalidateQueries({ queryKey: ['spam'] });
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const blockTag = useMutation({
    mutationFn: async (tag: string) =>
      api.post<{ pagesAffected: number }>('/api/spam/tag', { tag }),
    onSuccess: (r) => {
      toast.success(
        `Blocked tag — ${r.pagesAffected} page${r.pagesAffected === 1 ? '' : 's'} marked as spam.`,
      );
      qc.invalidateQueries({ queryKey: ['page'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
      qc.invalidateQueries({ queryKey: ['spam'] });
      setOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="relative">
      <button
        className="btn-ghost"
        onClick={() => setOpen((s) => !s)}
        aria-label="Spam controls"
        title="Spam / blocklist controls"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-1 w-64 rounded-xl border border-ink-200 bg-white p-1 text-sm shadow-soft dark:border-ink-800 dark:bg-ink-900">
            {isMarked ? (
              <button
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-ink-100 dark:hover:bg-ink-800"
                onClick={() => unmarkPage.mutate()}
                disabled={unmarkPage.isPending}
              >
                <CheckSquare className="h-4 w-4 text-emerald-600" />
                Unmark this page
              </button>
            ) : (
              <button
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-ink-100 dark:hover:bg-ink-800"
                onClick={() => markPage.mutate()}
                disabled={markPage.isPending}
              >
                <Ban className="h-4 w-4 text-red-600" />
                Mark this page as spam
              </button>
            )}
            {(page.senderAddresses ?? []).length > 0 && (
              <>
                <div className="my-1 border-t border-ink-200 dark:border-ink-800" />
                <div className="px-2 py-1 text-[10px] uppercase tracking-widest text-ink-500">
                  Block senders
                </div>
                {(page.senderAddresses ?? []).map((s) => (
                  <button
                    key={s}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-ink-100 dark:hover:bg-ink-800"
                    onClick={() => blockSender.mutate(s)}
                  >
                    <UserX className="h-4 w-4 shrink-0 text-red-600" />
                    <code className="truncate text-xs">{s}</code>
                  </button>
                ))}
              </>
            )}
            {(page.tags ?? []).length > 0 && (
              <>
                <div className="my-1 border-t border-ink-200 dark:border-ink-800" />
                <div className="px-2 py-1 text-[10px] uppercase tracking-widest text-ink-500">
                  Block tags
                </div>
                {(page.tags ?? []).slice(0, 6).map((t) => (
                  <button
                    key={t}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-ink-100 dark:hover:bg-ink-800"
                    onClick={() => blockTag.mutate(t)}
                  >
                    <TagXIcon className="h-4 w-4 shrink-0 text-red-600" />
                    <span>#{t}</span>
                  </button>
                ))}
              </>
            )}
            <div className="my-1 border-t border-ink-200 dark:border-ink-800" />
            <Link
              to="/settings/spam"
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800"
              onClick={() => setOpen(false)}
            >
              <ShieldAlert className="h-4 w-4" />
              Manage spam policy…
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function HeroImage({ url, alt }: { url: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <div className="-mt-2 mb-6 overflow-hidden rounded-2xl border border-ink-200 bg-ink-50 dark:border-ink-800 dark:bg-ink-900">
      <img
        src={url}
        alt={alt}
        className="block max-h-80 w-full object-cover"
        loading="eager"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function ImagesBlock({
  images,
  heroUrl,
}: {
  images: {
    url: string;
    alt?: string | null;
    description?: string | null;
    count: number;
    fromEmailId?: string;
  }[];
  heroUrl: string | null;
}) {
  const rest = images.filter((i) => i.url !== heroUrl);
  if (rest.length === 0) return null;
  return (
    <CountedSection
      icon={<ImageIcon className="h-4 w-4 text-rose-500" />}
      title="Images"
      count={images.length}
      collapseAt={6}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {rest.slice(0, 16).map((img) => (
          <Thumb key={img.url} {...img} />
        ))}
      </div>
    </CountedSection>
  );
}

function Thumb({
  url,
  alt,
  description,
  fromEmailId,
}: {
  url: string;
  alt?: string | null;
  description?: string | null;
  count?: number;
  fromEmailId?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  // Vision-derived description wins as the title (most useful hover);
  // alt falls back to it for accessibility.
  const tooltip = description || alt || url;
  const inner = (
    <div className="aspect-video overflow-hidden rounded-lg border border-ink-200 bg-ink-50 dark:border-ink-800 dark:bg-ink-900">
      <img
        src={url}
        alt={alt || description || ''}
        title={tooltip}
        className="block h-full w-full object-cover transition-transform group-hover:scale-105"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </div>
  );
  return fromEmailId ? (
    <Link to={`/e/${fromEmailId}`} className="group block" title={tooltip}>
      {inner}
    </Link>
  ) : (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="group block"
      title={alt ?? url}
    >
      {inner}
    </a>
  );
}
