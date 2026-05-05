import { describe, it, expect } from 'vitest';
import {
  DaydreamSynthesisOutput,
  DaydreamSettings,
  DaydreamSettingsUpdate,
} from '@rose/shared';

/**
 * The synthesis output schema is the load-bearing piece for the
 * prompt-injection defense in plan 09: a model that ignores the
 * "JSON only" instruction or invents extra fields fails this parse,
 * so the worker drops the result rather than persisting attacker-
 * controlled content. Tests below pin the contract.
 */
describe('DaydreamSynthesisOutput', () => {
  it('accepts a well-formed synthesis', () => {
    const ok = {
      displayName: 'Rust (programming language)',
      summary: 'Multi-paradigm systems language emphasising memory safety.',
      bodyMd: 'Rust is a multi-paradigm, general-purpose programming language…',
      usedSources: [0, 1],
      confidence: 'high' as const,
    };
    expect(DaydreamSynthesisOutput.safeParse(ok).success).toBe(true);
  });

  it('rejects a summary over the cap', () => {
    const bad = {
      displayName: 'X',
      summary: 'a'.repeat(500),
      bodyMd: 'short',
      usedSources: [],
      confidence: 'medium' as const,
    };
    expect(DaydreamSynthesisOutput.safeParse(bad).success).toBe(false);
  });

  it('rejects a confidence value outside the enum', () => {
    const bad = {
      displayName: 'X',
      summary: 'short',
      bodyMd: 'short',
      usedSources: [],
      confidence: 'extreme',
    };
    expect(DaydreamSynthesisOutput.safeParse(bad).success).toBe(false);
  });

  it('rejects a missing required field', () => {
    const bad = {
      summary: 'short',
      bodyMd: 'short',
      confidence: 'low' as const,
    };
    expect(DaydreamSynthesisOutput.safeParse(bad).success).toBe(false);
  });

  it('defaults usedSources to [] when omitted', () => {
    const r = DaydreamSynthesisOutput.parse({
      displayName: 'X',
      summary: 's',
      bodyMd: 'b',
      confidence: 'low' as const,
    });
    expect(r.usedSources).toEqual([]);
  });
});

/**
 * The settings shape feeds the UI form state. Tests ensure that
 * defaults populate when the database hasn't seen the field yet
 * (legacy users) and that the patch shape allows partial updates
 * without blowing away siblings.
 */
describe('DaydreamSettings', () => {
  it('parses an empty-ish object into documented defaults', () => {
    // Top-level fields with .default() ARE optional, but the
    // object-typed branches (sources, skip, externalSearch) require
    // their inner objects to be present; each inner object is then
    // happy with `{}` because every leaf field has a default.
    const cfg = DaydreamSettings.parse({
      sources: {
        wikipedia: {},
        wiktionary: {},
        wikidata: {},
        openalex: {},
        linkGraph: {},
        stackexchange: {},
        arxiv: {},
        hackernews: {},
        crossref: {},
        github: {},
      },
      skip: {},
      externalSearch: {
        marginalia: {},
        duckduckgo: {},
        brave: {},
        searxng: {},
      },
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.schedule).toBe('idle');
    expect(cfg.dailyCallCap).toBe(50);
    expect(cfg.sources.wikipedia.enabled).toBe(true);
    expect(cfg.sources.wikidata.enabled).toBe(false);
    expect(cfg.externalSearch.enabled).toBe(false);
    expect(cfg.externalSearch.marginalia.enabled).toBe(true);
  });
});

describe('DaydreamSettingsUpdate', () => {
  it('accepts a partial update with just one field', () => {
    const r = DaydreamSettingsUpdate.safeParse({ enabled: true });
    expect(r.success).toBe(true);
  });

  it('accepts a Brave apiKey set + clear shape', () => {
    const set = DaydreamSettingsUpdate.safeParse({
      externalSearch: { brave: { apiKey: 'BSAtoken' } },
    });
    expect(set.success).toBe(true);
    const clear = DaydreamSettingsUpdate.safeParse({
      externalSearch: { brave: { apiKey: null } },
    });
    expect(clear.success).toBe(true);
  });

  it('rejects an empty Brave apiKey string', () => {
    // Empty string would silently overwrite to "" if accepted; the
    // schema requires non-empty for set, null for clear.
    const r = DaydreamSettingsUpdate.safeParse({
      externalSearch: { brave: { apiKey: '' } },
    });
    expect(r.success).toBe(false);
  });
});
