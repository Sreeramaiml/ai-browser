// @ts-check
// Right-click menu: Sahayak → Explain this / Translate / Draft a reply (architecture §10.2).
// A click opens the panel and leaves the request in storage.session for it to run (§6.3).

import { PENDING_KEY, QUICK_ACTION_KINDS, makePendingRequest } from '../shared/pending-request.js';

const PARENT_ID = 'sahayak';
export const MENU_ITEMS = Object.freeze([
  { id: 'explain', title: 'Explain this' },
  { id: 'translate', title: 'Translate' },
  { id: 'draft', title: 'Draft a reply' }
]);

/**
 * @typedef {{
 *   removeAll: () => Promise<void>,
 *   create: (props: chrome.contextMenus.CreateProperties, callback?: () => void) => void
 * }} MenusApi
 */

/**
 * Recreate the menu. removeAll first, because items survive updates and a second create with the
 * same id fails (EC-CTX-12).
 * @param {MenusApi} menus
 */
export async function registerMenus(menus) {
  await menus.removeAll();
  // The callback reads lastError so a failure is logged by us, not reported as unchecked.
  const done = () => {
    const err = globalThis.chrome?.runtime?.lastError;
    if (err) console.warn('[Sahayak] context menu', err.message);
  };
  menus.create({ id: PARENT_ID, title: 'Sahayak', contexts: ['selection'] }, done);
  for (const item of MENU_ITEMS) {
    menus.create({ id: item.id, parentId: PARENT_ID, title: item.title, contexts: ['selection'] }, done);
  }
}

/**
 * @param {{
 *   openPanel: (tab: chrome.tabs.Tab) => void,
 *   savePending: (req: import('../shared/pending-request.js').PendingRequest) => Promise<void>,
 *   newId: () => string,
 *   now?: () => number
 * }} deps
 * @returns {(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void}
 */
export function createMenuClickHandler({ openPanel, savePending, newId, now = Date.now }) {
  return (info, tab) => {
    const kind = QUICK_ACTION_KINDS.find((k) => k === info.menuItemId);
    if (!kind) return;
    // First, and synchronously: sidePanel.open() only works inside the user gesture (EC-CTX-01).
    if (tab) openPanel(tab);
    const req = makePendingRequest({ kind, info, tab, id: newId(), now: now() });
    savePending(req).catch((err) => console.error('[Sahayak] could not hand the request to the panel', err));
  };
}

/** Register menu listeners. Call synchronously at the worker's top level. */
export function initContextMenus() {
  chrome.runtime.onInstalled.addListener(() => {
    registerMenus(chrome.contextMenus).catch((err) => console.error('[Sahayak] context menus failed', err));
  });

  chrome.contextMenus.onClicked.addListener(createMenuClickHandler({
    openPanel: (tab) => {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => console.error('[Sahayak] sidePanel.open failed', err));
    },
    // Replaces any earlier request, so two quick clicks run only the latest (EC-CTX-03).
    savePending: (req) => chrome.storage.session.set({ [PENDING_KEY]: req }),
    newId: () => crypto.randomUUID()
  }));
}
