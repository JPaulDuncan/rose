import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link as TiptapLink from '@tiptap/extension-link';
import { Save, History, Eye, Edit2, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApi } from '../lib/api';

type PageDoc = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  contentMd: string;
  tags: string[];
  version: number;
  updatedAt: string;
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
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{page.contentMd}</ReactMarkdown>
        ) : (
          <EditorContent editor={editor} />
        )}
      </article>

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
