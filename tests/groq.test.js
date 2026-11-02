import { describe, it, expect } from 'vitest';
import {
  buildGroqRequest, checkGroqKey, errorFromGroqResponse, finishGroq, generateGroq, groqHeaders, streamGroq
} from '../src/background/llm/providers/groq.js';

const KEY = 'gsk_' + 'g'.repeat(40); // fake, built at runtime
const req = {
  model: 'llama',
  system: 'Be brief.',
  turns: [
    { role: 'user', parts: [{ text: 'Page' }, { text: 'Question?' }] },
    { role: 'assistant', parts: [{ text: 'Earlier answer' }] },
    { role: 'user', parts: [{ text: 'Follow-up' }] }
  ]
};
const headers = (map) => ({ get: (h) => map[h.toLowerCase()] ?? null });

describe('buildGroqRequest', () => {
  it('maps the system prompt and turns to chat messages', () => {
    expect(buildGroqRequest({ ...req, maxTokens: 300 })).toEqual({
      model: 'llama',
      max_tokens: 300,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Page\n\nQuestion?' },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'Follow-up' }
      ]
    });
  });

  it('asks for a JSON object, or a stream', () => {
    expect(buildGroqRequest(req, { json: true }).response_format).toEqual({ type: 'json_object' });
    expect(buildGroqRequest(req, { stream: true }).stream).toBe(true);
  });

  it('refuses images and YouTube links with UNSUPPORTED_INPUT', () => {
    for (const part of [{ image: { mime: 'image/png', base64: 'AA==' } }, { youtubeUrl: 'https://www.youtube.com/watch?v=x' }]) {
      let caught;
      try { buildGroqRequest({ ...req, turns: [{ role: 'user', parts: [part] }] }); } catch (err) { caught = err; }
      expect(caught.code).toBe('UNSUPPORTED_INPUT');
    }
  });
});

describe('errorFromGroqResponse', () => {
  const body = (message, code) => ({ error: { message, code } });
  it.each([
    [401, body('Invalid API Key', 'invalid_api_key'), 'AUTH_FAILED'],
    [404, body('The model does not exist', 'model_not_found'), 'MODEL_UNAVAILABLE'],
    [400, body('The model has been decommissioned', 'model_decommissioned'), 'MODEL_UNAVAILABLE'],
    [413, body('Request too large'), 'CONTEXT_TOO_LARGE'],
    [400, body('Please reduce the length of the messages', 'context_length_exceeded'), 'CONTEXT_TOO_LARGE'],
    [503, null, 'OVERLOADED'],
    [500, null, 'PROVIDER_DOWN'],
    [400, body('bad'), 'BAD_REQUEST']
  ])('%s → %s', (status, b, code) => {
    expect(errorFromGroqResponse(status, b).code).toBe(code);
  });

  it('429 reads Retry-After; a per-day limit is QUOTA_EXHAUSTED', () => {
    const e = errorFromGroqResponse(429, body('Rate limit reached for requests per minute (RPM)'), headers({ 'retry-after': '7' }));
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.retryAfterMs).toBe(7000);
    expect(errorFromGroqResponse(429, body('Rate limit reached on tokens per day (TPD): Limit 100000')).code).toBe('QUOTA_EXHAUSTED');
  });
});

describe('finishGroq', () => {
  it('normalises stop reasons and catches bad endings', () => {
    expect(finishGroq({ text: 'Hi', finishReason: 'stop', model: 'm' })).toEqual({ text: 'Hi', model: 'm', stopReason: 'end_turn' });
    expect(finishGroq({ text: 'Hi', finishReason: 'length', model: 'm' }).stopReason).toBe('max_tokens');
    const code = (state) => { try { finishGroq(state); } catch (err) { return err.code; } };
    expect(code({ text: 'x', finishReason: 'content_filter', model: 'm' })).toBe('SAFETY_BLOCKED');
    expect(code({ text: 'x', finishReason: null, model: 'm' })).toBe('INTERRUPTED');
    expect(code({ text: ' ', finishReason: 'stop', model: 'm' })).toBe('EMPTY_RESPONSE');
  });
});

/** Fake fetch returning one JSON response. */
function jsonFetch(status, payload) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status, headers: headers({ 'content-type': 'application/json' }), json: async () => payload };
  };
  impl.calls = calls;
  return impl;
}

describe('generateGroq', () => {
  it('sends the key only as a Bearer token to Groq, and returns the answer', async () => {
    const fetchImpl = jsonFetch(200, { model: 'llama', choices: [{ message: { content: '{"n":5}' }, finish_reason: 'stop' }] });
    const result = await generateGroq(req, { apiKey: KEY, json: {}, fetchImpl });
    expect(result).toEqual({ text: '{"n":5}', model: 'llama', stopReason: 'end_turn' });
    const [{ url, init }] = fetchImpl.calls;
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init.headers).toEqual(groqHeaders(KEY));
    expect(url.includes(KEY) || init.body.includes(KEY)).toBe(false);
    expect(JSON.parse(init.body).response_format).toEqual({ type: 'json_object' });
  });

  it('maps HTTP errors', async () => {
    let caught;
    try { await generateGroq(req, { apiKey: KEY, fetchImpl: jsonFetch(401, { error: { message: 'Invalid API Key' } }) }); } catch (err) { caught = err; }
    expect(caught.code).toBe('AUTH_FAILED');
  });
});

describe('streamGroq', () => {
  it('streams deltas until [DONE]', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"choices":[{"delta":{"content":"Nam"}}]}',
      'data: {"choices":[{"delta":{"content":"aste 🙏"}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
      ''
    ].join('\n\n');
    const bytes = new TextEncoder().encode(sse);
    let offset = 0;
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      headers: headers({ 'content-type': 'text/event-stream' }),
      body: { getReader: () => ({ read: async () => (offset >= bytes.length ? { done: true } : { done: false, value: bytes.slice(offset, (offset += 5)) }) }) }
    });
    const deltas = [];
    const result = await streamGroq(req, { apiKey: KEY, fetchImpl, onDelta: (d) => deltas.push(d) });
    expect(result).toEqual({ text: 'Namaste 🙏', model: 'llama', stopReason: 'end_turn' });
    expect(deltas.join('')).toBe('Namaste 🙏');
  });
});

describe('checkGroqKey', () => {
  it('ok, with a warning when the configured model is gone (EC-RTL-08)', async () => {
    expect(await checkGroqKey(KEY, { model: 'llama', fetchImpl: jsonFetch(200, { data: [{ id: 'llama' }] }) })).toEqual({ ok: true, message: '✓ Key works.' });
    const r = await checkGroqKey(KEY, { model: 'llama', fetchImpl: jsonFetch(200, { data: [{ id: 'other' }] }) });
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/no longer offers llama/);
  });

  it('a rejected key → AUTH_FAILED', async () => {
    expect((await checkGroqKey(KEY, { model: 'llama', fetchImpl: jsonFetch(401, { error: {} }) })).code).toBe('AUTH_FAILED');
  });
});
