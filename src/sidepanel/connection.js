// @ts-check
// Keeps the side panel connected to the service worker (EC-PNL-12, EC-PNL-13, EC-INS-06).
// Dependencies are injected so the reconnect policy can be unit tested without Chrome.

/**
 * @typedef {'connecting'|'connected'|'failed'|'invalidated'} ConnectionStatus
 * @typedef {{
 *   postMessage: (msg: any) => void,
 *   onMessage: { addListener: (fn: (msg: any) => void) => void },
 *   onDisconnect: { addListener: (fn: () => void) => void }
 * }} PortLike
 * @typedef {{
 *   connect: () => PortLike,
 *   isExtensionAlive: () => boolean,
 *   hello: () => any,
 *   onMessage: (msg: any) => void,
 *   onStatus: (status: ConnectionStatus) => void,
 *   setTimeout?: (fn: () => void, ms: number) => any,
 *   clearTimeout?: (id: any) => void
 * }} ConnectionDeps
 */

/** Delay before retry N after N consecutive failures. The 5th failure gives up. */
export const BACKOFF_MS = [500, 1000, 2000, 4000];
export const MAX_FAILED_ATTEMPTS = BACKOFF_MS.length + 1;

/** @param {ConnectionDeps} deps */
export function createConnection(deps) {
  const schedule = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.clearTimeout ?? ((id) => clearTimeout(id));

  /** @type {PortLike|null} */
  let port = null;
  /** Consecutive disconnects without the worker ever answering. */
  let failures = 0;
  let timer = null;
  /** @type {ConnectionStatus} */
  let status = 'connecting';

  /** @param {ConnectionStatus} next */
  function setStatus(next) {
    if (next === status) return;
    status = next;
    deps.onStatus(next);
  }

  function open() {
    timer = null;
    if (!deps.isExtensionAlive()) {
      setStatus('invalidated');
      return;
    }
    let answered = false;
    let current;
    try {
      current = deps.connect();
    } catch {
      handleDrop(false);
      return;
    }
    port = current;
    current.onMessage.addListener((msg) => {
      if (port !== current) return;
      if (!answered) {
        answered = true;
        failures = 0;
        setStatus('connected');
      }
      deps.onMessage(msg);
    });
    current.onDisconnect.addListener(() => {
      if (port !== current) return;
      port = null;
      handleDrop(answered);
    });
    current.postMessage(deps.hello());
  }

  /** @param {boolean} wasHealthy */
  function handleDrop(wasHealthy) {
    if (!deps.isExtensionAlive()) {
      setStatus('invalidated'); // extension reloaded or removed: this page is orphaned
      return;
    }
    if (wasHealthy) {
      // Normal worker sleep/restart: reconnect quietly, without flagging an error.
      timer = schedule(open, BACKOFF_MS[0]);
      return;
    }
    failures += 1;
    if (failures >= MAX_FAILED_ATTEMPTS) {
      setStatus('failed');
      return;
    }
    setStatus('connecting');
    timer = schedule(open, BACKOFF_MS[failures - 1]);
  }

  return {
    start: open,

    /** Manual retry from the "stopped responding" banner. */
    retry() {
      if (timer !== null) cancel(timer);
      failures = 0;
      setStatus('connecting');
      open();
    },

    /**
     * @param {any} msg
     * @returns {boolean} whether the message was handed to a live port
     */
    send(msg) {
      if (!port) return false;
      try {
        port.postMessage(msg);
        return true;
      } catch {
        return false;
      }
    },

    getStatus: () => status
  };
}
