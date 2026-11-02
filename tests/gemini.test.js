import { describe, it, expect } from 'vitest';
import { buildRequest, createStreamState, finishStream, generateContent, streamMessage } from '../src/background/llm/providers/gemini.js';
import { LlmError, errorFromResponse } from '../src/background/llm/errors.js';
import { createSseParser } from '../src/background/llm/sse.js';

const KEY = 'AIza' + 'q'.repeat(35); // fake, built at runtime
const MODEL = 'gemini-3.5-flash-lite';

/** Hand-written stream in streamGenerateContent?alt=sse shape: data-only events, finishReason on the last. */
const chunk = (obj) => `data: ${JSON.stringify(obj)}\r\n\r\n`;
const textChunk = (text, extra = {}) => chunk({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0, ...extra }], modelVersion: MODEL });
const SSE_OK =
  chunk({ candidates: [{ content: { role: 'model', parts: [{ text: 'internal reasoning', thought: true }] } }] }) +
  textChunk('Photosynthesis is ') +
  textChunk('how plants make food. 🌱 पौधे', { finishReason: 'STOP' }) +
  chunk({ usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 42 } });
const EXPECTED_TEXT = 'Photosynthesis is how plants make food. 🌱 पौधे';

function runStream(text) {
  const tracker = createStreamState(MODEL);
  const deltas = [];
  const parser = createSseParser((e) => { const d = tracker.handle(e); if (d) deltas.push(d); });
  parser.push(text);
  parser.end();
  return { state: tracker.state, deltas };
}

function codeOf(fn) {
  try { fn(); } catch (err) { return err.code; }
  return null;
}

describe('buildRequest', () => {
  const base = { model: MODEL, system: 'sys', turns: [{ role: 'user', parts: [{ text: 'hi' }] }] };

  it('puts the system prompt in systemInstruction and turns in contents', () => {
    expect(buildRequest(base)).toEqual({
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }]
    });
  });

  it('maps assistant turns to the "model" role', () => {
    const body = buildRequest({ ...base, turns: [...base.turns, { role: 'assistant', parts: [{ text: 'hello' }] }] });
    expect(body.contents[1].role).toBe('model');
  });

  it('maps images to inlineData and YouTube links to fileData', () => {
    const body = buildRequest({ ...base, turns: [{ role: 'user', parts: [
      { image: { mime: 'image/png', base64: 'AAAA' } },
      { youtubeUrl: 'https://www.youtube.com/watch?v=abc' }
    ] }] });
    expect(body.contents[0].parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
      { fileData: { fileUri: 'https://www.youtube.com/watch?v=abc' } }
    ]);
  });

  it('sets maxOutputTokens only when asked', () => {
    expect('generationConfig' in buildRequest(base)).toBe(false);
    expect(buildRequest({ ...base, maxTokens: 500 }).generationConfig).toEqual({ maxOutputTokens: 500 });
  });

  it('requests JSON output, with or without a schema', () => {
    const schema = { type: 'OBJECT', properties: { a: { type: 'STRING' } } };
    expect(buildRequest(base, { json: { schema } }).generationConfig).toEqual({ responseMimeType: 'application/json', responseSchema: schema });
    expect(buildRequest(base, { json: {} }).generationConfig).toEqual({ responseMimeType: 'application/json' });
  });
});

describe('generateContent (non-streaming, for JSON tasks)', () => {
  const req = { model: MODEL, system: 'sys', turns: [{ role: 'user', parts: [{ text: 'Summarise' }] }] };
  const jsonFetch = (status, body, contentType = 'application/json; charset=UTF-8') => {
    const calls = [];
    const impl = async (url, init) => {
      calls.push({ url, init });
      return { ok: status >= 200 && status < 300, status, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) }, json: async () => body };
    };
    impl.calls = calls;
    return impl;
  };

  it('returns the text of a finished response and sends the schema', async () => {
    const fetchImpl = jsonFetch(200, { candidates: [{ content: { parts: [{ text: '{"a":"b"}' }] }, finishReason: 'STOP' }] });
    const r = await generateContent(req, { apiKey: KEY, fetchImpl, json: { schema: { type: 'OBJECT' } } });
    expect(r).toEqual({ text: '{"a":"b"}', model: MODEL, stopReason: 'end_turn' });
    const [{ url, init }] = fetchImpl.calls;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(init.headers['x-goog-api-key']).toBe(KEY);
    expect(JSON.parse(init.body).generationConfig).toEqual({ responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' } });
  });

  it('maps HTTP errors and blocked answers like the streaming path', async () => {
    let caught;
    try {
      await generateContent(req, { apiKey: KEY, fetchImpl: jsonFetch(404, { error: { code: 404, status: 'NOT_FOUND', message: 'not found' } }) });
    } catch (err) { caught = err; }
    expect(caught.code).toBe('MODEL_UNAVAILABLE');

    caught = undefined;
    try {
      await generateContent(req, { apiKey: KEY, fetchImpl: jsonFetch(200, { promptFeedback: { blockReason: 'SAFETY' } }) });
    } catch (err) { caught = err; }
    expect(caught.code).toBe('SAFETY_BLOCKED');
  });

  it('an HTML page instead of JSON → PROVIDER_DOWN', async () => {
    let caught;
    try {
      await generateContent(req, { apiKey: KEY, fetchImpl: jsonFetch(200, null, 'text/html') });
    } catch (err) { caught = err; }
    expect(caught.code).toBe('PROVIDER_DOWN');
  });
});

describe('stream state', () => {
  it('collects answer text, skipping thought parts and usage-only chunks', () => {
    const { state, deltas } = runStream(SSE_OK);
    expect(deltas.join('')).toBe(EXPECTED_TEXT);
    expect(finishStream(state)).toEqual({ text: EXPECTED_TEXT, model: MODEL, stopReason: 'end_turn' });
  });

  it('prompt blocked → SAFETY_BLOCKED', () => {
    const { state } = runStream(chunk({ promptFeedback: { blockReason: 'SAFETY' } }));
    expect(codeOf(() => finishStream(state))).toBe('SAFETY_BLOCKED');
  });

  it('answer stopped by a filter → SAFETY_BLOCKED, even with partial text', () => {
    for (const reason of ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII']) {
      const { state } = runStream(textChunk('Sure, here') + textChunk('', { finishReason: reason }));
      expect(codeOf(() => finishStream(state))).toBe('SAFETY_BLOCKED');
    }
  });

  it('MAX_TOKENS and CONTINUATION are returned as max_tokens, not errors (EC-LLM-04)', () => {
    for (const reason of ['MAX_TOKENS', 'CONTINUATION']) {
      const { state } = runStream(textChunk('Long…', { finishReason: reason }));
      expect(finishStream(state).stopReason).toBe('max_tokens');
    }
  });

  it('stream ends without a finishReason → INTERRUPTED (EC-LLM-03)', () => {
    const { state } = runStream(textChunk('Half an ans'));
    expect(codeOf(() => finishStream(state))).toBe('INTERRUPTED');
  });

  it('no text → EMPTY_RESPONSE (EC-LLM-06)', () => {
    const { state } = runStream(textChunk('', { finishReason: 'STOP' }));
    expect(codeOf(() => finishStream(state))).toBe('EMPTY_RESPONSE');
  });

  it('an error object mid-stream → its typed error', () => {
    const { state } = runStream(textChunk('partial') + chunk({ error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } }));
    expect(codeOf(() => finishStream(state))).toBe('OVERLOADED');
  });
});

describe('errorFromResponse', () => {
  const err = (code, status, message = '', details = []) => ({ error: { code, status, message, details } });
  const cases = [
    [400, err(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [{ reason: 'API_KEY_INVALID' }]), 'AUTH_FAILED'],
    [400, err(400, 'FAILED_PRECONDITION', 'User location is not supported for the API use.'), 'REGION_UNSUPPORTED'],
    [400, err(400, 'INVALID_ARGUMENT', 'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).'), 'CONTEXT_TOO_LARGE'],
    [400, err(400, 'INVALID_ARGUMENT', 'Invalid JSON payload received.'), 'BAD_REQUEST'],
    [403, err(403, 'PERMISSION_DENIED', 'Method doesn\'t allow unregistered callers.'), 'AUTH_FAILED'],
    [404, err(404, 'NOT_FOUND', 'models/gemini-x is not found for API version v1beta'), 'MODEL_UNAVAILABLE'],
    [500, err(500, 'INTERNAL'), 'PROVIDER_DOWN'],
    [503, err(503, 'UNAVAILABLE', 'The model is overloaded.'), 'OVERLOADED'],
    [502, null, 'PROVIDER_DOWN']
  ];
  for (const [status, body, code] of cases) {
    it(`${status} ${body?.error?.status ?? '(no body)'} → ${code}`, () => expect(errorFromResponse(status, body).code).toBe(code));
  }

  it('429 reads RetryInfo.retryDelay', () => {
    const e = errorFromResponse(429, err(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded', [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '31s' }]));
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.retryAfterMs).toBe(31000);
    expect(e.retryable).toBe(true);
  });

  it('429 falls back to the Retry-After header', () => {
    const e = errorFromResponse(429, err(429, 'RESOURCE_EXHAUSTED', 'Too many requests'), { get: (h) => (h === 'retry-after' ? '4' : null) });
    expect(e.retryAfterMs).toBe(4000);
  });

  it('quota wording wins over a 5xx status (EC-RTL-14)', () => {
    expect(errorFromResponse(500, err(500, 'INTERNAL', 'Quota exceeded for this model.')).code).toBe('RATE_LIMITED');
  });

  it('a per-day quota 429 → QUOTA_EXHAUSTED', () => {
    const e = errorFromResponse(429, err(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded', [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }
    ]));
    expect(e.code).toBe('QUOTA_EXHAUSTED');
    expect(e.retryable).toBe(false);
  });

  it('user-facing messages never contain provider error text', () => {
    const e = errorFromResponse(400, err(400, 'INVALID_ARGUMENT', `API key not valid: ${KEY}`, [{ reason: 'API_KEY_INVALID' }]));
    expect(JSON.stringify(e.toPayload()).includes(KEY)).toBe(false);
  });
});

/** Fake streaming fetch: splits the body into byte chunks of the given size. */
function streamingFetch(text, { chunkSize = 17 } = {}) {
  const calls = [];
  const bytes = new TextEncoder().encode(text);
  const impl = async (url, init) => {
    calls.push({ url, init });
    let offset = 0;
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/event-stream' : null) },
      body: {
        getReader: () => ({
          read: async () => {
            if (offset >= bytes.length) return { done: true, value: undefined };
            const value = bytes.slice(offset, offset + chunkSize);
            offset += chunkSize;
            return { done: false, value };
          }
        })
      }
    };
  };
  impl.calls = calls;
  return impl;
}

describe('streamMessage', () => {
  const req = { model: MODEL, system: 'sys', turns: [{ role: 'user', parts: [{ text: 'Explain' }] }] };

  it('streams deltas, decoding multi-byte characters split across chunks (EC-LLM-02)', async () => {
    for (const chunkSize of [1, 3, 17, 4096]) {
      const deltas = [];
      const result = await streamMessage(req, { apiKey: KEY, fetchImpl: streamingFetch(SSE_OK, { chunkSize }), onDelta: (d) => deltas.push(d) });
      expect(result.text).toBe(EXPECTED_TEXT);
      expect(deltas.join('')).toBe(EXPECTED_TEXT);
    }
  });

  it('calls streamGenerateContent with the key only in the header', async () => {
    const fetchImpl = streamingFetch(SSE_OK);
    await streamMessage(req, { apiKey: KEY, fetchImpl, onDelta: () => {} });
    const [{ url, init }] = fetchImpl.calls;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse');
    expect(init.method).toBe('POST');
    expect(init.headers['x-goog-api-key']).toBe(KEY);
    expect(url.includes(KEY) || init.body.includes(KEY)).toBe(false);
  });

  it('turns an HTTP 429 into RATE_LIMITED with the retry delay', async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 429,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'application/json; charset=UTF-8' : null) },
      json: async () => ({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12s' }] } })
    });
    let caught;
    try { await streamMessage(req, { apiKey: KEY, fetchImpl, onDelta: () => {} }); } catch (err) { caught = err; }
    expect(caught instanceof LlmError).toBe(true);
    expect(caught.code).toBe('RATE_LIMITED');
    expect(caught.retryAfterMs).toBe(12000);
  });

  it('offline → NETWORK', async () => {
    const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    let caught;
    try { await streamMessage(req, { apiKey: KEY, fetchImpl, onDelta: () => {} }); } catch (err) { caught = err; }
    expect(caught.code).toBe('NETWORK');
  });

  it('caller abort → CANCELLED (EC-LLM-08)', async () => {
    const controller = new AbortController();
    const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const pending = streamMessage(req, { apiKey: KEY, fetchImpl, signal: controller.signal, onDelta: () => {} });
    controller.abort();
    let caught;
    try { await pending; } catch (err) { caught = err; }
    expect(caught.code).toBe('CANCELLED');
  });
});
