import { describe, it, expect } from 'vitest';
import { cleanBody } from '../index.js';

describe('cleanBody', () => {
  it('strips quoted reply lines', () => {
    const input = `Hello,\n> Original message\n> stays out\nMy reply continues.`;
    const out = cleanBody(input);
    expect(out).toContain('Hello');
    expect(out).not.toContain('Original message');
    expect(out).toContain('My reply continues');
  });

  it('strips signature delimiter', () => {
    const input = `Body content\n\n-- \nName\nTitle`;
    const out = cleanBody(input);
    expect(out).toContain('Body content');
    expect(out).not.toContain('Name');
  });

  it('strips reply marker', () => {
    const input = `Reply text\n\nOn Mon, Apr 1 2026, Joe <joe@x> wrote:\nold stuff`;
    const out = cleanBody(input);
    expect(out).toContain('Reply text');
    expect(out).not.toContain('old stuff');
  });
});
