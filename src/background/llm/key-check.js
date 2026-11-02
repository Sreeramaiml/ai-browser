// @ts-check
// "Test key" for Gemini: one free GET /models call. It proves the key works and that Sahayak's
// configured models are available to it. Results carry user-facing copy and never the key.

import { GEMINI_API_BASE, KEY_TEST_TIMEOUT_MS } from '../../shared/config.js';

/**
 * @typedef {{ ok: true, message: string, warning?: string }
 *   | { ok: false, code: 'NO_API_KEY'|'AUTH_FAILED'|'RATE_LIMITED'|'REGION_UNSUPPORTED'|'NETWORK'|'TIMEOUT'|'PROVIDER_DOWN', message: string }} KeyCheckResult
 */

/**
 * Headers for every call to the Gemini API. The key goes in a header, never the URL, so it can't
 * leak into logs (architecture §8.3).
 * @param {string} key
 */
export function geminiHeaders(key) {
  return { 'x-goog-api-key': key };
}

/**
 * Turn the /models response into a result (pure, for tests).
 * @param {number} status
 * @param {any} body parsed JSON, or null if the body wasn't JSON
 * @param {string[]} requiredModels model IDs Sahayak is configured to use
 * @returns {KeyCheckResult}
 */
export function interpretModelsResponse(status, body, requiredModels) {
  if (status === 200 && body && Array.isArray(body.models)) {
    const available = new Set(body.models.map((m) => String(m?.name ?? '').replace(/^models\//, '')));
    const missing = requiredModels.filter((id) => !available.has(id));
    return missing.length
      ? {
          ok: true,
          message: '✓ Key works.',
          warning: `But ${missing.join(' and ')} ${missing.length > 1 ? "aren't" : "isn't"} available to this key, so answers will fail. Sahayak's model settings need updating.`
        }
      : { ok: true, message: '✓ Key works.' };
  }

  const err = body?.error ?? {};
  const reason = Array.isArray(err.details) ? err.details.map((d) => d?.reason).find(Boolean) : undefined;
  const text = String(err.message ?? '');

  if (reason === 'ACCESS_TOKEN_TYPE_UNSUPPORTED' || /ACCESS_TOKEN_TYPE_UNSUPPORTED/.test(text)) {
    // Some accounts' new "AQ." keys are refused by the Gemini endpoint (a Google-side issue).
    return {
      ok: false,
      code: 'AUTH_FAILED',
      message: 'Google refused this key type for the Gemini API, which happens with some new "AQ." keys. ' +
        'Try creating another key in Google AI Studio, choosing a Google Cloud project for it.'
    };
  }
  if (reason === 'API_KEY_INVALID' || (status === 400 && /api key/i.test(text))) {
    return { ok: false, code: 'AUTH_FAILED', message: 'Google rejected this key. Check that you copied the whole key.' };
  }
  if (err.status === 'FAILED_PRECONDITION' && /location|region|country/i.test(text)) {
    return { ok: false, code: 'REGION_UNSUPPORTED', message: "Google's Gemini API isn't available in your region." };
  }
  if (status === 401 || status === 403) {
    // EC-SET-04: key exists but the API is disabled or the key is restricted.
    return {
      ok: false,
      code: 'AUTH_FAILED',
      message: "This key isn't allowed to use the Gemini API. Create a new key in Google AI Studio and try again."
    };
  }
  if (status === 429) {
    return { ok: false, code: 'RATE_LIMITED', message: 'This key is being rate-limited right now. Wait a minute and test again.' };
  }
  if (status >= 500 || body === null) {
    // body === null covers HTML error pages from proxies or captive portals (EC-LLM-12).
    return { ok: false, code: 'PROVIDER_DOWN', message: "Google's AI service isn't responding properly right now. Try again shortly." };
  }
  return { ok: false, code: 'AUTH_FAILED', message: `Google couldn't verify this key (error ${status}).` };
}

/**
 * @param {string} key already validated with validateKeyInput
 * @param {{ requiredModels: string[], fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Promise<KeyCheckResult>}
 */
export async function checkGeminiKey(key, { requiredModels, fetchImpl = fetch, timeoutMs = KEY_TEST_TIMEOUT_MS }) {
  if (!key) return { ok: false, code: 'NO_API_KEY', message: 'Enter a key first.' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${GEMINI_API_BASE}/models?pageSize=1000`, {
      method: 'GET',
      headers: geminiHeaders(key),
      signal: controller.signal
    });
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
    const body = isJson ? await res.json().catch(() => null) : null;
    return interpretModelsResponse(res.status, body, requiredModels);
  } catch {
    if (controller.signal.aborted) {
      return { ok: false, code: 'TIMEOUT', message: 'Google took too long to respond. Try again.' };
    }
    // fetch() rejects with TypeError when offline or blocked (EC-SET-03) — not an invalid key.
    return { ok: false, code: 'NETWORK', message: "Couldn't reach Google. Check your internet connection." };
  } finally {
    clearTimeout(timer);
  }
}
