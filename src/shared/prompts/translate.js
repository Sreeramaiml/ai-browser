// @ts-check
// "Translate": the selection into settings.translateTarget (default Hindi), plus a romanised line for Hindi.
// No EN | Hinglish language block here: the output language is the translation target.

import { TRANSLATE_TARGETS } from '../config.js';
import { UNTRUSTED_DATA_RULE, wrapUntrusted } from './_common.js';

/**
 * @param {{ text: string, targetLang: string, pageTitle?: string, url?: string, truncated?: boolean }} input
 * @returns {{ system: string, turns: import('../../background/llm/providers/gemini.js').Turn[] }}
 */
export function buildTranslatePrompt(input) {
  const target = TRANSLATE_TARGETS[input.targetLang] ?? TRANSLATE_TARGETS.hi;
  const script = input.targetLang === 'hi'
    ? 'Write the Hindi in Devanagari script. Then add a blank line and a line that starts with "Romanised:" giving the ' +
      'same Hindi in Roman (Latin) letters, for readers who don\'t read Devanagari.'
    : input.targetLang === 'en' ? '' : `Use the standard script for ${target}.`;

  const system = [
    'You are Pagewise, a helpful assistant inside the user\'s browser.',
    `Translate the text in <selection> into ${target}.`,
    'Keep the meaning, tone and formatting (line breaks, lists). Keep names, brands, code, URLs and numbers as they are.',
    'Output only the translation: no preamble, no notes, no quotes around it.',
    script,
    UNTRUSTED_DATA_RULE
  ].filter(Boolean).join('\n');

  const user = [
    wrapUntrusted('selection', input.text, { page_title: input.pageTitle ?? '', url: input.url ?? '' }),
    input.truncated ? 'The selection was very long, so only its first part is included.' : '',
    `Translate the selection above into ${target}.`
  ].filter(Boolean).join('\n\n');

  return { system, turns: [{ role: 'user', parts: [{ text: user }] }] };
}
