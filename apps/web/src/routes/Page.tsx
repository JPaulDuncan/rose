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
  Sparkles,
  MapPin as MapPinIcon,
  GitMerge,
  X as XIcon,
  User as UserIcon,
  Film,
  Building2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApi } from '../lib/api';
import { adapterLabel } from '../lib/sourceLabel';
import { ShareButton } from '../components/ShareButton';
import { FavoriteButton } from '../components/FavoriteButton';
import { MapInset, type MapPin } from '../components/MapInset';

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
  /** Plan: long-running topic pages run incrementally — new emails
   *  get folded into the existing prose instead of rewriting it. */
  generationMode?: 'rebuild' | 'incremental';
  primaryTopic?: string | null;
  topicAliases?: string[];
  citations?: Record<string, Citation>;
  sourceEmailIds?: string[];
  synthesisOf?: string[];
  generationModel?: string | null;
  generatedAt?: string | null;
  generatedBy?: 'llm' | 'synth' | 'briefing' | 'human' | null;
  priority?: 'high' | 'normal' | 'low';
  priorityOverride?: boolean;
  articleDate?: string | null;
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
  /** Plan 11 — extracted + geocoded place entities. Renders as a
   *  small map inset in the right rail when at least one entry
   *  has lat/lon. */
  places?: {
    name: string;
    normKey: string;
    lat: number | null;
    lon: number | null;
    displayName: string | null;
    geocodedAt: string | null;
    failed: boolean;
  }[];
  /** Named entities — people, works, organizations — extracted
   *  from the page body. Each gets auto-linked in prose to
   *  `/n/<normKey>` and surfaced in the right-rail Mentions card. */
  entities?: {
    name: string;
    normKey: string;
    type: 'person' | 'work' | 'organization';
    displayName: string;
  }[];
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
  /** Map of canonical kebab tag → human display name; populated by
   *  the API for every tag on the page. UI substitutes this for the
   *  raw kebab form on every pill that renders a tag. */
  tagDisplayNames?: Record<string, string>;
  /** Live (non-dismissed) merge suggestions surfaced to the user as a
   *  "Potential duplicate of …" banner above the page body. */
  mergeSuggestions?: {
    pageId: string;
    score: number;
    reason: string;
    suggestedAt: string | null;
    title: string;
    slug: string;
    summary: string;
  }[];
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
        Placeholder.configure({ placeholder: 'Write your article in markdown…' }),
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
    <div className="mx-auto w-full max-w-8xl px-6 py-10">
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
                    title={`See all #${t}`}
                  >
                    {displayTag(t, page.tagDisplayNames)}
                  </Link>
                ),
            )}
            <span className="text-xs text-ink-400">
              v{page.version} ·{' '}
              {new Date(page.articleDate ?? page.updatedAt).toLocaleString()}
              {page.articleDate && (
                <span className="ml-1 text-ink-500">(article date)</span>
              )}
            </span>
          </div>
          {mode === 'view' && <Attribution page={page} />}
          {mode === 'view' && <MergeBanner page={page} />}
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
          {mode === 'view' && page && (
            <PriorityControl
              pageId={page._id}
              priority={page.priority ?? 'normal'}
              priorityOverride={page.priorityOverride ?? false}
            />
          )}
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

      {mode === 'view' ? (
        // `minmax(0, …fr)` rather than `7fr_3fr` is load-bearing — bare
        // `fr` resolves to `minmax(auto, 1fr)` which lets a long
        // unbreakable token (a tracking URL, an image filename) in
        // the rail override the ratio and squeeze the article column.
        <div className="mt-2 grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
          {/* Left column (~70%) — hero, body, sources, background, provenance.
              The hero floats inside the article so text wraps newspaper-
              style around its native dimensions. */}
          <div className="min-w-0 space-y-6">
            {/* `flow-root` establishes a new block formatting context
                so the floated hero is contained — without it, a tall
                portrait image extends past the body text and overlaps
                the Sources card sitting underneath. */}
            <article className="card prose prose-rose max-w-none flow-root dark:prose-invert">
              {page.heroImageUrl && <FloatedHero url={page.heroImageUrl} alt={page.title} />}
              <MarkdownWithCitations
                md={page.contentMd}
                citations={page.citations ?? {}}
                tags={page.tags ?? []}
                topics={page.topics ?? []}
                entities={page.entities ?? []}
                places={page.places ?? []}
              />
            </article>
            <SourcesSection
              citations={page.citations ?? {}}
              sourceEmailIds={page.sourceEmailIds ?? []}
            />
            <BackgroundPanel pageId={page._id} />
            <RelatedArticles pageId={page._id} />
            <Provenance page={page} />
          </div>
          {/* Right column (~30%) — reference cards: topics, images, links,
              attachments. Sticky at top so they stay in view when the
              body scrolls past them. */}
          <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
            <PlacesCard places={page.places ?? []} />
            <MentionsCard entities={page.entities ?? []} />
            <TopicsBlock topics={page.topics ?? []} />
            <ImagesBlock
              images={page.pageImages ?? []}
              heroUrl={page.heroImageUrl ?? null}
            />
            <LinksBlock links={page.pageLinks ?? []} />
            <AttachmentsBlock attachments={page.pageAttachments ?? []} />
          </aside>
        </div>
      ) : (
        <article className="card prose prose-rose mt-2 max-w-none dark:prose-invert">
          <EditorContent editor={editor} />
        </article>
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
/**
 * One match record produced by the auto-linker's compiled regex.
 * The `route` decides what page we link to; `target` is the slug
 * to URL-encode.
 */
type LinkSpec = {
  /** Lowercased phrase used as the regex alternative. */
  phrase: string;
  route: 'tag' | 'entity';
  target: string;
  /** What we render the link as when caller displays it (currently
   *  unused — we render the matched text verbatim, matching the
   *  prior tag behavior, but kept around for future "show
   *  displayName instead" tweaks). */
  display?: string;
  /** Tooltip override. */
  title?: string;
};

/**
 * Auto-link compiled regex + lookup. The lookup is keyed on the
 * lowercased matched phrase (with optional trailing 's' stripped)
 * so plural matching for tags continues to work without crossing
 * over into entity matching.
 */
type Linker = {
  re: RegExp;
  lookup: Map<string, LinkSpec>;
};

function buildLinker(args: {
  tags?: string[];
  topics?: string[];
  entities?: PageDoc['entities'];
  places?: PageDoc['places'];
}): Linker | null {
  const lookup = new Map<string, LinkSpec>();
  const phrases = new Set<string>();
  const add = (rawPhrase: string, spec: LinkSpec) => {
    const phrase = rawPhrase.trim().toLowerCase();
    if (!phrase || phrase.length < 3) return;
    if (lookup.has(phrase)) return; // first one wins; entities are added before tags
    lookup.set(phrase, spec);
    phrases.add(phrase);
  };
  // Entities first so a tag that happens to share a phrase with an
  // entity defers to the more specific link target. Places get
  // routed through /n/<normKey> too — the entity page knows how to
  // render places (map + page list).
  for (const e of args.entities ?? []) {
    add(e.displayName || e.name, {
      phrase: (e.displayName || e.name).toLowerCase(),
      route: 'entity',
      target: e.normKey,
      title: `Open ${e.displayName || e.name}`,
    });
  }
  for (const p of args.places ?? []) {
    add(p.name, {
      phrase: p.name.toLowerCase(),
      route: 'entity',
      target: p.normKey,
      title: `Open ${p.name}`,
    });
  }
  for (const t of [...new Set([...(args.tags ?? []), ...(args.topics ?? [])])]) {
    add(t, {
      phrase: t.trim().toLowerCase(),
      route: 'tag',
      target: t.trim().toLowerCase(),
      title: `See all #${t.trim().toLowerCase()}`,
    });
  }
  if (phrases.size === 0) return null;
  // Longest-first so "Wait Wait... Don't Tell Me!" beats "Wait
  // Wait" if both somehow show up. Each entry is regex-escaped.
  const sorted = [...phrases].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // `s?` keeps the existing pluralisation tolerance for tags
  // ("promotion" → matches "promotions"). Stripped on lookup so
  // entity matches stay exact.
  const re = new RegExp(`\\b(${escaped.join('|')})s?\\b`, 'gi');
  return { re, lookup };
}

function MarkdownWithCitations({
  md,
  citations,
  tags,
  topics,
  entities,
  places,
}: {
  md: string;
  citations: Record<string, Citation>;
  tags?: string[];
  topics?: string[];
  entities?: PageDoc['entities'];
  places?: PageDoc['places'];
}) {
  const linker = buildLinker({ tags, topics, entities, places });
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // ReactMarkdown passes raw text strings to this hook. We split on the
        // citation regex AND on auto-link mentions (tags / entities / places),
        // emitting a mix of plain text + citation chips + <Link>s.
        p: ({ children }) => (
          <p>{transformChildren(children, citations, linker)}</p>
        ),
        li: ({ children }) => (
          <li>{transformChildren(children, citations, linker)}</li>
        ),
      }}
    >
      {md}
    </ReactMarkdown>
  );
}

/**
 * Walk a text segment, splitting on the unified linker regex, and
 * convert whole-word mentions into <Link>s. Tags route to /t/<key>
 * (with the existing trailing-`s` plural tolerance); entities and
 * places route to /n/<normKey>. Lookup strips a trailing 's' before
 * checking — that way "promotions" matches the "promotion" tag but
 * not the "Promotion" entity.
 */
function autoLinkMentions(text: string, linker: Linker | null): React.ReactNode[] {
  if (!linker || !text) return [text];
  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  for (const match of text.matchAll(linker.re)) {
    const start = match.index ?? 0;
    if (start > lastIdx) out.push(text.slice(lastIdx, start));
    const word = match[0];
    const phraseLc = match[1]!.toLowerCase();
    // Try the exact phrase first, then the de-pluralised form.
    const spec =
      linker.lookup.get(phraseLc) ??
      (phraseLc.endsWith('s') ? linker.lookup.get(phraseLc.slice(0, -1)) : undefined);
    if (!spec) {
      // No spec for this exact match (shouldn't happen given how
      // the regex was built, but be defensive). Fall through to
      // emitting the raw text.
      out.push(word);
    } else if (spec.route === 'tag') {
      out.push(
        <Link
          key={`lt-${start}`}
          to={`/t/${encodeURIComponent(spec.target)}`}
          className="text-rose-700 underline-offset-2 hover:underline dark:text-rose-300"
          title={spec.title ?? `See all #${spec.target}`}
        >
          {word}
        </Link>,
      );
    } else {
      out.push(
        <Link
          key={`le-${start}`}
          to={`/n/${encodeURIComponent(spec.target)}`}
          className="text-rose-700 underline-offset-2 hover:underline decoration-dotted dark:text-rose-300"
          title={spec.title ?? word}
        >
          {word}
        </Link>,
      );
    }
    lastIdx = start + match[0].length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

function transformChildren(
  children: React.ReactNode,
  citations: Record<string, Citation>,
  linker: Linker | null,
): React.ReactNode {
  return Array.from(toArray(children)).flatMap((child, idx) => {
    if (typeof child !== 'string') return [child];
    const parts: React.ReactNode[] = [];
    let lastIdx = 0;
    for (const match of child.matchAll(CITATION_RE)) {
      const start = match.index ?? 0;
      if (start > lastIdx) {
        // The text segment between the previous citation and this
        // one gets passed through the auto-linker before being
        // flushed; the citation chip itself is opaque.
        parts.push(...autoLinkMentions(child.slice(lastIdx, start), linker));
      }
      const labels = match[1]!.split(',').map((s) => s.trim()).filter((s) => /^e\d+$/.test(s));
      parts.push(
        <CitationChip key={`${idx}-${start}`} labels={labels} citations={citations} />,
      );
      lastIdx = start + match[0].length;
    }
    if (lastIdx < child.length) {
      parts.push(...autoLinkMentions(child.slice(lastIdx), linker));
    }
    return parts.length ? parts : autoLinkMentions(child, linker);
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

  const senderCount = new Set(groups.map((g) => g.sender)).size;
  const dates = all
    .map((s) => (s.data.date ? new Date(s.data.date).getTime() : NaN))
    .filter((t) => Number.isFinite(t));
  const dateRange = (() => {
    if (dates.length === 0) return null;
    const min = new Date(Math.min(...dates));
    const max = new Date(Math.max(...dates));
    const fmt = (d: Date) =>
      d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return min.toDateString() === max.toDateString() ? fmt(min) : `${fmt(min)} – ${fmt(max)}`;
  })();
  const summary = `Compiled from ${all.length} ${all.length === 1 ? 'email' : 'emails'} across ${senderCount} ${senderCount === 1 ? 'sender' : 'senders'}${dateRange ? `, ${dateRange}` : ''}.`;

  return (
    <CountedSection
      icon={<Mail className="h-4 w-4 text-rose-500" />}
      title="Sources cited"
      count={all.length}
      collapseAt={8}
    >
      <p className="mb-3 text-xs italic text-ink-500">{summary}</p>
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

type DaydreamNoteView = {
  _id: string;
  kind: 'topic' | 'sender' | 'tag' | 'entity';
  subjectKey: string;
  displayName: string;
  summary: string;
  bodyMd: string;
  sources: { adapter: string; url: string; title: string; fetchedAt: string | null }[];
  confidence: 'low' | 'medium' | 'high';
  model: string | null;
  generatedAt: string | null;
  failed: boolean;
  failureReason: string | null;
};

/**
 * Daydream-supplied encyclopedic context. Renders a CountedSection with
 * one card per researched subject, each showing the LLM's short summary,
 * the source attribution (with click-through), and a refresh / forget
 * menu. Failed notes are shown too so the user can see why a subject
 * didn't produce content. Returns null when daydream is off, hasn't yet
 * produced anything for this page, or the user hasn't opted in.
 */
function BackgroundPanel({ pageId }: { pageId: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['daydream-notes', pageId],
    queryFn: () =>
      api.get<{ notes: DaydreamNoteView[] }>(`/api/pages/${pageId}/daydream`),
  });
  const force = useMutation({
    mutationFn: async () =>
      api.post<{ jobId: string }>(`/api/pages/${pageId}/daydream`),
    onSuccess: () => {
      toast.success('Daydream queued — refresh in a moment');
      void setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['daydream-notes', pageId] });
      }, 5000);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const forget = useMutation({
    mutationFn: async (id: string) =>
      api.del<{ ok: true }>(`/api/daydream/notes/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['daydream-notes', pageId] });
    },
  });
  const notes = data?.notes ?? [];
  if (notes.length === 0) {
    // Nothing yet — render a single tiny "Daydream now" affordance so
    // the user can opt-in without leaving the page.
    return (
      <section className="mt-6 flex items-center justify-between rounded-lg border border-dashed border-ink-200 bg-ink-50 px-4 py-2 text-xs dark:border-ink-800 dark:bg-ink-900">
        <span className="text-ink-500">
          ✨ <em>Background</em> — encyclopedic context for this page's
          topics. Empty so far.
        </span>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => force.mutate()}
          disabled={force.isPending}
          title="Force a daydream pass — needs daydream enabled in Settings → Daydream"
        >
          Daydream now
        </button>
      </section>
    );
  }

  return (
    <CountedSection
      icon={<Sparkles className="h-4 w-4 text-rose-500" />}
      title="Background"
      count={notes.length}
      collapseAt={4}
    >
      <div className="space-y-3">
        {notes.map((n) => (
          <DaydreamNoteCard
            key={n._id}
            note={n}
            onForget={() => forget.mutate(n._id)}
          />
        ))}
        <div className="flex justify-end">
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => force.mutate()}
            disabled={force.isPending}
          >
            Refresh all
          </button>
        </div>
      </div>
    </CountedSection>
  );
}

function DaydreamNoteCard({
  note,
  onForget,
}: {
  note: DaydreamNoteView;
  onForget: () => void;
}) {
  const conf = note.confidence;
  const confCls =
    conf === 'high'
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
      : conf === 'medium'
        ? 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
        : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300';
  return (
    <div className="rounded-lg border border-ink-200 bg-white p-3 text-sm dark:border-ink-800 dark:bg-ink-950">
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <span className="text-xs italic text-ink-500">{note.kind}</span>
        <h3 className="font-serif text-base font-semibold leading-snug">
          {note.displayName || note.subjectKey}
        </h3>
        {!note.failed && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${confCls}`}>
            {conf}
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            if (confirm(`Forget background note for "${note.displayName || note.subjectKey}"?`))
              onForget();
          }}
          className="ml-auto text-xs text-ink-400 hover:text-red-600"
          title="Forget — daydream may re-research it later"
        >
          Forget
        </button>
      </div>
      {note.failed ? (
        <p className="text-xs italic text-ink-500">
          No background found{note.failureReason ? `: ${note.failureReason}` : ''}.
        </p>
      ) : (
        <>
          {note.summary && <p className="text-ink-700 dark:text-ink-200">{note.summary}</p>}
          {note.bodyMd && note.bodyMd !== note.summary && (
            <p className="mt-1 whitespace-pre-wrap text-xs text-ink-600 dark:text-ink-300">
              {note.bodyMd}
            </p>
          )}
        </>
      )}
      {note.sources.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
          {note.sources.map((s) => (
            <a
              key={s.url}
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded bg-ink-100 px-1.5 py-0.5 hover:text-rose-600 dark:bg-ink-800"
              title={s.title || s.url}
            >
              via {adapterLabel(s.adapter, s.url)}
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          ))}
          {note.generatedAt && (
            <span>· {new Date(note.generatedAt).toLocaleDateString()}</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Provenance footer — credits the LLM that produced the current contentMd
 * (provider:model + when), notes contributing source counts, and links to
 * any pages the entry was synthesized from. Always rendered for transparency
 * about data lineage even on hand-edited pages (the badge flips to "Human").
 */

type RelatedPage = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  heroImageUrl: string | null;
  tags: string[];
  updatedAt: string;
  score: number;
};

/**
 * "Related Articles" — up to 5 articles with the highest cosine
 * similarity to this page's embedding. The endpoint applies the
 * floor (>= 0.55) so an empty list here means "nothing close
 * enough", which is correct UX (better silent than misleading).
 */
function RelatedArticles({ pageId }: { pageId: string }) {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['page-related', pageId],
    queryFn: () =>
      api.get<{ related: RelatedPage[] }>(`/api/pages/${pageId}/related`),
    staleTime: 5 * 60_000,
  });
  if (isLoading) return null;
  const related = data?.related ?? [];
  if (related.length === 0) return null;
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-ink-500">
        Related Articles
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {related.map((p) => (
          <li key={p._id}>
            <Link
              to={`/p/${p.slug}`}
              className="group flex h-full gap-3 rounded-lg border border-ink-200 p-3 transition-colors hover:border-rose-300 dark:border-ink-800 dark:hover:border-rose-800"
            >
              {p.heroImageUrl && (
                <img
                  src={p.heroImageUrl}
                  alt=""
                  className="h-16 w-16 shrink-0 rounded border border-ink-200 bg-ink-50 object-cover dark:border-ink-700 dark:bg-ink-900"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                  }}
                />
              )}
              <div className="min-w-0 flex-1">
                <h3 className="font-serif text-sm font-semibold leading-snug group-hover:text-rose-700 dark:group-hover:text-rose-300">
                  {p.title}
                </h3>
                {p.summary && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-ink-600 dark:text-ink-300">
                    {p.summary}
                  </p>
                )}
                {p.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1 text-[10px] uppercase tracking-widest text-ink-400">
                    {p.tags.slice(0, 3).map((t) => (
                      <span key={t}>#{t}</span>
                    ))}
                  </div>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

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
        ? 'Synthesized by'
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
            Synthesized from {synthCount} other page{synthCount === 1 ? '' : 's'}
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

/**
 * Convert a stored kebab-case tag (the canonical, what's in
 * `page.tags`) into the human-readable label the UI should render.
 * The API attaches `tagDisplayNames` to every page payload —
 * exhaustive over `page.tags`, with title-cased fallbacks for tags
 * the user hasn't customized yet. Falls back to `#<canonical>` when
 * the map is missing entirely.
 */
function displayTag(canonical: string, map?: Record<string, string>): string {
  if (!canonical) return canonical;
  const dn = map?.[canonical];
  return dn && dn.trim() ? dn : `#${canonical}`;
}

/**
 * "Potential duplicate of …" banner. Surfaced when the merge-detect
 * worker step has confirmed (via embedding pre-filter + LLM dedupe
 * check) that this page looks like a near-duplicate of one or more
 * existing pages. Each suggestion gets a Merge / Dismiss action.
 *
 * Merge is destructive — it folds this page's source emails into
 * the target, switches the target to topic+incremental mode,
 * enqueues a regeneration, and deletes this page. The confirm
 * dialog spells that out before firing.
 *
 * Dismiss is durable — the suggestion never reappears for the same
 * pair after a regeneration.
 */
function MergeBanner({ page }: { page: PageDoc }) {
  const api = useApi();
  const qc = useQueryClient();
  const suggestions = page.mergeSuggestions ?? [];
  const merge = useMutation({
    mutationFn: async (intoPageId: string) =>
      api.post<{ ok: true; targetSlug: string }>(`/api/pages/${page._id}/merge`, {
        intoPageId,
      }),
    onSuccess: (resp) => {
      toast.success('Merged — opening the consolidated page');
      qc.invalidateQueries({ queryKey: ['pages-recent'] });
      window.location.href = `/p/${resp.targetSlug}`;
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const dismiss = useMutation({
    mutationFn: async (targetId: string) =>
      api.del<{ ok: true }>(`/api/pages/${page._id}/merge-suggestions/${targetId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['page'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (suggestions.length === 0) return null;
  return (
    <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs dark:border-amber-900/40 dark:bg-amber-950/30">
      <div className="mb-1 flex items-center gap-2 font-medium text-amber-900 dark:text-amber-200">
        <GitMerge className="h-3.5 w-3.5" />
        {suggestions.length === 1
          ? 'Potential duplicate detected'
          : `${suggestions.length} potential duplicates detected`}
      </div>
      <ul className="space-y-1.5">
        {suggestions.map((s) => (
          <li
            key={s.pageId}
            className="flex items-start gap-2 rounded border border-amber-200/70 bg-white/60 px-2 py-1.5 dark:border-amber-900/30 dark:bg-amber-950/20"
          >
            <div className="min-w-0 flex-1">
              <Link
                to={`/p/${s.slug}`}
                className="font-medium text-amber-900 hover:underline dark:text-amber-200"
                title="Open the candidate page"
              >
                {s.title}
              </Link>
              {s.summary && (
                <div className="truncate text-amber-800/80 dark:text-amber-200/70">
                  {s.summary}
                </div>
              )}
              {s.reason && (
                <div className="italic text-amber-700/80 dark:text-amber-300/70">
                  {s.reason}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <span
                className="text-[10px] text-amber-700/70 dark:text-amber-300/60"
                title="Confidence (cosine + LLM verdict)"
              >
                {Math.round(s.score * 100)}%
              </span>
              <button
                type="button"
                className="rounded bg-amber-200 px-1.5 py-0.5 font-medium text-amber-900 hover:bg-amber-300 disabled:opacity-50 dark:bg-amber-900/60 dark:text-amber-100 dark:hover:bg-amber-900"
                onClick={() => {
                  if (
                    confirm(
                      `Merge "${page.title}" into "${s.title}"?\n\nThis page's source emails roll into "${s.title}" and the target is regenerated to fold them in. This page is then deleted. The action cannot be undone.`,
                    )
                  ) {
                    merge.mutate(s.pageId);
                  }
                }}
                disabled={merge.isPending}
                title="Merge this page into the candidate"
              >
                Merge
              </button>
              <button
                type="button"
                className="rounded p-1 text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/50"
                onClick={() => dismiss.mutate(s.pageId)}
                disabled={dismiss.isPending}
                title="Dismiss — won't suggest this pair again"
                aria-label="Dismiss"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
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
  // Topic pages span multiple senders by design; the strip should
  // surface that distinctly so the reader knows what they're looking
  // at is a long-running consolidated story, not a single thread.
  const isTopic = mode === 'topic';
  const modeLabel = isStream
    ? 'Notification stream'
    : isTopic
      ? 'Topic page'
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
          isStream || isTopic
            ? 'rounded bg-rose-100 px-1.5 py-0.5 font-medium text-rose-700 dark:bg-rose-950/50 dark:text-rose-300'
            : 'font-medium text-ink-600 dark:text-ink-300'
        }
      >
        {modeLabel}
      </span>
      {/* Topic pages summarise as "X messages from Y senders" because
          the spread of senders is the whole point. Other modes show
          the thread count instead. */}
      {emailCount > 0 && isTopic ? (
        <span className="text-ink-500">
          · {emailCount} message{emailCount === 1 ? '' : 's'} from{' '}
          {senders.length} sender{senders.length === 1 ? '' : 's'}
        </span>
      ) : (
        emailCount > 0 && (
          <span className="text-ink-500">
            · {emailCount} message{emailCount === 1 ? '' : 's'}
            {threadCount > 0 && (
              <>
                {' '}across {threadCount} thread{threadCount === 1 ? '' : 's'}
              </>
            )}
          </span>
        )
      )}
      {dateRange && <span className="text-ink-500">· {dateRange}</span>}
      {isTopic && page.generationMode === 'incremental' && (
        <span
          className="text-ink-500"
          title="New emails on this topic are folded into the existing prose rather than rewriting it from scratch."
        >
          · evolving
        </span>
      )}
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

/**
 * Right-rail card showing the page's geocoded places. Plan 11.
 *
 * Renders a small Leaflet inset with one pin per place that has
 * lat/lon coordinates, and a list of place names underneath. Returns
 * null when no place has coordinates so the card never appears as an
 * empty rectangle. Failed-geocode entries are omitted from both map
 * and list — they stay only as audit data on the page document.
 */
function PlacesCard({ places }: { places: NonNullable<PageDoc['places']> }) {
  const located = places.filter(
    (p): p is typeof p & { lat: number; lon: number } =>
      typeof p.lat === 'number' && typeof p.lon === 'number',
  );
  if (located.length === 0) return null;

  const pins: MapPin[] = located.map((p) => ({
    lat: p.lat,
    lon: p.lon,
    label: p.name,
  }));

  return (
    <section className="card mt-6">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <MapPinIcon className="h-4 w-4 text-rose-500" />
        Places ({located.length})
      </h2>
      <MapInset pins={pins} height="180px" className="overflow-hidden rounded-lg" />
      <ul className="mt-3 space-y-1 text-xs">
        {located.map((p) => (
          <li key={p.normKey} className="flex items-start gap-1.5">
            <MapPinIcon className="mt-0.5 h-3 w-3 shrink-0 text-ink-400" />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{p.name}</span>
              {p.displayName && p.displayName !== p.name && (
                <span className="ml-1 text-ink-500">— {p.displayName}</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Right-rail card listing the named entities the page mentions —
 * grouped by type (People, Works, Organizations) with per-type
 * icons. Each entry links to `/n/<normKey>`. Places live in their
 * own card above (with map); they're routable through the same
 * /n/:key URL but rendered separately so the card layout stays
 * predictable.
 */
function MentionsCard({
  entities,
}: {
  entities: NonNullable<PageDoc['entities']>;
}) {
  if (!entities.length) return null;
  const groups: Record<'person' | 'work' | 'organization', typeof entities> = {
    person: [],
    work: [],
    organization: [],
  };
  for (const e of entities) {
    if (groups[e.type]) groups[e.type].push(e);
  }
  const order: Array<{
    key: 'person' | 'work' | 'organization';
    label: string;
    Icon: typeof UserIcon;
  }> = [
    { key: 'person', label: 'People', Icon: UserIcon },
    { key: 'work', label: 'Works', Icon: Film },
    { key: 'organization', label: 'Organizations', Icon: Building2 },
  ];
  const total = entities.length;
  return (
    <section className="card mt-6">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <UserIcon className="h-4 w-4 text-rose-500" />
        Mentions ({total})
      </h2>
      <div className="space-y-3 text-sm">
        {order.map(({ key, label, Icon }) => {
          const arr = groups[key];
          if (arr.length === 0) return null;
          return (
            <div key={key}>
              <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-ink-500">
                <Icon className="h-3 w-3" />
                {label}
              </div>
              <ul className="space-y-1">
                {arr.map((e) => (
                  <li key={e.normKey}>
                    <Link
                      to={`/n/${encodeURIComponent(e.normKey)}`}
                      className="block truncate text-rose-700 hover:underline dark:text-rose-300"
                      title={e.displayName || e.name}
                    >
                      {e.displayName || e.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
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
  const label = link.text || link.url;
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
        {truncateLinkLabel(label)}
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

/**
 * Hard character cap for link labels rendered in the right-rail
 * Links list. CSS `truncate` (overflow-ellipsis) handles the
 * common case once column widths are constrained, but a
 * pathologically long token (a 400-character tracking URL with no
 * spaces) can still nudge the grid track wider before the ellipsis
 * kicks in. Capping at 48 chars (46 visible + space + ellipsis)
 * guarantees the rail stays at its allocated width regardless of
 * input.
 */
function truncateLinkLabel(s: string, max = 48): string {
  if (!s) return s;
  if (s.length <= max) return s;
  // 46 + space + single-char ellipsis = 48
  return s.slice(0, max - 2) + ' …';
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
                    <span>{displayTag(t, page.tagDisplayNames)}</span>
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

/**
 * Newspaper-style floated hero. Renders at its intrinsic size so a
 * portrait photo stays portrait and a landscape banner stays
 * landscape — no fixed crop. `max-width: min(45%, 360px)` caps how
 * much of the article column the image can claim, but
 * `width: auto / height: auto` (the browser default) lets the
 * intrinsic aspect ratio drive layout. Body text wraps around it
 * with the standard `float-right` flow.
 *
 * Rendered inside `<article className="prose">` so prose's own
 * margin rules apply to the surrounding paragraphs, but the image
 * sits in float context, not in the prose flow.
 */
function FloatedHero({ url, alt }: { url: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={url}
      alt={alt}
      // Float-right is the more familiar newspaper position; the
      // `[max-width:min(45%,360px)]` keeps unusually large images
      // from dominating the column. Margins create breathing room
      // between the photo and wrapped text. `not-prose` opts the
      // image out of typography's image-styling reset so we keep
      // our exact margin/border rules.
      className="not-prose float-right my-1 ml-5 mb-3 rounded-lg border border-ink-200 [max-width:min(45%,360px)] dark:border-ink-800"
      loading="eager"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
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

/**
 * Priority dropdown for the page header. Writes through to
 * POST /api/pages/:id/priority and locks the page's priority to the
 * user's choice (the generation worker honours `priorityOverride`).
 * Selecting "Auto" clears the override so the next regeneration
 * passes the heuristic-derived priority through again.
 */
function PriorityControl({
  pageId,
  priority,
  priorityOverride,
}: {
  pageId: string;
  priority: 'high' | 'normal' | 'low';
  priorityOverride: boolean;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const setPriority = useMutation({
    mutationFn: async (next: 'high' | 'normal' | 'low' | 'auto') =>
      api.post<{ ok: true; priority: string; priorityOverride: boolean }>(
        `/api/pages/${pageId}/priority`,
        { priority: next },
      ),
    onSuccess: () => {
      void qc.invalidateQueries();
      toast.success('Priority updated');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const value = priorityOverride ? priority : 'auto';
  const labelFor = (v: string) =>
    v === 'auto' ? 'Auto' : v === 'high' ? 'High' : v === 'low' ? 'Low' : 'Normal';

  return (
    <label
      className="inline-flex items-center gap-1 text-xs"
      title={
        priorityOverride
          ? `Manual priority: ${labelFor(priority)}. Set to Auto to clear.`
          : `Auto priority: ${labelFor(priority)}.`
      }
    >
      <Flame
        className={
          'h-3.5 w-3.5 ' +
          (priority === 'high'
            ? 'text-rose-500'
            : priority === 'low'
              ? 'text-ink-400'
              : 'text-ink-500')
        }
      />
      <select
        className="input h-7 px-1 py-0 text-xs"
        value={value}
        onChange={(e) =>
          setPriority.mutate(
            e.target.value as 'high' | 'normal' | 'low' | 'auto',
          )
        }
        disabled={setPriority.isPending}
      >
        <option value="auto">Auto</option>
        <option value="high">High</option>
        <option value="normal">Normal</option>
        <option value="low">Low</option>
      </select>
    </label>
  );
}
