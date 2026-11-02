// @ts-check
// Request/response over the panel port: tags each request with a requestId and resolves
// with whichever reply carries the same id. Streaming requests also receive progress
// messages (e.g. CHAT_DELTA) before their final reply.

/**
 * @typedef {import('../shared/messages.js').Message} Message
 * @typedef {{ onProgress?: (msg: Message) => void, timeoutMs?: number }} RequestOptions
 */

/**
 * @param {{
 *   send: (msg: Message) => boolean,
 *   progressTypes?: Set<string>,
 *   timeoutMs?: number,
 *   setTimeout?: (fn: () => void, ms: number) => any,
 *   clearTimeout?: (id: any) => void
 * }} deps
 */
export function createRpc({
  send,
  progressTypes = new Set(),
  timeoutMs = 20_000,
  setTimeout: schedule = (fn, ms) => setTimeout(fn, ms),
  clearTimeout: cancel = (id) => clearTimeout(id)
}) {
  let counter = 0;
  /** @type {Map<string, { resolve: (msg: Message) => void, reject: (err: Error) => void, timer: any, arm: () => void, onProgress?: (msg: Message) => void }>} */
  const pending = new Map();

  /**
   * @param {string} type
   * @param {any} payload
   * @param {RequestOptions} [opts]
   */
  function start(type, payload, opts = {}) {
    const requestId = `r${Date.now().toString(36)}-${++counter}`;
    const limit = opts.timeoutMs ?? timeoutMs;
    const done = new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: null,
        onProgress: opts.onProgress,
        // For streams the timeout is an idle timeout: each progress message re-arms it.
        arm() {
          if (entry.timer !== null) cancel(entry.timer);
          entry.timer = schedule(() => {
            pending.delete(requestId);
            reject(new Error('Pagewise took too long to respond. Please try again.'));
          }, limit);
        }
      };
      pending.set(requestId, entry);
      entry.arm();
      /** @type {Message} */
      const msg = { type, requestId };
      if (payload !== undefined) msg.payload = payload;
      if (!send(msg)) {
        cancel(entry.timer);
        pending.delete(requestId);
        reject(new Error("Pagewise's background isn't connected. Please try again in a moment."));
      }
    });
    return { requestId, done };
  }

  return {
    /**
     * @param {string} type
     * @param {any} [payload]
     * @param {{ timeoutMs?: number }} [opts]
     * @returns {Promise<Message>} the reply message (ERROR replies resolve too)
     */
    request: (type, payload, opts) => start(type, payload, opts).done,

    /**
     * Like request(), but progress messages go to onProgress until the final reply.
     * @param {string} type
     * @param {any} payload
     * @param {RequestOptions} opts
     * @returns {{ requestId: string, done: Promise<Message> }}
     */
    stream: (type, payload, opts) => start(type, payload, opts),

    /**
     * Route an incoming message to its waiting request.
     * @param {Message} msg
     * @returns {boolean} true if it was a reply or progress message and has been consumed
     */
    handle(msg) {
      if (!msg.requestId) return false;
      const entry = pending.get(msg.requestId);
      if (!entry) return false;
      if (progressTypes.has(msg.type)) {
        entry.arm();
        entry.onProgress?.(msg);
        return true;
      }
      pending.delete(msg.requestId);
      cancel(entry.timer);
      entry.resolve(msg);
      return true;
    }
  };
}
