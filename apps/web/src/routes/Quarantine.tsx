import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ShieldAlert,
  ShieldCheck,
  Bot,
  UserX,
  RefreshCw,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';

type QuarantinePage = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  spamScore: number;
  senderAddresses: string[];
  topics: string[];
  tags: string[];
  heroImageUrl: string | null;
  flags: {
    hasLikelySpam?: boolean;
    userMarkedSpam?: boolean;
    autoQuarantined?: boolean;
  };
  messageCount: number;
  updatedAt: string;
};

type QuarantineResp = {
  pages: QuarantinePage[];
  counts: { user: number; auto: number; heuristic: number };
};

type Kind = 'all' | 'user' | 'auto' | 'heuristic';

export default function QuarantinePage() {
  const api = useApi();
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['quarantine', kind],
    queryFn: () =>
      api.get<QuarantineResp>(`/api/quarantine?kind=${kind}&limit=200`),
  });

  const rescue = useMutation({
    mutationFn: async (id: string) =>
      api.del<{ ok: true }>(`/api/spam/page/${id}`),
    onSuccess: () => {
      toast.success('Rescued — back in your edition');
      qc.invalidateQueries({ queryKey: ['quarantine'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const trustSender = useMutation({
    mutationFn: async (address: string) =>
      api.post<{ ok: true }>(
        `/api/spam/sender/${encodeURIComponent(address)}/trust`,
      ),
    onSuccess: () => {
      toast.success('Sender trusted');
      qc.invalidateQueries({ queryKey: ['quarantine'] });
      qc.invalidateQueries({ queryKey: ['digest'] });
      qc.invalidateQueries({ queryKey: ['senders'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const counts = data?.counts ?? { user: 0, auto: 0, heuristic: 0 };
  const totalAll = counts.user + counts.auto + counts.heuristic;

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <header className="mb-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-rose-500">
          <ShieldAlert className="h-3.5 w-3.5" />
          Quarantine
        </div>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">
          Review held mail
        </h1>
        <p className="mt-1 text-sm text-ink-500">
          Pages that were hidden from your edition. Rescue restores a page
          and credits the sender's reputation; trusting a sender clears
          the auto-quarantine for everything from that brand.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap gap-1 rounded-lg border border-ink-200 p-1 text-xs dark:border-ink-800">
        <KindTab
          label={`All · ${totalAll}`}
          active={kind === 'all'}
          onClick={() => setKind('all')}
        />
        <KindTab
          label={`Auto · ${counts.auto}`}
          active={kind === 'auto'}
          icon={<Bot className="h-3 w-3" />}
          onClick={() => setKind('auto')}
        />
        <KindTab
          label={`Marked · ${counts.user}`}
          active={kind === 'user'}
          icon={<UserX className="h-3 w-3" />}
          onClick={() => setKind('user')}
        />
        <KindTab
          label={`Heuristic · ${counts.heuristic}`}
          active={kind === 'heuristic'}
          icon={<ShieldAlert className="h-3 w-3" />}
          onClick={() => setKind('heuristic')}
        />
      </div>

      {isLoading ? (
        <div className="text-sm text-ink-500">Loading…</div>
      ) : (data?.pages.length ?? 0) === 0 ? (
        <div className="card flex flex-col items-center gap-3 py-12 text-center">
          <ShieldCheck className="h-10 w-10 text-emerald-500" />
          <div>
            <h3 className="font-semibold">Nothing held</h3>
            <p className="text-sm text-ink-500">
              No pages are currently in quarantine.
            </p>
          </div>
        </div>
      ) : (
        <ul className="space-y-3">
          {data!.pages.map((p) => (
            <li
              key={p._id}
              className="flex gap-3 rounded-xl border border-ink-200 bg-white p-3 dark:border-ink-800 dark:bg-ink-900"
            >
              {p.heroImageUrl && (
                <img
                  src={p.heroImageUrl}
                  alt=""
                  className="h-20 w-28 shrink-0 rounded-md object-cover"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                  }}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap gap-1.5 text-[10px] font-semibold uppercase tracking-widest">
                  {p.flags.userMarkedSpam && (
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-950/40 dark:text-red-200">
                      Marked spam
                    </span>
                  )}
                  {p.flags.autoQuarantined && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                      Auto · Sender reputation
                    </span>
                  )}
                  {p.flags.hasLikelySpam &&
                    !p.flags.userMarkedSpam &&
                    !p.flags.autoQuarantined && (
                      <span className="rounded bg-ink-100 px-1.5 py-0.5 text-ink-700 dark:bg-ink-800 dark:text-ink-200">
                        Heuristic · score {p.spamScore.toFixed(2)}
                      </span>
                    )}
                </div>
                <Link
                  to={`/p/${p.slug}`}
                  className="mt-1 block font-serif text-base font-semibold leading-snug hover:text-rose-700 dark:hover:text-rose-300"
                >
                  {p.title}
                </Link>
                {p.summary && (
                  <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-600 dark:text-ink-300">
                    {p.summary}
                  </p>
                )}
                <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] uppercase tracking-widest text-ink-500">
                  {p.senderAddresses[0] && <span>From {p.senderAddresses[0]}</span>}
                  <span>
                    {p.messageCount} {p.messageCount === 1 ? 'msg' : 'msgs'}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <button
                  className="btn-secondary text-xs"
                  onClick={() => rescue.mutate(p._id)}
                  disabled={rescue.isPending}
                  title="Restore this page"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Rescue
                </button>
                {p.senderAddresses[0] && (
                  <button
                    className="btn-ghost text-[10px] text-emerald-700 dark:text-emerald-300"
                    onClick={() => trustSender.mutate(p.senderAddresses[0]!)}
                    disabled={trustSender.isPending}
                    title="Trust this sender across the address book"
                  >
                    <ShieldCheck className="h-3 w-3" />
                    Trust sender
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KindTab({
  label,
  active,
  icon,
  onClick,
}: {
  label: string;
  active: boolean;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'inline-flex items-center gap-1 rounded px-2 py-1 ' +
        (active
          ? 'bg-rose-500 text-white'
          : 'text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800')
      }
    >
      {icon}
      {label}
    </button>
  );
}
