import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Send, Copy, X, RefreshCw, Trash2, Mail } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';
import { useAuth } from '../lib/auth';

type Email = {
  _id: string;
  subject?: string;
  from?: { name?: string; address?: string } | null;
  draftReply?: string | null;
  draftReplyMeta?: {
    model?: string | null;
    generatedAt?: string | null;
    edits?: number;
  } | null;
};

type Citation = { pageId: string; slug: string; title: string; score: number };

type Outbound = {
  _id: string;
  status: 'queued' | 'sent' | 'failed';
  subject: string;
  to: { name?: string; address: string }[];
  sentAt: string | null;
  error: string | null;
  createdAt: string;
};

export function DraftReply({ email }: { email: Email }) {
  const api = useApi();
  const qc = useQueryClient();
  const { token } = useAuth();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string>(email.draftReply ?? '');
  const [streaming, setStreaming] = useState(false);
  const [citations, setCitations] = useState<Record<string, Citation>>({});
  const dirty = useRef(false);

  // Reset when the email changes.
  useEffect(() => {
    setDraft(email.draftReply ?? '');
    dirty.current = false;
  }, [email._id, email.draftReply]);

  const { data: outbox } = useQuery({
    queryKey: ['outbound', email._id],
    queryFn: () =>
      api.get<{ outbound: Outbound[] }>(
        `/api/outbound?inReplyToEmailId=${email._id}`,
      ),
    enabled: open,
  });

  const replyTo = email.from?.address;

  async function generate() {
    if (!replyTo) {
      toast.error('No sender address to reply to');
      return;
    }
    setStreaming(true);
    setDraft('');
    setCitations({});
    try {
      const res = await fetch(`/api/emails/${email._id}/draft-reply`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
      });
      if (!res.ok || !res.body) {
        throw new Error(`${res.status} ${res.statusText}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let leftover = '';
      let buffer = '';
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
          if (payload.type === 'citations') {
            setCitations(payload.citations as Record<string, Citation>);
          } else if (payload.type === 'token') {
            buffer += (payload.delta as string) ?? '';
            setDraft(buffer);
          } else if (payload.type === 'error') {
            throw new Error(payload.message as string);
          }
        }
      }
      dirty.current = false;
      qc.invalidateQueries({ queryKey: ['email', email._id] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setStreaming(false);
    }
  }

  const saveDraft = useMutation({
    mutationFn: async () =>
      api.post<{ ok: true }>(`/api/emails/${email._id}/draft-reply/save`, {
        draft,
      }),
    onSuccess: () => {
      dirty.current = false;
      toast.success('Draft saved');
      qc.invalidateQueries({ queryKey: ['email', email._id] });
    },
  });

  const clearDraft = useMutation({
    mutationFn: async () =>
      api.del<{ ok: true }>(`/api/emails/${email._id}/draft-reply`),
    onSuccess: () => {
      setDraft('');
      qc.invalidateQueries({ queryKey: ['email', email._id] });
    },
  });

  const send = useMutation({
    mutationFn: async () => {
      // Persist any pending edits before sending.
      if (dirty.current) {
        await api.post(`/api/emails/${email._id}/draft-reply/save`, { draft });
      }
      const subject = (email.subject ?? '').toLowerCase().startsWith('re:')
        ? email.subject ?? ''
        : `Re: ${email.subject ?? ''}`;
      return api.post<{ outboundId: string }>('/api/outbound', {
        inReplyToEmailId: email._id,
        to: [{ address: replyTo }],
        subject,
        bodyMd: draft,
      });
    },
    onSuccess: () => {
      toast.success('Sent — see "Sent from this thread" below for status.');
      dirty.current = false;
      qc.invalidateQueries({ queryKey: ['outbound', email._id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!open) {
    return (
      <button
        type="button"
        className="btn-secondary"
        onClick={() => setOpen(true)}
      >
        <Sparkles className="h-4 w-4" /> Draft reply
      </button>
    );
  }

  return (
    <section className="card mt-4 space-y-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4 text-rose-500" />
          <span className="font-semibold">Draft reply</span>
          {email.draftReplyMeta?.model && (
            <span className="text-[10px] uppercase tracking-widest text-ink-400">
              {email.draftReplyMeta.model}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => generate()}
            disabled={streaming}
          >
            <RefreshCw
              className={'h-3.5 w-3.5 ' + (streaming ? 'animate-spin' : '')}
            />
            {streaming ? 'Drafting…' : draft ? 'Regenerate' : 'Generate'}
          </button>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => setOpen(false)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          dirty.current = true;
        }}
        placeholder="Click Generate to draft a reply…"
        className="input min-h-[180px] font-mono text-sm"
        disabled={streaming}
      />

      {Object.keys(citations).length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[11px] text-ink-500">
          <span className="uppercase tracking-widest">Drew from</span>
          {Object.entries(citations).map(([label, c]) => (
            <a
              key={label}
              href={`/p/${c.slug}`}
              className="rounded bg-rose-100 px-1.5 py-0.5 text-rose-700 hover:bg-rose-200 dark:bg-rose-950/40 dark:text-rose-200"
              title={c.title}
            >
              {label} · {c.title.slice(0, 30)}
              {c.title.length > 30 ? '…' : ''}
            </a>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => {
            void navigator.clipboard.writeText(draft);
            toast.success('Copied to clipboard');
          }}
          disabled={!draft.trim()}
        >
          <Copy className="h-3.5 w-3.5" /> Copy
        </button>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => saveDraft.mutate()}
          disabled={!draft.trim() || saveDraft.isPending}
        >
          Save draft
        </button>
        <button
          type="button"
          className="btn-ghost text-xs text-red-600"
          onClick={() => {
            if (confirm('Clear this draft?')) clearDraft.mutate();
          }}
          disabled={!draft.trim()}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="btn-primary text-xs"
          onClick={() => {
            if (!replyTo) return;
            if (
              confirm(
                `Send to ${replyTo}?\n\nThis fires immediately through your configured outbound source.`,
              )
            )
              send.mutate();
          }}
          disabled={!draft.trim() || send.isPending || !replyTo}
        >
          <Send className="h-3.5 w-3.5" />
          {send.isPending ? 'Sending…' : `Send to ${replyTo}`}
        </button>
      </div>

      {(outbox?.outbound?.length ?? 0) > 0 && (
        <div className="border-t border-ink-200 pt-3 dark:border-ink-800">
          <div className="mb-2 text-[10px] uppercase tracking-widest text-ink-500">
            Sent from this thread
          </div>
          <ul className="space-y-1.5 text-xs">
            {outbox!.outbound.map((o) => (
              <li
                key={o._id}
                className="flex items-center justify-between gap-2 rounded border border-ink-200 px-2 py-1 dark:border-ink-800"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <Mail className="h-3 w-3 text-ink-400" />
                  <span className="truncate">{o.subject || '(no subject)'}</span>
                </span>
                <span
                  className={
                    'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest ' +
                    (o.status === 'sent'
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200'
                      : o.status === 'failed'
                        ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-200'
                        : 'bg-ink-100 text-ink-600 dark:bg-ink-800 dark:text-ink-300')
                  }
                  title={o.error ?? ''}
                >
                  {o.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
