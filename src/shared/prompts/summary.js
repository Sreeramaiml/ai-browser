// @ts-check
// Structured page summary: TL;DR, 5 key points, next steps (FR-4).

import { SUMMARY_SHAPE_TEXT } from '../schemas.js';
import { UNTRUSTED_DATA_RULE, languageBlock, wrapUntrusted } from './_common.js';

/**
 * @param {{
 *   title: string, byline?: string|null, text: string, url: string, language: string,
 *   source: 'article'|'visible', truncated: boolean
 * }} input
 * @returns {{ system: string, turns: import('../../background/llm/providers/gemini.js').Turn[] }}
 */
export function buildSummaryPrompt(input) {
  const system = [
    'You are Pagewise, a helpful assistant inside the user\'s browser.',
    'Summarise the web page in <page_content> for a busy student.',
    'Use only information from the page. Do not add facts, opinions or advice that the page does not support.',
    '"tldr": one plain sentence of at most 30 words saying what the page is about and why it matters.',
    '"keyPoints": exactly 5 short points (at most 25 words each), most important first, no list markers.',
    '"nextSteps": 1 to 3 practical things the reader could do next, based on the page (for example: read a section, try something, check a source).',
    SUMMARY_SHAPE_TEXT,
    UNTRUSTED_DATA_RULE,
    `${languageBlock(input.language)} Use this language for every string value; keep the JSON keys in English.`
  ].join('\n');

  const notes = [];
  if (input.source === 'visible') notes.push('This page is not a typical article; the text is what was visible on the page.');
  if (input.truncated) notes.push('The page was long, so its middle part was left out.');

  const user = [
    wrapUntrusted('page_content', input.text, { title: input.title, byline: input.byline ?? '', url: input.url }),
    ...notes,
    'Summarise the page above as JSON.'
  ].join('\n\n');

  return { system, turns: [{ role: 'user', parts: [{ text: user }] }] };
}
