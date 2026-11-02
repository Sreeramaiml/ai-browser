// @ts-check
// Outbound redaction (architecture §15.2): card numbers, Aadhaar, PAN, OTPs, UPI IDs and API keys
// are replaced before any text leaves for an AI provider. Run by the gateway on every text part,
// so no feature can skip it. Checksums keep order IDs and phone numbers intact (EC-RED-02, -03).

import { luhnValid, verhoeffValid } from './safety/field-rules.js';

export const REDACTED = Object.freeze({
  card: '[card number removed]',
  aadhaar: '[Aadhaar removed]',
  pan: '[PAN removed]',
  otp: '[code removed]',
  upi: '[UPI ID removed]',
  key: '[API key removed]',
  email: '[email removed]',
  phone: '[phone number removed]'
});

/** @typedef {keyof typeof REDACTED} RedactionKind */

// Precompiled, one pass each (EC-RED-11).
const CARD_RE = /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g;
const AADHAAR_RE = /(?<![\d-])[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?![\d-])/g;
const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/gi; // EC-RED-04
// An OTP needs an OTP word within 20 characters, before or after: "area code 040" stays (EC-RED-05).
const OTP_WORD = String.raw`(?:otp|one[\s-]?time\s*(?:pass(?:word|code)?|code|pin)?|verification\s*code|security\s*code|auth(?:entication)?\s*code|2fa\s*code|login\s*code|ओटीपी)`;
const OTP_RE = new RegExp(String.raw`(${OTP_WORD}[^\d\n]{0,20}?)(?<!\d)(\d{4,8})(?!\d)|(?<!\d)(\d{4,8})(?!\d)(?=[^\d\n]{0,20}?${OTP_WORD})`, 'gi');
// Known UPI handles only, so ordinary emails survive (EC-RED-06).
const UPI_HANDLES = [
  'okaxis', 'oksbi', 'okhdfcbank', 'okicici', 'ybl', 'ibl', 'axl', 'paytm', 'pthdfc', 'ptsbi', 'ptaxis', 'ptyes',
  'upi', 'apl', 'yapl', 'rapl', 'axisbank', 'icici', 'hdfcbank', 'sbi', 'kotak', 'indus', 'federal', 'idfcbank',
  'aubank', 'jupiteraxis', 'freecharge', 'mobikwik', 'ikwik', 'airtel', 'jio', 'postbank', 'barodampay', 'cnrb',
  'waaxis', 'wahdfcbank', 'waicici', 'wasbi', 'fbl', 'naviaxis', 'superyes', 'timecosmos', 'slice', 'abfspay'
];
const UPI_RE = new RegExp(String.raw`\b[\w.-]{2,256}@(?:${UPI_HANDLES.join('|')})\b(?!\.)`, 'gi');
// Key shapes for Gemini, Groq and Claude, in case one is pasted into a question (EC-RED-10).
const KEY_RE = /\b(?:AIza[0-9A-Za-z_-]{35}|AQ\.[A-Za-z0-9._~+/=-]{20,}|gsk_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,})/g;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const PHONE_RE = /(?<![\w+])(?:\+?\d{1,3}[ -]?)?(?:\(?\d{2,5}\)?[ -]?)?\d{3,5}[ -]?\d{4,5}(?!\w)/g;

/**
 * @param {string} text
 * @param {{ contacts?: boolean }} [opts] contacts: also hide emails and phone numbers (EC-RED-09)
 * @returns {{ text: string, counts: Partial<Record<RedactionKind, number>> }}
 */
export function redact(text, { contacts = false } = {}) {
  /** @type {Partial<Record<RedactionKind, number>>} */
  const counts = {};
  /** @param {RedactionKind} kind */
  const hit = (kind) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    return REDACTED[kind];
  };
  let out = String(text ?? '');
  if (!out) return { text: out, counts };

  out = out.replace(KEY_RE, () => hit('key'));
  // Cards before Aadhaar: a 16-digit card also contains 12 digits in a row.
  out = out.replace(CARD_RE, (m) => (luhnValid(m.replace(/\D/g, '')) ? hit('card') : m));
  out = out.replace(AADHAAR_RE, (m) => (verhoeffValid(m.replace(/\D/g, '')) ? hit('aadhaar') : m));
  out = out.replace(PAN_RE, () => hit('pan'));
  out = out.replace(UPI_RE, () => hit('upi'));
  out = out.replace(OTP_RE, (m, before, code) => (code !== undefined ? `${before}${hit('otp')}` : hit('otp')));
  if (contacts) {
    out = out.replace(EMAIL_RE, () => hit('email'));
    out = out.replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 8 ? hit('phone') : m));
  }
  return { text: out, counts };
}

/**
 * Redact every text part of a request (images are left alone: screenshots are only allowed on
 * tier-0 pages, EC-RED-13).
 * @template {{ parts: Array<{ text?: string }> }} T
 * @param {T[]} turns
 * @param {{ contacts?: boolean }} [opts]
 * @returns {T[]}
 */
export function redactTurns(turns, opts) {
  return turns.map((t) => ({
    ...t,
    parts: t.parts.map((p) => (typeof p.text === 'string' ? { ...p, text: redact(p.text, opts).text } : p))
  }));
}
