import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export type MapPin = {
  lat: number;
  lon: number;
  label: string;
  /** Optional in-app navigation target. Click on a pin navigates here. */
  href?: string;
};

/**
 * Parse the `height` prop into integer pixels for the static
 * snapshot URL. Strings like "180px" or "12rem" are coerced; the
 * latter falls back to 200px since the static endpoint needs an
 * integer pixel count.
 */
function parseHeightPx(h: string): number {
  const m = /^(\d+)px$/.exec(h.trim());
  if (m) return Math.max(48, Math.min(1024, Number(m[1])));
  return 200;
}

/**
 * Read-only Leaflet inset. Plan 11.
 *
 * - Tiles: CARTO Voyager raster (free, no key, OSM-attributed).
 * - Markers: inline SVG so we don't deal with Leaflet's default-icon
 *   image-path dance under bundlers.
 * - Auto-fits bounds to all pins. Single pin → reasonable fixed
 *   zoom (z=12). Empty pin list renders nothing.
 *
 * Plan 18 — single-pin views now render a static PNG snapshot
 * served by `/api/maps/static` instead of mounting Leaflet on every
 * page navigation. The snapshot is cached in Redis (long TTL —
 * places don't move) AND in the browser's HTTP cache (immutable),
 * so a page that's been viewed once renders its map with zero
 * tile loads from then on. Multi-pin views still use the live
 * Leaflet map; static-image multi-pin overlays could come later.
 */
export function MapInset({
  pins,
  height = '180px',
  className,
}: {
  pins: MapPin[];
  height?: string;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();
  // Track image-load failure so we can transparently fall back to
  // the live Leaflet map when the static endpoint is disabled
  // (Settings → Maps off) or the upstream is unreachable.
  const [staticFailed, setStaticFailed] = useState(false);

  // Single-pin static snapshot path. Skips the Leaflet effect
  // entirely so the page doesn't pay the bundle/tile-load cost.
  const useStatic = pins.length === 1 && !staticFailed;

  useEffect(() => {
    if (useStatic) return;
    const el = containerRef.current;
    if (!el || pins.length === 0) return;

    const map = L.map(el, {
      // Read-only inset. Disable scroll-wheel zoom so the map
      // doesn't hijack page scrolling; users can still drag-pan
      // and tap zoom controls.
      scrollWheelZoom: false,
      zoomControl: true,
      attributionControl: true,
    });

    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
      {
        // CARTO requires the OSM + CARTO attribution combo. Plain
        // text — Leaflet renders it inside its attribution control.
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright" rel="noreferrer">OSM</a> &copy; <a href="https://carto.com/attributions" rel="noreferrer">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19,
      },
    ).addTo(map);

    const icon = L.divIcon({
      className: 'rose-pin',
      html: `
        <svg width="24" height="32" viewBox="0 0 24 32" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20c0-6.6-5.4-12-12-12z" fill="#e11d48"/>
          <circle cx="12" cy="12" r="4.5" fill="white"/>
        </svg>`,
      iconSize: [24, 32],
      iconAnchor: [12, 32],
      popupAnchor: [0, -28],
    });

    const markers: L.Marker[] = [];
    for (const p of pins) {
      const m = L.marker([p.lat, p.lon], { icon, title: p.label });
      m.bindTooltip(p.label, { direction: 'top', offset: [0, -28] });
      if (p.href) {
        m.on('click', () => {
          // Same-window in-app navigation. External links can be
          // added by callers via a different prop in a later
          // iteration; Tier A only links to internal routes.
          navigate(p.href!);
        });
      }
      m.addTo(map);
      markers.push(m);
    }

    if (markers.length === 1) {
      const only = markers[0]!.getLatLng();
      map.setView(only, 12);
    } else {
      const group = L.featureGroup(markers);
      map.fitBounds(group.getBounds(), { padding: [16, 16], maxZoom: 14 });
    }

    return () => {
      map.remove();
    };
  }, [pins, navigate, useStatic]);

  if (pins.length === 0) return null;

  if (useStatic) {
    const pin = pins[0]!;
    const heightPx = parseHeightPx(height);
    // Width is unknown without a layout pass; we ask the API for a
    // generous 800px wide image and let CSS scale it down. Cached
    // upstream so the size choice is paid for once.
    const src = `/api/maps/static?lat=${encodeURIComponent(
      pin.lat,
    )}&lon=${encodeURIComponent(pin.lon)}&zoom=12&w=800&h=${heightPx}`;
    const img = (
      <img
        src={src}
        alt={pin.label || 'Map'}
        loading="lazy"
        className="block h-full w-full object-cover"
        // Egress disabled or upstream down → fall through to Leaflet
        // on the next render. Avoids an infinite img-error loop by
        // setting state once.
        onError={() => setStaticFailed(true)}
      />
    );
    return (
      <div
        className={className}
        style={{ height }}
        role="region"
        aria-label="Map"
      >
        {pin.href ? (
          <Link to={pin.href} title={pin.label} className="block h-full w-full">
            {img}
          </Link>
        ) : (
          img
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ height }}
      role="region"
      aria-label="Map"
    />
  );
}
