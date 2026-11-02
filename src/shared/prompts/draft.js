// @ts-check
// "Draft a reply" to the selected message, shaped for where it will be posted (email, LinkedIn,
// forum, or a plain message), in the user's tone, signed only with a name we actually know.

import { TONES } from '../config.js';
import { CONCISE_RULE, UNTRUSTED_DATA_RULE, languageBlock, wrapUntrusted } from './_common.js';

/** Where the reply goes. 'message' is the neutral default when we can't tell (EC-CTX-08). */
export const MEDIUMS = Object.freeze({ email: 'Email', linkedin: 'LinkedIn', forum: 'Forum', message: 'Message' });

const EMAIL_HOSTS = new Set(['outlook.live.com', 'outlook.office.com', 'outlook.office365.com']);
const FORUM_HOSTS = [
  'reddit.com', 'stackoverflow.com', 'stackexchange.com', 'superuser.com', 'serverfault.com', 'askubuntu.com',
  'quora.com', 'github.com', 'news.ycombinator.com', 'discord.com', 'dev.to'
];

/**
 * Guess the medium from the page URL, then from the text itself.
 * @param {string|undefined} url
 * @param {string} [text]
 * @returns {keyof typeof MEDIUMS}
 */
export function inferMedium(url, text = '') {
  let host = '';
  let path = '';
  try {
    const parsed = new URL(String(url ?? ''));
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.toLowerCase();
  } catch {
    /* no usable URL: go by the text */
  }
  const onHost = (h) => host === h || host.endsWith(`.${h}`);
  if (host.startsWith('mail.') || EMAIL_HOSTS.has(host)) return 'email';
  if (onHost('linkedin.com')) return 'linkedin';
  if (FORUM_HOSTS.some(onHost) || /^forums?\./.test(host) || /\/(forums?|community|discuss|t)\//.test(path)) return 'forum';
  if (/^\s*dear\b/i.test(text) || /^\s*(best|kind|warm)?\s*regards,?\s*$|^\s*sincerely,?\s*$/im.test(text)) return 'email';
  return 'message';
}

/** @type {Record<keyof typeof MEDIUMS, string>} */
const MEDIUM_RULES = {
  email: 'Write an email reply: a greeting, a short body, and a sign-off.',
  linkedin: 'Write a reply comment for LinkedIn: professional and warm, 1 to 4 sentences, no greeting line, no signature, no hashtags.',
  forum: 'Write a forum reply: helpful and to the point, answering the question or points raised. No signature.',
  message: 'Write a short reply suitable for a chat message or comment. No signature.'
};

/** @type {Record<string, string>} */
const TONE_RULES = {
  polite: 'Tone: polite and respectful.',
  friendly: 'Tone: friendly and relaxed, but not overly casual.',
  formal: 'Tone: formal and professional.'
};

/**
 * @param {{
 *   text: string, contextBefore?: string, contextAfter?: string, pageTitle?: string, url?: string,
 *   medium: keyof typeof MEDIUMS, tone: keyof typeof TONES, name?: string|null, language: string,
 *   truncated?: boolean, refine?: 'shorter'|'formal', previousDraft?: string
 * }} input
 * @returns {{ system: string, turns: import('../../background/llm/providers/gemini.js').Turn[] }}
 */
export function buildDraftPrompt(input) {
  // Never invent a name (EC-CTX-09).
  const signature = input.medium !== 'email'
    ? ''
    : input.name
      ? `Sign off with the name ${JSON.stringify(input.name)}.`
      : 'Sign off with the placeholder "[Your name]". Never invent a name.';

  const system = [
    'You are Sahayak, a helpful assistant inside the user\'s browser.',
    'Draft a reply that the user can send to the message in <selection>. Write as the user, in the first person.',
    MEDIUM_RULES[input.medium] ?? MEDIUM_RULES.message,
    signature,
    TONE_RULES[input.tone] ?? TONE_RULES.polite,
    'Respond to what the message actually says. Do not make up facts about the user; use [placeholders] for details ' +
      'only they know, such as dates, numbers or decisions.',
    'Use the surrounding context only to understand the message.',
    'Output only the reply text, ready to paste.',
    UNTRUSTED_DATA_RULE,
    CONCISE_RULE,
    languageBlock(input.language)
  ].filter(Boolean).join('\n');

  const pieces = [];
  if (input.contextBefore) pieces.push(wrapUntrusted('context_before', input.contextBefore));
  pieces.push(wrapUntrusted('selection', input.text, { page_title: input.pageTitle ?? '', url: input.url ?? '' }));
  if (input.contextAfter) pieces.push(wrapUntrusted('context_after', input.contextAfter));
  if (input.truncated) pieces.push('The message was very long, so only its first part is included.');
  pieces.push(`Draft my reply to the message above (${MEDIUMS[input.medium] ?? MEDIUMS.message}).`);

  /** @type {import('../../background/llm/providers/gemini.js').Turn[]} */
  const turns = [{ role: 'user', parts: [{ text: pieces.join('\n\n') }] }];
  if (input.refine && input.previousDraft) {
    turns.push(
      { role: 'assistant', parts: [{ text: input.previousDraft }] },
      {
        role: 'user',
        parts: [{
          text: input.refine === 'shorter'
            ? 'Rewrite that draft to be shorter: about half the length, keeping the key points. Output only the new draft.'
            : 'Rewrite that draft in a more formal, professional tone. Output only the new draft.'
        }]
      }
    );
  }
  return { system, turns };
}
