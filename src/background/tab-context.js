// @ts-check
// Active-tab tracking for the side panel header, plus page-access rules.
// The pure helpers at the top have no chrome.* dependency so they can be unit tested.

import { ToContent } from '../shared/messages.js';
import { FeatureError } from './feature-error.js';

/**
 * @typedef {'browser'|'webstore'|'file'|'pdf'|'none'} RestrictedReason
 * @typedef {{ restricted: boolean, reason?: RestrictedReason }} PageAccess
 * @typedef {{
 *   tabId: number|null, windowId: number, url: string, title: string,
 *   favIconUrl: string|null, status: string, access: PageAccess,
 *   safety?: { level: 'ok'|'sensitive'|'blocked', label: string }|null
 * }} ActiveTabInfo safety: the header badge, once the page has loaded (P4.3)
 */

const BROWSER_SCHEMES = new Set([
  'chrome:', 'chrome-extension:', 'chrome-untrusted:', 'chrome-search:', 'devtools:',
  'edge:', 'about:', 'view-source:', 'data:', 'blob:', 'javascript:', 'filesystem:'
]);

const MAX_DATA_FAVICON_CHARS = 8_192; // EC-PNL-14

/**
 * Decide whether Pagewise can read and act on a URL (EC-PNL-01..04, EC-PNL-10).
 * @param {string|undefined|null} url
 * @param {{ fileAccessAllowed?: boolean }} [opts]
 * @returns {PageAccess}
 */
export function describePageAccess(url, opts = {}) {
  if (!url) return { restricted: true, reason: 'none' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { restricted: true, reason: 'none' };
  }
  if (BROWSER_SCHEMES.has(parsed.protocol)) return { restricted: true, reason: 'browser' };
  if (parsed.protocol === 'file:') {
    return opts.fileAccessAllowed ? { restricted: false } : { restricted: true, reason: 'file' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { restricted: true, reason: 'browser' };

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'chromewebstore.google.com' ||
      (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'))) {
    return { restricted: true, reason: 'webstore' };
  }
  // Chrome renders PDFs in its own viewer, which content scripts can't reach.
  if (/\.pdf$/i.test(parsed.pathname)) return { restricted: true, reason: 'pdf' };
  return { restricted: false };
}

/**
 * Keep only favicons that are safe and cheap to put in the store (EC-PNL-14).
 * @param {string|undefined|null} url
 * @returns {string|null}
 */
export function sanitizeFavIcon(url) {
  if (!url) return null;
  if (url.startsWith('data:')) {
    return url.startsWith('data:image/') && url.length <= MAX_DATA_FAVICON_CHARS ? url : null;
  }
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * @param {chrome.tabs.Tab|undefined} tab
 * @param {number} windowId
 * @param {{ fileAccessAllowed?: boolean }} [opts]
 * @returns {ActiveTabInfo}
 */
export function toActiveTabInfo(tab, windowId, opts = {}) {
  if (!tab) {
    return { tabId: null, windowId, url: '', title: '', favIconUrl: null, status: 'complete', access: { restricted: true, reason: 'none' } };
  }
  // A tab that is still loading may only have pendingUrl.
  const url = tab.url || tab.pendingUrl || '';
  return {
    tabId: tab.id ?? null,
    windowId: tab.windowId ?? windowId,
    url,
    title: tab.title || url,
    favIconUrl: sanitizeFavIcon(tab.favIconUrl),
    status: tab.status || 'complete',
    access: describePageAccess(url, opts)
  };
}

// ---- chrome.* wrappers (service worker only) ----

/**
 * @param {number} windowId
 * @returns {Promise<ActiveTabInfo>}
 */
export async function getActiveTabInfo(windowId) {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  const url = tab?.url || tab?.pendingUrl || '';
  const fileAccessAllowed = url.startsWith('file:') ? await chrome.extension.isAllowedFileSchemeAccess() : false;
  return toActiveTabInfo(tab, windowId, { fileAccessAllowed });
}

/** Content scripts, injected in this order on demand (architecture §5.3). */
const CONTENT_FILES = [
  'vendor/Readability.js',
  'vendor/Readability-readerable.js', // isProbablyReaderable()
  'src/content/generated/field-rules.classic.js', // generated from src/shared/safety (architecture §14.6)
  'src/content/generated/action-rules.classic.js',
  'src/content/bootstrap.js',
  'src/content/extractor.js',
  'src/content/scanner.js',
  'src/content/overlay.js',
  'src/content/executor.js',
  'src/content/youtube.js'
];

/**
 * Wait until a tab finishes loading, up to `timeoutMs` (EC-PNL-05).
 * @param {number} tabId
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true if it finished, false if we gave up waiting
 */
export function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (/** @type {boolean} */ finished) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(finished);
    };
    /** @type {Parameters<typeof chrome.tabs.onUpdated.addListener>[0]} */
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done(true);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    // Listen first, then check, so a load that finishes in between isn't missed.
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') done(true); }, () => done(false));
  });
}

/**
 * Inject the content scripts unless the page already has the handlers we need.
 * Throws if Chrome won't let us script the page (restricted pages).
 * @param {number} tabId
 * @param {string[]} requiredHandlers
 */
export async function ensureInjected(tabId, requiredHandlers) {
  const [probe] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => Object.keys(/** @type {any} */ (globalThis).__pagewise?.handlers ?? {})
  });
  const present = Array.isArray(probe?.result) ? probe.result : [];
  if (requiredHandlers.every((h) => present.includes(h))) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
}

/**
 * Ask the page's content script to do something and return its result.
 * @param {number} tabId
 * @param {string} type
 * @param {any} [payload]
 */
export async function sendToTab(tabId, type, payload) {
  // Only the top frame, which is where ensureInjected put the content scripts: an iframe on the
  // page can never answer for it (P4.3).
  const response = await chrome.tabs.sendMessage(tabId, { type, payload }, { frameId: 0 });
  if (!response) throw new Error(`No response from page for ${type}`);
  if (!response.ok) throw new Error(response.error ?? `Page failed ${type}`);
  return response.result;
}

/**
 * The page's article text, or its visible text when it isn't an article (summary and chat).
 * Gives a loading page up to 10 s, then reads what's there (EC-PNL-05).
 * @param {number} tabId
 * @returns {Promise<{ source: 'article'|'visible', title: string, byline: string|null, text: string,
 *   url: string, isReadable?: boolean, stillLoading: boolean }>}
 */
export async function readPageText(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (describePageAccess(tab.url ?? tab.pendingUrl, { fileAccessAllowed: true }).restricted) {
    throw new FeatureError('PAGE_RESTRICTED', "Pagewise can't read this kind of page.");
  }
  const finished = await waitForTabComplete(tabId, 10_000);
  try {
    await ensureInjected(tabId, [ToContent.CS_EXTRACT_ARTICLE]);
    const page = await sendToTab(tabId, ToContent.CS_EXTRACT_ARTICLE);
    return { ...page, stillLoading: !finished };
  } catch {
    throw new FeatureError('PAGE_RESTRICTED', "Pagewise can't read this page.");
  }
}

/**
 * The text selected on the page, with a little context around it (quick actions and skills).
 * @param {number} tabId
 * @returns {Promise<{ text: string, contextBefore?: string, contextAfter?: string, truncated?: boolean,
 *   protected?: boolean, pageTitle?: string, url?: string }>}
 */
export async function readSelection(tabId) {
  const tab = await chrome.tabs.get(tabId);
  // file:// is let through here; if access isn't granted, injection below fails and we report it.
  if (describePageAccess(tab.url ?? tab.pendingUrl, { fileAccessAllowed: true }).restricted) {
    throw new FeatureError('PAGE_RESTRICTED', "Pagewise can't read this kind of page.");
  }
  try {
    await ensureInjected(tabId, [ToContent.CS_GET_SELECTION]);
    const sel = await sendToTab(tabId, ToContent.CS_GET_SELECTION);
    return { ...sel, pageTitle: tab.title, url: tab.url };
  } catch {
    // Chrome refused to script the page (e.g. file:// without access, or a protected site).
    throw new FeatureError('PAGE_RESTRICTED', "Pagewise can't read this page.");
  }
}

const RELEVANT_CHANGES = ['url', 'title', 'favIconUrl', 'status'];

/**
 * Register tab listeners. Must be called synchronously at the service worker's top level.
 * @param {(windowId: number) => void} onWindowChanged called when a window's active tab (or its details) changed
 */
export function watchActiveTabs(onWindowChanged) {
  chrome.tabs.onActivated.addListener(({ windowId }) => onWindowChanged(windowId));
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && RELEVANT_CHANGES.some((k) => k in changeInfo)) onWindowChanged(tab.windowId);
  });
  // Dragging a tab between windows changes the active tab of both windows (EC-PNL-08).
  chrome.tabs.onDetached.addListener((_tabId, { oldWindowId }) => onWindowChanged(oldWindowId));
  chrome.tabs.onAttached.addListener((_tabId, { newWindowId }) => onWindowChanged(newWindowId));
}
