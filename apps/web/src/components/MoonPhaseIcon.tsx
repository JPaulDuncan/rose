import { type MoonPhase, MOON_PHASE_LABEL } from '@rose/shared';

const PHASE_GLYPH: Record<MoonPhase, string> = {
  new: '🌑',
  'waxing-crescent': '🌒',
  'first-quarter': '🌓',
  'waxing-gibbous': '🌔',
  full: '🌕',
  'waning-gibbous': '🌖',
  'last-quarter': '🌗',
  'waning-crescent': '🌘',
};

/**
 * Moon-phase glyph rendered as a Unicode emoji. Recognizable at every
 * size, no SVG compositing pitfalls. The OS renderer picks the style
 * (colorful on Apple, line-art on Windows) — that's a feature not a
 * bug; users opt into the icon and get whatever their platform draws.
 */
export function MoonPhaseIcon({
  phase,
  size = 16,
  className,
  title,
}: {
  phase: MoonPhase;
  size?: number;
  className?: string;
  title?: string;
}) {
  const label = title ?? MOON_PHASE_LABEL[phase];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={className}
      style={{ fontSize: `${size}px`, lineHeight: 1, display: 'inline-block' }}
    >
      {PHASE_GLYPH[phase]}
    </span>
  );
}
