import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { useMutation } from '@tanstack/react-query';
import { Globe, Upload, Link2, FileText, FileType, Tag } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';
import { useAuth } from '../lib/auth';

export default function SavePage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-10">
      <header className="mb-6 border-b-2 border-ink-900 pb-3 dark:border-ink-100">
        <div className="text-[10px] uppercase tracking-[0.25em] text-ink-500">
          Capture
        </div>
        <h1 className="mt-0.5 font-serif text-4xl font-black tracking-tight">
          Save to wiki
        </h1>
        <p className="mt-2 text-sm text-ink-500">
          Drop in a URL or upload a document. Rose runs the same
          parse → embed → generate pipeline as your inbox: a wiki
          page lands a few seconds later, searchable and chat-ready.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <UrlSaveCard />
        <FileUploadCard />
      </div>

      <div className="mt-6 rounded-lg border border-ink-200 bg-ink-50 p-3 text-xs text-ink-600 dark:border-ink-800 dark:bg-ink-900/40 dark:text-ink-300">
        <strong>Bookmarklet:</strong>{' '}
        <code className="text-[11px] text-ink-700 dark:text-ink-200">
          {`javascript:fetch('${typeof window !== 'undefined' ? window.location.origin : ''}/api/save/url',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:location.href})})`}
        </code>
        <span className="ml-1 text-ink-500">
          — drag this URL bar this snippet on a tab to save the active page.
        </span>
      </div>
    </div>
  );
}

function UrlSaveCard() {
  const api = useApi();
  const [url, setUrl] = useState('');
  const [tags, setTags] = useState('');
  const save = useMutation({
    mutationFn: async () =>
      api.post<{ jobId: string; url: string }>('/api/save/url', {
        url: url.trim(),
        tags: tags
          .split(/[,;\s]+/)
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
      }),
    onSuccess: (r) => {
      toast.success(`Queued — fetching ${new URL(r.url).hostname}…`);
      setUrl('');
      setTags('');
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <form
      className="card space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex items-center gap-2">
        <Link2 className="h-4 w-4 text-rose-500" />
        <h2 className="font-semibold">Save a URL</h2>
      </div>
      <p className="text-xs text-ink-500">
        Article, blog post, paper, README — anything readable. Worker
        runs Mozilla Readability, then ingests the cleaned content.
      </p>
      <label className="block text-xs">
        <span className="mb-1 block font-medium text-ink-700 dark:text-ink-200">
          URL
        </span>
        <input
          className="input"
          type="url"
          required
          placeholder="https://example.com/article"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      <label className="block text-xs">
        <span className="mb-1 block font-medium text-ink-700 dark:text-ink-200">
          Tags <span className="text-ink-400">(optional, comma-separated)</span>
        </span>
        <input
          className="input"
          placeholder="reading, paper, ai"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
      </label>
      <button
        className="btn-primary justify-center"
        type="submit"
        disabled={save.isPending || !url.trim()}
      >
        <Globe className="h-4 w-4" />
        {save.isPending ? 'Queueing…' : 'Save URL'}
      </button>
    </form>
  );
}

function FileUploadCard() {
  const { token } = useAuth();
  const [tags, setTags] = useState('');
  const [pending, setPending] = useState(false);

  const onDrop = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;
      if (file.size > 25 * 1024 * 1024) {
        toast.error('File too large (max 25 MB)');
        return;
      }
      const fd = new FormData();
      fd.append('file', file);
      if (tags.trim()) fd.append('tags', tags.trim());
      setPending(true);
      try {
        const res = await fetch('/api/save/file', {
          method: 'POST',
          credentials: 'include',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          body: fd,
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => null)) as { message?: string } | null;
          throw new Error(err?.message ?? `${res.status} ${res.statusText}`);
        }
        toast.success(`Queued — parsing ${file.name}…`);
        setTags('');
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setPending(false);
      }
    },
    [token, tags],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'text/plain': ['.txt'],
      'text/markdown': ['.md', '.markdown'],
      'text/html': ['.html', '.htm'],
    },
  });

  return (
    <div className="card space-y-3">
      <div className="flex items-center gap-2">
        <Upload className="h-4 w-4 text-rose-500" />
        <h2 className="font-semibold">Upload a document</h2>
      </div>
      <p className="text-xs text-ink-500">
        PDF, DOCX, Markdown, plaintext, or HTML. ≤ 25 MB.
      </p>
      <label className="block text-xs">
        <span className="mb-1 block font-medium text-ink-700 dark:text-ink-200">
          Tags <span className="text-ink-400">(optional)</span>
        </span>
        <input
          className="input"
          placeholder="paper, contract, notes"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
      </label>
      <div
        {...getRootProps()}
        className={
          'flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-4 text-center text-sm transition-colors ' +
          (isDragActive
            ? 'border-rose-500 bg-rose-50 text-rose-700 dark:bg-rose-950/30 dark:text-rose-200'
            : 'border-ink-200 text-ink-500 hover:border-rose-300 dark:border-ink-700 dark:hover:border-rose-700')
        }
      >
        <input {...getInputProps()} />
        {pending ? (
          <span>Uploading…</span>
        ) : (
          <>
            <FileText className="h-6 w-6 text-ink-400" />
            <span>
              Drop a file here, or <span className="font-medium text-rose-600 dark:text-rose-300">click to choose</span>
            </span>
            <span className="text-[10px] uppercase tracking-widest text-ink-400">
              <FileType className="mb-0.5 mr-1 inline-block h-3 w-3" />
              PDF · DOCX · MD · TXT · HTML
            </span>
          </>
        )}
      </div>
    </div>
  );
}
