import { describe, it, expect } from 'vitest';
import { normalizeCategoryName } from '@rose/db';

/**
 * Codex chapters dedupe via this helper. Regression here would
 * resurface the "Email Marketing / email marketing / email-marketing"
 * triple-listing bug from the case-insensitive cleanup.
 */
describe('normalizeCategoryName', () => {
  it('collapses casing and punctuation', () => {
    const variants = [
      'Email Marketing',
      'email marketing',
      'EMAIL-MARKETING',
      'email_marketing',
      '  email   marketing  ',
      'Email-Marketing!',
    ];
    const normalized = new Set(variants.map(normalizeCategoryName));
    expect(normalized.size).toBe(1);
    expect([...normalized][0]).toBe('email marketing');
  });

  it('handles unicode and digits', () => {
    expect(normalizeCategoryName('Tech 2024')).toBe('tech 2024');
    expect(normalizeCategoryName('Café+Roast')).toBe('caf roast'); // ascii-only filter
  });

  it('returns empty string for null/undefined input', () => {
    expect(normalizeCategoryName(null as unknown as string)).toBe('');
    expect(normalizeCategoryName(undefined as unknown as string)).toBe('');
    expect(normalizeCategoryName('')).toBe('');
  });
});
