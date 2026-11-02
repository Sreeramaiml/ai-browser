// @ts-check
// Shared bootstrap for extension pages that talk to the service worker (side panel, options page).

import { PORT_NAME, ToPanel, ToSW, makeMessage } from '../shared/messages.js';
import { createConnection } from './connection.js';
import { createRpc } from './rpc.js';

const HEARTBEAT_MS = 20_000;

/**
 * @param {{
 *   surface: 'sidepanel'|'options',
 *   onMessage: (msg: import('../shared/messages.js').Message, windowId: number) => void,
 *   onStatus: (status: import('./connection.js').ConnectionStatus) => void
 * }} opts
 */
export async function startClient({ surface, onMessage, onStatus }) {
  const { id: windowId } = await chrome.windows.getCurrent();
  if (windowId === undefined) throw new Error('No window');

  /** @type {ReturnType<typeof createConnection>} */
  let connection;
  const rpc = createRpc({
    send: (msg) => connection.send(msg),
    progressTypes: new Set([ToPanel.CHAT_START, ToPanel.CHAT_DELTA, ToPanel.CHAT_RESET]),
    // Opus thinks before it writes, so allow a long silence before the first words.
    timeoutMs: 90_000
  });

  connection = createConnection({
    connect: () => chrome.runtime.connect({ name: PORT_NAME }),
    isExtensionAlive: () => Boolean(chrome.runtime?.id),
    hello: () => makeMessage(ToSW.PANEL_HELLO, { windowId, surface }),
    onMessage: (msg) => {
      if (!rpc.handle(msg)) onMessage(msg, windowId);
    },
    onStatus
  });
  connection.start();

  // Messages from the panel reset the worker's 30 s idle timer, so a long answer isn't cut off.
  setInterval(() => connection.send(makeMessage(ToSW.PING)), HEARTBEAT_MS);

  return {
    windowId,
    connection,
    request: rpc.request,
    stream: rpc.stream,
    /** Fire-and-forget message (e.g. CANCEL). */
    send: (/** @type {import('../shared/messages.js').Message} */ msg) => connection.send(msg)
  };
}
