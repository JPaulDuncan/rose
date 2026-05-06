import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { User, Film, Building2, MapPin as MapPinIcon, ArrowRight } from 'lucide-react';
import { useApi } from '../lib/api';
import { MapInset } from '../components/MapInset';

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
