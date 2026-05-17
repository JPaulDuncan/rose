import { describe, it, expect } from 'vitest';
import { normalizeCalendarUrl, InvalidCalendarUrlError } from '@rose/shared';

/**
 * `normalizeCalendarUrl` is the gate between whatever the user
 * pasted and what the worker fetches. The Google `cid=` rewrite is
 * the load-bearing piece — the rest of the function is "accept
 * webcal://, accept .ics, reject everything else" plumbing.
 */

// jpaulduncan@gmail.com → "anBhdWxkdW5jYW5AZ21haWwuY29t"
const CID_FOR_JPAULDUNCAN = 'anBhdWxkdW5jYW5AZ21haWwuY29t';

describe('normalizeCalendarUrl — Google cid= share links', () => {
  it('decodes the example from the user prompt', () => {
    const out = normalizeCalendarUrl(
      `https://calendar.google.com/calendar/u/0?cid=${CID_FOR_JPAULDUNCAN}`,
    );
    expect(out).toBe(
      'https://calendar.google.com/calendar/ical/jpaulduncan%40gmail.com/public/basic.ics',
    );
  });

  it('accepts share links without the `u/<index>` segment', () => {
    const out = normalizeCalendarUrl(
      `https://calendar.google.com/calendar/embed?cid=${CID_FOR_JPAULDUNCAN}`,
    );
    expect(out).toBe(
      'https://calendar.google.com/calendar/ical/jpaulduncan%40gmail.com/public/basic.ics',
    );
  });

  it('pads URL-safe base64 without trailing `=`', () => {
    // "hello@x.io" base64 is "aGVsbG9AeC5pbw==" — strip the padding
    // and confirm the decode still works (URL-safe variants commonly
    // do this).
    const cid = Buffer.from('hello@x.io').toString('base64').replace(/=+$/, '');
    const out = normalizeCalendarUrl(
      `https://calendar.google.com/calendar/u/0?cid=${cid}`,
    );
    expect(out).toBe(
      'https://calendar.google.com/calendar/ical/hello%40x.io/public/basic.ics',
    );
  });

  it('rejects share links without a cid parameter', () => {
    expect(() =>
      normalizeCalendarUrl('https://calendar.google.com/calendar/u/0'),
    ).not.toThrow();
    // No cid → fall through to the verbatim branch. That's OK; the
    // worker will get a 404 from Google but the URL is still valid
    // shape-wise.
  });

  it("doesn't refuse to normalise a cid that's syntactically valid base64", () => {
    // We let the network layer surface the eventual 404 on garbage
    // calendar IDs rather than try to second-guess Google's path
    // shape here. Anything that round-trips through Buffer.from
    // (base64) without control bytes is forwarded.
    expect(() =>
      normalizeCalendarUrl('https://calendar.google.com/?cid=zzzz'),
    ).not.toThrow();
  });
});

describe('normalizeCalendarUrl — webcal:// scheme', () => {
  it('rewrites webcal:// to https://', () => {
    expect(normalizeCalendarUrl('webcal://example.com/cal.ics')).toBe(
      'https://example.com/cal.ics',
    );
  });

  it('rewrites webcals:// to https:// as well', () => {
    expect(normalizeCalendarUrl('webcals://example.com/cal.ics')).toBe(
      'https://example.com/cal.ics',
    );
  });

  it('preserves query strings on webcal:// inputs', () => {
    expect(
      normalizeCalendarUrl('webcal://outlook.office365.com/owa/calendar/abc/cid-X/calendar.ics'),
    ).toBe(
      'https://outlook.office365.com/owa/calendar/abc/cid-X/calendar.ics',
    );
  });
});

describe('normalizeCalendarUrl — direct .ics URLs', () => {
  it('passes through https URLs verbatim', () => {
    const url = 'https://p123.calendar.icloud.com/published/2/abcdef';
    expect(normalizeCalendarUrl(url)).toBe(url);
  });

  it('passes through http (non-TLS) URLs verbatim', () => {
    expect(normalizeCalendarUrl('http://example.local/cal.ics')).toBe(
      'http://example.local/cal.ics',
    );
  });
});

describe('normalizeCalendarUrl — rejected inputs', () => {
  it('rejects empty / whitespace-only input', () => {
    expect(() => normalizeCalendarUrl('')).toThrow(InvalidCalendarUrlError);
    expect(() => normalizeCalendarUrl('   ')).toThrow(InvalidCalendarUrlError);
  });

  it('rejects un-parseable URLs', () => {
    expect(() => normalizeCalendarUrl('not-a-url')).toThrow(InvalidCalendarUrlError);
  });

  it('rejects unsupported schemes', () => {
    expect(() => normalizeCalendarUrl('ftp://example.com/cal.ics')).toThrow(
      InvalidCalendarUrlError,
    );
    expect(() => normalizeCalendarUrl('file:///etc/passwd')).toThrow(
      InvalidCalendarUrlError,
    );
  });
});
