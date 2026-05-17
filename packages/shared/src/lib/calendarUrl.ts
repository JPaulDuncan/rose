/**
 * Normalise whatever URL the user pasted into a fetchable HTTPS
 * iCalendar feed endpoint. Three shapes are accepted:
 *
 *   1. Google share link with `?cid=<base64>`. We decode the cid
 *      (it's base64 of the calendar ID, usually the owner's email)
 *      and build the public ICS endpoint. Only works against
 *      calendars the owner has explicitly made public; private
 *      calendars still need the OAuth path.
 *   2. `webcal://` URL — the legacy iCal subscription scheme.
 *      Identical to https for our purposes; swap the protocol.
 *   3. Direct `http(s)://` URL pointing at an ICS feed — returned
 *      verbatim. No path-extension check because modern services
 *      use opaque token paths with no `.ics` suffix.
 *
 * Throws on invalid input so callers can return a useful error
 * rather than persist an unreachable URL.
 */

export class InvalidCalendarUrlError extends Error {
  override name = 'InvalidCalendarUrlError';
}

const GOOGLE_PUBLIC_ICS_BASE = 'https://calendar.google.com/calendar/ical/';

export function normalizeCalendarUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new InvalidCalendarUrlError('Empty URL');

  let normalised = raw;
  if (/^webcal:\/\//i.test(normalised)) {
    normalised = 'https://' + normalised.slice('webcal://'.length);
  } else if (/^webcals:\/\//i.test(normalised)) {
    normalised = 'https://' + normalised.slice('webcals://'.length);
  }

  let url: URL;
  try {
    url = new URL(normalised);
  } catch {
    throw new InvalidCalendarUrlError('Not a parseable URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new InvalidCalendarUrlError('Unsupported scheme: ' + url.protocol);
  }

  // Google share-link → public ICS endpoint.
  if (
    (url.hostname === 'calendar.google.com' ||
      url.hostname === 'www.google.com' ||
      url.hostname.endsWith('.google.com')) &&
    url.searchParams.has('cid')
  ) {
    const cid = url.searchParams.get('cid') ?? '';
    const decoded = decodeBase64Cid(cid);
    if (!decoded) {
      throw new InvalidCalendarUrlError(
        'Google share link is missing a decodable cid value',
      );
    }
    return GOOGLE_PUBLIC_ICS_BASE + encodeURIComponent(decoded) + '/public/basic.ics';
  }

  return url.toString();
}

/**
 * Google's `cid` is URL-safe base64 of the calendar ID; for personal
 * calendars this is the owner's email. Buffer accepts both standard
 * and URL-safe alphabets; we still pad to a multiple of 4 because
 * some share links strip the trailing `=` characters.
 *
 * Returns null when the result looks like binary garbage (i.e. the
 * caller passed something that wasn't actually base64).
 */
function decodeBase64Cid(cid: string): string | null {
  if (!cid) return null;
  const padding = (4 - (cid.length % 4)) % 4;
  const padded = cid + '='.repeat(padding);
  let decoded: string;
  try {
    decoded = Buffer.from(padded, 'base64').toString('utf-8').trim();
  } catch {
    return null;
  }
  if (!decoded) return null;
  // Reject decoded values that contain ASCII control bytes — a
  // mistyped paste decodes to something high-bit-y that we don't
  // want to round-trip into a URL path.
  for (let i = 0; i < decoded.length; i += 1) {
    const code = decoded.charCodeAt(i);
    if (code < 0x20 && code !== 0x09) return null;
  }
  return decoded;
}
