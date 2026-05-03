import { useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ExternalLink,
  Flame,
  ShieldAlert,
  Megaphone,
  Paperclip,
  Tag as TagIcon,
  LinkIcon,
  Mail,
  AtSign,
  Calendar,
  FileText,
  Code2,
} from 'lucide-react';
import { useApi } from '../lib/api';

type EmailDetail = {
  _id: string;
  subject: string;
  from?: { name?: string; address?: string } | null;
  to?: { name?: string; address?: string }[];
  cc?: { name?: string; address?: string }[];
  date?: string | null;
  text?: string;
  rawText?: string;
  html?: string | null;
  attachments?: { filename: string; contentType: string; size: number }[];
  priority?: 'high' | 'normal' | 'low';
  topics?: string[];
  links?: { url: string; text?: string | null }[];
  spamScore?: number;
  spamSignals?: string[];
  isMassMailing?: boolean;
  ingestStatus?: string;
  pageId?: string | null;
  threadKey?: string | null;
  subjectTemplate?: string | null;
  createdAt?: string;
};

export default function EmailView() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const { data, isLoading, error } = useQuery({
    queryKey: ['email', id],
    queryFn: () => api.get<EmailDetail>(`/api/emails/${id}`),
    enabled: !!id,
  });

  // Look up the wiki page slug if this email contributed to one.
  const { data: pageInfo } = useQuery({
    queryKey: ['email-page', data?.pageId],
    queryFn: () =>
      api.get<{ slug: string; title: string }>(`/api/pages/${data!.pageId}`),
    enabled: !!data?.pageId,
  });

  const [view, setView] = useState<'text' | 'html' | 'raw'>('text');

  if (isLoading || !data) {
    if (error) {
      return (
        <div className="mx-auto max-w-3xl px-6 py-10 text-sm text-red-600">
          Couldn't load email: {(error as Error).message}
        </div>
      );
    }
    return <div className="px-6 py-10 text-ink-500">Loading email…</div>;
  }

  const fromLabel = data.from?.name
    ? `${data.from.name} <${data.from.address ?? '?'}>`
    : data.from?.address ?? 'unknown sender';
  const toList = (data.to ?? []).map((a) => a.address).filter(Boolean) as string[];
  const ccList = (data.cc ?? []).map((a) => a.address).filter(Boolean) as string[];
  const date = data.date ? new Date(data.date) : data.createdAt ? new Date(data.createdAt) : null;

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <Link
        to={pageInfo ? `/p/${pageInfo.slug}` : '/inbox'}
        className="mb-4 inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-900 dark:hover:text-ink-100"
      >
        <ArrowLeft className="h-3 w-3" /> {pageInfo ? `Back to “${pageInfo.title}”` : 'Back to Inbox'}
      </Link>

      <header className="mb-6 border-b border-ink-200 pb-4 dark:border-ink-800">
        <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-rose-500">
          <Mail className="h-3.5 w-3.5" />
          Original email
        </div>
        <h1 className="mt-1 break-words text-2xl font-semibold tracking-tight">
          {data.subject || '(no subject)'}
        </h1>

        <div className="mt-3 grid gap-1 text-sm sm:grid-cols-[100px_1fr]">
          <span className="text-ink-500">From</span>
          <code className="text-xs">{fromLabel}</code>
          {toList.length > 0 && (
            <>
              <span className="text-ink-500">To</span>
              <code className="text-xs">{toList.join(', ')}</code>
            </>
          )}
          {ccList.length > 0 && (
            <>
              <span className="text-ink-500">Cc</span>
              <code className="text-xs">{ccList.join(', ')}</code>
            </>
          )}
          {date && (
            <>
              <span className="text-ink-500">Date</span>
              <span className="inline-flex items-center gap-1 text-xs">
                <Calendar className="h-3 w-3" />
                {date.toLocaleString()}
              </span>
            </>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {data.priority === 'high' && (
            <Badge tone="rose" icon={<Flame className="h-3 w-3" />}>
              High priority
            </Badge>
          )}
          {(data.spamScore ?? 0) >= 0.5 && (
            <Badge
              tone="red"
              icon={<ShieldAlert className="h-3 w-3" />}
              title={data.spamSignals?.join('; ')}
            >
              Likely spam · {Math.round((data.spamScore ?? 0) * 100)}%
            </Badge>
          )}
          {data.isMassMailing && (data.spamScore ?? 0) < 0.5 && (
            <Badge tone="ink" icon={<Megaphone className="h-3 w-3" />}>
              Bulk mail
            </Badge>
          )}
          {data.attachments && data.attachments.length > 0 && (
            <Badge tone="ink" icon={<Paperclip className="h-3 w-3" />}>
              {data.attachments.length} attachment
              {data.attachments.length === 1 ? '' : 's'}
            </Badge>
          )}
          {data.ingestStatus && (
            <Badge tone="ink">status: {data.ingestStatus}</Badge>
          )}
          {pageInfo && (
            <Link
              to={`/p/${pageInfo.slug}`}
              className="ml-auto inline-flex items-center gap-1 rounded-full border border-rose-300 px-2 py-0.5 font-medium text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/30"
            >
              Open wiki page <ExternalLink className="h-3 w-3" />
            </Link>
          )}
        </div>
      </header>

      <BodyTabs view={view} setView={setView} hasHtml={!!data.html} hasRaw={!!data.rawText} />
      <div className="mt-3">
        {view === 'text' && <TextBody text={data.text || data.rawText || ''} />}
        {view === 'html' && data.html && <HtmlBody html={data.html} />}
        {view === 'raw' && <TextBody text={data.rawText || data.text || ''} mono />}
      </div>

      {data.topics && data.topics.length > 0 && (
        <Section title="Topics" icon={<TagIcon className="h-4 w-4 text-rose-500" />}>
          <div className="flex flex-wrap gap-1.5">
            {data.topics.map((t) => (
              <Link
                key={t}
                to={`/t/${encodeURIComponent(t)}`}
                className="pill hover:bg-rose-100 hover:text-rose-800 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
              >
                {t}
              </Link>
            ))}
          </div>
        </Section>
      )}

      {data.links && data.links.length > 0 && (
        <Section
          title={`Links (${data.links.length})`}
          icon={<LinkIcon className="h-4 w-4 text-rose-500" />}
        >
          <ul className="space-y-1.5 text-sm">
            {data.links.slice(0, 50).map((l) => (
              <li key={l.url} className="flex items-start gap-2">
                <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-400" />
                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="min-w-0 flex-1 truncate text-rose-600 hover:underline dark:text-rose-400"
                  title={l.url}
                >
                  {l.text || hostOf(l.url)}
                </a>
                <span className="shrink-0 text-xs text-ink-400">{hostOf(l.url)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {data.attachments && data.attachments.length > 0 && (
        <Section
          title={`Attachments (${data.attachments.length})`}
          icon={<Paperclip className="h-4 w-4 text-rose-500" />}
        >
          <ul className="space-y-1.5 text-sm">
            {data.attachments.map((a, i) => (
              <li key={`${a.filename}-${i}`} className="flex items-center gap-2">
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                <span className="min-w-0 flex-1 truncate font-medium">{a.filename}</span>
                <span className="shrink-0 text-xs text-ink-500">{a.contentType}</span>
                <span className="shrink-0 text-xs text-ink-400">{formatBytes(a.size)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        title="Routing metadata"
        icon={<AtSign className="h-4 w-4 text-rose-500" />}
        muted
      >
        <dl className="grid grid-cols-1 gap-y-1 text-xs sm:grid-cols-[140px_1fr]">
          <dt className="text-ink-500">Email ID</dt>
          <dd>
            <code>{data._id}</code>
          </dd>
          {data.threadKey && (
            <>
              <dt className="text-ink-500">Thread key</dt>
              <dd className="break-all">
                <code>{data.threadKey}</code>
              </dd>
            </>
          )}
          {data.subjectTemplate && (
            <>
              <dt className="text-ink-500">Subject template</dt>
              <dd>
                <code>{data.subjectTemplate}</code>
              </dd>
            </>
          )}
        </dl>
      </Section>
    </div>
  );
}

function BodyTabs({
  view,
  setView,
  hasHtml,
  hasRaw,
}: {
  view: 'text' | 'html' | 'raw';
  setView: (v: 'text' | 'html' | 'raw') => void;
  hasHtml: boolean;
  hasRaw: boolean;
}) {
  return (
    <div className="flex gap-1 border-b border-ink-200 dark:border-ink-800">
      <TabButton active={view === 'text'} onClick={() => setView('text')}>
        <FileText className="h-3.5 w-3.5" /> Plain text
      </TabButton>
      {hasHtml && (
        <TabButton active={view === 'html'} onClick={() => setView('html')}>
          <Code2 className="h-3.5 w-3.5" /> HTML
        </TabButton>
      )}
      {hasRaw && (
        <TabButton active={view === 'raw'} onClick={() => setView('raw')}>
          Raw
        </TabButton>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'inline-flex items-center gap-1 px-3 py-1.5 text-sm border-b-2 -mb-px ' +
        (active
          ? 'border-rose-500 font-medium text-rose-700 dark:text-rose-300'
          : 'border-transparent text-ink-500 hover:text-ink-900 dark:hover:text-ink-100')
      }
    >
      {children}
    </button>
  );
}

function TextBody({ text, mono }: { text: string; mono?: boolean }) {
  if (!text.trim()) {
    return (
      <div className="card text-sm text-ink-500">No plain-text body for this email.</div>
    );
  }
  return (
    <pre
      className={
        'card whitespace-pre-wrap break-words text-sm leading-relaxed ' +
        (mono ? 'font-mono text-xs' : 'font-sans')
      }
    >
      {text}
    </pre>
  );
}

/**
 * HTML email renderer. We sandbox in an iframe so untrusted markup can't
 * touch the rest of the SPA, and we do a defensive strip of script/style
 * tags before injecting. The iframe gets `sandbox` (no scripts, no
 * top-navigation) and a `srcdoc` with the cleaned HTML.
 */
function HtmlBody({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const cleaned = useMemo(() => sanitizeHtml(html), [html]);
  const [tall, setTall] = useState(600);
  return (
    <div className="card !p-0 overflow-hidden">
      <iframe
        ref={ref}
        title="Email HTML body"
        srcDoc={cleaned}
        sandbox=""
        className="block w-full bg-white"
        style={{ height: tall }}
        onLoad={() => {
          try {
            const doc = ref.current?.contentDocument;
            const h = doc?.body?.scrollHeight ?? 600;
            setTall(Math.min(2000, Math.max(400, h + 16)));
          } catch {
            // sandbox may block inspection; keep default
          }
        }}
      />
    </div>
  );
}

function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?<\/embed>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '#blocked-js:');
}

function Section({
  title,
  icon,
  muted,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={'card mt-4 ' + (muted ? 'opacity-70' : '')}>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Badge({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'rose' | 'red' | 'ink';
  icon?: React.ReactNode;
  title?: string;
  children: React.ReactNode;
}) {
  const cls =
    tone === 'rose'
      ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
      : tone === 'red'
        ? 'bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-200'
        : 'bg-ink-100 text-ink-700 dark:bg-ink-800 dark:text-ink-200';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${cls}`}
      title={title}
    >
      {icon}
      {children}
    </span>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function formatBytes(n: number): string {
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
