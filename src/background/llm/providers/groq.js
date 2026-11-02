// @ts-check
// Groq adapter: OpenAI-compatible chat completions, text only (architecture §8.3). The free,
// optional fallback when Gemini is busy. Pure helpers at the top are unit tested; I/O is at the bottom.

import { GROQ_API_BASE, LLM_FIRST_BYTE_TIMEOUT_MS, LLM_STREAM_IDLE_TIMEOUT_MS } from '../../../shared/config.js';
import { LlmError, parseRetryAfter } from '../errors.js';
import { createSseParser } from '../sse.js';

/**
 * @typedef {import('./gemini.js').GeminiRequest} ChatRequest same shape for both providers
 * @typedef {import('./gemini.js').GeminiResult} ChatResult
 */

/**
 * Headers for every call to Groq. The key goes only in Authorization, only to GROQ_API_BASE.
 * @param {string} key
 */
export function groqHeaders(key) {
  return { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

/**
 * Build the chat-completions body (pure). Images and YouTube links can't be sent to Groq, so they
 * throw UNSUPPORTED_INPUT, which tells the gateway to move to the next link.
 * @param {ChatRequest} req
 * @param {{ json?: boolean, stream?: boolean }} [opts]
 */
export function buildGroqRequest(req, opts = {}) {
  const messages = [{ role: 'system', content: req.system }];
  for (const turn of req.turns) {
    const texts = turn.parts.map((part) => {
      if (typeof part.text !== 'string') throw new LlmError('UNSUPPORTED_INPUT');
      return part.text;
    });
    messages.push({ role: turn.role === 'assistant' ? 'assistant' : 'user', content: texts.join('\n\n') });
  }
  /** @type {Record<string, any>} */
  const body = { model: req.model, messages };
  if (req.maxTokens) body.max_tokens = req.maxTokens;
  // Groq has no schema enforcement; the prompt describes the shape and the validator checks it.
  if (opts.json) body.response_format = { type: 'json_object' };
  if (opts.stream) body.stream = true;
  return body;
}

/**
 * Map a Groq error response to an LlmError (pure). Groq errors look like
 * { error: { message, type, code } }.
 * @param {number} status
 * @param {any} body
 * @param {{ get: (name: string) => string|null }} [headers]
 */
export function errorFromGroqResponse(status, body, headers) {
  const err = body?.error ?? {};
  const code = String(err.code ?? '');
  const text = String(err.message ?? '');
  if (status === 429 || code === 'rate_limit_exceeded') {
    const retryAfterMs = parseRetryAfter(headers?.get?.('retry-after'));
    // Groq names daily limits "tokens per day (TPD)" / "requests per day (RPD)".
    const daily = /per day|\b(TPD|RPD)\b/i.test(text);
    return new LlmError(daily ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED', { status, retryAfterMs });
  }
  if (status === 401 || status === 403 || code === 'invalid_api_key') return new LlmError('AUTH_FAILED', { status });
  if (status === 404 || code === 'model_not_found' || code === 'model_decommissioned') {
    return new LlmError('MODEL_UNAVAILABLE', { status }); // EC-RTL-08
  }
  if (status === 413 || code === 'context_length_exceeded' || /context length|too long|reduce the length/i.test(text)) {
    return new LlmError('CONTEXT_TOO_LARGE', { status });
  }
  if (status === 503 || status === 498) return new LlmError('OVERLOADED', { status });
  if (status >= 500 || status === 0) return new LlmError('PROVIDER_DOWN', { status });
  return new LlmError('BAD_REQUEST', { status });
}

/** @param {string|null|undefined} reason */
function stopReasonOf(reason) {
  if (reason === 'stop') return 'end_turn';
  if (reason === 'length') return 'max_tokens';
  return reason ?? null;
}

/**
 * Final checks on a finished answer (pure).
 * @param {{ text: string, finishReason: string|null, model: string }} state
 * @returns {ChatResult}
 */
export function finishGroq(state) {
  if (state.finishReason === 'content_filter') throw new LlmError('SAFETY_BLOCKED');
  if (!state.finishReason) throw new LlmError('INTERRUPTED');
  if (!state.text.trim()) throw new LlmError('EMPTY_RESPONSE');
  return { text: state.text, model: state.model, stopReason: stopReasonOf(state.finishReason) };
}

// ---- I/O ----

/**
 * @param {Response} res
 */
async function failFrom(res) {
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  return errorFromGroqResponse(res.status, isJson ? await res.json().catch(() => null) : null, res.headers);
}

/**
 * One non-streaming request (JSON tasks).
 * @param {ChatRequest} req
 * @param {{ apiKey: string, signal?: AbortSignal, json?: object, timeoutMs?: number, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<ChatResult>}
 */
export async function generateGroq(req, { apiKey, signal, json, timeoutMs = LLM_FIRST_BYTE_TIMEOUT_MS, fetchImpl = fetch }) {
  const body = buildGroqRequest(req, { json: Boolean(json) });
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const res = await fetchImpl(`${GROQ_API_BASE}/chat/completions`, {
      method: 'POST', headers: groqHeaders(apiKey), body: JSON.stringify(body), signal: controller.signal
    });
    if (!res.ok) throw await failFrom(res);
    const data = await res.json().catch(() => null);
    if (!data) throw new LlmError('PROVIDER_DOWN', { status: res.status });
    if (data.error) throw errorFromGroqResponse(0, data);
    const choice = data.choices?.[0];
    return finishGroq({ text: String(choice?.message?.content ?? ''), finishReason: choice?.finish_reason ?? null, model: data.model ?? req.model });
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (signal?.aborted) throw new LlmError('CANCELLED');
    if (timedOut) throw new LlmError('TIMEOUT');
    throw new LlmError('NETWORK', { cause: err });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

/**
 * Stream a response: SSE `data:` lines with OpenAI-style deltas, ending with `data: [DONE]`.
 * @param {ChatRequest} req
 * @param {{ apiKey: string, signal?: AbortSignal, onDelta: (text: string) => void, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<ChatResult>}
 */
export async function streamGroq(req, { apiKey, signal, onDelta, fetchImpl = fetch }) {
  const body = buildGroqRequest(req, { stream: true });
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller);
  let timedOut = false;
  let timer = setTimeout(() => { timedOut = true; controller.abort(); }, LLM_FIRST_BYTE_TIMEOUT_MS);
  const resetIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, LLM_STREAM_IDLE_TIMEOUT_MS);
  };

  const state = { text: '', finishReason: /** @type {string|null} */ (null), model: req.model };
  /** @type {LlmError|null} */
  let streamError = null;
  try {
    const res = await fetchImpl(`${GROQ_API_BASE}/chat/completions`, {
      method: 'POST', headers: groqHeaders(apiKey), body: JSON.stringify(body), signal: controller.signal
    });
    if (!res.ok) throw await failFrom(res);
    if (!res.body) throw new LlmError('EMPTY_RESPONSE');

    const decoder = new TextDecoder();
    const parser = createSseParser(({ data }) => {
      if (data === '[DONE]') return;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }
      if (chunk.error) {
        streamError = errorFromGroqResponse(0, chunk);
        return;
      }
      if (chunk.model) state.model = chunk.model;
      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) state.finishReason = choice.finish_reason;
      const delta = choice?.delta?.content;
      if (typeof delta === 'string' && delta) {
        state.text += delta;
        onDelta(delta);
      }
    });
    const reader = res.body.getReader();
    resetIdle();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
    if (streamError) throw streamError;
    return finishGroq(state);
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (signal?.aborted) throw new LlmError('CANCELLED');
    if (timedOut) throw new LlmError(state.text ? 'INTERRUPTED' : 'TIMEOUT');
    throw new LlmError('NETWORK', { cause: err });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

/**
 * "Test key" for Groq: GET /models (free). Also checks Pagewise's Groq model is still offered (EC-RTL-08).
 * @param {string} key
 * @param {{ model: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Promise<import('../key-check.js').KeyCheckResult>}
 */
export async function checkGroqKey(key, { model, fetchImpl = fetch, timeoutMs = 10_000 }) {
  if (!key) return { ok: false, code: 'NO_API_KEY', message: 'Enter a key first.' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${GROQ_API_BASE}/models`, { method: 'GET', headers: groqHeaders(key), signal: controller.signal });
    const body = await res.json().catch(() => null);
    if (res.status === 200 && Array.isArray(body?.data)) {
      const ids = new Set(body.data.map((m) => String(m?.id ?? '')));
      return ids.has(model)
        ? { ok: true, message: '✓ Key works.' }
        : { ok: true, message: '✓ Key works.', warning: `But Groq no longer offers ${model}, so the backup won't work. Pagewise's Groq model setting needs updating.` };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'AUTH_FAILED', message: 'Groq rejected this key. Check that you copied the whole key.' };
    }
    if (res.status === 429) return { ok: false, code: 'RATE_LIMITED', message: 'This key is being rate-limited right now. Wait a minute and test again.' };
    return { ok: false, code: 'PROVIDER_DOWN', message: "Groq isn't responding properly right now. Try again shortly." };
  } catch {
    if (controller.signal.aborted) return { ok: false, code: 'TIMEOUT', message: 'Groq took too long to respond. Try again.' };
    return { ok: false, code: 'NETWORK', message: "Couldn't reach Groq. Check your internet connection." };
  } finally {
    clearTimeout(timer);
  }
}
