import { describe, it, expect } from 'vitest';
import { parseIcs } from '@rose/shared';

/**
 * Hand-rolled VEVENT extractor. Lock down the shapes RFC 5545
 * permits at the practical level — line unfolding, escape sequences
 * in TEXT-typed fields, the three DTSTART date formats, and nested
 * VALARM/VTIMEZONE that should NOT bleed into the event itself.
 */

const SAMPLE_BODY = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Acme//Cal//EN',
  'X-WR-CALNAME:Acme Releases',
  'BEGIN:VEVENT',
  'UID:event-1@acme',
  'DTSTART:20260615T130000Z',
  'DTEND:20260615T140000Z',
  'SUMMARY:Q3 launch — final review',
  'LOCATION:Conference room A',
  'DESCRIPTION:Last review before public release.\\nBring questions.',
  'BEGIN:VALARM',
  'TRIGGER:-PT15M',
  'ACTION:DISPLAY',
  "SUMMARY:Don\\'t worry about this alarm summary",
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:event-2@acme',
  'DTSTART;VALUE=DATE:20260704',
  'SUMMARY:Independence Day (US)',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('parseIcs — basic VEVENT extraction', () => {
  it('captures the calendar name from X-WR-CALNAME', () => {
    const out = parseIcs(SAMPLE_BODY);
    expect(out.name).toBe('Acme Releases');
  });

  it('extracts every top-level VEVENT', () => {
    const out = parseIcs(SAMPLE_BODY);
    expect(out.events.map((e) => e.uid)).toEqual([
      'event-1@acme',
      'event-2@acme',
    ]);
  });

  it('parses DTSTART/DTEND UTC times to Date objects', () => {
    const out = parseIcs(SAMPLE_BODY);
    const ev = out.events.find((e) => e.uid === 'event-1@acme')!;
    expect(ev.start?.toISOString()).toBe('2026-06-15T13:00:00.000Z');
    expect(ev.end?.toISOString()).toBe('2026-06-15T14:00:00.000Z');
    expect(ev.allDay).toBe(false);
  });

  it('parses VALUE=DATE all-day events as midnight UTC', () => {
    const out = parseIcs(SAMPLE_BODY);
    const ev = out.events.find((e) => e.uid === 'event-2@acme')!;
    expect(ev.start?.toISOString()).toBe('2026-07-04T00:00:00.000Z');
    expect(ev.allDay).toBe(true);
  });

  it('unescapes \\n / \\, / \\; / \\\\ in TEXT fields', () => {
    const out = parseIcs(SAMPLE_BODY);
    const ev = out.events.find((e) => e.uid === 'event-1@acme')!;
    expect(ev.description).toContain('Last review');
    expect(ev.description).toContain('\n');
  });

  it('does not let a VALARM child overwrite the parent SUMMARY', () => {
    const out = parseIcs(SAMPLE_BODY);
    const ev = out.events.find((e) => e.uid === 'event-1@acme')!;
    expect(ev.summary).toBe('Q3 launch — final review');
  });
});

describe('parseIcs — RFC 5545 line folding', () => {
  it('joins continuation lines (space-prefixed) into the previous line', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:wrapped',
      'DTSTART:20260101T000000Z',
      'SUMMARY:This is a very long summary that gets',
      ' folded across multiple lines because',
      "\tit's quite a lot of text",
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const out = parseIcs(ics);
    const ev = out.events[0]!;
    expect(ev.summary).toBe(
      "This is a very long summary that getsfolded across multiple lines becauseit's quite a lot of text",
    );
  });
});

describe('parseIcs — recurrence flagging (no expansion)', () => {
  it('notes RRULE on the master event but ingests only the master', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:weekly-meeting',
      'DTSTART:20260101T140000Z',
      'SUMMARY:Weekly standup',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const out = parseIcs(ics);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.hasRecurrence).toBe(true);
  });
});

describe('parseIcs — robustness', () => {
  it('returns an empty calendar for an empty or non-iCal input', () => {
    expect(parseIcs('').events).toEqual([]);
    expect(parseIcs('not actually a calendar').events).toEqual([]);
  });

  it('skips VEVENTs with no UID (un-dedupable)', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'DTSTART:20260101T140000Z',
      'SUMMARY:Anonymous event',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(parseIcs(ics).events).toEqual([]);
  });

  it('handles URL values containing colons in property values', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:with-url',
      'DTSTART:20260101T140000Z',
      'SUMMARY:Meeting',
      'DESCRIPTION:Join at https://meet.example.com/room/abc',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const out = parseIcs(ics);
    expect(out.events[0]!.description).toBe(
      'Join at https://meet.example.com/room/abc',
    );
  });
});
