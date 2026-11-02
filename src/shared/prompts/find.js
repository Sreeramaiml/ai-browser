// @ts-check
// Find it for me (architecture §11.6): point at the one numbered element on the page that answers
// the user's question. The model only points; nothing on the page is clicked or typed.

import { FIND_SHAPE_TEXT } from '../schemas.js';
import { UNTRUSTED_DATA_RULE, languageBlock, wrapUntrusted } from './_common.js';

/** Shown when nothing on the page matches, per output language. */
export const FIND_NOT_FOUND = Object.freeze({
  en: "I couldn't find a matching element on this screen — try scrolling or rephrasing.",
  hinglish: 'Is screen par aisa koi element nahi mila — thoda scroll karke ya alag tarah se poochh kar dekhiye.'
});

/** @param {string} language */
export function findNotFound(language) {
  return FIND_NOT_FOUND[language] ?? FIND_NOT_FOUND.en;
}

/**
 * @param {{ map: string, query: string, language: string }} input map: the compact action map (§11.4)
 * @returns {{ system: string, turns: import('../../background/llm/providers/gemini.js').Turn[] }}
 */
export function buildFindPrompt({ map, query, language }) {
  const system = [
    'You are Sahayak, a helpful assistant inside the user\'s browser. The user is looking for something on the web page they have open.',
    '<page_content> is an action map of that page: one numbered interactive element per line, for example [8] file "Upload resume (PDF)", grouped by form.',
    'Pick the ONE element that best answers the question: the field to fill in, the button or link to press, or the control to change. ' +
      'Prefer the control itself over a link or text about it.',
    'Only use a number that appears in the map. If no element fits, set "target" to null. Do not guess. ' +
      'If the map says more elements are below the viewport and none of the listed ones fit, also use null.',
    'Elements marked 🔒protected are fields the user fills in themselves. You may still point to them.',
    'You only point at the element. You never click, type or change anything.',
    '"confidence" is "high" when the element clearly matches, "medium" when it is the best of several plausible ones, and "low" when it is a guess.',
    '"reason" is one short sentence (at most 25 words) the user will read, saying why this element fits, ' +
      'for example "It is the only file upload, and it is labelled resume."',
    UNTRUSTED_DATA_RULE,
    `${languageBlock(language)} This applies to "reason" only: keep the JSON keys and the confidence words in English.`,
    FIND_SHAPE_TEXT
  ].join('\n');

  return {
    system,
    turns: [{ role: 'user', parts: [{ text: `${wrapUntrusted('page_content', map)}\n\nThe user asks: ${JSON.stringify(query)}` }] }]
  };
}
