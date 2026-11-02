import { describe, it, expect } from 'vitest';
import { GAP_MARKER, extractKeywords, scoreChunks, selectRelevant, splitIntoChunks } from '../src/shared/chunking.js';

describe('splitIntoChunks', () => {
  it('packs whole lines into chunks no longer than the size', () => {
    const text = Array.from({ length: 50 }, (_, i) => `Line ${i} ${'x'.repeat(80)}`).join('\n');
    const chunks = splitIntoChunks(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    expect(chunks.join('\n')).toBe(text);
  });

  it('splits an over-long line at sentence ends', () => {
    const sentence = `${'word '.repeat(30).trim()}.`; // 150 chars
    const chunks = splitIntoChunks(Array(10).fill(sentence).join(' '), 400);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(400);
      expect(c.endsWith('.')).toBe(true);
    }
  });

  it('hard-cuts text with no sentence breaks, and skips blank lines', () => {
    expect(splitIntoChunks('a'.repeat(1000), 400).map((c) => c.length)).toEqual([400, 400, 200]);
    expect(splitIntoChunks('a\n\n\n  \nb', 100)).toEqual(['a\nb']);
  });
});

describe('extractKeywords', () => {
  it('drops question words and stopwords', () => {
    expect(extractKeywords('What is the capital of France?')).toHaveLength(2);
    expect(extractKeywords('What is this page about?')).toEqual([]);
  });

  it('matches plural and past forms to the base word', () => {
    expect(extractKeywords('prices')).toEqual(extractKeywords('price'));
    expect(extractKeywords('caused')).toEqual(extractKeywords('cause'));
    expect(extractKeywords('studies')).toEqual(extractKeywords('study'));
    expect(extractKeywords('class status')).toEqual(['class', 'status']);
  });

  it('ignores Hinglish filler words (EC-CHT-06)', () => {
    expect(extractKeywords('iska price kya hai?')).toEqual(extractKeywords('price'));
  });

  it('keeps numbers and Devanagari words', () => {
    expect(extractKeywords('What happened in 1947?')).toContain('1947');
    expect(extractKeywords('दिल्ली की आबादी कितनी है?')).toContain('दिल्ली');
  });
});

describe('scoreChunks', () => {
  it('scores chunks by matching keywords, repeated ones a little higher', () => {
    const scores = scoreChunks(['apples are red', 'bananas are yellow', 'apples and more apples'], extractKeywords('apples'));
    expect(scores[1]).toBe(0);
    expect(scores[0]).toBeGreaterThan(0);
    expect(scores[2]).toBeGreaterThan(scores[0]);
  });
});

describe('selectRelevant', () => {
  const filler = (i) => `Lorem ipsum dolor sit amet ${i} `.padEnd(150, 'z');
  const lines = ['Intro: this page is about gardening.'];
  for (let i = 0; i < 10; i++) lines.push(filler(i));
  lines.push('The tomato harvest begins in August.');
  for (let i = 10; i < 20; i++) lines.push(filler(i));
  const page = lines.join('\n');
  const budget = 600;

  it('returns short pages unchanged', () => {
    expect(selectRelevant('A short page.', 'anything', 100)).toEqual({ text: 'A short page.', truncated: false });
  });

  it('keeps the head, adds the chunk that answers the question, and marks the gaps', () => {
    const r = selectRelevant(page, 'When does the tomato harvest begin?', budget, { chunkChars: 200 });
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith('Intro: this page is about gardening.')).toBe(true);
    expect(r.text).toContain('The tomato harvest begins in August.');
    expect(r.text).toContain(GAP_MARKER);
    expect(r.text).not.toContain('amet 5 ');
    expect(r.text.length).toBeLessThanOrEqual(budget + GAP_MARKER.length);
  });

  it('with no useful keywords, fills the budget from the top of the page', () => {
    const r = selectRelevant(page, 'What is this page about?', budget, { chunkChars: 200 });
    expect(r.text.endsWith(GAP_MARKER.trimEnd())).toBe(true);
    expect(r.text.slice(0, -GAP_MARKER.trimEnd().length)).not.toContain('[…]');
    expect(r.text).toContain('amet 1 ');
    expect(r.text).not.toContain('tomato');
  });
});
