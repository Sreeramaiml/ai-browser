import { describe, it, expect } from 'vitest';
import { checkHinglish, isAlreadyInTargetScript, isLanguage, otherLanguage, summaryText } from '../src/shared/language.js';

const HINGLISH = 'Photosynthesis woh process hai jismein plants sunlight se apna khana banate hain, aur isse oxygen bhi nikalti hai.';
const ENGLISH = 'Photosynthesis is the process by which plants use sunlight to make their own food and release oxygen into the air.';
const DEVANAGARI = 'प्रकाश संश्लेषण वह प्रक्रिया है जिससे पौधे भोजन बनाते हैं।';

describe('checkHinglish (EC-LNG-01, EC-LNG-02)', () => {
  it('accepts real Hinglish', () => {
    expect(checkHinglish(HINGLISH)).toEqual({ ok: true });
  });

  it('flags Devanagari script', () => {
    expect(checkHinglish(DEVANAGARI)).toEqual({ ok: false, problem: 'devanagari' });
    expect(checkHinglish(`${HINGLISH} ${DEVANAGARI}`)).toEqual({ ok: false, problem: 'devanagari' });
  });

  it('tolerates a quoted Devanagari name or two', () => {
    expect(checkHinglish(`${HINGLISH} (नमो)`)).toEqual({ ok: true });
  });

  it('flags long plain-English answers', () => {
    expect(checkHinglish(ENGLISH)).toEqual({ ok: false, problem: 'english' });
  });

  it('does not judge very short texts as English', () => {
    expect(checkHinglish('Mitochondria make energy.')).toEqual({ ok: true });
  });
});

describe('language helpers', () => {
  it('recognises supported languages only', () => {
    expect(isLanguage('en')).toBe(true);
    expect(isLanguage('hinglish')).toBe(true);
    expect(isLanguage('fr')).toBe(false);
    expect(isLanguage(undefined)).toBe(false);
  });

  it('switches between English and Hinglish', () => {
    expect(otherLanguage('en')).toBe('hinglish');
    expect(otherLanguage('hinglish')).toBe('en');
  });

  it('collects every user-visible summary string, including chapters', () => {
    const text = summaryText({ tldr: 'T', keyPoints: ['a', 'b'], nextSteps: ['n'], chapters: [{ title: 'c1', notes: 'x' }] });
    expect(text).toBe('T\na\nb\nn\nc1\nx');
  });
});

describe('isAlreadyInTargetScript (EC-CTX-10)', () => {
  it('spots text already written in the target script', () => {
    expect(isAlreadyInTargetScript(DEVANAGARI, 'hi')).toBe(true);
    expect(isAlreadyInTargetScript('வணக்கம், எப்படி இருக்கிறீர்கள்?', 'ta')).toBe(true);
    expect(isAlreadyInTargetScript('আমি ভালো আছি, ধন্যবাদ', 'bn')).toBe(true);
  });

  it('does not flag other scripts, mixed text, or very short snippets', () => {
    expect(isAlreadyInTargetScript(ENGLISH, 'hi')).toBe(false);
    expect(isAlreadyInTargetScript(DEVANAGARI, 'ta')).toBe(false);
    expect(isAlreadyInTargetScript(`${ENGLISH} (नमो)`, 'hi')).toBe(false);
    expect(isAlreadyInTargetScript('नमो', 'hi')).toBe(false);
  });

  it('never blocks translating into English, even Hinglish text', () => {
    expect(isAlreadyInTargetScript(ENGLISH, 'en')).toBe(false);
    expect(isAlreadyInTargetScript(HINGLISH, 'en')).toBe(false);
  });
});
