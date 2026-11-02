// @ts-check
// Gemini adapter: models/{model}:streamGenerateContent?alt=sse (architecture §8.3).
// Pure helpers at the top (request body, stream state) are unit tested; I/O is at the bottom.

import { GEMINI_API_BASE, LLM_FIRST_BYTE_TIMEOUT_MS, LLM_STREAM_IDLE_TIMEOUT_MS } from '../../../shared/config.js';
import { geminiHeaders } from '../key-check.js';
import { LlmError, errorFromResponse } from '../errors.js';
import { createSseParser } from '../sse.js';

/**
 * @typedef {{ text?: string, image?: { mime: string, base64: string }, youtubeUrl?: string }} Part
 * @typedef {{ role: 'user'|'assistant', parts: Part[] }} Turn
 * @typedef {{ model: string, system: string, turns: Turn[], maxTokens?: number }} GeminiRequest
 * @typedef {{ text: string, model: string, stopReason: string|null }} GeminiResult
 */

/** Finish reasons that mean the answer was withheld by a filter. */
const BLOCKED_FINISH = new Set([
  'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII',
  'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION'
]);
/** Finish reasons that mean the answer stopped early but what we have is usable. */
const TRUNCATED_FINISH = new Set(['MAX_TOKENS', 'CONTINUATION']);

/** @param {Part} part */
function toGeminiPart(part) {
  if (typeof part.text === 'string') return { text: part.text };
  if (part.image) return { inlineData: { mimeType: part.image.mime, data: part.image.base64 } };
  if (part.youtubeUrl) return { fileData: { fileUri: part.youtubeUrl } };
  throw new LlmError('UNSUPPORTED_INPUT');
}

/**
 * Build the generateContent request body (pure).
 * Thinking is left at each model's default (minimal on Flash-Lite, medium on Flash).
 * @param {GeminiRequest} req
 * @param {{ json?: { schema?: object } }} [opts] request JSON output, optionally constrained by a schema
 */
export function buildRequest(req, opts = {}) {
  /** @type {Record<string, any>} */
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: req.turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: t.parts.map(toGeminiPart) }))
  };
  /** @type {Record<string, any>} */
  const config = {};
  if (req.maxTokens) config.maxOutputTokens = req.maxTokens;
  if (opts.json) {
    config.responseMimeType = 'application/json';
    if (opts.json.schema) config.responseSchema = opts.json.schema;
  }
  if (Object.keys(config).length) body.generationConfig = config;
  return body;
}

/**
 * Tracks one streamed response from its SSE chunks (pure). Each chunk is a GenerateContentResponse.
 * @param {string} requestedModel
 */
export function createStreamState(requestedModel) {
  const state = {
    text: '',
    model: requestedModel,
    finishReason: /** @type {string|null} */ (null),
    blockReason: /** @type {string|null} */ (null),
    /** @type {LlmError|null} */
    error: null
  };

  return {
    state,

    /**
     * @param {{ event: string, data: string }} sse
     * @returns {string} text delta to show ('' if none)
     */
    handle(sse) {
      let chunk;
      try {
        chunk = JSON.parse(sse.data);
      } catch {
        return '';
      }
      if (chunk.error) {
        state.error = errorFromResponse(0, chunk);
        return '';
      }
      if (chunk.promptFeedback?.blockReason) state.blockReason = chunk.promptFeedback.blockReason;

      const candidate = chunk.candidates?.[0];
      if (!candidate) return '';
      if (candidate.finishReason) state.finishReason = candidate.finishReason;

      let delta = '';
      for (const part of candidate.content?.parts ?? []) {
        // Thought summaries aren't part of the answer.
        if (part.thought || typeof part.text !== 'string') continue;
        delta += part.text;
      }
      state.text += delta;
      return delta;
    }
  };
}

/**
 * Final checks once the stream ends (pure). Stop reasons are normalised so the UI doesn't need
 * provider details: 'end_turn' for a normal finish, 'max_tokens' when cut short.
 * @param {ReturnType<typeof createStreamState>['state']} state
 * @returns {GeminiResult}
 */
export function finishStream(state) {
  if (state.error) throw state.error;
  if (state.blockReason) throw new LlmError('SAFETY_BLOCKED');
  if (state.finishReason && BLOCKED_FINISH.has(state.finishReason)) throw new LlmError('SAFETY_BLOCKED');
  if (!state.finishReason) throw new LlmError('INTERRUPTED'); // EC-LLM-03: stream ended without a finish
  if (!state.text.trim()) throw new LlmError('EMPTY_RESPONSE'); // EC-LLM-06
  const stopReason = state.finishReason === 'STOP'
    ? 'end_turn'
    : TRUNCATED_FINISH.has(state.finishReason) ? 'max_tokens' : state.finishReason.toLowerCase();
  return { text: state.text, model: state.model, stopReason };
}

// ---- I/O ----

/**
 * One non-streaming request (used for JSON tasks, where partial output is useless).
 * @param {GeminiRequest} req
 * @param {{ apiKey: string, signal?: AbortSignal, json?: { schema?: object }, timeoutMs?: number, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<GeminiResult>}
 */
export async function generateContent(req, { apiKey, signal, json, timeoutMs = LLM_FIRST_BYTE_TIMEOUT_MS, fetchImpl = fetch }) {
  const body = buildRequest(req, { json });
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

  try {
    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(req.model)}:generateContent`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { ...geminiHeaders(apiKey), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    const data = isJson ? await res.json().catch(() => null) : null;
    if (!res.ok) throw errorFromResponse(res.status, data, res.headers);
    if (!data) throw new LlmError('PROVIDER_DOWN', { status: res.status }); // e.g. an HTML proxy page

    // A full response has the same shape as one stream chunk, so the stream checks apply as-is.
    const tracker = createStreamState(req.model);
    tracker.handle({ event: 'message', data: JSON.stringify(data) });
    return finishStream(tracker.state);
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
 * Stream a response, calling onDelta with each piece of answer text.
 * @param {GeminiRequest} req
 * @param {{ apiKey: string, signal?: AbortSignal, onDelta: (text: string) => void, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<GeminiResult>}
 */
export async function streamMessage(req, { apiKey, signal, onDelta, fetchImpl = fetch }) {
  const body = buildRequest(req);
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener('abort', abortFromCaller);
  let timedOut = false;
  let timer = setTimeout(() => { timedOut = true; controller.abort(); }, LLM_FIRST_BYTE_TIMEOUT_MS);
  const resetIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, LLM_STREAM_IDLE_TIMEOUT_MS);
  };

  const tracker = createStreamState(req.model);
  try {
    const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { ...geminiHeaders(apiKey), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
      throw errorFromResponse(res.status, isJson ? await res.json().catch(() => null) : null, res.headers);
    }
    if (!res.body) throw new LlmError('EMPTY_RESPONSE');

    const decoder = new TextDecoder();
    const parser = createSseParser((sse) => {
      const delta = tracker.handle(sse);
      if (delta) onDelta(delta);
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
    return finishStream(tracker.state);
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (signal?.aborted) throw new LlmError('CANCELLED');
    if (timedOut) throw new LlmError(tracker.state.text ? 'INTERRUPTED' : 'TIMEOUT');
    throw new LlmError('NETWORK', { cause: err }); // fetch TypeError: offline, DNS, blocked
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
