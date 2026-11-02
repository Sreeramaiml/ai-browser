// @ts-check
// Screen capture for Screenshot-and-ask (architecture §10.3): the visible part of the active tab in
// the panel's window, as a PNG. Cropping and downscaling happen in the panel.

import { ToPanel, ToSW, makeMessage } from '../shared/messages.js';
import { FeatureError } from './feature-error.js';
import { chromePageGuard } from './page-guard.js';
import { on } from './router.js';
import { describePageAccess } from './tab-context.js';

/** Chrome allows about 2 captures per second; keep at least this gap between them. */
export const CAPTURE_MIN_GAP_MS = 600;
/** Wait before the one retry after Chrome's rate-limit error (EC-SCR-01). */
export const CAPTURE_RETRY_DELAY_MS = 600;

/** @param {unknown} err */
const errorText = (err) => String(err instanceof Error ? err.message : err ?? '');
/** @param {unknown} err */
const isRateLimit = (err) => /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|per second|quota/i.test(errorText(err));
/** @param {unknown} err */
const isNotAllowed = (err) => /cannot access|cannot be scripted|permission|chrome:\/\/|extensions gallery|webstore/i.test(errorText(err));

/**
 * Serialises captures and spaces them out (EC-SCR-01).
 * @param {{
 *   captureVisibleTab: (windowId: number) => Promise<string>,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>
 * }} deps
 */
export function createCapturer({ captureVisibleTab, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let last = -Infinity;
  let queue = Promise.resolve();

  /** @param {number} windowId */
  async function once(windowId) {
    const wait = last + CAPTURE_MIN_GAP_MS - now();
    if (wait > 0) await sleep(wait);
    last = now();
    return captureVisibleTab(windowId);
  }

  return {
    /**
     * @param {number} windowId
     * @returns {Promise<string>} PNG data URL
     */
    capture(windowId) {
      const run = queue.then(async () => {
        try {
          return await once(windowId);
        } catch (err) {
          if (!isRateLimit(err)) throw err;
          await sleep(CAPTURE_RETRY_DELAY_MS);
          return once(windowId);
        }
      });
      queue = run.then(() => undefined, () => undefined);
      return run;
    }
  };
}

/**
 * @typedef {(page: { tabId: number, url: string, title: string }) =>
 *   ({ allowed: true } | { allowed: false, message: string }) | Promise<{ allowed: true } | { allowed: false, message: string }>} ScreenshotPolicy
 *   screenshots are only allowed on tier-0 pages (architecture §14.2)
 */

/**
 * @param {{
 *   capturer: ReturnType<typeof createCapturer>,
 *   getActiveTab: (windowId: number) => Promise<chrome.tabs.Tab|undefined>,
 *   checkPage: ScreenshotPolicy
 * }} deps
 */
export function createScreenCapture({ capturer, getActiveTab, checkPage }) {
  return {
    /**
     * Capture the active tab of the panel's window: the tab the user is looking at, even if the
     * panel's header hasn't caught up yet (EC-SCR-03). The result says which tab it was.
     * @param {number} windowId
     * @returns {Promise<{ dataUrl: string, tabId: number, title: string, url: string }>}
     */
    async captureScreen(windowId) {
      const tab = await getActiveTab(windowId);
      if (tab?.id === undefined) throw new FeatureError('PAGE_RESTRICTED', 'Switch to a tab with a web page first.');
      const url = tab.url || tab.pendingUrl || '';
      const title = tab.title || url;

      // PDFs can't be read as text, but what's on screen can still be captured (EC-PNL-04).
      const access = describePageAccess(url, { fileAccessAllowed: true });
      if (access.restricted && access.reason !== 'pdf') {
        throw new FeatureError('PAGE_RESTRICTED', "Pagewise can't capture this kind of page."); // EC-SCR-02
      }
      const verdict = await checkPage({ tabId: tab.id, url, title });
      if (!verdict.allowed) throw new FeatureError('PAGE_BLOCKED', verdict.message);

      // P3.3: hide Pagewise's own number badges before capturing, then restore them (EC-SCR-08).
      let dataUrl;
      try {
        dataUrl = await capturer.capture(tab.windowId ?? windowId);
      } catch (err) {
        if (isNotAllowed(err)) throw new FeatureError('PAGE_RESTRICTED', "Pagewise can't capture this page.");
        throw new FeatureError('CAPTURE_FAILED', "Couldn't capture the screen. Please try again.");
      }
      return { dataUrl, tabId: tab.id, title, url };
    }
  };
}

/** Wire capture into the router. Call synchronously at the worker's top level. */
export function initCapture() {
  const guard = chromePageGuard();
  const screen = createScreenCapture({
    capturer: createCapturer({ captureVisibleTab: (windowId) => chrome.tabs.captureVisibleTab(windowId, { format: 'png' }) }),
    getActiveTab: async (windowId) => (await chrome.tabs.query({ active: true, windowId }))[0],
    async checkPage({ tabId, url }) {
      try {
        // Chrome's PDF viewer can't be asked for page signals, so only a PDF's address is checked.
        if (describePageAccess(url, { fileAccessAllowed: true }).reason === 'pdf') await guard.assertUrl(url, 'screenshot');
        else await guard.assert(tabId, 'screenshot');
        return { allowed: true };
      } catch (err) {
        if (err instanceof FeatureError) return { allowed: false, message: err.message };
        throw err;
      }
    }
  });

  on(ToSW.CAPTURE_SCREEN, async (_payload, { port, windowId }, msg) => {
    try {
      port.postMessage(makeMessage(ToPanel.CAPTURE_RESULT, await screen.captureScreen(windowId), msg.requestId));
    } catch (err) {
      if (!(err instanceof FeatureError)) throw err; // router turns this into a generic INTERNAL error
      port.postMessage(makeMessage(ToPanel.ERROR, err.toPayload(), msg.requestId));
    }
  });
}
