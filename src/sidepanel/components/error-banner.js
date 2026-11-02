// @ts-check
// Inline error banner with the right next step (architecture §16.1): fix settings, retry, or nothing.
// Rate limits show a live countdown, and Retry turns on when the cooldown ends.

/** Errors the user fixes in Settings. */
const SETTINGS_CODES = new Set(['NO_API_KEY', 'AUTH_FAILED', 'BILLING', 'MODEL_UNAVAILABLE', 'PROFILE_EMPTY']);
/** Not failures — just guidance. Shown in a neutral style. */
const INFO_CODES = new Set([
  'NO_SELECTION', 'PROTECTED_FIELD', 'PAGE_RESTRICTED', 'NOT_ENOUGH_TEXT', 'INVALID_YOUTUBE_URL', 'EMPTY_QUESTION', 'PAGE_CHANGED',
  'ALREADY_IN_TARGET', 'UNKNOWN_ACTION', 'PAGE_BLOCKED', 'IMAGE_INVALID', 'SKILL_NOT_FOUND', 'SKILL_TEMPLATE', 'NEEDS_ACK'
]);

/**
 * @typedef {{ code: string, message: string, retryable?: boolean, retryAfterMs?: number, retryAt?: number, hint?: string, domain?: string }} ErrorPayload
 */

/**
 * Countdown copy (pure).
 * @param {number} until epoch ms
 * @param {number} now
 */
export function countdownText(until, now) {
  const seconds = Math.ceil((until - now) / 1000);
  if (seconds <= 0) return 'You can try again now.';
  if (seconds < 120) return `Try again in ~${seconds} s.`;
  return `Try again in ~${Math.ceil(seconds / 60)} min.`;
}

/** @param {number} at epoch ms → "1:30 PM" in the user's own time zone */
function localTime(at) {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * @param {ErrorPayload} error
 * @param {{ onRetry?: () => void, onOpenSettings?: () => void, onAck?: (domain: string) => void }} actions
 *   onAck: the user agreed to send only their selection from a private page (NEEDS_ACK, EC-TIR-09)
 * @returns {HTMLElement}
 */
export function createErrorBanner(error, { onRetry, onOpenSettings, onAck }) {
  const banner = document.createElement('div');
  banner.className = INFO_CODES.has(error.code) ? 'inline-banner info' : 'inline-banner error';
  banner.setAttribute('role', INFO_CODES.has(error.code) ? 'status' : 'alert');

  const until = typeof error.retryAt === 'number'
    ? error.retryAt
    : error.retryAfterMs && error.retryAfterMs > 0 ? Date.now() + error.retryAfterMs : null;

  const text = document.createElement('p');
  let message = error.message;
  // The daily quota resets at midnight Pacific; say when that is for the user (EC-RTL-04).
  if (error.code === 'QUOTA_EXHAUSTED' && until) message += ` It resets around ${localTime(until)}.`;
  if (error.hint === 'add-groq') message += ' Adding a free Groq key in Settings keeps text features working.';
  text.textContent = message;
  banner.append(text);

  const buttons = [];
  if (error.code === 'NEEDS_ACK' && onAck && error.domain) {
    const ack = button('Send only my selection', () => {
      ack.disabled = true;
      onAck(/** @type {string} */ (error.domain));
    });
    buttons.push(ack);
  }
  if ((SETTINGS_CODES.has(error.code) || error.hint === 'add-groq') && onOpenSettings) buttons.push(button('Open Settings', onOpenSettings));
  /** @type {HTMLButtonElement|null} */
  let retry = null;
  if (error.retryable && onRetry) {
    retry = button('Try again', onRetry);
    buttons.push(retry);
  }
  if (buttons.length) {
    const row = document.createElement('div');
    row.className = 'row';
    row.append(...buttons);
    banner.append(row);
  }

  // Countdown until a cooled-down model is free again; Retry waits for it (P2.4).
  if (until && error.code !== 'QUOTA_EXHAUSTED' && until > Date.now()) {
    const countdown = document.createElement('p');
    countdown.className = 'countdown';
    countdown.setAttribute('aria-live', 'off'); // a per-second announcement would be noise
    text.after(countdown);
    if (retry) retry.disabled = true;
    let shown = false;
    const tick = () => {
      if (banner.isConnected) shown = true;
      else if (shown) return clearInterval(timer); // removed from the page
      countdown.textContent = countdownText(until, Date.now());
      if (Date.now() >= until) {
        clearInterval(timer);
        if (retry) retry.disabled = false;
      }
    };
    const timer = setInterval(tick, 1000);
    tick();
  }
  return banner;
}

/** @param {string} label @param {() => void} onClick */
function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn btn-secondary';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
