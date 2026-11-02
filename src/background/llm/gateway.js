// @ts-check
// Single entry point for LLM calls (architecture §8.1). Feature code names a task; the routing
// policy turns it into a chain of links (Flash-Lite → Groq → Flash, …) and this walks the chain:
// retry the same link on short waits and transient errors, cool a link down on rate limits, fall
// back to the next link, and fail fast on errors no other link would fix (§8.4).
// Keys are read here and never leave the service worker. Every outbound text part is redacted
// here too (architecture §15.2), so no feature can forget to.

import { redact, redactTurns } from '../../shared/redact.js';
import { parseModelJson } from '../../shared/text.js';
import { LlmError } from './errors.js';
import { generateContent, streamMessage } from './providers/gemini.js';
import { generateGroq, streamGroq } from './providers/groq.js';
import { DEFAULT_COOLDOWN_MS, abortableSleep, createRateLimiter, memoryArea, nextMidnightPacific } from './rate-limiter.js';
import { chainFor } from './routing-policy.js';

/**
 * @typedef {import('./providers/gemini.js').Turn} Turn
 * @typedef {import('./routing-policy.js').Attempt} Link
 * @typedef {{ text: string, provider: string, model: string, stopReason: string|null, attempts: number }} GatewayResult
 * @typedef {'429'|'500'|'timeout'|'daily'} Fault dev-only fault injection (Settings → Advanced, ?dev=1)
 * @typedef {{ action: 'retry', delayMs: number } | { action: 'trim' }
 *   | { action: 'next', cooldown?: { ms: number } | { daily: true } } | { action: 'fail' }} Decision
 */

/** Hard cap on provider calls for one user request, so failures can't snowball (EC-RTL-10). */
export const MAX_HTTP_ATTEMPTS = 6;
/** A rate-limit wait up to this long is sat out on the same link; longer ones move on (EC-RTL-01/02). */
export const MAX_SAME_LINK_WAIT_MS = 8_000;
/** Backoff before the 2nd and 3rd attempt after a 5xx or network error. */
export const BACKOFF_MS = [1_000, 3_000];
const JITTER_MS = 300;

/** Errors worth retrying on the same link after a backoff. */
const TRANSIENT = new Set(['PROVIDER_DOWN', 'OVERLOADED', 'NETWORK', 'EMPTY_RESPONSE', 'INTERRUPTED']);

/**
 * What to do after one call on a link failed (pure).
 * @param {LlmError} err
 * @param {{ attempt: number, provider: 'gemini'|'groq', trimmed: boolean }} ctx attempt: 0 for the link's first call
 * @returns {Decision}
 */
export function decide(err, { attempt, provider, trimmed }) {
  switch (err.code) {
    case 'RATE_LIMITED': {
      const delay = err.retryAfterMs;
      if (delay !== undefined && delay <= MAX_SAME_LINK_WAIT_MS && attempt < 2) return { action: 'retry', delayMs: delay };
      return { action: 'next', cooldown: { ms: delay ?? DEFAULT_COOLDOWN_MS } };
    }
    case 'QUOTA_EXHAUSTED':
      return { action: 'next', cooldown: { daily: true } };
    case 'TIMEOUT':
      return attempt < 1 ? { action: 'retry', delayMs: 0 } : { action: 'next' };
    case 'CONTEXT_TOO_LARGE':
      return trimmed ? { action: 'fail' } : { action: 'trim' };
    case 'MODEL_UNAVAILABLE': // e.g. a decommissioned model (EC-RTL-08)
    case 'UNSUPPORTED_INPUT': // Groq given an image
    case 'INVALID_OUTPUT': // JSON failed twice: escalate (§8.5)
      return { action: 'next' };
    case 'AUTH_FAILED':
    case 'BAD_REQUEST':
      // A broken optional Groq key mustn't stop Gemini's Flash from answering.
      return provider === 'groq' ? { action: 'next' } : { action: 'fail' };
    default:
      if (TRANSIENT.has(err.code)) return attempt < 2 ? { action: 'retry', delayMs: BACKOFF_MS[attempt] } : { action: 'next' };
      // SAFETY_BLOCKED (no getting round a provider's safety, EC-LLM-05), REGION_UNSUPPORTED, CANCELLED, …
      return { action: 'fail' };
  }
}

/**
 * For a "context too long" 400: cut the longest text part to half, keeping its start and end (so
 * closing tags and the final instruction survive), and retry once (§8.4).
 * @param {Turn[]} turns
 * @returns {Turn[]}
 */
export function halveLongestText(turns) {
  /** @type {{ ti: number, pi: number, len: number }|null} */
  let best = null;
  turns.forEach((t, ti) => t.parts.forEach((p, pi) => {
    if (typeof p.text === 'string' && (!best || p.text.length > best.len)) best = { ti, pi, len: p.text.length };
  }));
  if (!best) return turns;
  const { ti: bt, pi: bp } = best;
  return turns.map((t, ti) => (ti !== bt ? t : {
    ...t,
    parts: t.parts.map((p, pi) => {
      if (pi !== bp || typeof p.text !== 'string') return p;
      const text = p.text;
      return { text: `${text.slice(0, Math.floor(text.length * 0.4))}\n\n[… part of this text was cut to fit …]\n\n${text.slice(-Math.floor(text.length * 0.1))}` };
    })
  }));
}

/**
 * The error a simulated fault raises in place of a real Gemini call.
 * @param {Fault} fault
 */
function faultError(fault) {
  if (fault === '429') return new LlmError('RATE_LIMITED', { status: 429, retryAfterMs: 15_000 });
  if (fault === 'daily') return new LlmError('QUOTA_EXHAUSTED', { status: 429 });
  if (fault === '500') return new LlmError('PROVIDER_DOWN', { status: 500 });
  return new LlmError('TIMEOUT');
}

/**
 * @param {{
 *   getApiKey: () => Promise<string|undefined>,
 *   getModels: () => Promise<{ lite: string, flash: string, groq?: string }>,
 *   getGroqKey?: () => Promise<string|undefined>,
 *   getRedaction?: () => Promise<{ contacts: boolean }>,
 *   stream?: typeof streamMessage,
 *   generate?: typeof generateContent,
 *   groqStream?: typeof streamGroq,
 *   groqGenerate?: typeof generateGroq,
 *   limiter?: ReturnType<typeof createRateLimiter>,
 *   takeFault?: () => Promise<Fault|null>,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   now?: () => number,
 *   random?: () => number
 * }} deps getGroqKey: the Groq key if saved and enabled (Groq links are skipped otherwise);
 *   getRedaction: whether to also hide emails and phone numbers (EC-RED-09)
 */
export function createGateway({
  getApiKey, getModels, getGroqKey = async () => undefined, getRedaction = async () => ({ contacts: false }),
  stream = streamMessage, generate = generateContent, groqStream = streamGroq, groqGenerate = generateGroq,
  limiter = createRateLimiter({ area: memoryArea() }), takeFault = async () => null,
  sleep = abortableSleep, now = Date.now, random = Math.random
}) {
  /**
   * Walk the chain for one request. `call` makes one provider call on a link.
   * @template R
   * @param {{ task: import('./routing-policy.js').TaskKind, turns: Turn[], escalate?: boolean, signal?: AbortSignal }} req
   * @param {(link: Link, turns: Turn[], apiKey: string) => Promise<R>} call
   * @returns {Promise<R & { provider: string, attempts: number }>}
   */
  async function runChain(req, call) {
    const [geminiKey, groqKey, models, fault] = await Promise.all([getApiKey(), getGroqKey(), getModels(), takeFault()]);
    if (!geminiKey) throw new LlmError('NO_API_KEY');
    const chain = chainFor(req.task, models, { escalate: req.escalate, groq: Boolean(groqKey) });
    // Escalations cost more quota, so they are logged (architecture §8.2).
    if (req.escalate) console.info('[Pagewise] escalation', { task: req.task, to: chain[0]?.model, reason: 'try-harder' });

    let turns = req.turns;
    let trimmed = false;
    let calls = 0;
    /** @type {LlmError[]} */
    const failures = [];
    /** @type {import('./rate-limiter.js').Cooldown[]} */
    const cooling = [];

    chain: for (const [i, link] of chain.entries()) {
      const key = `${link.provider}:${link.model}`;
      const active = await limiter.cooldown(key);
      if (active) {
        cooling.push(active);
        continue;
      }
      if (i > 0) {
        console.info(`[Pagewise] ${link.tier === 'groq' ? 'fallback' : 'escalation'}`, {
          task: req.task, to: link.model, reason: failures.at(-1)?.code ?? 'cooldown'
        });
      }

      for (let attempt = 0; ; attempt++) {
        if (req.signal?.aborted) throw new LlmError('CANCELLED'); // nothing is sent after Stop (EC-RTL-11)
        if (calls >= MAX_HTTP_ATTEMPTS) break chain;
        await limiter.pace(key, link.tier, req.signal);
        calls++;
        try {
          if (fault && link.provider === 'gemini') throw faultError(fault);
          const result = await call(link, turns, link.provider === 'groq' ? /** @type {string} */ (groqKey) : geminiKey);
          return { ...result, provider: link.provider, attempts: calls };
        } catch (err) {
          if (!(err instanceof LlmError)) throw err;
          if (err.code === 'CANCELLED' || req.signal?.aborted) throw new LlmError('CANCELLED');
          const decision = decide(err, { attempt, provider: link.provider, trimmed });
          if (decision.action === 'fail') throw err;
          if (decision.action === 'trim') {
            turns = halveLongestText(turns);
            trimmed = true;
            continue;
          }
          if (decision.action === 'retry') {
            await sleep(decision.delayMs + random() * JITTER_MS, req.signal);
            continue;
          }
          failures.push(err);
          if (decision.cooldown) {
            const daily = 'daily' in decision.cooldown;
            const until = 'daily' in decision.cooldown ? nextMidnightPacific(now()) : now() + decision.cooldown.ms;
            const reason = daily ? 'daily' : 'rate';
            await limiter.setCooldown(key, until, reason);
            cooling.push({ until, reason });
          }
          continue chain;
        }
      }
    }

    // Nothing answered. Rate limits win, with the earliest time a link frees up (EC-RTL-05).
    if (cooling.length) {
      const retryAt = Math.min(...cooling.map((c) => c.until));
      const daily = cooling.every((c) => c.reason === 'daily');
      throw new LlmError(daily ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED', { retryAt, hint: daily && !groqKey ? 'add-groq' : undefined });
    }
    throw failures[0] ?? new LlmError('PROVIDER_DOWN');
  }

  /**
   * The request as it may leave the browser: card numbers, Aadhaar, PAN, OTPs, UPI IDs and keys
   * removed from the system prompt and every text part (§15.2).
   * @template {{ system: string, turns: Turn[] }} R
   * @param {R} req
   * @returns {Promise<R>}
   */
  async function scrub(req) {
    const opts = await getRedaction();
    return { ...req, system: redact(req.system, opts).text, turns: redactTurns(req.turns, opts) };
  }

  return {
    /**
     * Stream an answer. Resolves with the full text once the model finishes. If a link fails after
     * streaming some text, onReset is called before the next attempt streams its own.
     * @param {{
     *   task: import('./routing-policy.js').TaskKind,
     *   system: string,
     *   turns: Turn[],
     *   maxTokens?: number,
     *   escalate?: boolean,
     *   signal?: AbortSignal,
     *   onDelta: (text: string) => void,
     *   onReset?: () => void
     * }} original escalate: start at the stronger model (the user pressed "Try harder")
     * @returns {Promise<GatewayResult>}
     */
    async stream(original) {
      const req = await scrub(original);
      let streamed = false;
      return runChain(req, (link, turns, apiKey) => {
        if (streamed) {
          req.onReset?.();
          streamed = false;
        }
        const impl = link.provider === 'groq' ? groqStream : stream;
        const onDelta = (/** @type {string} */ d) => {
          streamed = true;
          req.onDelta(d);
        };
        return impl({ model: link.model, system: req.system, turns, maxTokens: req.maxTokens }, { apiKey, signal: req.signal, onDelta });
      });
    },

    /**
     * Ask for strict JSON and return it only once it passes `validate` (architecture §8.5):
     * parse → validate → one repair re-ask that quotes the validator error → the next link
     * (escalation) → INVALID_OUTPUT.
     * @template T
     * @param {{
     *   task: import('./routing-policy.js').TaskKind,
     *   system: string,
     *   turns: Turn[],
     *   schema?: object,
     *   validate: (value: unknown) => ({ ok: true, value: T } | { ok: false, error: string }),
     *   escalate?: boolean,
     *   signal?: AbortSignal,
     *   timeoutMs?: number
     * }} original
     * @returns {Promise<{ value: T, provider: string, model: string, attempts: number }>}
     */
    async json(original) {
      const req = await scrub(original);
      const { value, provider, model, attempts } = await runChain(req, async (link, turns, apiKey) => {
        const gen = link.provider === 'groq' ? groqGenerate : generate;
        // Groq can't enforce a schema; the prompt describes the shape either way (§8.3).
        let schema = link.provider === 'groq' ? undefined : req.schema;
        const opts = { apiKey, signal: req.signal, timeoutMs: req.timeoutMs };

        /** @param {Turn[]} t */
        const callOnce = async (t) => {
          const base = { model: link.model, system: req.system, turns: t };
          try {
            return await gen(base, { ...opts, json: schema ? { schema } : {} });
          } catch (err) {
            // If the API rejects our schema, the prompt still describes the shape: retry without it.
            if (schema && err instanceof LlmError && err.code === 'BAD_REQUEST') {
              schema = undefined;
              return gen(base, { ...opts, json: {} });
            }
            throw err;
          }
        };

        let attemptTurns = turns;
        for (let n = 0; n < 2; n++) {
          const result = await callOnce(attemptTurns);
          const parsed = parseModelJson(result.text);
          const checked = parsed.ok ? req.validate(parsed.value) : parsed;
          if (checked.ok) return { value: checked.value, model: result.model };
          // Repair: show the model its own answer and exactly what was wrong with it.
          attemptTurns = [
            ...turns,
            { role: 'assistant', parts: [{ text: result.text }] },
            { role: 'user', parts: [{ text: `That reply was not usable: ${checked.error} Reply again with the corrected JSON only.` }] }
          ];
        }
        throw new LlmError('INVALID_OUTPUT');
      });
      return { value, provider, model, attempts };
    }
  };
}
