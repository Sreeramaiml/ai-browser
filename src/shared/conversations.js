// @ts-check
// Page-chat history in chrome.storage.session (architecture §7.2): { [tabId:url]: Conversation }.
// Cleared when the browser restarts (EC-CHT-15). Only the service worker writes; the panel reads
// it to restore the chat after a reload. The area is injected so everything here is unit testable.

import { CHAT_HISTORY_PAIRS } from './config.js';

export const CONVERSATIONS_KEY = 'conversations';
/** Conversations kept across all tabs; the least recently used are dropped. */
export const MAX_CONVERSATIONS = 20;
/** Messages kept per conversation for display. Only the last CHAT_HISTORY_PAIRS go to the model. */
export const MAX_STORED_MESSAGES = 60;

/**
 * @typedef {{ role: 'user', text: string, at: number }} UserMessage
 * @typedef {{
 *   role: 'assistant', text: string, at: number, model: string, provider: string, stopReason: string|null,
 *   notFound: boolean, truncated: boolean, unverifiedQuotes: number
 * }} AssistantMessage
 * @typedef {{ role: 'event', kind: 'content-updated', at: number }} EventMessage
 * @typedef {UserMessage|AssistantMessage|EventMessage} ChatMessage
 * @typedef {{ url: string, title: string, contentHash: string|null, updatedAt: number, messages: ChatMessage[] }} Conversation
 * @typedef {{
 *   get: (keys: string|string[]) => Promise<Record<string, any>>,
 *   set: (items: Record<string, any>) => Promise<void>
 * }} SessionArea
 */

/**
 * One conversation per tab and page. The #fragment is ignored (EC-CHT-10) but the query isn't,
 * because `?page=2` is different content (EC-CHT-11). Same URL in two tabs = two chats (EC-CHT-09).
 * @param {number} tabId
 * @param {string} url
 */
export function conversationKey(tabId, url) {
  return `${tabId}:${String(url ?? '').replace(/#.*$/, '')}`;
}

/**
 * The question/answer pairs to send with the next question, oldest first (EC-CHT-07).
 * Events and unanswered questions are skipped.
 * @param {ChatMessage[]} messages
 * @param {number} [pairs]
 * @returns {Array<UserMessage|AssistantMessage>}
 */
export function recentTurns(messages, pairs = CHAT_HISTORY_PAIRS) {
  /** @type {Array<UserMessage|AssistantMessage>} */
  const out = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const q = messages[i];
    const a = messages[i + 1];
    if (q.role === 'user' && a.role === 'assistant') {
      out.push(q, a);
      i++;
    }
  }
  return out.slice(-pairs * 2);
}

/** @param {unknown} v */
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {SessionArea} area
 * @returns {Promise<Record<string, Conversation>>}
 */
async function readAll(area) {
  const { [CONVERSATIONS_KEY]: all } = await area.get(CONVERSATIONS_KEY);
  return isPlainObject(all) ? all : {};
}

/**
 * Panel side: read one conversation (or null).
 * @param {SessionArea} area
 * @param {string} key
 * @returns {Promise<Conversation|null>}
 */
export async function readConversation(area, key) {
  const conv = (await readAll(area))[key];
  return isPlainObject(conv) && Array.isArray(conv.messages) ? conv : null;
}

/**
 * Service-worker side.
 * @param {SessionArea} area usually chrome.storage.session
 */
export function createConversationStore(area) {
  /** Serialises read-modify-write within this worker, like storage.js. */
  let queue = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  return {
    /** @param {string} key */
    get: (key) => readConversation(area, key),

    /**
     * Add messages to a conversation (creating it), refresh its page details, and prune old data.
     * @param {string} key
     * @param {{ url: string, title: string, contentHash: string|null }} page
     * @param {ChatMessage[]} messages
     */
    append(key, page, messages) {
      return serial(async () => {
        const all = await readAll(area);
        const previous = isPlainObject(all[key]) && Array.isArray(all[key].messages) ? all[key].messages : [];
        all[key] = { ...page, updatedAt: Date.now(), messages: [...previous, ...messages].slice(-MAX_STORED_MESSAGES) };
        const keep = Object.entries(all)
          .sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0))
          .slice(0, MAX_CONVERSATIONS);
        await area.set({ [CONVERSATIONS_KEY]: Object.fromEntries(keep) });
      });
    },

    /**
     * Forget every conversation of a closed tab.
     * @param {number} tabId
     */
    removeTab(tabId) {
      return serial(async () => {
        const all = await readAll(area);
        const prefix = `${tabId}:`;
        const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
        if (keys.length === 0) return;
        for (const k of keys) delete all[k];
        await area.set({ [CONVERSATIONS_KEY]: all });
      });
    }
  };
}
