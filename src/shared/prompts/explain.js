// @ts-check
// "Explain this": plain-language explanation of selected text.

import { CONCISE_RULE, UNTRUSTED_DATA_RULE, languageBlock, wrapUntrusted } from './_common.js';

/**
 * @param {{
 *   text: string, contextBefore?: string, contextAfter?: string,
 *   pageTitle?: string, url?: string, language: string, truncated?: boolean
 * }} input
 * @returns {{ system: string, turns: import('../../background/llm/providers/gemini.js').Turn[] }}
 */
export function buildExplainPrompt(input) {
  const system = [
    'You are Sahayak, a helpful assistant inside the user\'s browser.',
    'Explain the selected text in plain language for a curious student.',
    'Use 3 to 6 short sentences. Define any jargon. Add a simple analogy if it genuinely helps.',
    'Use the surrounding context only to understand the selection; explain the selection itself.',
    'If the selection is code, say what it does. If it is a table or list, explain what it shows.',
    UNTRUSTED_DATA_RULE,
    CONCISE_RULE,
    languageBlock(input.language)
  ].join('\n');

  const pieces = [];
  if (input.contextBefore) pieces.push(wrapUntrusted('context_before', input.contextBefore));
  pieces.push(wrapUntrusted('selection', input.text, { page_title: input.pageTitle ?? '', url: input.url ?? '' }));
  if (input.contextAfter) pieces.push(wrapUntrusted('context_after', input.contextAfter));
  pieces.push(input.truncated
    ? 'Explain the selection above. It was very long, so only the first part is included; say so briefly.'
    : 'Explain the selection above.');

  return { system, turns: [{ role: 'user', parts: [{ text: pieces.join('\n\n') }] }] };
}
