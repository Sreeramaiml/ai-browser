// @ts-check
// Accepts panel ports and dispatches incoming messages to handlers.
// Two surfaces connect: the side panel (one per window, receives ACTIVE_TAB) and the options page.

import { PORT_NAME, ToPanel, ToSW, isMessage, makeMessage } from '../shared/messages.js';

/**
 * @typedef {'sidepanel'|'options'} Surface
 * @typedef {{ port: chrome.runtime.Port, windowId: number, surface: Surface }} PanelContext
 * @typedef {(payload: any, ctx: PanelContext, msg: import('../shared/messages.js').Message) => (void|Promise<void>)} Handler
 */

/** windowId → side panel port. Rebuilt on every reconnect, so it's safe to lose when the worker sleeps. */
const sidePanels = new Map();
/** Every identified port, side panels and options pages alike. */
/** @type {Set<chrome.runtime.Port>} */
const allPorts = new Set();
/** @type {Map<string, Handler>} */
const handlers = new Map();
/** @type {Set<(ctx: PanelContext) => void>} */
const connectListeners = new Set();
/** @type {Set<(ctx: PanelContext) => void>} */
const disconnectListeners = new Set();

/**
 * @param {string} type
 * @param {Handler} handler
 */
export function on(type, handler) {
  handlers.set(type, handler);
}

/** @param {(ctx: PanelContext) => void} fn called when any panel surface (re)connects */
export function onPanelConnected(fn) {
  connectListeners.add(fn);
}

/** @param {(ctx: PanelContext) => void} fn called when an identified panel surface goes away (closed or reloaded) */
export function onPanelDisconnected(fn) {
  disconnectListeners.add(fn);
}

/** @param {chrome.runtime.Port} port @param {import('../shared/messages.js').Message} msg */
function post(port, msg) {
  try {
    port.postMessage(msg);
    return true;
  } catch {
    allPorts.delete(port); // died between disconnect and cleanup
    return false;
  }
}

/**
 * Send to the side panel open in `windowId`, if any.
 * @param {number} windowId
 * @param {import('../shared/messages.js').Message} msg
 * @returns {boolean} whether a panel received it
 */
export function sendToWindow(windowId, msg) {
  const port = sidePanels.get(windowId);
  if (!port) return false;
  if (post(port, msg)) return true;
  sidePanels.delete(windowId);
  return false;
}

/** @param {import('../shared/messages.js').Message} msg */
export function broadcast(msg) {
  for (const port of [...allPorts]) post(port, msg);
}

const SURFACE_PAGES = { sidepanel: 'src/sidepanel/index.html', options: 'src/sidepanel/options.html' };

/** @param {chrome.runtime.Port} port */
function isTrustedPort(port) {
  // Only our own extension pages may connect (EC-INJ-07).
  return port.name === PORT_NAME &&
    port.sender?.id === chrome.runtime.id &&
    typeof port.sender?.url === 'string' &&
    port.sender.url.startsWith(chrome.runtime.getURL('src/sidepanel/'));
}

/** Register the connection listener. Must be called synchronously at the service worker's top level. */
export function initRouter() {
  chrome.runtime.onConnect.addListener((port) => {
    if (!isTrustedPort(port)) {
      port.disconnect();
      return;
    }
    /** @type {PanelContext|null} */
    let ctx = null;

    port.onMessage.addListener(async (msg) => {
      if (!isMessage(msg)) return;

      if (msg.type === ToSW.PANEL_HELLO) {
        const windowId = Number(msg.payload?.windowId);
        const surface = msg.payload?.surface === 'options' ? 'options' : 'sidepanel';
        if (!Number.isInteger(windowId)) return;
        // The claimed surface must match the page that actually connected.
        if (!port.sender?.url?.startsWith(chrome.runtime.getURL(SURFACE_PAGES[surface]))) return;
        ctx = { port, windowId, surface };
        allPorts.add(port);
        if (surface === 'sidepanel') sidePanels.set(windowId, port);
        for (const fn of connectListeners) fn(ctx);
        return;
      }
      if (ctx === null) return; // ignore anything before the page identifies itself
      if (msg.type === ToSW.PING) return; // receiving it is the point: it resets the worker's idle timer

      const handler = handlers.get(msg.type);
      if (!handler) {
        post(port, makeMessage(ToPanel.ERROR, { code: 'UNKNOWN_MESSAGE', message: `No handler for ${msg.type}` }, msg.requestId));
        return;
      }
      try {
        await handler(msg.payload, ctx, msg);
      } catch (err) {
        // Log the type only: payloads can contain API keys (EC-SET-13).
        console.error('[Pagewise] handler failed', msg.type, err instanceof Error ? err.name : 'error');
        post(port, makeMessage(ToPanel.ERROR, { code: 'INTERNAL', message: 'Something went wrong. Please try again.' }, msg.requestId));
      }
    });

    port.onDisconnect.addListener(() => {
      allPorts.delete(port);
      if (ctx?.surface === 'sidepanel' && sidePanels.get(ctx.windowId) === port) sidePanels.delete(ctx.windowId);
      if (ctx) for (const fn of disconnectListeners) fn(ctx);
    });
  });
}
