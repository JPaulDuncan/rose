/**
 * Minimal RFC 5545 (iCalendar) parser. Extracts VEVENT entries with
 * the fields Rose's CalendarEvent collection needs: UID, SUMMARY,
 * DTSTART, DTEND, LOCATION, DESCRIPTION. Deliberately small — we
 * don't pull in `ical.js` or `node-ical` because:
 *
 *   • The full spec includes VTIMEZONE expansion, RRULE / EXDATE
 *     recurrence rules, alarm rules, attachment binary blobs, and
 *     a dozen other features we don't surface today.
 *   • For non-OAuth calendar subscriptions ("share via link"), the
 *     master event is usually enough — the user is subscribing to
 *     "this calendar's events" not "this calendar with full
 *     recurrence expansion in the user's tz." If they need
 *     RRULE expansion they can use the OAuth-based `gcal` source.
 *   • Bundling 250KB of parser code for six fields is a poor
 *     trade-off.
 *
 * When v2 lands recurrence expansion, swap this for `rrule` (smaller
 * than ical.js and recurrence-only) and keep the rest of this file
 * intact — the call sites only care about the `IcsEvent` shape.
 */

export type IcsEvent = {
  uid: string;
  summary: string;
  start: Date | null;
  end: Date | null;
  allDay: boolean;
  location: string;
  description: string;
  /** True when an RRULE was declared. We don't expand; the master
   *  event still gets ingested so the user sees *something*. */
  hasRecurrence: boolean;
};

export type IcsCalendar = {
  /** X-WR-CALNAME or PRODID — display name for the source. */
  name: string | null;
  events: IcsEvent[];
};

/**
 * Unfold the RFC 5545 line-continuation convention. Lines starting
 * with a space or tab are continuations of the previous line; they
 * get joined with the separator stripped.
 */
function unfold(raw: string): string[] {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * Parse a single property line into `{name, params, value}`. The
 * line shape is `NAME;PARAM=value;PARAM=value:VALUE` where any
 * number of params can appear before the value. Values can contain
 * colons (URLs do) so we only split on the FIRST unquoted colon.
 */
type Property = { name: string; params: Record<string, string>; value: string };

function parseProperty(line: string): Property | null {
  if (!line) return null;
  // Find the first colon outside of quoted parameter values. Quoted
  // values in iCal use double-quotes and may not contain quotes
  // themselves (the spec disallows escaping inside DQUOTE).
  let colonIdx = -1;
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) {
      colonIdx = i;
      break;
    }
  }
  if (colonIdx < 0) return null;
  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);

  const parts = head.split(';');
  const name = (parts.shift() ?? '').toUpperCase();
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

/**
 * RFC 5545 date and date-time values. Three shapes:
 *   - `YYYYMMDD` (date-only, all-day event)
 *   - `YYYYMMDDTHHMMSS` (floating local time; tz is in TZID param)
 *   - `YYYYMMDDTHHMMSSZ` (UTC, trailing Z)
 *
 * We treat date-only as midnight UTC for the event start. For
 * tzid-bearing times we don't resolve the timezone (would require
 * VTIMEZONE expansion) — we ingest the wall-clock time as UTC and
 * note `allDay=false`. Imperfect, but rendering can still be useful
 * because most public-calendar consumers display their own
 * timezone anyway.
 */
function parseIcsDate(
  value: string,
  params: Record<string, string>,
): { date: Date | null; allDay: boolean } {
  const isDateOnly = params.VALUE === 'DATE' || /^\d{8}$/.test(value);
  if (isDateOnly) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (!m) return { date: null, allDay: true };
    const [, y, mo, d] = m;
    const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
    return { date: Number.isFinite(date.getTime()) ? date : null, allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return { date: null, allDay: false };
  const [, y, mo, d, h, mi, s, z] = m;
  // Floating + tzid-bearing both fall through to UTC interpretation
  // — see the function doc. Z-suffixed times are explicitly UTC.
  void z;
  const date = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
  );
  return { date: Number.isFinite(date.getTime()) ? date : null, allDay: false };
}

/**
 * Unescape RFC 5545 TEXT-typed values (`\n` → newline, `\,` →
 * comma, `\;` → semicolon, `\\` → backslash). SUMMARY, DESCRIPTION,
 * and LOCATION are all TEXT-typed.
 */
function unescapeText(s: string): string {
  return s
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

export function parseIcs(raw: string): IcsCalendar {
  const lines = unfold(raw);
  let calName: string | null = null;
  const events: IcsEvent[] = [];
  let current: Partial<IcsEvent> | null = null;
  // Depth tracker: skip blocks we don't care about (VTIMEZONE,
  // VTODO, VJOURNAL, VALARM, etc) so a SUMMARY inside a nested
  // VALARM doesn't overwrite the event's own.
  const blockStack: string[] = [];
  let prodId: string | null = null;

  for (const line of lines) {
    const prop = parseProperty(line);
    if (!prop) continue;

    if (prop.name === 'BEGIN') {
      blockStack.push(prop.value);
      if (prop.value === 'VEVENT' && blockStack.length === 2) {
        current = { hasRecurrence: false };
      }
      continue;
    }
    if (prop.name === 'END') {
      const closing = blockStack.pop();
      if (closing === 'VEVENT' && current) {
        if (current.uid) {
          events.push({
            uid: current.uid,
            summary: current.summary ?? '',
            start: current.start ?? null,
            end: current.end ?? null,
            allDay: current.allDay ?? false,
            location: current.location ?? '',
            description: current.description ?? '',
            hasRecurrence: current.hasRecurrence ?? false,
          });
        }
        current = null;
      }
      continue;
    }

    // Calendar-level metadata while we're inside VCALENDAR but not
    // yet in a child block.
    if (blockStack.length === 1 && blockStack[0] === 'VCALENDAR') {
      if (prop.name === 'X-WR-CALNAME') calName = unescapeText(prop.value).trim();
      else if (prop.name === 'PRODID') prodId = unescapeText(prop.value).trim();
      continue;
    }

    // Per-event properties — only when we're directly inside VEVENT,
    // not inside a nested VALARM.
    if (!current || blockStack[blockStack.length - 1] !== 'VEVENT') continue;

    switch (prop.name) {
      case 'UID':
        current.uid = prop.value.trim();
        break;
      case 'SUMMARY':
        current.summary = unescapeText(prop.value);
        break;
      case 'LOCATION':
        current.location = unescapeText(prop.value);
        break;
      case 'DESCRIPTION':
        current.description = unescapeText(prop.value);
        break;
      case 'DTSTART': {
        const { date, allDay } = parseIcsDate(prop.value, prop.params);
        current.start = date;
        current.allDay = allDay;
        break;
      }
      case 'DTEND': {
        const { date } = parseIcsDate(prop.value, prop.params);
        current.end = date;
        break;
      }
      case 'RRULE':
        current.hasRecurrence = true;
        break;
      default:
        break;
    }
  }

  return { name: calName ?? prodId, events };
}
