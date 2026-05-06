import { describe, it, expect } from 'vitest';
import {
  hostnameAdapterLabel,
  normaliseSubjectKey,
} from '../lib/sourceLabel.js';

describe('hostnameAdapterLabel', () => {
  it('strips wikipedia language subdomain', () => {
    expect(hostnameAdapterLabel('https://en.wikipedia.org/wiki/Inception')).toBe('wikipedia');
    expect(hostnameAdapterLabel('https://es.wikipedia.org/wiki/Inception')).toBe('wikipedia');
  });

  it('strips www. and TLD for plain hosts', () => {
    expect(hostnameAdapterLabel('https://www.openalex.org/works/W123')).toBe('openalex');
    expect(hostnameAdapterLabel('https://api.crossref.org/works/10.1/x')).toBe('crossref');
  });

  it('handles bare hostnames without TLDs', () => {
    expect(hostnameAdapterLabel('http://localhost')).toBe('localhost');
  });

  it('returns "source" for unparseable URLs (never literal "unknown")', () => {
    expect(hostnameAdapterLabel('not-a-url')).toBe('source');
    expect(hostnameAdapterLabel('')).toBe('source');
  });
});

describe('normaliseSubjectKey', () => {
  it('whitespace-collapses and lowercases', () => {
    expect(normaliseSubjectKey('  Wait Wait... Don\'t Tell Me!  ')).toBe(
      "wait wait... don't tell me!",
    );
    expect(normaliseSubjectKey('Bill   Walsh')).toBe('bill walsh');
  });

  it('treats falsy input as empty string', () => {
    expect(normaliseSubjectKey('')).toBe('');
    expect(normaliseSubjectKey(undefined as unknown as string)).toBe('');
  });
});
