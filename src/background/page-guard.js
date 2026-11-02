// @ts-check
// The page check every feature runs before page content leaves the browser (architecture §14.1):
// read the page's safety signals, work out its tiers, and allow or refuse the feature. Signals
// that can't be read count as unsafe (fail closed, EC-TIR-19).

import { ToContent } from '../shared/messages.js';
import { checkPage, pageTiers, safetyBadge } from '../shared/safety/policy.js';
import { createStorage } from '../shared/storage.js';
import { FeatureError } from './feature-error.js';
import { ensureInjected, sendToTab } from './tab-context.js';

/** Signals for a URL with no page behind it (a pasted YouTube link). */
export const NO_SIGNALS = Object.freeze({
  hasPasswordField: false, hasCardFields: false, hasOtpField: false, hasUpiField: false, keywords: [], frameHosts: []
});
const SIGNALS_TIMEOUT_MS = 3_000;

/**
 * @typedef {import('../shared/safety/policy.js').PageFeature} PageFeature
 * @typedef {import('../shared/safety/policy.js').PageSignals} PageSignals
 * @typedef {{ userBlockedDomains: string[], sensitiveAckDomains: string[] }} SafetyLists
 */

/**
 * @param {{
 *   getUrl: (tabId: number) => Promise<string>,
 *   getSignals: (tabId: number) => Promise<PageSignals|null>,
 *   getSafety: () => Promise<SafetyLists>
 * }} deps
 */
export function createPageGuard({ getUrl, getSignals, getSafety }) {
  /**
   * @param {string} url
   * @param {PageSignals|null} signals
   * @param {PageFeature} feature
   */
  async function verdictFor(url, signals, feature) {
    const safety = await getSafety();
    const tiers = pageTiers({ url, signals, userBlockedDomains: safety.userBlockedDomains });
    return { tiers, verdict: checkPage(tiers, feature, { url, sensitiveAckDomains: safety.sensitiveAckDomains }) };
  }

  /** @param {import('../shared/safety/policy.js').PageVerdict} verdict */
  function enforce(verdict) {
    if (verdict.allowed) return verdict;
    throw new FeatureError(verdict.code, verdict.message, { tier: verdict.tier, ...(verdict.domain ? { domain: verdict.domain } : {}) });
  }

  return {
    /**
     * Allow or refuse a feature on this tab, looking at the page as it is now (EC-TIR-07).
     * @param {number} tabId
     * @param {PageFeature} feature
     */
    async check(tabId, feature) {
      const url = await getUrl(tabId);
      return verdictFor(url, await getSignals(tabId), feature);
    },

    /**
     * Like check, but throws PAGE_BLOCKED (or NEEDS_ACK for a private page's selection).
     * @param {number} tabId
     * @param {PageFeature} feature
     * @returns {Promise<{ allowed: true, scope: 'page'|'selection-only' }>}
     */
    async assert(tabId, feature) {
      return /** @type {any} */ (enforce((await this.check(tabId, feature)).verdict));
    },

    /**
     * For a URL with no page to look at, such as a pasted YouTube link: the domain rules only.
     * @param {string} url
     * @param {PageFeature} feature
     */
    async assertUrl(url, feature) {
      return enforce((await verdictFor(url, NO_SIGNALS, feature)).verdict);
    },

    /** The header badge for this tab (🟢 / 🟡 / 🔴). @param {number} tabId */
    async badge(tabId) {
      const { tiers } = await this.check(tabId, 'read');
      return safetyBadge(tiers);
    }
  };
}

/**
 * The page's signals, or null if the page couldn't be asked (treated as unsafe by pageTiers).
 * @param {number} tabId
 * @returns {Promise<PageSignals|null>}
 */
export async function readSignals(tabId) {
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), SIGNALS_TIMEOUT_MS); });
    const ask = (async () => {
      await ensureInjected(tabId, [ToContent.CS_PAGE_SIGNALS]);
      return sendToTab(tabId, ToContent.CS_PAGE_SIGNALS);
    })();
    return /** @type {PageSignals} */ (await Promise.race([ask, timeout]));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** @type {ReturnType<typeof createPageGuard>|null} */
let shared = null;

/** The Chrome-backed guard, shared by every feature in the worker. */
export function chromePageGuard() {
  if (shared) return shared;
  const storage = createStorage(chrome.storage.local);
  shared = createPageGuard({
    getUrl: async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      return tab.url ?? tab.pendingUrl ?? '';
    },
    getSignals: readSignals,
    getSafety: () => storage.get('safety')
  });
  return shared;
}
