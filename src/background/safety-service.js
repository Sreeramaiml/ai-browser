// @ts-check
// Settings → Safety (P4.3): the user's blocklist, the sites they own (where the agent may run), and
// the private sites where they've agreed to send selected text. Built-in rules live in code and
// can't be changed from here; tier 3 always wins (EC-TIR-11).

import { ToPanel, ToSW, makeMessage } from '../shared/messages.js';
import { isFinancialHost, isSensitiveHost, normalizeDomainInput } from '../shared/safety/site-rules.js';
import { StorageError, createStorage } from '../shared/storage.js';
import { broadcast, on } from './router.js';

/** Most entries one list may hold. */
export const SAFETY_LIST_MAX = 100;
const LISTS = new Set(['userBlockedDomains', 'ownedDomains', 'sensitiveAckDomains']);

/**
 * @typedef {'userBlockedDomains'|'ownedDomains'|'sensitiveAckDomains'} SafetyList
 * @typedef {{ type: string, payload: any }} Reply
 */

/** @param {ReturnType<typeof createStorage>} storage */
export function createSafetyService(storage) {
  /** @param {string} message @returns {Reply} */
  const invalid = (message) => ({ type: ToPanel.VALIDATION_ERROR, payload: { errors: { domain: message } } });

  /**
   * @param {SafetyList} list
   * @param {'add'|'remove'} action
   * @param {string} domain already normalised
   * @returns {Promise<Reply>}
   */
  async function change(list, action, domain) {
    try {
      const safety = await storage.updateSafety((current) => {
        const entries = current[list].filter((d) => d !== domain);
        if (action === 'add') entries.push(domain);
        const next = { ...current, [list]: entries.slice(-SAFETY_LIST_MAX) };
        return { safety: next, result: next };
      });
      return { type: ToPanel.SAFETY_STATE, payload: { safety } };
    } catch (err) {
      if (err instanceof StorageError) return { type: ToPanel.ERROR, payload: { code: err.code, message: err.message } };
      throw err;
    }
  }

  return {
    /** @returns {Promise<Reply>} */
    async get() {
      return { type: ToPanel.SAFETY_STATE, payload: { safety: await storage.get('safety') } };
    },

    /**
     * @param {{ list?: unknown, action?: unknown, domain?: unknown, confirmOwned?: unknown }} payload
     * @returns {Promise<Reply>}
     */
    async update(payload) {
      const list = /** @type {SafetyList} */ (payload?.list);
      if (!LISTS.has(list) || (payload?.action !== 'add' && payload?.action !== 'remove')) return invalid('Unknown change.');
      if (payload.action === 'remove') {
        return change(list, 'remove', typeof payload.domain === 'string' ? payload.domain.trim().toLowerCase() : '');
      }
      const checked = normalizeDomainInput(payload.domain);
      if (!checked.ok) return invalid(checked.error);
      const { domain } = checked;
      if (list === 'ownedDomains') {
        if (isFinancialHost(domain)) return invalid("Banking and payment sites can't be added. Pagewise never acts on them."); // EC-TIR-11
        if (isSensitiveHost(domain)) return invalid("Private sites like email, documents and messaging can't be added.");
        if (payload.confirmOwned !== true) return invalid('Tick "I own or control this site" to add it.'); // §14.3
      }
      // sensitiveAckDomains: any site the panel asked about, private by list or by its login or card
      // fields; the acknowledgment only ever lets selected text through.
      return change(list, 'add', domain);
    },

    /**
     * "Only the text I selected" on a private page (EC-TIR-09), from the panel's prompt.
     * @param {{ domain?: unknown }} payload
     * @returns {Promise<Reply>}
     */
    async acknowledge(payload) {
      return this.update({ list: 'sensitiveAckDomains', action: 'add', domain: payload?.domain });
    }
  };
}

/** Wire the service into the router. Call synchronously at the worker's top level. */
export function initSafetyService() {
  const storage = createStorage(chrome.storage.local);
  const service = createSafetyService(storage);

  /** @param {(payload: any) => Promise<Reply>} run @returns {import('./router.js').Handler} */
  const reply = (run) => async (payload, { port }, msg) => {
    const r = await run(payload);
    port.postMessage(makeMessage(r.type, r.payload, msg.requestId));
  };

  on(ToSW.SAFETY_GET, reply(() => service.get()));
  on(ToSW.SAFETY_UPDATE, reply((p) => service.update(p)));
  on(ToSW.SAFETY_ACK, reply((p) => service.acknowledge(p)));

  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== 'local' || !('safety' in changes)) return;
    broadcast(makeMessage(ToPanel.SAFETY_STATE, { safety: await storage.get('safety') }));
  });

  return service;
}
