// @ts-check
// Grounded page chat (architecture §10.1, P2.1). Each question re-reads the page, so turn 0 is
// always the current content:
//   page text (relevant chunks) → last 10 Q/A pairs → question → stream → save the pair

import { CHAT_MAX_QUESTION_CHARS, PAGE_TEXT_CHAR_BUDGET } from '../shared/config.js';
import { selectRelevant } from '../shared/chunking.js';
import { conversationKey, createConversationStore, recentTurns } from '../shared/conversations.js';
import { isLanguage } from '../shared/language.js';
import { ToSW } from '../shared/messages.js';
import { buildChatPrompt, countUnverifiedQuotes, isNotFound } from '../shared/prompts/chat.js';
import { createStorage } from '../shared/storage.js';
import { hashString } from '../shared/text.js';
import { FeatureError } from './feature-error.js';
import { createDefaultGateway } from './llm/default-gateway.js';
import { createGateway } from './llm/gateway.js';
import { on } from './router.js';
import { streamInLanguage, streamingHandler } from './streaming.js';
import { chromePageGuard } from './page-guard.js';
import { readPageText } from './tab-context.js';

/**
 * @typedef {{ source: 'article'|'visible', title: string, text: string, url: string }} ChatPage
 * @typedef {import('../shared/conversations.js').ChatMessage} ChatMessage
 */

/**
 * @param {{
 *   gateway: ReturnType<typeof createGateway>,
 *   getPage: (tabId: number) => Promise<ChatPage>,
 *   getLanguage: () => Promise<string>,
 *   conversations: ReturnType<typeof createConversationStore>,
 *   now?: () => number
 * }} deps
 */
export function createPageChat({ gateway, getPage, getLanguage, conversations, now = Date.now }) {
  return {
    /**
     * @param {{ tabId?: number, text?: string, conversationId?: string, language?: string }} payload
     *   conversationId: the conversation the panel is showing; if the page has moved on since, the
     *   question is refused rather than answered about a page the user isn't looking at
     * @param {import('./streaming.js').StreamIO} io
     */
    async send(payload, io) {
      if (typeof payload?.tabId !== 'number') throw new FeatureError('PAGE_RESTRICTED', 'Open a web page to chat about it.');
      const question = typeof payload.text === 'string' ? payload.text.trim().slice(0, CHAT_MAX_QUESTION_CHARS) : '';
      if (!question) throw new FeatureError('EMPTY_QUESTION', 'Type a question about the page first.');

      const page = await getPage(payload.tabId);
      if (!page.text.trim()) throw new FeatureError('NOT_ENOUGH_TEXT', "There isn't any text on this page to chat about.");

      const key = conversationKey(payload.tabId, page.url);
      if (typeof payload.conversationId === 'string' && payload.conversationId !== key) {
        throw new FeatureError('PAGE_CHANGED', 'The page changed. Ask your question again about the new page.');
      }

      const conversation = await conversations.get(key);
      const contentHash = hashString(page.text);
      // Same URL, different text (live scores, an SPA update): new page text, same history (EC-CHT-08).
      const contentChanged = Boolean(conversation?.contentHash && conversation.contentHash !== contentHash);
      const history = recentTurns(conversation?.messages ?? []);
      const language = isLanguage(payload.language) ? payload.language : await getLanguage();

      // The previous question helps follow-ups ("and the second one?") find the same part of the page.
      const lastQuestion = [...history].reverse().find((m) => m.role === 'user')?.text ?? '';
      const selected = selectRelevant(page.text, `${question}\n${lastQuestion}`, PAGE_TEXT_CHAR_BUDGET);
      const { system, turns } = buildChatPrompt({
        page: { title: page.title, url: page.url, source: page.source, text: selected.text, truncated: selected.truncated },
        history,
        question,
        language
      });

      io.onStart({ conversationKey: key, contentChanged });
      const askedAt = now();
      const result = await streamInLanguage(gateway, { task: 'chat', system, turns }, language, io);

      /** @type {import('../shared/conversations.js').AssistantMessage} */
      const answer = {
        role: 'assistant',
        text: result.text,
        at: now(),
        model: result.model,
        provider: result.provider,
        stopReason: result.stopReason,
        notFound: isNotFound(result.text),
        truncated: selected.truncated,
        unverifiedQuotes: countUnverifiedQuotes(result.text, page.text)
      };
      /** @type {ChatMessage[]} */
      const added = [];
      if (contentChanged) added.push({ role: 'event', kind: 'content-updated', at: askedAt });
      added.push({ role: 'user', text: question, at: askedAt }, answer);
      // Saved before CHAT_DONE goes out, so a panel reloaded right after still shows it. History is
      // best-effort: a failed save mustn't turn a good answer into an error.
      await conversations.append(key, { url: page.url, title: page.title, contentHash }, added).catch(() => {});

      const { role: _role, at: _at, ...done } = answer;
      return { ...done, conversationKey: key };
    }
  };
}

/** Wire page chat into the router. Call synchronously at the worker's top level. */
export function initPageChat() {
  const storage = createStorage(chrome.storage.local);
  const gateway = createDefaultGateway();
  const conversations = createConversationStore(chrome.storage.session);
  const guard = chromePageGuard();

  const chat = createPageChat({
    gateway,
    conversations,
    getLanguage: async () => (await storage.getSettings()).language,
    async getPage(tabId) {
      const page = await readPageText(tabId);
      await guard.assert(tabId, 'read'); // nothing is sent from a sensitive page (§14.2)
      // Key by the tab's URL, the same one the panel sees in ACTIVE_TAB.
      const tab = await chrome.tabs.get(tabId);
      return { ...page, url: tab.url || page.url };
    }
  });

  on(ToSW.CHAT_SEND, streamingHandler((payload, io) => chat.send(payload, io)));

  // A closed tab's chats can never be shown again.
  chrome.tabs.onRemoved.addListener((tabId) => {
    conversations.removeTab(tabId).catch(() => { /* history is best-effort */ });
  });
}
