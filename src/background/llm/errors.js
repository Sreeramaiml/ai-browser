// @ts-check
// Typed LLM errors with user-facing copy (architecture §16.1). The message is always ours —
// provider error text is never shown, because it could echo request details.

/**
 * @typedef {'NO_API_KEY'|'AUTH_FAILED'|'RATE_LIMITED'|'QUOTA_EXHAUSTED'|'REGION_UNSUPPORTED'|'PROVIDER_DOWN'
 *   |'OVERLOADED'|'TIMEOUT'|'NETWORK'|'CONTEXT_TOO_LARGE'|'SAFETY_BLOCKED'|'MODEL_UNAVAILABLE'|'BAD_REQUEST'
 *   |'EMPTY_RESPONSE'|'INTERRUPTED'|'INVALID_OUTPUT'|'UNSUPPORTED_INPUT'|'YOUTUBE_UNSUPPORTED'|'CANCELLED'} LlmErrorCode
 */

/**
 * User-facing copy (architecture §16.1). Provider-neutral where the request may have been answered
 * by any link in the chain. RATE_LIMITED and QUOTA_EXHAUSTED carry `retryAt`, which the panel turns
 * into a countdown or a local reset time.
 * @type {Record<LlmErrorCode, { message: string, retryable: boolean }>}
 */
export const LLM_ERRORS = {
  NO_API_KEY: { message: 'Add your free Gemini API key in Settings to get started.', retryable: false },
  AUTH_FAILED: { message: 'Your Gemini API key was rejected. Please check it in Settings.', retryable: false },
  RATE_LIMITED: { message: 'The free AI limit is busy right now.', retryable: true },
  QUOTA_EXHAUSTED: { message: "Today's free AI quota is used up.", retryable: false },
  REGION_UNSUPPORTED: { message: "Google's Gemini API isn't available in your region.", retryable: false },
  PROVIDER_DOWN: { message: "The AI service isn't responding. Please try again shortly.", retryable: true },
  OVERLOADED: { message: 'The AI service is very busy right now. Please try again in a moment.', retryable: true },
  TIMEOUT: { message: 'That took too long. Try a shorter page or try again.', retryable: true },
  NETWORK: {
    message: "Couldn't reach the AI service. Check your internet connection. On a work or school network, it may be blocked.", // EC-LLM-13
    retryable: true
  },
  CONTEXT_TOO_LARGE: { message: 'That text is too long for one request. Try selecting less.', retryable: false },
  SAFETY_BLOCKED: { message: 'The AI declined to answer this content.', retryable: false },
  MODEL_UNAVAILABLE: { message: "Sahayak's AI model isn't available to your key. Check the model setting.", retryable: false },
  BAD_REQUEST: { message: 'Sahayak sent a request the AI service couldn’t accept. Please try again.', retryable: false },
  EMPTY_RESPONSE: { message: 'The AI returned an empty answer. Please try again.', retryable: true },
  INTERRUPTED: { message: 'The answer was cut off. Please try again.', retryable: true },
  INVALID_OUTPUT: { message: "The AI's answer wasn't in the expected format. Please try again.", retryable: true },
  UNSUPPORTED_INPUT: { message: "This model can't handle that kind of input.", retryable: false },
  YOUTUBE_UNSUPPORTED: {
    message: "This video can't be summarised. It may be private, age-restricted, a live stream, or too long for the free tier.",
    retryable: false
  },
  CANCELLED: { message: 'Stopped.', retryable: false }
};

export class LlmError extends Error {
  /**
   * @param {LlmErrorCode} code
   * @param {{ status?: number, retryAfterMs?: number, retryAt?: number, hint?: 'add-groq', cause?: unknown }} [details]
   *   retryAfterMs: the provider's own hint; retryAt: when the user can try again (epoch ms);
   *   hint 'add-groq': a Groq key would keep text features working
   */
  constructor(code, details = {}) {
    super(LLM_ERRORS[code]?.message ?? 'Something went wrong.');
    this.name = 'LlmError';
    this.code = code;
    this.retryable = LLM_ERRORS[code]?.retryable ?? false;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.retryAt = details.retryAt;
    this.hint = details.hint;
  }

  /** Shape sent to the panel in an ERROR message. */
  toPayload() {
    /** @type {{ code: string, message: string, retryable: boolean, retryAfterMs?: number, retryAt?: number, hint?: string }} */
    const payload = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.retryAfterMs !== undefined) payload.retryAfterMs = this.retryAfterMs;
    if (this.retryAt !== undefined) payload.retryAt = this.retryAt;
    if (this.hint !== undefined) payload.hint = this.hint;
    return payload;
  }
}

/**
 * A Retry-After header: delay in seconds, or an HTTP date (pure).
 * @param {string|null|undefined} value
 * @param {number} [now]
 * @returns {number|undefined} milliseconds to wait
 */
export function parseRetryAfter(value, now = Date.now()) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Message text that means "rate or quota limit", whatever the status code says (EC-RTL-14). */
const QUOTA_TEXT_RE = /quota|rate[ _-]?limit|resource[ _]exhausted|too many requests/i;

/** Parse Google's "30s" / "1.5s" duration strings. */
function durationMs(value) {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(value ?? ''));
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

/**
 * Map a Gemini API error to an LlmError (pure, for tests).
 * Gemini errors look like { error: { code, message, status, details: [{ '@type', reason, retryDelay, ... }] } }.
 * @param {number} status HTTP status (0 when the error arrived inside a stream)
 * @param {any} body parsed JSON or null
 * @param {{ get: (name: string) => string|null }} [headers] for Retry-After
 */
export function errorFromResponse(status, body, headers) {
  const err = body?.error ?? {};
  const code = status || Number(err.code) || 0;
  const grpc = String(err.status ?? '');
  const text = String(err.message ?? '');
  const details = Array.isArray(err.details) ? err.details : [];
  const reason = details.map((d) => d?.reason).find(Boolean);

  if (code === 429 || grpc === 'RESOURCE_EXHAUSTED' || QUOTA_TEXT_RE.test(text)) {
    const retryAfterMs = durationMs(details.find((d) => String(d?.['@type']).endsWith('RetryInfo'))?.retryDelay) ??
      parseRetryAfter(headers?.get?.('retry-after'));
    const daily = /per[ _-]?day|daily/i.test(text) ||
      details.some((d) => (d?.violations ?? []).some((v) => /PerDay/i.test(String(v?.quotaId ?? ''))));
    return new LlmError(daily ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED', { status: code, retryAfterMs });
  }
  if (reason === 'API_KEY_INVALID' || (code === 400 && /api key/i.test(text))) return new LlmError('AUTH_FAILED', { status: code });
  if (grpc === 'FAILED_PRECONDITION' && /location|region|country/i.test(text)) return new LlmError('REGION_UNSUPPORTED', { status: code });
  if (code === 401 || code === 403 || grpc === 'PERMISSION_DENIED' || grpc === 'UNAUTHENTICATED') return new LlmError('AUTH_FAILED', { status: code });
  if (code === 404 || grpc === 'NOT_FOUND') return new LlmError('MODEL_UNAVAILABLE', { status: code });
  if (code === 413 || /token count|exceeds the maximum|too long|context window/i.test(text)) return new LlmError('CONTEXT_TOO_LARGE', { status: code });
  if (code === 503 || grpc === 'UNAVAILABLE') return new LlmError('OVERLOADED', { status: code });
  if (code >= 500 || grpc === 'INTERNAL') return new LlmError('PROVIDER_DOWN', { status: code });
  return new LlmError('BAD_REQUEST', { status: code });
}
