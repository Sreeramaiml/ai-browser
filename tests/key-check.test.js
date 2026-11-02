import { describe, it, expect } from 'vitest';
import { checkGeminiKey, geminiHeaders, interpretModelsResponse } from '../src/background/llm/key-check.js';

const KEY = 'AIza' + 'k'.repeat(35); // fake, built at runtime so no key-shaped literal exists
const REQUIRED = ['gemini-3.5-flash-lite', 'gemini-3.8-flash'];

const modelsBody = (...ids) => ({ models: ids.map((id) => ({ name: `models/${id}` })) });
const googleError = (code, status, reason, message = 'error') => ({
  error: { code, status, message, details: reason ? [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] : [] }
});

/** Fake fetch that records calls and returns a JSON (or HTML) response. */
function fakeFetch(status, body, { contentType = 'application/json' } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      status,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) },
      json: async () => body
    };
  };
  impl.calls = calls;
  return impl;
}

describe('geminiHeaders', () => {
  it('sends the key in x-goog-api-key', () => {
    expect(geminiHeaders(KEY)).toEqual({ 'x-goog-api-key': KEY });
  });
});

describe('interpretModelsResponse', () => {
  it('ok when all configured models are available', () => {
    expect(interpretModelsResponse(200, modelsBody(...REQUIRED, 'other'), REQUIRED)).toEqual({ ok: true, message: '✓ Key works.' });
  });

  it('ok with a clear warning when a configured model is missing (EC-SET-05)', () => {
    const r = interpretModelsResponse(200, modelsBody('gemini-3.8-flash', 'gemini-2.5-flash'), REQUIRED);
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/gemini-3\.5-flash-lite isn't available/);
    expect(r.warning).toMatch(/answers will fail/);
  });

  it('invalid key → AUTH_FAILED', () => {
    const r = interpretModelsResponse(400, googleError(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID', 'API key not valid.'), REQUIRED);
    expect(r).toEqual({ ok: false, code: 'AUTH_FAILED', message: 'Google rejected this key. Check that you copied the whole key.' });
  });

  it('an "AQ." key refused with ACCESS_TOKEN_TYPE_UNSUPPORTED gets a specific explanation', () => {
    const r = interpretModelsResponse(401, googleError(401, 'UNAUTHENTICATED', 'ACCESS_TOKEN_TYPE_UNSUPPORTED', 'Request had invalid authentication credentials.'), REQUIRED);
    expect(r.code).toBe('AUTH_FAILED');
    expect(r.message).toMatch(/AQ\./);
    expect(r.message).toMatch(/Google Cloud project/);
  });

  it('API disabled or key restricted → AUTH_FAILED with a hint (EC-SET-04)', () => {
    const r = interpretModelsResponse(403, googleError(403, 'PERMISSION_DENIED', 'SERVICE_DISABLED'), REQUIRED);
    expect(r.code).toBe('AUTH_FAILED');
    expect(r.message).toMatch(/AI Studio/);
  });

  it('unsupported location → REGION_UNSUPPORTED', () => {
    const r = interpretModelsResponse(400, googleError(400, 'FAILED_PRECONDITION', null, 'User location is not supported for the API use.'), REQUIRED);
    expect(r.code).toBe('REGION_UNSUPPORTED');
  });

  it('429 → RATE_LIMITED', () => {
    expect(interpretModelsResponse(429, googleError(429, 'RESOURCE_EXHAUSTED'), REQUIRED).code).toBe('RATE_LIMITED');
  });

  it('5xx or a non-JSON body → PROVIDER_DOWN', () => {
    expect(interpretModelsResponse(503, googleError(503, 'UNAVAILABLE'), REQUIRED).code).toBe('PROVIDER_DOWN');
    expect(interpretModelsResponse(200, null, REQUIRED).code).toBe('PROVIDER_DOWN');
  });
});

describe('checkGeminiKey', () => {
  it('sends the key only in the x-goog-api-key header, never in the URL', async () => {
    const fetchImpl = fakeFetch(200, modelsBody(...REQUIRED));
    const r = await checkGeminiKey(KEY, { requiredModels: REQUIRED, fetchImpl });
    expect(r.ok).toBe(true);
    const [{ url, init }] = fetchImpl.calls;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
    expect(url.includes(KEY)).toBe(false);
    expect(init.headers['x-goog-api-key']).toBe(KEY);
  });

  it('treats an HTML error page as PROVIDER_DOWN (EC-LLM-12)', async () => {
    const fetchImpl = fakeFetch(200, null, { contentType: 'text/html' });
    expect((await checkGeminiKey(KEY, { requiredModels: REQUIRED, fetchImpl })).code).toBe('PROVIDER_DOWN');
  });

  it('offline → NETWORK, not "invalid key" (EC-SET-03)', async () => {
    const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    expect((await checkGeminiKey(KEY, { requiredModels: REQUIRED, fetchImpl })).code).toBe('NETWORK');
  });

  it('times out → TIMEOUT', async () => {
    const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    expect((await checkGeminiKey(KEY, { requiredModels: REQUIRED, fetchImpl, timeoutMs: 5 })).code).toBe('TIMEOUT');
  });

  it('no key → NO_API_KEY without a network call', async () => {
    const fetchImpl = fakeFetch(200, modelsBody());
    expect((await checkGeminiKey('', { requiredModels: REQUIRED, fetchImpl })).code).toBe('NO_API_KEY');
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('never echoes the key in any result (EC-SET-13)', async () => {
    const responses = [
      fakeFetch(200, modelsBody()),
      fakeFetch(400, googleError(400, 'INVALID_ARGUMENT', 'API_KEY_INVALID', `API key not valid: ${KEY}`)),
      fakeFetch(403, googleError(403, 'PERMISSION_DENIED', null, KEY)),
      fakeFetch(500, { error: { message: KEY } })
    ];
    for (const fetchImpl of responses) {
      const r = await checkGeminiKey(KEY, { requiredModels: REQUIRED, fetchImpl });
      expect(JSON.stringify(r).includes(KEY)).toBe(false);
    }
  });
});
