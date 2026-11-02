import { describe, it, expect } from 'vitest';
import { fitToBudget, hashString, parseModelJson } from '../src/shared/text.js';

describe('fitToBudget (EC-ART-04)', () => {
  it('leaves short text alone', () => {
    expect(fitToBudget('hello', 100)).toEqual({ text: 'hello', truncated: false });
  });

  it('keeps the start and the end of long text within the budget', () => {
    const text = 'A'.repeat(1000) + 'M'.repeat(1000) + 'Z'.repeat(1000);
    const { text: out, truncated } = fitToBudget(text, 1000);
    expect(truncated).toBe(true);
    expect(out.length <= 1000).toBe(true);
    expect(out.startsWith('AAAA')).toBe(true);
    expect(out.endsWith('ZZZZ')).toBe(true);
    expect(out).toContain('middle of the page omitted');
  });
});

describe('hashString', () => {
  it('is deterministic and sensitive to changes', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc') === hashString('abd')).toBe(false);
    expect(hashString('')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('parseModelJson', () => {
  it('parses plain JSON', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('strips ```json fences', () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('tolerates prose around the object', () => {
    expect(parseModelJson('Here you go: {"a": [1, 2]} Hope this helps!')).toEqual({ ok: true, value: { a: [1, 2] } });
  });

  it('reports missing or broken JSON', () => {
    expect(parseModelJson('no json here').ok).toBe(false);
    expect(parseModelJson('{"a": }').ok).toBe(false);
    expect(parseModelJson(undefined).ok).toBe(false);
  });
});
