import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Package,
  RefreshCw,
  ExternalLink,
  Truck,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Clock,
  Trash2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApi } from '../lib/api';
import { CarrierLabels, StatusLabels, type Carrier, type ShipmentStatus } from '@rose/shared';

type ShipmentRow = {
  _id: string;
  carrier: Carrier;
  trackingNumber: string;
  label: string | null;
  status: ShipmentStatus;
  trackingUrl: string;
  lastEventDescription: string | null;
  lastEventAt: string | null;
  estimatedDeliveryAt: string | null;
  deliveredAt: string | null;
  history: Array<{
    at: string | null;
    status: ShipmentStatus;
    description: string;
    location?: string | null;
    source: 'email' | 'carrier-api';
  }>;
  sourceEmailIds: string[];
  lastCheckedAt: string | null;
  lastError: string | null;
  pollCount: number;
  createdAt: string;
  updatedAt: string;
};

const STATUS_FILTERS: Array<{ value: ShipmentStatus | 'active'; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'in_transit', label: 'In transit' },
  { value: 'out_for_delivery', label: 'Out for delivery' },
  { value: 'exception', label: 'Exception' },
  { value: 'delivered', label: 'Delivered' },
];

/**
 * Shipment Statuses page. Rose detects carrier tracking numbers in
 * incoming emails and groups the resulting shipments by status. The
 * "Refresh" button hits the carrier's API where credentials are
 * configured; otherwise the rendered status comes purely from email
 * keyword inference (which works surprisingly well for Amazon,
 * carrier-direct notifications, etc.).
 */
export default function ShipmentsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<ShipmentStatus | 'active'>('active');

  const { data, isLoading } = useQuery({
    queryKey: ['shipments', filter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filter === 'delivered') params.set('includeDelivered', '1');
      if (filter !== 'active') params.set('status', filter);
      const r = await api.get<{ shipments: ShipmentRow[] }>(
        `/api/shipments?${params.toString()}`,
      );
      return r;
    },
  });

  const refresh = useMutation({
    mutationFn: async (id: string) =>
      api.post<{ ok: boolean; error?: string; shipment: ShipmentRow }>(
        `/api/shipments/${id}/refresh`,
      ),
    onSuccess: (r) => {
      if (!r.ok) toast.error(r.error ?? 'Carrier refresh failed');
      else toast.success('Status updated');
      void qc.invalidateQueries({ queryKey: ['shipments'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => api.del<{ ok: true }>(`/api/shipments/${id}`),
    onSuccess: () => {
      toast.success('Removed');
      void qc.invalidateQueries({ queryKey: ['shipments'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const scan = useMutation({
    mutationFn: async () =>
      api.post<{ ok: true; scannedEmails: number; shipmentsUpserted: number }>(
        '/api/shipments/scan',
        {},
      ),
    onSuccess: (r) => {
      toast.success(
        `Scanned ${r.scannedEmails} emails, ${r.shipmentsUpserted} shipments saved`,
      );
      void qc.invalidateQueries({ queryKey: ['shipments'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const grouped = useMemo(() => groupShipments(data?.shipments ?? []), [data]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-8">
      <header>
        <div className="text-[10px] uppercase tracking-[0.25em] text-rose-600 dark:text-rose-300">
          Logistics desk
        </div>
        <h1 className="mt-1 font-serif text-3xl font-black tracking-tight">
          Shipment Statuses
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-500">
          Tracking numbers Rose pulled from your inbox. Status is inferred from
          carrier notification keywords by default; click Refresh to query the
          carrier directly when API credentials are configured.
        </p>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-200 pb-3 text-xs dark:border-ink-800">
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={
                'rounded-full px-3 py-1 ' +
                (filter === f.value
                  ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200'
                  : 'text-ink-500 hover:text-ink-700 dark:hover:text-ink-200')
              }
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => scan.mutate()}
          disabled={scan.isPending}
          title="Walk recent emails through tracking-number detection"
        >
          <RefreshCw
            className={'h-3.5 w-3.5' + (scan.isPending ? ' animate-spin' : '')}
          />{' '}
          Scan inbox
        </button>
      </div>

      {isLoading ? (
        <div className="card text-sm text-ink-500">Loading shipments…</div>
      ) : (data?.shipments ?? []).length === 0 ? (
        <div className="card flex flex-col items-center gap-3 py-12 text-center">
          <Package className="h-10 w-10 text-rose-500" />
          <div>
            <h3 className="font-semibold">Nothing to ship</h3>
            <p className="mt-1 text-sm text-ink-500">
              Rose adds rows here automatically when an email contains a UPS,
              FedEx, USPS, or DHL tracking number. New carrier emails update
              the status in place.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(({ status, shipments }) => (
            <section key={status}>
              <h2 className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] text-ink-500">
                <StatusBadge status={status} />
                <span>{StatusLabels[status]}</span>
                <span className="text-ink-400">· {shipments.length}</span>
              </h2>
              <ul className="space-y-2">
                {shipments.map((s) => (
                  <ShipmentRowCard
                    key={s._id}
                    shipment={s}
                    onRefresh={() => refresh.mutate(s._id)}
                    onRemove={() => {
                      if (
                        confirm(
                          `Remove tracking for ${s.trackingNumber}? Source emails stay; the shipment row is recreated if a new email mentions the number.`,
                        )
                      ) {
                        remove.mutate(s._id);
                      }
                    }}
                    refreshing={refresh.isPending && refresh.variables === s._id}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function ShipmentRowCard({
  shipment,
  onRefresh,
  onRemove,
  refreshing,
}: {
  shipment: ShipmentRow;
  onRefresh: () => void;
  onRemove: () => void;
  refreshing: boolean;
}) {
  return (
    <li className="card space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-widest text-ink-500">
            <span className="rounded bg-ink-100 px-1.5 py-0.5 font-medium text-ink-700 dark:bg-ink-800 dark:text-ink-200">
              {CarrierLabels[shipment.carrier]}
            </span>
            <code className="font-mono text-[11px]">{shipment.trackingNumber}</code>
            {shipment.estimatedDeliveryAt && (
              <span className="text-ink-500">
                ETA {new Date(shipment.estimatedDeliveryAt).toLocaleDateString()}
              </span>
            )}
          </div>
          <div className="mt-1 truncate text-sm font-medium">
            {shipment.label ?? 'Tracked package'}
          </div>
          {shipment.lastEventDescription && (
            <div className="mt-0.5 text-xs text-ink-500">
              {shipment.lastEventDescription}
              {shipment.lastEventAt && (
                <span className="ml-1 text-ink-400">
                  · {new Date(shipment.lastEventAt).toLocaleString()}
                </span>
              )}
            </div>
          )}
          {shipment.lastError && (
            <div className="mt-1 text-xs text-amber-600 dark:text-amber-300">
              {shipment.lastError}
            </div>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-1">
          <a
            href={shipment.trackingUrl}
            target="_blank"
            rel="noreferrer"
            className="btn-ghost text-xs"
            title="Open carrier tracking page"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Carrier
          </a>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={onRefresh}
            disabled={refreshing}
            title="Query the carrier API"
          >
            <RefreshCw
              className={'h-3.5 w-3.5' + (refreshing ? ' animate-spin' : '')}
            />{' '}
            Refresh
          </button>
          <button
            type="button"
            className="btn-ghost text-xs text-red-600"
            onClick={onRemove}
            title="Remove this shipment row"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {shipment.sourceEmailIds.length > 0 && (
        <div className="flex flex-wrap gap-1 text-[10px] uppercase tracking-widest text-ink-500">
          {shipment.sourceEmailIds.slice(0, 6).map((id) => (
            <Link
              key={id}
              to={`/e/${id}`}
              className="rounded bg-ink-100 px-1.5 py-0.5 hover:bg-ink-200 dark:bg-ink-800 dark:hover:bg-ink-700"
              title="Source email"
            >
              email
            </Link>
          ))}
          {shipment.sourceEmailIds.length > 6 && (
            <span>+{shipment.sourceEmailIds.length - 6}</span>
          )}
        </div>
      )}

      {shipment.history.length > 0 && (
        <details className="text-xs text-ink-500">
          <summary className="cursor-pointer select-none">
            History · {shipment.history.length}
          </summary>
          <ol className="mt-2 space-y-1 border-l border-ink-200 pl-3 dark:border-ink-800">
            {shipment.history.slice(0, 25).map((h, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-0.5 block">
                  <StatusBadge status={h.status} small />
                </span>
                <div className="min-w-0">
                  <div className="text-[12px] text-ink-700 dark:text-ink-200">
                    {h.description || StatusLabels[h.status]}
                  </div>
                  <div className="text-[10px] text-ink-500">
                    {h.at ? new Date(h.at).toLocaleString() : 'no timestamp'}
                    {h.location ? ` · ${h.location}` : ''}
                    {h.source === 'carrier-api' ? ' · carrier' : ' · email'}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}
    </li>
  );
}

function StatusBadge({ status, small }: { status: ShipmentStatus; small?: boolean }) {
  const cls = small
    ? 'inline-flex h-4 w-4 items-center justify-center rounded-full'
    : 'inline-flex h-5 w-5 items-center justify-center rounded-full';
  switch (status) {
    case 'delivered':
      return (
        <span className={cls + ' bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'}>
          <CheckCircle2 className={small ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
        </span>
      );
    case 'out_for_delivery':
      return (
        <span className={cls + ' bg-rose-500/15 text-rose-600 dark:text-rose-300'}>
          <Truck className={small ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
        </span>
      );
    case 'exception':
      return (
        <span className={cls + ' bg-amber-500/15 text-amber-700 dark:text-amber-300'}>
          <AlertTriangle className={small ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
        </span>
      );
    case 'returned':
      return (
        <span className={cls + ' bg-ink-300/40 text-ink-700 dark:text-ink-200'}>
          <RotateCcw className={small ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
        </span>
      );
    case 'in_transit':
      return (
        <span className={cls + ' bg-sky-500/15 text-sky-600 dark:text-sky-300'}>
          <Truck className={small ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
        </span>
      );
    default:
      return (
        <span className={cls + ' bg-ink-200/60 text-ink-600 dark:bg-ink-800 dark:text-ink-300'}>
          <Clock className={small ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
        </span>
      );
  }
}

const STATUS_ORDER: ShipmentStatus[] = [
  'out_for_delivery',
  'in_transit',
  'exception',
  'detected',
  'unknown',
  'delivered',
  'returned',
];

function groupShipments(shipments: ShipmentRow[]): {
  status: ShipmentStatus;
  shipments: ShipmentRow[];
}[] {
  const buckets = new Map<ShipmentStatus, ShipmentRow[]>();
  for (const s of shipments) {
    const arr = buckets.get(s.status) ?? [];
    arr.push(s);
    buckets.set(s.status, arr);
  }
  return STATUS_ORDER.filter((k) => buckets.has(k)).map((status) => ({
    status,
    shipments: buckets.get(status)!,
  }));
}
