// @ts-check
// Central configuration (architecture §3). Provider model IDs change often — verify them at
// https://ai.google.dev/gemini-api/docs/models and in the Groq console, and keep them only here.

export const MODELS = Object.freeze({
  lite: 'gemini-3.5-flash-lite', // default for everything
  flash: 'gemini-3.8-flash',     // vision-heavy / reasoning escalation
  groq: 'llama-3.3-70b-versatile' // text-only fallback
});

/** Model keys served by Gemini (checked by "Test key"). */
export const GEMINI_MODEL_KEYS = /** @type {const} */ (['lite', 'flash']);

/** Friendly names for the "via …" chip under answers. Unknown IDs are shown as-is. */
export const MODEL_LABELS = Object.freeze({
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'llama-3.3-70b-versatile': 'Llama 3.3 70B'
});

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_KEY_URL = 'https://aistudio.google.com/apikey';
export const GROQ_API_BASE = 'https://api.groq.com/openai/v1';
export const GROQ_KEY_URL = 'https://console.groq.com/keys';

/** No first byte within this time → TIMEOUT. */
export const LLM_FIRST_BYTE_TIMEOUT_MS = 60_000;
/** Silence between stream chunks longer than this → INTERRUPTED. */
export const LLM_STREAM_IDLE_TIMEOUT_MS = 60_000;
/** Gemini has to watch the video first, so video summaries get longer. */
export const YOUTUBE_TIMEOUT_MS = 90_000;
/** Minimum gap between two calls to the same model, so bursts don't trip per-minute limits (§8.4). */
export const LLM_MIN_GAP_MS = Object.freeze({ lite: 1_500, flash: 1_500, groq: 0 });
/** storage.session key for the dev-only fault switch (Settings → Advanced, options page with ?dev=1). */
export const DEV_FAULT_KEY = 'devFault';

export const AGENT_DEFAULT_MAX_STEPS = 15;
/**
 * The published practice site the agent may always run on, besides localhost (architecture §14.3).
 * Empty until it's on GitHub Pages; forks set their own (EC-PRC-03). Must end with '/'.
 * Example: 'https://<user>.github.io/pagewise/practice/'
 */
export const PRACTICE_SITE_URL = '';
export const AGENT_HARD_MAX_STEPS = 30;
/** Longest agent goal accepted (P3.5). */
export const AGENT_GOAL_MAX_CHARS = 1_000;
/** Longest hint the user can give a stuck agent (P3.6). */
export const AGENT_HINT_MAX_CHARS = 300;
export const PAGE_TEXT_CHAR_BUDGET = 60_000; // ≈15k tokens
/** Long pages are split into chunks of about this size and the most relevant ones sent (P2.1). */
export const CHAT_CHUNK_CHARS = 2_000;
/** Earlier question/answer pairs sent with each chat question (EC-CHT-07). */
export const CHAT_HISTORY_PAIRS = 10;
/** Longest chat question accepted (EC-CHT-12). */
export const CHAT_MAX_QUESTION_CHARS = 4_000;

/** Screenshots are cropped, then downscaled to this long edge and sent as JPEG (P2.3). */
export const SCREENSHOT = Object.freeze({
  maxEdge: 1600,
  quality: 0.85,
  // Second try when the first encoding is still too big (EC-SCR-11).
  fallbackMaxEdge: 1280,
  fallbackQuality: 0.7,
  /** Largest image (decoded bytes) sent to the model. Far below Gemini's inline request limit. */
  maxBytes: 4_000_000,
  /** A crop smaller than this (in image pixels) on either side counts as no crop (EC-SCR-05). */
  minCropPx: 16
});
/** Longest screenshot question accepted. */
export const SCREENSHOT_MAX_QUESTION_CHARS = 2_000;
export const ACTION_MAP_MAX_ELEMENTS = 150;
/** Longest "Find it for me" question accepted (P3.4). */
export const FIND_MAX_QUERY_CHARS = 300;
export const KEY_TEST_TIMEOUT_MS = 10_000;

/** Output languages for the EN | Hinglish toggle. */
export const LANGUAGES = Object.freeze({ en: 'English', hinglish: 'Hinglish' });

/** Tested translation targets (edge case EC-CTX-11). */
export const TRANSLATE_TARGETS = Object.freeze({
  hi: 'Hindi',
  en: 'English',
  bn: 'Bengali',
  ta: 'Tamil',
  te: 'Telugu',
  mr: 'Marathi',
  gu: 'Gujarati',
  kn: 'Kannada',
  ml: 'Malayalam',
  pa: 'Punjabi',
  ur: 'Urdu'
});

export const TONES = Object.freeze({ polite: 'Polite', friendly: 'Friendly', formal: 'Formal' });
