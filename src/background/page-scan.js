// @ts-check
// Numbering the page for the Agent tab (P3.3): scan → compact action map, and number badges on the
// page. One tab per window can show badges, and one can show a highlight ring (Find, P3.4); both
// come off when the panel closes (§11.5).

import { ACTION_MAP_MAX_ELEMENTS } from '../shared/config.js';
import { buildActionMap, estimateTokens } from '../shared/action-map.js';
import { ToContent, ToPanel, ToSW, makeMessage } from '../shared/messages.js';
import { FeatureError } from './feature-error.js';
import { on, onPanelDisconnected } from './router.js';
import { describePageAccess, ensureInjected, sendToTab, waitForTabComplete } from './tab-context.js';

/** storage.session: { [windowId]: tabId } — the tab showing badges in each window. */
const BADGE_TABS_KEY = 'badgeTabs';
/** storage.session: { [windowId]: tabId } — the tab showing a highlight ring in each window. */
const HIGHLIGHT_TABS_KEY = 'highlightTabs';

/**
 * @typedef {{ get: (windowId: number) => Promise<number|null>, set: (windowId: number, tabId: number|null) => Promise<void> }} WindowTabs
 * @typedef {{ snapshotId: string, elementId: number, fingerprint?: string, style: 'find'|'pending'|'dry-run'|'blocked' }} HighlightTarget
 */

/**
 * @param {{
 *   getTab: (tabId: number) => Promise<{ url?: string, pendingUrl?: string }>,
 *   prepare: (tabId: number) => Promise<void>,
 *   send: (tabId: number, type: string, payload?: any) => Promise<any>,
 *   badgeTabs: WindowTabs,
 *   highlightTabs: WindowTabs
 * }} deps prepare: wait for the page and inject the content scripts (throws if Chrome refuses)
 */
export function createPageScan({ getTab, prepare, send, badgeTabs, highlightTabs }) {
  /** @param {number} tabId */
  async function ready(tabId) {
    if (typeof tabId !== 'number') throw new FeatureError('PAGE_RESTRICTED', 'Open a web page first.');
    const tab = await getTab(tabId);
    if (describePageAccess(tab.url || tab.pendingUrl, { fileAccessAllowed: true }).restricted) {
      throw new FeatureError('PAGE_RESTRICTED', "Pagewise can't read this kind of page.");
    }
    try {
      await prepare(tabId);
    } catch {
      throw new FeatureError('PAGE_RESTRICTED', "Pagewise can't read this page.");
    }
  }

  /** Hide badges in a tab; it may have closed or navigated away, which is fine. @param {number} tabId */
  const hideIn = (tabId) => send(tabId, ToContent.CS_HIDE_BADGES).catch(() => {});
  /** @param {number} tabId */
  const unringIn = (tabId) => send(tabId, ToContent.CS_HIGHLIGHT, { style: null }).catch(() => {});

  /**
   * Scan the page: the raw descriptors plus the action map built from them.
   * @param {number} tabId
   */
  async function observe(tabId) {
    await ready(tabId);
    /** @type {import('../shared/action-map.js').ScanResult} */
    const result = await send(tabId, ToContent.CS_SCAN);
    return { result, map: buildActionMap(result) };
  }

  /**
   * @param {number} windowId
   * @param {number} tabId
   * @param {boolean} show
   */
  async function setBadges(windowId, tabId, show) {
    const previous = await badgeTabs.get(windowId);
    if (!show) {
      await hideIn(tabId);
      if (previous === tabId) await badgeTabs.set(windowId, null);
      return { tabId, shown: false };
    }
    if (previous !== null && previous !== tabId) await hideIn(previous); // one tab per window
    await ready(tabId);
    await send(tabId, ToContent.CS_SHOW_BADGES);
    await badgeTabs.set(windowId, tabId);
    return { tabId, shown: true };
  }

  return {
    setBadges,
    observe,

    /**
     * Ring one element of a snapshot, or clear the ring with `null`. Rings in other tabs of the
     * window are cleared first. Never throws: a closed tab or a gone element is { ok: false }.
     * @param {number} windowId
     * @param {number} tabId
     * @param {HighlightTarget|null} target
     * @returns {Promise<{ ok: boolean, reason?: string }>}
     */
    async highlight(windowId, tabId, target) {
      const previous = await highlightTabs.get(windowId);
      if (previous !== null && previous !== tabId) await unringIn(previous);
      /** @type {{ ok?: boolean, reason?: string }} */
      let reply;
      try {
        reply = await send(tabId, ToContent.CS_HIGHLIGHT, target ?? { style: null });
      } catch {
        reply = { ok: false, reason: 'STALE_TARGET' }; // closed, navigated, or never scanned
      }
      const ok = reply?.ok === true;
      await highlightTabs.set(windowId, target && ok ? tabId : null);
      return ok ? { ok } : { ok, reason: reply?.reason ?? 'STALE_TARGET' };
    },

    /**
     * @param {number} tabId
     * @param {{ windowId: number, badges?: boolean }} opts badges: also number the page
     */
    async scan(tabId, { windowId, badges = false }) {
      const { result, map } = await observe(tabId);
      if (badges) await setBadges(windowId, tabId, true);
      return {
        snapshotId: result.snapshotId,
        count: result.elements.length,
        protectedCount: result.elements.filter((d) => d.protected).length,
        map,
        tokens: estimateTokens(map),
        truncated: result.truncated || result.elements.length > ACTION_MAP_MAX_ELEMENTS,
        badges
      };
    },

    /** The panel in this window closed: take its badges and rings off the page. @param {number} windowId */
    async hideWindow(windowId) {
      const tabs = new Set([await badgeTabs.get(windowId), await highlightTabs.get(windowId)]);
      tabs.delete(null);
      if (tabs.size === 0) return;
      for (const tabId of tabs) await hideIn(/** @type {number} */ (tabId)); // hiding clears the ring too
      await badgeTabs.set(windowId, null);
      await highlightTabs.set(windowId, null);
    }
  };
}

/** @param {string} key storage.session key holding { [windowId]: tabId } @returns {WindowTabs} */
function sessionWindowTabs(key) {
  return {
    async get(windowId) {
      const { [key]: all = {} } = await chrome.storage.session.get(key);
      return typeof all[windowId] === 'number' ? all[windowId] : null;
    },
    async set(windowId, tabId) {
      const { [key]: all = {} } = await chrome.storage.session.get(key);
      if (tabId === null) delete all[windowId];
      else all[windowId] = tabId;
      await chrome.storage.session.set({ [key]: all });
    }
  };
}

/** The Chrome-backed page scanner. Its state lives in storage.session, so instances can share it. */
export function chromePageScan() {
  return createPageScan({
    getTab: (tabId) => chrome.tabs.get(tabId),
    async prepare(tabId) {
      await waitForTabComplete(tabId, 5_000);
      await ensureInjected(tabId, [ToContent.CS_SCAN, ToContent.CS_SHOW_BADGES, ToContent.CS_EXECUTE]);
    },
    send: (tabId, type, payload) => sendToTab(tabId, type, payload),
    badgeTabs: sessionWindowTabs(BADGE_TABS_KEY),
    highlightTabs: sessionWindowTabs(HIGHLIGHT_TABS_KEY)
  });
}

/** Wire scanning into the router. Call synchronously at the worker's top level. */
export function initPageScan() {
  const pageScan = chromePageScan();

  /**
   * @param {(payload: any, windowId: number) => Promise<{ type: string, payload: any }>} run
   * @returns {import('./router.js').Handler}
   */
  const reply = (run) => async (payload, { port, windowId }, msg) => {
    try {
      const { type, payload: out } = await run(payload, windowId);
      port.postMessage(makeMessage(type, out, msg.requestId));
    } catch (err) {
      if (!(err instanceof FeatureError)) throw err; // router turns this into a generic INTERNAL error
      port.postMessage(makeMessage(ToPanel.ERROR, err.toPayload(), msg.requestId));
    }
  };

  on(ToSW.SCAN_PAGE, reply(async (p, windowId) => ({
    type: ToPanel.SCAN_RESULT, payload: await pageScan.scan(p?.tabId, { windowId, badges: p?.badges === true })
  })));
  on(ToSW.SET_BADGES, reply(async (p, windowId) => ({
    type: ToPanel.BADGES_STATE, payload: await pageScan.setBadges(windowId, p?.tabId, p?.show === true)
  })));

  // Badges come off when the panel closes or reloads (§11.5).
  onPanelDisconnected(({ windowId, surface }) => {
    if (surface === 'sidepanel') pageScan.hideWindow(windowId).catch(() => {});
  });
}
