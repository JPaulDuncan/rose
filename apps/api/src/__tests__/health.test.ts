import { describe, it, expect } from 'vitest';
import { renderTemplate, extractVariables, extractJson } from '@rose/llm';

describe('llm helpers', () => {
  it('renderTemplate substitutes mustache vars', () => {
    expect(renderTemplate('Hello {{name}}', { name: 'world' })).toBe('Hello world');
  });

  it('renderTemplate leaves unknowns blank', () => {
    expect(renderTemplate('{{a}}-{{b}}', { a: 'x' })).toBe('x-');
  });

  it('extractVariables finds vars', () => {
    expect(extractVariables('a {{one}} b {{two}} {{one}}')).toEqual(['one', 'two']);
  });

  it('extractJson handles fenced and unfenced', () => {
    expect(extractJson<{ a: number }>('{"a":1}').a).toBe(1);
    expect(extractJson<{ a: number }>('```json\n{"a":2}\n```').a).toBe(2);
    expect(extractJson<{ a: number }>('Some words {"a":3} done').a).toBe(3);
  });
});
