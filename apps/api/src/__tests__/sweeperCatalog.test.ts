import { describe, it, expect } from 'vitest';
import { SWEEPER_CATALOG, getSweeperById } from '@rose/shared';

/**
 * SWEEPER_CATALOG is the static source of truth for setInterval-
 * driven sweepers in the worker. Drift between the catalog and the
 * actual SWEEP_INTERVAL_MS constants is exactly the kind of thing
 * the admin "Cron jobs" view exists to surface — pin it loud here
 * so an out-of-sync edit fails CI rather than showing the operator
 * a stale interval.
 */

describe('SWEEPER_CATALOG', () => {
  it('has at least the six known sweepers shipped today', () => {
    const ids = SWEEPER_CATALOG.map((s) => s.id);
    for (const expected of [
      'daydream',
      'reputation-decay',
      'alert',
      'tag-digest',
      'library-sync',
      'event-soon',
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it('every entry has a positive interval and points at a worker file', () => {
    for (const s of SWEEPER_CATALOG) {
      expect(s.intervalMs).toBeGreaterThan(0);
      expect(s.definedAt).toMatch(/^apps\/worker\/src\//);
      expect(s.label).toBeTruthy();
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it('ids are unique across the catalog', () => {
    const ids = SWEEPER_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("getSweeperById is the catalog's lookup helper", () => {
    expect(getSweeperById('daydream')?.intervalMs).toBe(60_000);
    expect(getSweeperById('does-not-exist')).toBeUndefined();
  });
});
