import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Inbox, Upload, FileText } from 'lucide-react';
import { useApi } from '../lib/api';

type PageSummary = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  updatedAt: string;
};

export default function HomePage() {
  const api = useApi();
  const { data, isLoading } = useQuery({
    queryKey: ['pages-recent'],
    queryFn: () => api.get<{ pages: PageSummary[] }>('/api/pages?limit=10'),
  });

  const pages = data?.pages ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p className="text-sm text-ink-500">Recent wiki pages from your inbox.</p>
        </div>
        <Link to="/inbox?upload=1" className="btn-primary">
          <Upload className="h-4 w-4" /> Upload email
        </Link>
      </div>

      {isLoading ? (
        <div className="text-ink-500">Loading…</div>
      ) : pages.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {pages.map((p) => (
            <li key={p._id}>
              <Link to={`/p/${p.slug}`} className="card block hover:border-rose-300">
                <div className="flex items-start gap-3">
                  <FileText className="mt-1 h-4 w-4 shrink-0 text-ink-400" />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{p.title}</div>
                    <div className="line-clamp-2 text-sm text-ink-500">{p.summary}</div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {p.tags.slice(0, 4).map((t) => (
                        <span key={t} className="pill">
                          #{t}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="card flex flex-col items-center justify-center gap-3 py-16 text-center">
      <Inbox className="h-10 w-10 text-rose-500" />
      <div>
        <h3 className="font-semibold">No pages yet</h3>
        <p className="text-sm text-ink-500">
          Upload an email or connect an inbox and Rose will draft your first wiki page.
        </p>
      </div>
      <div className="flex gap-2">
        <Link to="/inbox?upload=1" className="btn-primary">
          <Upload className="h-4 w-4" /> Upload email
        </Link>
        <Link to="/settings/sources" className="btn-secondary">
          Connect a source
        </Link>
      </div>
    </div>
  );
}
