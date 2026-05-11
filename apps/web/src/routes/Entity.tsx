import { useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  User,
  Film,
  Building2,
  MapPin as MapPinIcon,
  ArrowRight,
  Sparkles,
  ExternalLink,
  RotateCw,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';
import { adapterLabel } from '../lib/sourceLabel';
import { MapInset } from '../components/MapInset';
import { EntityRelations } from '../components/EntityRelations';

type EntityType = 'person' | 'work' | 'organization' | 'place' | null;

type RelatedEntity = {
  key: string;
  displayName: string;
  type: string;
  count: number;
};

type EntityPageDoc = {
  _id: string;
  slug: string;
  title: string;
  summary: string;
  tags?: string[];
  topics?: string[];
  heroImageUrl?: string | null;
  updatedAt: string;
  groupingMode?: string;
  senderAddresses?: string[];
};

type EntityResponse = {
  key: string;
  displayName: string;
  type: EntityType;
  aliases: string[];
  pageCount: number;
  placeCoords: { lat: number; lon: number; displayName: string | null } | null;
  pages: EntityPageDoc[];
  related: RelatedEntity[];
  /** Globally-shared facts for organization-typed entities. Null
   *  for other types or when no Organization row exists yet. */
  org: {
    displayName: string | null;
    websites: string[];
    logoUrl: string | null;
    summary: string;
    /** Wikidata Q-ID when the ontology resolver pinned the org to
     *  a canonical external entry. Null when unresolved or low-confidence. */
    wikidataId: string | null;
    wikidataConfidence: number;
  } | null;
};

type DaydreamNoteView = {
  _id: string;
  summary: string;
  bodyMd: string;
  sources: { adapter: string; url: string; title: string; fetchedAt: string | null }[];
  confidence: 'low' | 'medium' | 'high';
  model: string | null;
  generatedAt: string | null;
  failed: boolean;
  failureReason: string | null;
  /** Plan 15 — display name of the user whose daydream pass first
   *  surfaced this entity. Empty string when unknown / unmigrated. */
  contributedBy?: string;
};

const TYPE_LABEL: Record<NonNullable<EntityType>, string> = {
  person: 'Person',
  work: 'Work',
  organization: 'Organization',
  place: 'Place',
};

function typeBadgeClass(type: EntityType): string {
  switch (type) {
    case 'person':
      return 'bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-200';
    case 'work':
      return 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200';
    case 'organization':
      return 'bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-200';
    case 'place':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200';
    default:
      return 'bg-ink-100 text-ink-800 dark:bg-ink-800 dark:text-ink-100';
  }
}

function TypeIcon({ type, className }: { type: EntityType; className?: string }) {
  const cls = className ?? 'h-4 w-4';
  switch (type) {
    case 'person':
      return <User className={cls} />;
    case 'work':
      return <Film className={cls} />;
    case 'organization':
      return <Building2 className={cls} />;
    case 'place':
      return <MapPinIcon className={cls} />;
    default:
      return <User className={cls} />;
  }
}

export default function EntityPage() {
  const { key } = useParams<{ key: string }>();
  const api = useApi();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['entity', key],
    queryFn: () => api.get<EntityResponse>(`/api/entities/${encodeURIComponent(key ?? '')}`),
    enabled: !!key,
  });

  if (isLoading) {
    return <div className="px-6 py-10 text-ink-500">Loading…</div>;
  }
  if (isError || !data) {
    return (
      <div className="mx-auto w-full max-w-4xl px-6 py-10 text-sm">
        <div className="card">
          <div className="font-medium text-red-600">Entity not found.</div>
          <div className="mt-1 text-xs text-ink-500">
            No pages currently mention <code>{key}</code>.{' '}
            <Link to="/" className="text-rose-600 hover:underline">
              Go home
            </Link>
            .
          </div>
        </div>
      </div>
    );
  }

  const showMap =
    data.type === 'place' && data.placeCoords?.lat != null && data.placeCoords?.lon != null;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="mb-6 flex items-start gap-3">
        {data.org?.logoUrl ? (
          <img
            src={data.org.logoUrl}
            alt=""
            className="mt-1 h-8 w-8 shrink-0 rounded object-contain"
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : null}
        <span className={`mt-1 inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium ${typeBadgeClass(data.type)}`}>
          <TypeIcon type={data.type} className="h-3 w-3" />
          {data.type ? TYPE_LABEL[data.type] : 'Mention'}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-semibold tracking-tight">{data.displayName}</h1>
          <p className="mt-1 text-sm text-ink-500">
            Mentioned on {data.pageCount} page{data.pageCount === 1 ? '' : 's'}
            {data.aliases.length > 0 && (
              <>
                {' · also: '}
                {data.aliases.slice(0, 4).map((a, i) => (
                  <span key={a}>
                    {i > 0 && ', '}
                    <code className="rounded bg-ink-100 px-1 text-[10px] dark:bg-ink-800">{a}</code>
                  </span>
                ))}
                {data.aliases.length > 4 && <> +{data.aliases.length - 4} more</>}
              </>
            )}
          </p>
          {data.org?.websites && data.org.websites.length > 0 && (
            <p className="mt-1 text-xs text-ink-500">
              {data.org.websites.slice(0, 3).map((w, i) => (
                <span key={w}>
                  {i > 0 && ' · '}
                  <a
                    href={`https://${w}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-rose-600 hover:underline"
                  >
                    {w}
                  </a>
                </span>
              ))}
            </p>
          )}
          {data.org?.wikidataId && (
            <p className="mt-1 text-xs text-ink-500">
              <a
                href={`https://www.wikidata.org/wiki/${data.org.wikidataId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[11px] text-ink-700 hover:bg-ink-200 dark:bg-ink-800 dark:text-ink-200 dark:hover:bg-ink-700"
                title={`Wikidata canonical entry · resolver confidence ${Math.round((data.org.wikidataConfidence ?? 0) * 100)}%`}
              >
                Wikidata: <code>{data.org.wikidataId}</code>
                {(data.org.wikidataConfidence ?? 0) < 0.9 && (
                  <span className="text-[10px] italic">unverified</span>
                )}
              </a>
            </p>
          )}
        </div>
      </div>

      {showMap && data.placeCoords && (
        <section className="mb-6">
          <MapInset
            pins={[
              {
                lat: data.placeCoords.lat,
                lon: data.placeCoords.lon,
                label: data.placeCoords.displayName ?? data.displayName,
              },
            ]}
            height="220px"
            className="overflow-hidden rounded-lg"
          />
        </section>
      )}

      <BackgroundBrief entityKey={data.key} displayName={data.displayName} type={data.type} />
      <EntityRelations entityKey={data.key} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]">
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-ink-500">
            Pages mentioning this {data.type ? TYPE_LABEL[data.type].toLowerCase() : 'entity'}
          </h2>
          {data.pages.length === 0 ? (
            <p className="text-sm italic text-ink-500">
              No pages currently reference this entity.
            </p>
          ) : (
            <ul className="space-y-3">
              {data.pages.map((p) => (
                <li key={p._id}>
                  <Link
                    to={`/p/${p.slug}`}
                    className="card block hover:border-rose-300 dark:hover:border-rose-700"
                  >
                    <div className="flex items-start gap-3">
                      {p.heroImageUrl && (
                        <img
                          src={p.heroImageUrl}
                          alt=""
                          className="h-16 w-16 shrink-0 rounded object-cover"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{p.title}</div>
                        {p.summary && (
                          <p className="mt-0.5 line-clamp-2 text-sm text-ink-500">
                            {p.summary}
                          </p>
                        )}
                        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] uppercase tracking-widest text-ink-500">
                          <span>{new Date(p.updatedAt).toLocaleDateString()}</span>
                          {(p.tags ?? []).slice(0, 3).map((t) => (
                            <span key={t}>· #{t}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          {data.related.length > 0 && (
            <section className="card">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <ArrowRight className="h-4 w-4 text-rose-500" />
                Related
              </h3>
              <ul className="space-y-1.5 text-sm">
                {data.related.map((r) => (
                  <li key={r.key} className="flex items-center gap-2">
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${typeBadgeClass(r.type as EntityType)}`}
                      title={r.type}
                    >
                      <TypeIcon type={r.type as EntityType} className="h-2.5 w-2.5" />
                    </span>
                    <Link
                      to={`/n/${encodeURIComponent(r.key)}`}
                      className="min-w-0 flex-1 truncate hover:text-rose-700 dark:hover:text-rose-300"
                      title={r.displayName}
                    >
                      {r.displayName}
                    </Link>
                    <span className="shrink-0 text-[10px] text-ink-400">
                      ×{r.count}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * Daydream-supplied "what is this" brief. Pulls the cached note for
 * the entity (kind: 'entity', subjectKey = lowercased displayName)
 * from /api/entities/:key/daydream and renders summary + body +
 * source attribution. The "Daydream now" button enqueues a fresh
 * pass via the daydream worker's per-entity job mode.
 *
 * When no note exists yet the component still renders — a slim
 * "ask Rose to research this" prompt with the same button — so the
 * surface is always discoverable.
 */
function BackgroundBrief({
  entityKey,
  displayName,
  type,
}: {
  entityKey: string;
  displayName: string;
  type: EntityType;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['entity-daydream', entityKey],
    queryFn: () =>
      api.get<{ note: DaydreamNoteView | null }>(
        `/api/entities/${encodeURIComponent(entityKey)}/daydream`,
      ),
  });
  const force = useMutation({
    mutationFn: async () =>
      api.post<{ jobId: string }>(
        `/api/entities/${encodeURIComponent(entityKey)}/daydream`,
      ),
    onSuccess: () => {
      toast.success('Daydream queued — refresh in a moment');
      // Existing daydream config holds research time at a few
      // seconds for cheap subjects, longer for those that need
      // multiple adapters; 5s is a reasonable refetch delay so the
      // UI usually catches the result on the first invalidation.
      window.setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['entity-daydream', entityKey] });
      }, 5000);
    },
    onError: (e: Error) => {
      if (e.message.includes('rate_limited')) {
        toast.error('Daydream-now is rate-limited (5/min).');
      } else {
        toast.error(e.message);
      }
    },
  });

  const note = data?.note;
  const typeLabel =
    type === 'person'
      ? 'person'
      : type === 'work'
        ? 'work'
        : type === 'organization'
          ? 'organization'
          : type === 'place'
            ? 'place'
            : 'subject';

  return (
    <section className="card mb-6">
      <div className="mb-2 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-rose-500" />
        <h2 className="text-sm font-semibold">Background</h2>
        <button
          type="button"
          onClick={() => force.mutate()}
          disabled={force.isPending}
          className="ml-auto inline-flex items-center gap-1 text-xs text-ink-500 hover:text-rose-600 dark:hover:text-rose-300"
          title="Run daydream now to refresh the brief — needs daydream enabled in Settings → Daydream"
        >
          <RotateCw
            className={`h-3 w-3 ${force.isPending ? 'animate-spin' : ''}`}
          />
          {note ? 'Refresh' : 'Daydream now'}
        </button>
      </div>
      {isLoading ? (
        <p className="text-sm text-ink-500">Loading…</p>
      ) : !note ? (
        <p className="text-sm italic text-ink-500">
          No background research yet for this {typeLabel}. Click
          "Daydream now" to ask Rose to fetch encyclopedic context
          from your enabled knowledge sources (Wikipedia, Wikidata,
          OpenAlex, etc.). Daydream must be enabled in{' '}
          <Link to="/settings/daydream" className="text-rose-600 hover:underline">
            Settings → Daydream
          </Link>
          .
        </p>
      ) : note.failed ? (
        <p className="text-xs italic text-ink-500">
          No background found
          {note.failureReason ? `: ${note.failureReason}` : ''}. Try
          enabling more knowledge sources in{' '}
          <Link to="/settings/daydream" className="text-rose-600 hover:underline">
            Settings → Daydream
          </Link>
          .
        </p>
      ) : (
        <>
          <p className="text-sm text-ink-700 dark:text-ink-200">
            {note.summary || displayName}
          </p>
          {note.bodyMd && note.bodyMd !== note.summary && (
            <p className="mt-2 whitespace-pre-wrap text-xs text-ink-600 dark:text-ink-300">
              {note.bodyMd}
            </p>
          )}
          {note.sources.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
              {note.sources.slice(0, 6).map((s) => (
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
              {note.contributedBy && (
                <span
                  className="italic"
                  title="Daydream notes are shared. This shows whose research first surfaced the subject."
                >
                  · contributed by {note.contributedBy}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
