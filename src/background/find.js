// @ts-check
// Find it for me (architecture §11.6, P3.4): scan the page → ask which numbered element answers the
// user's question → check that element exists → ring it on the page. Nothing is clicked or typed.

import { FIND_MAX_QUERY_CHARS } from '../shared/config.js';
import { isLanguage } from '../shared/language.js';
import { ToPanel, ToSW, makeMessage } from '../shared/messages.js';
import { buildFindPrompt, findNotFound } from '../shared/prompts/find.js';
import { FindSchema, validateFind } from '../shared/schemas.js';
import { createStorage } from '../shared/storage.js';
import { FeatureError } from './feature-error.js';
import { LlmError } from './llm/errors.js';
import { createDefaultGateway } from './llm/default-gateway.js';
import { createGateway } from './llm/gateway.js';
import { chromePageScan, createPageScan } from './page-scan.js';
import { chromePageGuard } from './page-guard.js';
import { on } from './router.js';

/**
 * @typedef {{
 *   query: string, elementId: number|null, reason: string, confidence: 'high'|'medium'|'low',
 *   snapshotId: string, fingerprint: string|null, name: string|null, role: string|null,
 *   protected: 'password'|'otp'|'card'|null, highlighted: boolean, escalated: boolean,
 *   model: string|null, provider: string|null, language: string, message: string|null
 * }} FindResult message: the "couldn't find" copy, set when elementId is null
 */

/**
 * @param {{
 *   gateway: Pick<ReturnType<typeof createGateway>, 'json'>,
 *   pageScan: Pick<ReturnType<typeof createPageScan>, 'observe'|'highlight'>,
 *   getLanguage: () => Promise<string>,
 *   checkPage?: (tabId: number) => Promise<unknown>
 * }} deps checkPage: the page-tier "read" check (§14.2), since the page's map goes to the model
 */
export function createFind({ gateway, pageScan, getLanguage, checkPage = async () => {} }) {
  return {
    /**
     * @param {{ tabId?: number, query?: string, language?: string }} payload
     * @param {{ windowId: number, signal?: AbortSignal }} ctx
     * @returns {Promise<FindResult>}
     */
    async find(payload, { windowId, signal }) {
      const query = typeof payload?.query === 'string' ? payload.query.trim().slice(0, FIND_MAX_QUERY_CHARS) : '';
      if (!query) throw new FeatureError('EMPTY_QUESTION', 'Type what you\'re looking for, e.g. "Where do I upload my resume?"');
      const tabId = /** @type {number} */ (payload.tabId);
      const language = isLanguage(payload.language) ? payload.language : await getLanguage();

      const { result: scan, map } = await pageScan.observe(tabId);
      await checkPage(tabId); // after the scan, which reports restricted pages in its own words
      const byId = new Map(scan.elements.map((d) => [d.id, d]));

      /** @type {{ value: import('../shared/schemas.js').FindAnswer, model: string|null, provider: string|null }} */
      let reply = {
        value: { target: null, reason: 'There are no buttons, links or fields on this screen.', confidence: 'high' },
        model: null,
        provider: null
      };
      let escalated = false;
      if (byId.size > 0) { // an empty page needs no model call (EC-SCN-01)
        const { system, turns } = buildFindPrompt({ map, query, language });
        const req = {
          task: /** @type {const} */ ('find'), system, turns, schema: FindSchema, signal,
          validate: (/** @type {unknown} */ v) => validateFind(v, { ids: new Set(byId.keys()) })
        };
        reply = await gateway.json(req);
        if (reply.value.confidence === 'low') {
          // One escalation to Flash (architecture §8.2, trigger 3). If Flash fails, the first answer stands.
          try {
            reply = await gateway.json({ ...req, escalate: true });
            escalated = true;
          } catch (err) {
            if (signal?.aborted || (err instanceof LlmError && err.code === 'CANCELLED')) throw err;
          }
        }
      }

      const { target, reason, confidence } = reply.value;
      const d = target === null ? null : byId.get(target) ?? null;
      // Ring the answer, or clear an earlier ring so it can't be mistaken for this one.
      const shown = await pageScan.highlight(windowId, tabId, d
        ? { snapshotId: scan.snapshotId, elementId: d.id, fingerprint: d.fingerprint, style: 'find' }
        : null);

      return {
        query,
        elementId: d?.id ?? null,
        reason,
        confidence,
        snapshotId: scan.snapshotId,
        fingerprint: d?.fingerprint ?? null,
        name: d?.name ?? null,
        role: d ? (d.role === 'generic' ? d.tag : d.role) : null,
        protected: d?.protected ?? null,
        highlighted: Boolean(d) && shown.ok,
        escalated,
        model: reply.model,
        provider: reply.provider,
        language,
        message: d ? null : findNotFound(language)
      };
    },

    /**
     * Ring the found element again ("Show again"). Falls back to its fingerprint if the page was
     * rescanned since.
     * @param {{ tabId?: number, snapshotId?: string, elementId?: number, fingerprint?: string|null }} payload
     * @param {number} windowId
     */
    async showAgain(payload, windowId) {
      const { tabId, snapshotId, elementId, fingerprint } = payload ?? {};
      if (typeof tabId !== 'number' || typeof snapshotId !== 'string' || !Number.isInteger(elementId)) {
        return { ok: false, reason: 'STALE_TARGET' };
      }
      return pageScan.highlight(windowId, tabId, {
        snapshotId, elementId: /** @type {number} */ (elementId), style: 'find',
        ...(typeof fingerprint === 'string' ? { fingerprint } : {})
      });
    }
  };
}

/** Wire Find into the router. Call synchronously at the worker's top level. */
export function initFind() {
  const storage = createStorage(chrome.storage.local);
  const guard = chromePageGuard();
  const finder = createFind({
    gateway: createDefaultGateway(),
    pageScan: chromePageScan(),
    getLanguage: async () => (await storage.getSettings()).language,
    checkPage: (tabId) => guard.assert(tabId, 'read')
  });

  on(ToSW.FIND_ELEMENT, async (payload, { port, windowId }, msg) => {
    try {
      port.postMessage(makeMessage(ToPanel.FIND_RESULT, await finder.find(payload, { windowId }), msg.requestId));
    } catch (err) {
      if (err instanceof LlmError || err instanceof FeatureError) {
        port.postMessage(makeMessage(ToPanel.ERROR, err.toPayload(), msg.requestId));
      } else {
        throw err; // router turns this into a generic INTERNAL error
      }
    }
  });
  on(ToSW.FIND_SHOW_AGAIN, async (payload, { port, windowId }, msg) => {
    port.postMessage(makeMessage(ToPanel.FIND_SHOWN, await finder.showAgain(payload, windowId), msg.requestId));
  });
}
