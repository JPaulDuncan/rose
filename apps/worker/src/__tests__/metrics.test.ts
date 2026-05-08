import { describe, it, expect } from 'vitest';
import { inc, observe, setGauge, snapshot } from '../lib/metrics.js';

/**
 * Tests for the in-process metrics registry. The publisher loop
 * (Redis SET, SADD, periodic flush) is integration-flavoured and
 * not covered here; this suite keeps the counter / histogram /
 * gauge math honest so the diagnostics dashboard stays trustworthy.
 *
 * Note: the registry is module-level state — no reset/teardown
 * helper is exported (the registry survives the worker's lifetime).
 * Tests use unique metric names with a per-test prefix to avoid
 * cross-contamination.
 */

let testIdSeq = 0;
function uniq(name: string): string {
  testIdSeq += 1;
  return `test_${testIdSeq}_${name}`;
}

describe('inc', () => {
  it('accumulates a plain counter', () => {
    const k = uniq('plain');
    inc(k, 1);
    inc(k, 2);
    inc(k);
    const s = snapshot();
    expect(s.counters[k]).toBe(4);
  });

  it('keeps label sets distinct', () => {
    const base = uniq('labelled');
    inc(base, 1, { source: 'imap' });
    inc(base, 3, { source: 'gmail' });
    inc(base, 1, { source: 'imap' });
    const s = snapshot();
    expect(s.counters[`${base}|source=imap`]).toBe(2);
    expect(s.counters[`${base}|source=gmail`]).toBe(3);
    // Bare name (no labels) wasn't touched.
    expect(s.counters[base]).toBeUndefined();
  });

  it('serialises label keys in alphabetical order so the same labels always hash identically', () => {
    const k = uniq('order');
    inc(k, 1, { z: '1', a: '2' });
    inc(k, 1, { a: '2', z: '1' });
    const s = snapshot();
    expect(s.counters[`${k}|a=2,z=1`]).toBe(2);
  });
});

describe('observe', () => {
  it('records count, sum, and max on a histogram', () => {
    const k = uniq('hist');
    observe(k, 50);
    observe(k, 100);
    observe(k, 200);
    const s = snapshot();
    expect(s.histograms[k]?.count).toBe(3);
    expect(s.histograms[k]?.sum).toBe(350);
    expect(s.histograms[k]?.max).toBe(200);
  });

  it('computes percentiles roughly from the reservoir', () => {
    const k = uniq('pct');
    for (let i = 1; i <= 100; i += 1) observe(k, i);
    const s = snapshot().histograms[k]!;
    // Reservoir is bounded but at 100 < MAX_SAMPLES (1024) it has
    // every observation. p50 should land near 50, p95 near 95.
    expect(s.p50).toBeGreaterThanOrEqual(45);
    expect(s.p50).toBeLessThanOrEqual(55);
    expect(s.p95).toBeGreaterThanOrEqual(90);
    expect(s.p99).toBeGreaterThanOrEqual(95);
    expect(s.max).toBe(100);
  });

  it('keeps histogram label sets distinct from each other', () => {
    const base = uniq('multi');
    observe(base, 10, { outcome: 'ok' });
    observe(base, 20, { outcome: 'failed' });
    observe(base, 30, { outcome: 'ok' });
    const s = snapshot();
    expect(s.histograms[`${base}|outcome=ok`]?.count).toBe(2);
    expect(s.histograms[`${base}|outcome=failed`]?.count).toBe(1);
  });
});

describe('setGauge', () => {
  it('overwrites prior value', () => {
    const k = uniq('gauge');
    setGauge(k, 10);
    setGauge(k, 5);
    expect(snapshot().gauges[k]).toBe(5);
  });
});

describe('snapshot', () => {
  it('always returns the worker-identity fields', () => {
    const s = snapshot();
    expect(typeof s.workerId).toBe('string');
    expect(s.workerId.length).toBeGreaterThan(0);
    expect(typeof s.pid).toBe('number');
    expect(typeof s.uptimeSec).toBe('number');
    expect(s.uptimeSec).toBeGreaterThanOrEqual(0);
    // Memory + heap come from process.memoryUsage so they're > 0
    // any time Node is running.
    expect(s.rssBytes).toBeGreaterThan(0);
    expect(s.heapUsedBytes).toBeGreaterThan(0);
  });
});
