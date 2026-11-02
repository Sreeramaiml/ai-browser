import { describe, it, expect } from 'vitest';
import {
  FindSchema, SummarySchema, VideoSummarySchema, validateFind, validateSummary, validateVideoSummary
} from '../src/shared/schemas.js';

describe('validateVideoSummary (EC-YT-08, EC-YT-09)', () => {
  const base = { tldr: 'A talk about plants.', keyPoints: ['1', '2', '3', '4', '5'], nextSteps: ['Watch part 2'] };

  it('keeps valid chapters, sorted and de-duplicated', () => {
    const r = validateVideoSummary({ ...base, chapters: [
      { startSeconds: 120, title: 'Part B', notes: 'b' },
      { startSeconds: 0, title: 'Intro' },
      { startSeconds: 120, title: 'Duplicate start', notes: '' }
    ] });
    expect(r.ok).toBe(true);
    expect(r.value.chapters).toEqual([
      { startSeconds: 0, title: 'Intro', notes: '' },
      { startSeconds: 120, title: 'Part B', notes: 'b' }
    ]);
  });

  it('accepts "m:ss" and "h:mm:ss" strings and numeric strings as start times', () => {
    const r = validateVideoSummary({ ...base, chapters: [
      { startSeconds: '1:15', title: 'A' }, { startSeconds: '1:02:05', title: 'B' }, { startSeconds: '30', title: 'C' }
    ] });
    expect(r.value.chapters.map((c) => c.startSeconds)).toEqual([30, 75, 3725]);
  });

  it('drops negative, malformed, untitled and past-the-end chapters', () => {
    const r = validateVideoSummary({ ...base, chapters: [
      { startSeconds: -5, title: 'Neg' }, { startSeconds: 'soon', title: 'Bad' }, { startSeconds: 10, title: '  ' },
      { startSeconds: 50, title: 'Fine' }, { startSeconds: 400, title: 'Too late' }, null, 'x'
    ] }, { durationSeconds: 300 });
    expect(r.value.chapters).toEqual([{ startSeconds: 50, title: 'Fine', notes: '' }]);
  });

  it('allows an empty chapter list (the card hides it) but requires the array', () => {
    expect(validateVideoSummary({ ...base, chapters: [] }).ok).toBe(true);
    const missing = validateVideoSummary(base);
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/chapters/);
  });

  it('still enforces the base summary rules', () => {
    expect(validateVideoSummary({ ...base, keyPoints: ['1'], chapters: [] }).ok).toBe(false);
  });

  it('schema requires chapters', () => {
    expect(VideoSummarySchema.required).toEqual(['tldr', 'keyPoints', 'nextSteps', 'chapters']);
  });
});

const five = ['One', 'Two', 'Three', 'Four', 'Five'];
const valid = { tldr: 'A page about plants.', keyPoints: five, nextSteps: ['Read the FAQ'] };

describe('validateSummary (EC-ART-15, EC-ART-16)', () => {
  it('accepts a well-formed summary', () => {
    expect(validateSummary(valid)).toEqual({ ok: true, value: valid });
  });

  it('rejects 4 or 6 key points with a message that says how many there were', () => {
    const four = validateSummary({ ...valid, keyPoints: five.slice(0, 4) });
    expect(four.ok).toBe(false);
    expect(four.error).toMatch(/exactly 5 items, but it has 4/);
    expect(validateSummary({ ...valid, keyPoints: [...five, 'Six'] }).ok).toBe(false);
  });

  it('rejects a missing or empty TL;DR', () => {
    expect(validateSummary({ ...valid, tldr: '' }).ok).toBe(false);
    expect(validateSummary({ keyPoints: five, nextSteps: ['x'] }).ok).toBe(false);
  });

  it('rejects an overly long TL;DR', () => {
    expect(validateSummary({ ...valid, tldr: 'word '.repeat(120) }).ok).toBe(false);
  });

  it('rejects non-objects and wrong types', () => {
    expect(validateSummary(null).ok).toBe(false);
    expect(validateSummary('text').ok).toBe(false);
    expect(validateSummary([valid]).ok).toBe(false);
    expect(validateSummary({ ...valid, keyPoints: 'one, two' }).ok).toBe(false);
    expect(validateSummary({ ...valid, keyPoints: [1, 2, 3, 4, 5] }).ok).toBe(false);
  });

  it('drops empty items before counting (so 5 real points + 1 blank is fine)', () => {
    const r = validateSummary({ ...valid, keyPoints: [...five, '   '] });
    expect(r.ok).toBe(true);
    expect(r.value.keyPoints).toEqual(five);
  });

  it('needs at least one next step, and keeps at most three', () => {
    expect(validateSummary({ ...valid, nextSteps: [] }).ok).toBe(false);
    expect(validateSummary({ ...valid, nextSteps: ['  '] }).ok).toBe(false);
    expect(validateSummary({ ...valid, nextSteps: ['a', 'b', 'c', 'd'] }).value.nextSteps).toEqual(['a', 'b', 'c']);
  });

  it('strips list markers the model adds but keeps real leading numbers', () => {
    const r = validateSummary({ ...valid, keyPoints: ['1. One', '- Two', '• Three', '4) Four', '3 million people use it'] });
    expect(r.value.keyPoints).toEqual(['One', 'Two', 'Three', 'Four', '3 million people use it']);
  });

  it('trims whitespace', () => {
    expect(validateSummary({ ...valid, tldr: '  A page.  ' }).value.tldr).toBe('A page.');
  });
});

describe('SummarySchema', () => {
  it('requires all three fields', () => {
    expect(SummarySchema.required).toEqual(['tldr', 'keyPoints', 'nextSteps']);
  });
});

describe('validateFind (P3.4)', () => {
  const ids = new Set([1, 2, 8]);
  const check = (value) => validateFind(value, { ids });

  it('accepts a target that is in the snapshot', () => {
    expect(check({ target: 8, reason: ' The only file upload. ', confidence: 'high' }))
      .toEqual({ ok: true, value: { target: 8, reason: 'The only file upload.', confidence: 'high' } });
  });

  it('accepts null for "nothing matches"', () => {
    expect(check({ target: null, reason: 'No sort control here.', confidence: 'medium' }))
      .toEqual({ ok: true, value: { target: null, reason: 'No sort control here.', confidence: 'medium' } });
    expect(check({ target: 'null', reason: 'x', confidence: 'low' }).value.target).toBeNull();
  });

  it('rejects a number that is not on the page, saying so for the repair re-ask', () => {
    const r = check({ target: 42, reason: 'x', confidence: 'high' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/42 is not one of the \[numbered\] elements/);
    expect(check({ target: 0, reason: 'x', confidence: 'high' }).ok).toBe(false);
    expect(check({ target: 1.5, reason: 'x', confidence: 'high' }).ok).toBe(false);
  });

  it('accepts "8" and "[8]" as the number 8', () => {
    expect(check({ target: '8', reason: 'x', confidence: 'high' }).value.target).toBe(8);
    expect(check({ target: '[8]', reason: 'x', confidence: 'high' }).value.target).toBe(8);
    expect(check({ target: 'the upload box', reason: 'x', confidence: 'high' }).ok).toBe(false);
  });

  it('requires target, a reason, and a known confidence', () => {
    expect(check({ reason: 'x', confidence: 'high' }).ok).toBe(false);
    expect(check({ target: 1, reason: '  ', confidence: 'high' }).ok).toBe(false);
    expect(check({ target: 1, reason: 'x', confidence: 'sure' }).ok).toBe(false);
    expect(check({ target: true, reason: 'x', confidence: 'high' }).ok).toBe(false);
    expect(check({ target: 1, reason: 'x', confidence: 'HIGH' }).value.confidence).toBe('high');
  });

  it('rejects non-objects and caps long reasons', () => {
    for (const bad of [null, [], 'x', 3]) expect(check(bad).ok).toBe(false);
    expect(check({ target: 1, reason: 'y'.repeat(500), confidence: 'low' }).value.reason).toHaveLength(300);
  });

  it('schema requires all three fields and lets target be null', () => {
    expect(FindSchema.required).toEqual(['target', 'reason', 'confidence']);
    expect(FindSchema.properties.target).toMatchObject({ type: 'INTEGER', nullable: true });
    expect(FindSchema.properties.confidence.enum).toEqual(['high', 'medium', 'low']);
  });
});
