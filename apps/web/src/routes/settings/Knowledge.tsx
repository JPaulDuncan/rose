import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Brain,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Pencil,
  Trash2,
  CheckCircle2,
  Archive,
  ArchiveRestore,
  Search,
  X,
  Sparkles,
  Globe,
  User as UserIcon,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../../lib/api';

/**
 * Unified Knowledge page — collapses the previously-separate
 * Memory, Entities, and per-entity Daydream surfaces into one
 * coherent view. Three layers of the same question:
 *
 *   • Identifier:        Entity row (typed, keyed, Wikidata link)
 *   • Atomic claims:     MemoryComponent (subject='world')
 *   • Synthesised prose: DaydreamNote
 *
 * are now rendered together per-subject. The data model is
 * unchanged; the unification is purely presentation + a single
 * composite endpoint (/api/knowledge) so the UI doesn't fan out
 * three round-trips.
 *
 * Two top-level tabs:
 *   • About you  — user-facts (existing Memory rendering)
 *   • About the world — Entity cards with daydream + facts inline
 *
 * /n/:key deep-link is unchanged; the legacy Memory + Entities
 * settings pages remain reachable via direct URL during the
 * deprecation window.
 */

type Subject = 'user' | 'world';

type ComponentSource = { id: string; title: string; slug: string };
type Component = {
  _id: string;
  type: 'fact' | 'preference' | 'constraint' | 'relation' | 'state-update';
  text: string;
  confidence: number;
  status: 'active' | 'archived' | 'rejected';
  sources: ComponentSource[];
  lastSeenAt: string;
};

type EntityCard = {
  entity: {
    _id: string;
    key: string;
    displayName: string;
    type: 'person' | 'work' | 'organization' | 'place';
    aliases: string[];
    pageCount: number;
    wikidataId: string | null;
    wikidataConfidence: number;
  };
  daydreamNote: {
    subjectKey: string;
    displayName: string;
    summary: string;
    bodyMd: string;
    sources: { adapter: string; url: string; title: string }[];
    confidence: 'low' | 'medium' | 'high';
    generatedAt: string;
    model: string;
  } | null;
  facts: Component[];
};

type UserResponse = {
  subject: 'user';
  components: (Component & { groupId: string | null })[];
  groups: { _id: string; label: string; componentCount: number }[];
  totals: { components: number; groups: number };
};
type WorldResponse = {
  subject: 'world';
  entities: EntityCard[];
  looseFacts: Component[];
  totals: {
    entities: number;
    facts: number;
    facts_matched: number;
    facts_loose: number;
  };
};

const TYPE_TINT: Record<Component['type'], string> = {
  fact: 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200',
  preference: 'bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200',
  constraint: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  relation: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
  'state-update': 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
};

export default function KnowledgeSettingsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const subject = (searchParams.get('subject') as Subject) ?? 'user';
  const setSubject = (s: Subject) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('subject', s);
      return next;
    });
  };
  const [search, setSearch] = useState('');
  const [expandedEntities, setExpandedEntities] = useState<Set<string>>(new Set());

  const userQ = useQuery({
    queryKey: ['knowledge', 'user'],
    queryFn: () => api.get<UserResponse>('/api/knowledge?subject=user'),
    enabled: subject === 'user',
  });
  const worldQ = useQuery({
    queryKey: ['knowledge', 'world'],
    queryFn: () => api.get<WorldResponse>('/api/knowledge?subject=world'),
    enabled: subject === 'world',
  });

  // Mutations reuse the existing memory endpoints — no new
  // surface to maintain. Same for daydream-now (existing entity
  // endpoint).
  const update = useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: { text?: string; status?: 'active' | 'archived' | 'rejected' };
    }) => api.patch<{ ok: true }>(`/api/memory/components/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['knowledge'] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      api.del<{ ok: true }>(`/api/memory/components/${id}`),
    onSuccess: () => {
      toast.success('Removed');
      qc.invalidateQueries({ queryKey: ['knowledge'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const daydreamNow = useMutation({
    mutationFn: async (key: string) =>
      api.post<{ ok: true }>(`/api/entities/${encodeURIComponent(key)}/daydream`, {}),
    onSuccess: () => {
      toast.success("Daydream queued — note refreshes when the worker finishes.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const filteredWorldEntities = useMemo(() => {
    if (subject !== 'world' || !worldQ.data) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return worldQ.data.entities;
    return worldQ.data.entities.filter((c) => {
      if (c.entity.displayName.toLowerCase().includes(needle)) return true;
      if (c.daydreamNote?.summary?.toLowerCase().includes(needle)) return true;
      if (c.facts.some((f) => f.text.toLowerCase().includes(needle))) return true;
      return false;
    });
  }, [worldQ.data, search, subject]);

  const filteredLooseFacts = useMemo(() => {
    if (subject !== 'world' || !worldQ.data) return [];
    const needle = search.trim().toLowerCase();
    if (!needle) return worldQ.data.looseFacts;
    return worldQ.data.looseFacts.filter((f) =>
      f.text.toLowerCase().includes(needle),
    );
  }, [worldQ.data, search, subject]);

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="mb-2 flex items-center gap-2">
          <Brain className="h-5 w-5 text-rose-500" />
          <h2 className="font-semibold">Knowledge</h2>
        </div>
        <p className="text-sm text-ink-500">
          Everything Rose has learned, in one place. "About you" is
          the user-facts substrate that personalises the home page,
          briefing, and daydream context. "About the world" is the
          per-subject view — entities Rose recognises, with the
          atomic facts it extracted and the encyclopedic note it
          synthesised.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-md border border-ink-200 p-0.5 dark:border-ink-800">
          <button
            type="button"
            onClick={() => setSubject('user')}
            className={
              'inline-flex items-center gap-1 rounded px-3 py-1 text-sm ' +
              (subject === 'user'
                ? 'bg-rose-500 text-white'
                : 'text-ink-600 dark:text-ink-300')
            }
          >
            <UserIcon className="h-3 w-3" /> About you
          </button>
          <button
            type="button"
            onClick={() => setSubject('world')}
            className={
              'inline-flex items-center gap-1 rounded px-3 py-1 text-sm ' +
              (subject === 'world'
                ? 'bg-rose-500 text-white'
                : 'text-ink-600 dark:text-ink-300')
            }
          >
            <Globe className="h-3 w-3" /> About the world
          </button>
        </div>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={
              subject === 'user'
                ? 'Search facts about you…'
                : 'Search entities or facts…'
            }
            className="input w-full pl-9 text-sm"
          />
          {search && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-400 hover:text-ink-700"
              onClick={() => setSearch('')}
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {subject === 'user' && (
        <UserTab
          loading={userQ.isLoading}
          data={userQ.data}
          search={search}
          onUpdate={(id, patch) => update.mutate({ id, patch })}
          onRemove={(id) => remove.mutate(id)}
        />
      )}

      {subject === 'world' && (
        <WorldTab
          loading={worldQ.isLoading}
          entities={filteredWorldEntities}
          looseFacts={filteredLooseFacts}
          expandedEntities={expandedEntities}
          setExpandedEntities={setExpandedEntities}
          onDaydream={(key) => daydreamNow.mutate(key)}
          onUpdate={(id, patch) => update.mutate({ id, patch })}
          onRemove={(id) => remove.mutate(id)}
        />
      )}
    </div>
  );
}

function UserTab({
  loading,
  data,
  search,
  onUpdate,
  onRemove,
}: {
  loading: boolean;
  data: UserResponse | undefined;
  search: string;
  onUpdate: (
    id: string,
    patch: { text?: string; status?: 'active' | 'archived' | 'rejected' },
  ) => void;
  onRemove: (id: string) => void;
}) {
  const sectioned = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    const components = data.components.filter((c) =>
      needle ? c.text.toLowerCase().includes(needle) : true,
    );
    const byGroup = new Map<string | null, typeof components>();
    for (const c of components) {
      const k = c.groupId;
      const arr = byGroup.get(k) ?? [];
      arr.push(c);
      byGroup.set(k, arr);
    }
    const out: { label: string; items: typeof components }[] = [];
    for (const g of data.groups) {
      const items = byGroup.get(g._id) ?? [];
      if (items.length > 0) out.push({ label: g.label, items });
    }
    const ungrouped = byGroup.get(null) ?? [];
    if (ungrouped.length > 0) out.push({ label: 'Awaiting grouping', items: ungrouped });
    return out;
  }, [data, search]);

  if (loading) return <div className="card text-sm text-ink-500">Loading…</div>;
  if (!data || sectioned.length === 0) {
    return (
      <div className="card flex flex-col items-center gap-3 py-12 text-center">
        <Brain className="h-10 w-10 text-rose-500" />
        <div>
          <h3 className="font-semibold">
            {search ? 'Nothing matches your search' : 'Nothing learned yet'}
          </h3>
          <p className="mt-1 text-sm text-ink-500">
            {search
              ? 'Try a shorter query, or clear the search to see everything.'
              : 'Rose extracts user-facts in the background. Once a few pages have been processed, themes will appear here.'}
          </p>
        </div>
      </div>
    );
  }
  return (
    <>
      {sectioned.map(({ label, items }) => (
        <section key={label} className="card space-y-2">
          <header className="flex items-center gap-2 text-sm font-semibold">
            {label}
            <span className="text-xs font-normal text-ink-500">· {items.length}</span>
          </header>
          <ul className="space-y-2">
            {items.map((c) => (
              <ComponentRow
                key={c._id}
                comp={c}
                onUpdate={onUpdate}
                onRemove={onRemove}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function WorldTab({
  loading,
  entities,
  looseFacts,
  expandedEntities,
  setExpandedEntities,
  onDaydream,
  onUpdate,
  onRemove,
}: {
  loading: boolean;
  entities: EntityCard[];
  looseFacts: Component[];
  expandedEntities: Set<string>;
  setExpandedEntities: (s: Set<string>) => void;
  onDaydream: (key: string) => void;
  onUpdate: (
    id: string,
    patch: { text?: string; status?: 'active' | 'archived' | 'rejected' },
  ) => void;
  onRemove: (id: string) => void;
}) {
  if (loading) return <div className="card text-sm text-ink-500">Loading…</div>;
  if (entities.length === 0 && looseFacts.length === 0) {
    return (
      <div className="card flex flex-col items-center gap-3 py-12 text-center">
        <Globe className="h-10 w-10 text-rose-500" />
        <div>
          <h3 className="font-semibold">Nothing matches</h3>
          <p className="mt-1 text-sm text-ink-500">
            Entities show up here as Rose extracts them from pages.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {entities.map((card) => (
        <EntityRowCard
          key={card.entity._id}
          card={card}
          expanded={expandedEntities.has(card.entity._id)}
          onToggle={() => {
            const next = new Set(expandedEntities);
            if (next.has(card.entity._id)) next.delete(card.entity._id);
            else next.add(card.entity._id);
            setExpandedEntities(next);
          }}
          onDaydream={onDaydream}
          onUpdate={onUpdate}
          onRemove={onRemove}
        />
      ))}
      {looseFacts.length > 0 && (
        <section className="card space-y-2 border-dashed border-ink-300 dark:border-ink-700">
          <header className="text-sm font-semibold">
            Loose facts
            <span className="ml-2 text-xs font-normal text-ink-500">
              · {looseFacts.length} not tied to a registered entity
            </span>
          </header>
          <p className="text-xs text-ink-500">
            These claims don't match any entity Rose has registered.
            Mark wrong to suppress, or leave as-is until the
            underlying entity gets recognised on a future page.
          </p>
          <ul className="space-y-2">
            {looseFacts.map((c) => (
              <ComponentRow
                key={c._id}
                comp={c}
                onUpdate={onUpdate}
                onRemove={onRemove}
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function EntityRowCard({
  card,
  expanded,
  onToggle,
  onDaydream,
  onUpdate,
  onRemove,
}: {
  card: EntityCard;
  expanded: boolean;
  onToggle: () => void;
  onDaydream: (key: string) => void;
  onUpdate: (
    id: string,
    patch: { text?: string; status?: 'active' | 'archived' | 'rejected' },
  ) => void;
  onRemove: (id: string) => void;
}) {
  const { entity, daydreamNote, facts } = card;
  const PREVIEW = 3;
  const previewFacts = expanded ? facts : facts.slice(0, PREVIEW);
  const hiddenCount = facts.length - previewFacts.length;
  return (
    <section className="card space-y-2">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="flex flex-wrap items-center gap-2 text-left text-sm font-semibold"
            onClick={onToggle}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-ink-500" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-ink-500" />
            )}
            <span className="text-base">{entity.displayName}</span>
            <span className="rounded bg-ink-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-ink-600 dark:bg-ink-800 dark:text-ink-300">
              {entity.type}
            </span>
            <span className="text-xs font-normal text-ink-500">
              · {entity.pageCount} page{entity.pageCount === 1 ? '' : 's'}
            </span>
            {entity.wikidataId && (
              <a
                href={`https://www.wikidata.org/wiki/${entity.wikidataId}`}
                target="_blank"
                rel="noreferrer"
                className="text-[10px] font-mono text-ink-500 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {entity.wikidataId}
              </a>
            )}
            <span className="text-xs font-normal text-ink-500">
              · {facts.length} fact{facts.length === 1 ? '' : 's'}
            </span>
          </button>
          {!expanded && daydreamNote?.summary && (
            <p className="mt-1 line-clamp-2 text-xs text-ink-600 dark:text-ink-400">
              {daydreamNote.summary}
            </p>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => onDaydream(entity.key)}
            title="Refresh the encyclopedic note for this entity"
          >
            <Sparkles className="h-3.5 w-3.5" /> Daydream
          </button>
          <Link
            to={`/n/${encodeURIComponent(entity.key)}`}
            className="btn-ghost text-xs"
            title="Open entity page"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </div>
      </header>

      {expanded && daydreamNote && (
        <div className="rounded-md border border-ink-100 bg-ink-50/40 p-3 dark:border-ink-800 dark:bg-ink-900/30">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-500">
            Daydream note · {daydreamNote.confidence} confidence
          </div>
          {daydreamNote.summary && (
            <p className="text-sm leading-snug">{daydreamNote.summary}</p>
          )}
          {daydreamNote.bodyMd && (
            <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-ink-700 dark:text-ink-300">
              {daydreamNote.bodyMd}
            </p>
          )}
          {daydreamNote.sources && daydreamNote.sources.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-ink-500">
              {daydreamNote.sources.slice(0, 5).map((s, i) => (
                <a
                  key={i}
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded bg-ink-100 px-1.5 py-0.5 hover:underline dark:bg-ink-800"
                  title={s.title}
                >
                  via {s.adapter}
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {expanded && facts.length === 0 && (
        <p className="text-xs italic text-ink-500">
          No atomic facts extracted yet. They'll appear here as Rose
          processes pages that mention {entity.displayName}.
        </p>
      )}

      {previewFacts.length > 0 && (
        <ul className="space-y-2">
          {previewFacts.map((c) => (
            <ComponentRow
              key={c._id}
              comp={c}
              onUpdate={onUpdate}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}

      {!expanded && hiddenCount > 0 && (
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={onToggle}
        >
          Show {hiddenCount} more · note + sources
        </button>
      )}
    </section>
  );
}

function ComponentRow({
  comp,
  onUpdate,
  onRemove,
}: {
  comp: Component;
  onUpdate: (
    id: string,
    patch: { text?: string; status?: 'active' | 'archived' | 'rejected' },
  ) => void;
  onRemove: (id: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <li
      className={
        'rounded-md border p-2 ' +
        (comp.status === 'active'
          ? 'border-ink-200 dark:border-ink-800'
          : 'border-ink-100 opacity-60 dark:border-ink-900')
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={
                'rounded px-1.5 py-0.5 text-[10px] font-medium ' +
                TYPE_TINT[comp.type]
              }
            >
              {comp.type}
            </span>
            <span className="text-[10px] text-ink-400">
              confidence {Math.round(comp.confidence * 100)}%
            </span>
          </div>
          {editing !== null ? (
            <div className="mt-1 flex items-center gap-2">
              <input
                className="input flex-1 text-sm"
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                autoFocus
              />
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary text-xs"
                onClick={() => {
                  onUpdate(comp._id, { text: editing });
                  setEditing(null);
                }}
              >
                Save
              </button>
            </div>
          ) : (
            <p className="mt-1 text-sm">{comp.text}</p>
          )}
          {comp.sources.length > 0 && (
            <div className="mt-1 text-[11px] text-ink-500">
              learned from:{' '}
              {comp.sources.map((s, i) => (
                <span key={s.id}>
                  {i > 0 && ', '}
                  <Link to={`/p/${s.slug}`} className="hover:underline">
                    {s.title}
                  </Link>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => setEditing(comp.text)}
            title="Edit text"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          {comp.status === 'active' ? (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => onUpdate(comp._id, { status: 'archived' })}
              title="Archive — hide but keep the record"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => onUpdate(comp._id, { status: 'active' })}
              title="Restore"
            >
              <ArchiveRestore className="h-3.5 w-3.5" />
            </button>
          )}
          {comp.status !== 'rejected' && (
            <button
              type="button"
              className="btn-ghost text-xs text-red-600"
              onClick={() => onUpdate(comp._id, { status: 'rejected' })}
              title="Mark wrong — suppress + prevent re-learning"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            className="btn-ghost text-xs text-red-600"
            onClick={() => {
              if (confirm('Delete this fact?')) onRemove(comp._id);
            }}
            title="Delete"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </li>
  );
}
