import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  MessageSquare,
  Send,
  Plus,
  Pin,
  Trash2,
  Sparkles,
  Pencil,
  X,
  Check,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

type Conversation = {
  _id: string;
  title: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
};

type Citation = {
  pageId: string;
  slug: string;
  title: string;
  score: number;
};

type Message = {
  _id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  citations?: Record<string, Citation>;
  model?: string | null;
  createdAt: string;
};

type ConversationDetail = {
  conversation: Conversation;
  messages: Message[];
};

export default function ChatPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const qc = useQueryClient();

  const { data: list } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.get<{ conversations: Conversation[] }>('/api/chat'),
    refetchInterval: 30_000,
  });

  const detail = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.get<ConversationDetail>(`/api/chat/${id}`),
    enabled: !!id,
  });

  const remove = useMutation({
    mutationFn: async (cid: string) => api.del<{ ok: true }>(`/api/chat/${cid}`),
    onSuccess: (_r, cid) => {
      toast.success('Conversation deleted');
      qc.invalidateQueries({ queryKey: ['conversations'] });
      if (id === cid) navigate('/chat');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const togglePin = useMutation({
    mutationFn: async ({ cid, pinned }: { cid: string; pinned: boolean }) =>
      api.patch<Conversation>(`/api/chat/${cid}`, { pinned }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['conversations'] }),
  });

  const conversations = list?.conversations ?? [];
  const sorted = useMemo(() => {
    const pinned = conversations.filter((c) => c.pinned);
    const rest = conversations.filter((c) => !c.pinned);
    return { pinned, rest };
  }, [conversations]);

  return (
    <div className="grid h-full grid-cols-1 lg:grid-cols-[260px_1fr]">
      {/* Conversation rail */}
      <aside className="hidden border-r border-ink-200 bg-white p-3 dark:border-ink-800 dark:bg-ink-900 lg:flex lg:flex-col">
        <button
          className="btn-primary mb-3 justify-center"
          onClick={() => navigate('/chat')}
        >
          <Plus className="h-4 w-4" /> New chat
        </button>
        {sorted.pinned.length > 0 && (
          <div className="mb-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-ink-500">
              Pinned
            </div>
            {sorted.pinned.map((c) => (
              <ConversationItem
                key={c._id}
                c={c}
                active={id === c._id}
                onSelect={() => navigate(`/chat/${c._id}`)}
                onPin={() => togglePin.mutate({ cid: c._id, pinned: !c.pinned })}
                onDelete={() => {
                  if (confirm(`Delete "${c.title}"?`)) remove.mutate(c._id);
                }}
              />
            ))}
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-ink-500">
            Recent
          </div>
          {sorted.rest.length === 0 ? (
            <div className="text-xs italic text-ink-500">No conversations yet.</div>
          ) : (
            sorted.rest.map((c) => (
              <ConversationItem
                key={c._id}
                c={c}
                active={id === c._id}
                onSelect={() => navigate(`/chat/${c._id}`)}
                onPin={() => togglePin.mutate({ cid: c._id, pinned: !c.pinned })}
                onDelete={() => {
                  if (confirm(`Delete "${c.title}"?`)) remove.mutate(c._id);
                }}
              />
            ))
          )}
        </div>
      </aside>

      {/* Active conversation */}
      <main className="flex h-full min-h-0 flex-col">
        <ChatThread
          key={id ?? 'new'}
          conversationId={id}
          initial={detail.data ?? null}
        />
      </main>
    </div>
  );
}

function ConversationItem({
  c,
  active,
  onSelect,
  onPin,
  onDelete,
}: {
  c: Conversation;
  active: boolean;
  onSelect: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={
        'group mb-1 flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm ' +
        (active
          ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
          : 'text-ink-700 hover:bg-ink-100 dark:text-ink-200 dark:hover:bg-ink-800')
      }
    >
      <button
        type="button"
        onClick={onSelect}
        className="min-w-0 flex-1 truncate text-left"
      >
        {c.title}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onPin();
        }}
        className={
          'opacity-0 group-hover:opacity-100 ' +
          (c.pinned ? 'opacity-100 text-rose-500' : '')
        }
        aria-label="Pin"
        title={c.pinned ? 'Unpin' : 'Pin'}
      >
        <Pin className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="opacity-0 hover:text-red-600 group-hover:opacity-100"
        aria-label="Delete"
        title="Delete"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

type StreamingState = {
  conversationId: string | null;
  citations: Record<string, Citation>;
  buffer: string;
};

function ChatThread({
  conversationId,
  initial,
}: {
  conversationId: string | undefined;
  initial: ConversationDetail | null;
}) {
  const navigate = useNavigate();
  const { token } = useAuth();
  const qc = useQueryClient();
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [streaming, setStreaming] = useState<StreamingState>({
    conversationId: null,
    citations: {},
    buffer: '',
  });
  const [renamingTitle, setRenamingTitle] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const messages = initial?.messages ?? [];
  const conversation = initial?.conversation;

  // Auto-scroll on new tokens / new messages.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, streaming.buffer]);

  async function send() {
    const text = input.trim();
    if (!text || pending) return;
    setInput('');
    setPending(true);
    setStreaming({ conversationId: conversationId ?? null, citations: {}, buffer: '' });

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({ conversationId, message: text }),
      });
      if (!res.ok || !res.body) {
        const err = await res.text();
        throw new Error(err || `${res.status} ${res.statusText}`);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let leftover = '';
      let createdConvId: string | null = null;
      let buffer = '';
      let citations: Record<string, Citation> = {};

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
          if (payload.type === 'conversation') {
            createdConvId = payload.conversationId as string;
            setStreaming((s) => ({ ...s, conversationId: createdConvId }));
          } else if (payload.type === 'citations') {
            citations = payload.citations as Record<string, Citation>;
            setStreaming((s) => ({ ...s, citations }));
          } else if (payload.type === 'token') {
            buffer += (payload.delta as string) ?? '';
            setStreaming((s) => ({ ...s, buffer }));
          } else if (payload.type === 'error') {
            throw new Error((payload.message as string) ?? 'Stream error');
          }
        }
      }

      // Stream done — rehydrate from server, navigate if a new conv
      // was just created.
      qc.invalidateQueries({ queryKey: ['conversations'] });
      if (createdConvId) {
        if (createdConvId !== conversationId) {
          navigate(`/chat/${createdConvId}`, { replace: true });
        } else {
          qc.invalidateQueries({ queryKey: ['conversation', createdConvId] });
        }
      } else if (conversationId) {
        qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setPending(false);
      setStreaming({ conversationId: null, citations: {}, buffer: '' });
    }
  }

  const showStreaming = pending && (streaming.buffer || Object.keys(streaming.citations).length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-ink-200 px-6 py-3 dark:border-ink-800">
        <div className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4 text-rose-500" />
          {renamingTitle !== null ? (
            <RenameInput
              value={renamingTitle}
              onCancel={() => setRenamingTitle(null)}
              onSave={async (next) => {
                if (!conversationId) return;
                try {
                  await fetch(`/api/chat/${conversationId}`, {
                    method: 'PATCH',
                    credentials: 'include',
                    headers: {
                      'Content-Type': 'application/json',
                      Authorization: token ? `Bearer ${token}` : '',
                    },
                    body: JSON.stringify({ title: next }),
                  });
                  qc.invalidateQueries({ queryKey: ['conversations'] });
                  qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
                } finally {
                  setRenamingTitle(null);
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="font-medium hover:text-rose-700 dark:hover:text-rose-300"
              onClick={() => conversation && setRenamingTitle(conversation.title)}
              disabled={!conversation}
            >
              {conversation?.title ?? 'Ask the wiki'}
              {conversation && (
                <Pencil className="ml-1.5 inline-block h-3 w-3 text-ink-400" />
              )}
            </button>
          )}
        </div>
      </header>

      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-6 py-6">
        {messages.length === 0 && !showStreaming ? (
          <EmptyState />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            {messages.map((m) => (
              <MessageBubble key={m._id} message={m} />
            ))}
            {showStreaming && (
              <StreamingBubble
                buffer={streaming.buffer}
                citations={streaming.citations}
              />
            )}
          </div>
        )}
      </div>

      <div className="border-t border-ink-200 bg-white px-6 py-4 dark:border-ink-800 dark:bg-ink-900">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Ask anything about your wiki…"
            className="input min-h-[44px] flex-1 resize-none"
            rows={1}
            disabled={pending}
          />
          <button
            type="button"
            className="btn-primary"
            onClick={send}
            disabled={pending || !input.trim()}
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameInput({
  value,
  onCancel,
  onSave,
}: {
  value: string;
  onCancel: () => void;
  onSave: (next: string) => void | Promise<void>;
}) {
  const [v, setV] = useState(value);
  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void onSave(v.trim() || value);
          if (e.key === 'Escape') onCancel();
        }}
        className="input text-sm"
      />
      <button className="btn-ghost" onClick={() => void onSave(v.trim() || value)}>
        <Check className="h-3.5 w-3.5" />
      </button>
      <button className="btn-ghost" onClick={onCancel}>
        <X className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto mt-16 max-w-md text-center">
      <MessageSquare className="mx-auto h-10 w-10 text-rose-500" />
      <h2 className="mt-3 font-serif text-2xl font-bold tracking-tight">
        Ask the wiki
      </h2>
      <p className="mt-2 text-sm text-ink-500">
        Ask a question and Rose will answer using your wiki entries,
        citing the pages it pulled context from. Your knowledge base
        becomes a workspace.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-2 text-xs">
        {[
          'What did Stripe say about pricing this quarter?',
          'Summarise the GitHub Actions failures from last week',
          "What's on my calendar this week?",
        ].map((s) => (
          <span
            key={s}
            className="rounded-full bg-ink-100 px-3 py-1 text-ink-600 dark:bg-ink-800 dark:text-ink-300"
          >
            "{s}"
          </span>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-rose-500 px-4 py-2.5 text-sm text-white">
          <div className="whitespace-pre-wrap">{message.content}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="max-w-[90%]">
      <AssistantBody content={message.content} citations={message.citations ?? {}} />
      {message.model && (
        <div className="mt-1 text-[10px] uppercase tracking-widest text-ink-400">
          {message.model}
        </div>
      )}
    </div>
  );
}

function StreamingBubble({
  buffer,
  citations,
}: {
  buffer: string;
  citations: Record<string, Citation>;
}) {
  return (
    <div className="max-w-[90%]">
      <AssistantBody content={buffer || '…'} citations={citations} streaming />
    </div>
  );
}

function AssistantBody({
  content,
  citations,
  streaming,
}: {
  content: string;
  citations: Record<string, Citation>;
  streaming?: boolean;
}) {
  // Replace [pN] tokens with cite-tagged spans the markdown renderer
  // can pass through — we then catch them in the renderer and turn
  // them into clickable pills.
  const transformed = content.replace(
    /\[(p\d+(?:\s*,\s*p\d+)*)\]/g,
    (_, group: string) =>
      group
        .split(',')
        .map((label) => `‹cite:${label.trim()}›`)
        .join(''),
  );
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-2 prose-headings:my-3 prose-pre:my-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Catch our citation marker and render a pill.
          p({ children }) {
            return <p>{renderCitations(children, citations)}</p>;
          },
          li({ children }) {
            return <li>{renderCitations(children, citations)}</li>;
          },
        }}
      >
        {transformed}
      </ReactMarkdown>
      {streaming && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-rose-500" />}
    </div>
  );
}

function renderCitations(
  children: React.ReactNode,
  citations: Record<string, Citation>,
): React.ReactNode {
  if (typeof children === 'string') {
    return interpolateCites(children, citations);
  }
  if (Array.isArray(children)) {
    return children.map((c, i) => (
      <span key={i}>{renderCitations(c, citations)}</span>
    ));
  }
  return children;
}

function interpolateCites(
  text: string,
  citations: Record<string, Citation>,
): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /‹cite:(p\d+)›/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const label = m[1]!;
    const cite = citations[label];
    if (cite) {
      parts.push(
        <Link
          key={`${label}-${m.index}`}
          to={`/p/${cite.slug}`}
          className="mx-0.5 inline-flex items-center rounded bg-rose-100 px-1.5 py-0 align-baseline text-[10px] font-semibold text-rose-700 hover:bg-rose-200 dark:bg-rose-950/40 dark:text-rose-200"
          title={cite.title}
        >
          {label}
        </Link>,
      );
    } else {
      parts.push(
        <span
          key={`${label}-${m.index}`}
          className="mx-0.5 inline-flex items-center rounded bg-ink-100 px-1.5 py-0 align-baseline text-[10px] text-ink-500 dark:bg-ink-800"
        >
          {label}
        </span>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
