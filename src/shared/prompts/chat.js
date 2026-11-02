// @ts-check
// Grounded page chat (architecture §10.1): answer only from the page, quote it, and say so exactly
// when the page doesn't have the answer. Also the checks the service worker runs on the answer.

import { CONCISE_RULE, UNTRUSTED_DATA_RULE, languageBlock, wrapUntrusted } from './_common.js';

/** The exact sentence for "not on this page", per output language. */
export const NOT_FOUND_SENTENCES = Object.freeze({
  en: "I couldn't find that on this page.",
  hinglish: 'Yeh information is page par nahi mili.'
});

/** @param {string} language */
export function notFoundSentence(language) {
  return NOT_FOUND_SENTENCES[language] ?? NOT_FOUND_SENTENCES.en;
}

/**
 * @param {{
 *   page: { title: string, url: string, text: string, source: 'article'|'visible', truncated: boolean },
 *   history: Array<{ role: 'user'|'assistant', text: string }>,
 *   question: string,
 *   language: string
 * }} input
 * @returns {{ system: string, turns: import('../../background/llm/providers/gemini.js').Turn[] }}
 */
export function buildChatPrompt({ page, history, question, language }) {
  const notFound = notFoundSentence(language);
  const system = [
    'You are Pagewise, a helpful assistant inside the user\'s browser. The user is chatting with you about the web page in <page_content>.',
    'Answer ONLY from <page_content>. Never use outside knowledge, even if you are sure of the answer.',
    'Quote short phrases from the page in "double quotes", copied exactly as they appear on the page, to support your answer.',
    `If the page does not contain the answer, reply with exactly this sentence: "${notFound}" ` +
      'You may add one short sentence saying what the page does cover. Do not guess.',
    'If only part of the question is answered by the page, answer that part, then say clearly which part the page doesn\'t cover.',
    'If asked for an opinion or advice, give only the relevant facts the page states (for example the pros and cons it lists). Do not invent details.',
    'Questions about this conversation or about what you can do may be answered from the conversation itself, not the page.',
    'Use the earlier messages to understand follow-up questions such as "and the second one?".',
    '"[…]" in the page text marks parts of a long page that were left out.',
    UNTRUSTED_DATA_RULE,
    CONCISE_RULE,
    `${languageBlock(language)} Keep quotes from the page in the page's own words.`
  ].join('\n');

  const notes = [];
  if (page.source === 'visible') notes.push('This page is not a typical article; the text is what was visible on the page.');
  if (page.truncated) notes.push('The page is long, so only its beginning and the parts most related to the question are included.');

  /** @type {import('../../background/llm/providers/gemini.js').Turn[]} */
  const turns = [
    {
      role: 'user',
      parts: [{
        text: [
          wrapUntrusted('page_content', page.text, { title: page.title, url: page.url }),
          ...notes,
          'This is the page I am looking at. Answer my questions about it.'
        ].join('\n\n')
      }]
    },
    // Keeps the roles alternating, which some providers require.
    { role: 'assistant', parts: [{ text: 'I have read the page. What would you like to know?' }] },
    ...history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    { role: 'user', parts: [{ text: question }] }
  ];
  return { system, turns };
}

/**
 * Lower-case, straighten quotes, drop markdown emphasis and collapse spaces, so small formatting
 * differences don't matter (EC-CHT-13).
 * @param {string} text
 */
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {string} text */
const stripEnd = (text) => text.replace(/[\s.!?"'।…]+$/, '');

/**
 * Whether an answer is the not-found reply, in either language (the model sometimes ignores the toggle).
 * @param {string} answer
 */
export function isNotFound(answer) {
  const a = normalize(answer).replace(/^["']+/, '');
  return Object.values(NOT_FOUND_SENTENCES).some((s) => a.startsWith(stripEnd(normalize(s))));
}

/** Quotes shorter than this are too generic to check. */
const MIN_CHECKED_QUOTE = 20;
/** Pieces of an elided quote ("… … …") shorter than this aren't checked on their own. */
const MIN_CHECKED_PIECE = 8;

/**
 * Count the "quoted" passages in an answer that don't appear on the page (EC-CHT-14).
 * Elided quotes are checked piece by piece.
 * @param {string} answer
 * @param {string} pageText
 * @returns {number}
 */
export function countUnverifiedQuotes(answer, pageText) {
  const page = normalize(pageText).replace(/"/g, '');
  let missing = 0;
  for (const match of answer.matchAll(/["“”]([^"“”\n]+)["“”]/g)) {
    const quote = match[1];
    if (quote.trim().length < MIN_CHECKED_QUOTE) continue;
    const pieces = quote.split(/\.{3}|…/).map((p) => stripEnd(normalize(p)).replace(/^[\s.,;:]+/, ''));
    if (pieces.some((p) => p.length >= MIN_CHECKED_PIECE && !page.includes(p))) missing++;
  }
  return missing;
}
