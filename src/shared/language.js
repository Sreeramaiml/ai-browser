// @ts-check
// Output-language helpers: checking that "Hinglish" answers really are Hinglish (EC-LNG-01, EC-LNG-02).

import { LANGUAGES } from './config.js';

/** @typedef {keyof typeof LANGUAGES} Language */

/**
 * @param {unknown} value
 * @returns {value is Language}
 */
export function isLanguage(value) {
  return typeof value === 'string' && Object.hasOwn(LANGUAGES, value);
}

/** @param {Language} language @returns {Language} */
export function otherLanguage(language) {
  return language === 'hinglish' ? 'en' : 'hinglish';
}

const DEVANAGARI_RE = /[ऀ-ॿ]/g;
/** A few Devanagari letters can be a quoted name; this many means the answer slipped into Hindi script. */
const MAX_DEVANAGARI = 3;
/**
 * Everyday Hindi words that almost always appear in real Hinglish. Words that are also common English
 * ("the", "to", "me", "hi", "ho", "par") are left out so plain English isn't mistaken for Hinglish.
 */
const HINDI_WORDS = new Set([
  'hai', 'hain', 'tha', 'thi', 'ka', 'ki', 'ke', 'ko', 'se', 'mein', 'aur', 'ya', 'nahi',
  'nahin', 'yeh', 'ye', 'woh', 'wo', 'kya', 'kaise', 'kyun', 'kyunki', 'jo', 'jab', 'toh', 'bhi', 'liye',
  'apna', 'apne', 'apni', 'karna', 'karta', 'karti', 'karte', 'kar', 'hota', 'hoti', 'hote', 'sakta', 'sakti',
  'sakte', 'matlab', 'yaani', 'jaise', 'agar', 'lekin', 'sirf', 'bahut', 'zyada', 'kam', 'acha', 'accha', 'samjho'
]);
/** Too short to judge whether it's English or Hinglish. */
const MIN_WORDS_TO_JUDGE = 12;

/**
 * @param {string} text
 * @returns {{ ok: true } | { ok: false, problem: 'devanagari'|'english' }}
 */
export function checkHinglish(text) {
  if ((text.match(DEVANAGARI_RE) ?? []).length > MAX_DEVANAGARI) return { ok: false, problem: 'devanagari' };
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  if (words.length < MIN_WORDS_TO_JUDGE) return { ok: true };
  const hindi = words.filter((w) => HINDI_WORDS.has(w)).length;
  return hindi >= 3 ? { ok: true } : { ok: false, problem: 'english' };
}

/**
 * All user-visible strings of a summary, for checking.
 * @param {{ tldr: string, keyPoints: string[], nextSteps: string[], chapters?: Array<{ title: string, notes: string }> }} summary
 */
export function summaryText(summary) {
  return [
    summary.tldr,
    ...summary.keyPoints,
    ...summary.nextSteps,
    ...(summary.chapters ?? []).flatMap((c) => [c.title, c.notes])
  ].join('\n');
}

/** The script each non-Latin translation target is written in. Hindi and Marathi share Devanagari. */
const TARGET_SCRIPTS = {
  hi: /[ऀ-ॿ]/u,
  mr: /[ऀ-ॿ]/u,
  bn: /[ঀ-৿]/u,
  pa: /[਀-੿]/u,
  gu: /[઀-૿]/u,
  ta: /[஀-௿]/u,
  te: /[ఀ-౿]/u,
  kn: /[ಀ-೿]/u,
  ml: /[ഀ-ൿ]/u,
  ur: /[؀-ۿݐ-ݿ]/u
};

/**
 * Whether text is already written in the target language's script, so translating it would be
 * pointless (EC-CTX-10). Not checked for English: Hinglish is Latin script but still worth translating.
 * @param {string} text
 * @param {string} target a TRANSLATE_TARGETS key
 */
export function isAlreadyInTargetScript(text, target) {
  const script = TARGET_SCRIPTS[target];
  if (!script) return false;
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 4) return false;
  return letters.filter((ch) => script.test(ch)).length / letters.length >= 0.6;
}
