// @ts-check
// Client-side pacing and cooldowns (architecture §8.4). Cooldowns live in storage.session so every
// feature, and a restarted service worker, sees them (EC-RTL-12). Pacing is in memory: a worker
// that has just restarted has been idle long enough anyway.

import { LlmError } from './errors.js';

export const COOLDOWNS_KEY = 'cooldowns';
/** A 429 without a retry hint cools that link down this long (EC-RTL-03). */
export const DEFAULT_COOLDOWN_MS = 10_000;
/** No cooldown lasts longer than this, whatever the clock or provider says (EC-LLM-15). */
export const MAX_COOLDOWN_MS = 24 * 60 * 60_000;

/**
 * @typedef {{ until: number, reason: 'rate'|'daily' }} Cooldown
 * @typedef {{
 *   get: (key: string) => Promise<Record<string, any>>,
 *   set: (items: Record<string, any>) => Promise<void>
 * }} LimiterArea
 */

/**
 * The next midnight in US Pacific time, when Gemini's daily free quota resets (pure).
 * Handles the 23- and 25-hour days around daylight-saving changes.
 * @param {number} now epoch ms
 * @returns {number} epoch ms
 */
export function nextMidnightPacific(now) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23'
  });
  /** @param {number} t */
  const clock = (t) => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map((p) => [p.type, Number(p.value)]));
    return { h: parts.hour % 24, m: parts.minute, s: parts.second };
  };
  const { h, m, s } = clock(now);
  const sinceMidnight = ((h * 60 + m) * 60 + s) * 1000 + (now % 1000);
  let candidate = now - sinceMidnight + 24 * 3600_000;
  // On a DST change the day is an hour shorter or longer; nudge onto midnight.
  const hour = clock(candidate).h;
  if (hour === 23) candidate += 3600_000;
  else if (hour === 1) candidate -= 3600_000;
  return candidate;
}

/**
 * Sleep that stops early, with CANCELLED, if the user presses Stop (EC-RTL-11).
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError('CANCELLED'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LlmError('CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** In-memory stand-in for storage.session (tests, and gateways without shared state). */
export function memoryArea() {
  /** @type {Record<string, any>} */
  const data = {};
  return {
    get: async (key) => ({ [key]: data[key] }),
    set: async (items) => { Object.assign(data, JSON.parse(JSON.stringify(items))); }
  };
}

/**
 * @param {{
 *   area: LimiterArea,
 *   gaps?: Record<string, number>,
 *   now?: () => number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
 * }} deps gaps: minimum ms between calls, by link key ('gemini:<model>') or by tier ('lite', 'flash', 'groq')
 */
export function createRateLimiter({ area, gaps = {}, now = Date.now, sleep = abortableSleep }) {
  /** link key → when its last call started */
  const lastCall = new Map();
  let queue = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  /** @returns {Promise<Record<string, Cooldown>>} */
  async function readAll() {
    const { [COOLDOWNS_KEY]: all } = await area.get(COOLDOWNS_KEY);
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  }

  return {
    /**
     * The active cooldown for a link, if any.
     * @param {string} key
     * @returns {Promise<Cooldown|null>}
     */
    async cooldown(key) {
      const entry = (await readAll())[key];
      const t = now();
      if (!entry || typeof entry.until !== 'number' || entry.until <= t) return null;
      return { until: Math.min(entry.until, t + MAX_COOLDOWN_MS), reason: entry.reason === 'daily' ? 'daily' : 'rate' };
    },

    /**
     * @param {string} key
     * @param {number} until epoch ms
     * @param {'rate'|'daily'} reason
     */
    setCooldown(key, until, reason) {
      return serial(async () => {
        const t = now();
        const all = await readAll();
        // Drop expired entries while we're here.
        for (const [k, v] of Object.entries(all)) if (!v || v.until <= t) delete all[k];
        all[key] = { until: Math.min(until, t + MAX_COOLDOWN_MS), reason };
        try {
          await area.set({ [COOLDOWNS_KEY]: all });
        } catch {
          /* best effort: without it we simply ask again next time */
        }
      });
    },

    /**
     * Wait until this link's minimum gap since its last call has passed (EC-RTL-13).
     * @param {string} key
     * @param {string} tier
     * @param {AbortSignal} [signal]
     */
    async pace(key, tier, signal) {
      const gap = gaps[key] ?? gaps[tier] ?? 0;
      const wait = (lastCall.get(key) ?? -Infinity) + gap - now();
      // Claim the slot before waiting, so two callers don't both wake at the same moment.
      lastCall.set(key, now() + Math.max(0, wait));
      if (wait > 0) await sleep(wait, signal);
    }
  };
}

/** @type {ReturnType<typeof createRateLimiter>|null} */
let shared = null;

/**
 * The one limiter every feature's gateway shares, so pacing applies across features.
 * @param {Record<string, number>} gaps
 */
export function sharedLimiter(gaps) {
  shared ??= createRateLimiter({ area: chrome.storage.session, gaps });
  return shared;
}
