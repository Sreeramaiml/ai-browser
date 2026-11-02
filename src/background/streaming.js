// @ts-check
// Shared plumbing for streamed answers (explain, page chat, …): the Hinglish retry, the
// CHAT_START → CHAT_DELTA* → CHAT_DONE | ERROR message sequence, and CANCEL.

import { checkHinglish } from '../shared/language.js';
import { ToPanel, ToSW, makeMessage } from '../shared/messages.js';
import { hinglishRetryRule } from '../shared/prompts/_common.js';
import { FeatureError } from './feature-error.js';
import { LlmError } from './llm/errors.js';
import { on } from './router.js';

/**
 * @typedef {{
 *   signal?: AbortSignal,
 *   onStart: (info: Record<string, unknown>) => void,
 *   onDelta: (text: string) => void,
 *   onReset?: () => void
 * }} StreamIO onReset: discard the text streamed so far (a retry is about to replace it)
 */

/**
 * gateway.stream, plus one retry with a stronger instruction if a Hinglish answer came back in
 * Devanagari or plain English (EC-LNG-01/02). If the retry fails, the first answer is shown again.
 * @param {ReturnType<typeof import('./llm/gateway.js').createGateway>} gateway
 * @param {Omit<Parameters<ReturnType<typeof import('./llm/gateway.js').createGateway>['stream']>[0], 'onDelta'|'onReset'|'signal'>} req
 * @param {string} language
 * @param {StreamIO} io onReset is also used when the gateway falls back to another model mid-answer
 */
export async function streamInLanguage(gateway, req, language, { signal, onDelta, onReset = () => {} }) {
  const first = await gateway.stream({ ...req, signal, onDelta, onReset });
  if (language !== 'hinglish') return first;

  const check = checkHinglish(first.text);
  if (check.ok) return first;
  onReset();
  try {
    return await gateway.stream({ ...req, system: `${req.system}\n${hinglishRetryRule(check.problem)}`, signal, onDelta, onReset });
  } catch (err) {
    if (signal?.aborted) throw err;
    // The retry failed, but the first answer was fine apart from its language: show it again.
    onReset();
    onDelta(first.text);
    return first;
  }
}

/** requestId → controller, so CANCEL can stop a stream. Lost if the worker restarts, which also ends the stream. */
const running = new Map();

/**
 * Router handler for a streamed feature. `run` resolves with the CHAT_DONE payload.
 * @param {(payload: any, io: Required<StreamIO>) => Promise<Record<string, unknown>>} run
 * @returns {import('./router.js').Handler}
 */
export function streamingHandler(run) {
  return async (payload, { port }, msg) => {
    const requestId = msg.requestId;
    const controller = new AbortController();
    if (requestId) running.set(requestId, controller);

    /** @param {import('../shared/messages.js').Message} m */
    const post = (m) => {
      try {
        port.postMessage(m);
      } catch {
        controller.abort(); // panel closed: stop paying for tokens nobody will see
      }
    };

    try {
      const result = await run(payload, {
        signal: controller.signal,
        onStart: (info) => post(makeMessage(ToPanel.CHAT_START, info, requestId)),
        onDelta: (text) => post(makeMessage(ToPanel.CHAT_DELTA, { text }, requestId)),
        onReset: () => post(makeMessage(ToPanel.CHAT_RESET, {}, requestId))
      });
      post(makeMessage(ToPanel.CHAT_DONE, result, requestId));
    } catch (err) {
      if (err instanceof LlmError || err instanceof FeatureError) {
        post(makeMessage(ToPanel.ERROR, err.toPayload(), requestId));
      } else {
        throw err; // router turns this into a generic INTERNAL error
      }
    } finally {
      if (requestId) running.delete(requestId);
    }
  };
}

/** Register CANCEL once for every streamed feature. Call synchronously at the worker's top level. */
export function initCancel() {
  on(ToSW.CANCEL, (payload) => {
    running.get(payload?.requestId)?.abort();
  });
}
