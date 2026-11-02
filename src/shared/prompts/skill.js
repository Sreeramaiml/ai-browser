// @ts-check
// An answer-mode skill (architecture §13.2): the user's own template, filled in. Page text and the
// selection still arrive wrapped as untrusted data, wherever the template puts them.

import { resolve } from '../template.js';
import { UNTRUSTED_DATA_RULE, languageBlock, wrapUntrusted } from './_common.js';

/**
 * @param {{
 *   prompt: string, language: string, profile?: Record<string, unknown>,
 *   page?: { text: string, title?: string, url?: string, truncated?: boolean } | null,
 *   selection?: string, url?: string, title?: string
 * }} input
 * @returns {{ system: string, turns: import('../../background/llm/providers/gemini.js').Turn[] }}
 */
export function buildSkillPrompt(input) {
  const system = [
    "You are Sahayak, a helpful assistant inside the user's browser.",
    'The user saved the instructions below as a one-click "skill". Carry them out for the page or text they give you.',
    'Output only the result, ready to read or copy. Use markdown where it helps.',
    UNTRUSTED_DATA_RULE,
    languageBlock(input.language)
  ].join('\n');

  const page = input.page
    ? wrapUntrusted('page_content', input.page.truncated ? `${input.page.text}\n[…the page continues]` : input.page.text,
      { title: input.page.title ?? '', url: input.page.url ?? '' })
    : '';
  const text = resolve(input.prompt, {
    profile: input.profile ?? {},
    page,
    selection: input.selection ? wrapUntrusted('selection', input.selection) : '',
    url: input.url ?? '',
    title: input.title ?? '',
    language: input.language
  });
  return { system, turns: [{ role: 'user', parts: [{ text }] }] };
}
