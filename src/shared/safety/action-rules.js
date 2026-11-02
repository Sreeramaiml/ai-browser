// @ts-check
// Consequential and blocked clicks (architecture §14.5, edge cases §15.2).
//   blocked:       the click submits a form that holds a password, OTP or card field (login,
//                  "Verify OTP", "Pay ₹499"), or it pays, checks out or logs in wherever it is
//                  (P4.3); never run, whatever the user approves
//   consequential: submits, sends, pays, deletes…; runs only after a second confirmation
//   normal:        everything else; runs after the usual one approval
//
// Canonical source, imported by the service worker. It must stay import-free and end with a single
// `export { … };` line: scripts/sync-classic.mjs turns it into the classic-script copy that content
// scripts load (src/content/generated/action-rules.classic.js). Run `npm run sync` after editing.

/**
 * What the rules look at. `label` is the accessible name (architecture §11.2).
 * @typedef {{
 *   tag?: string, role?: string, inputType?: string, label?: string, href?: string,
 *   inForm?: boolean, isFormDefaultSubmit?: boolean, formHasProtectedField?: boolean
 * }} ActionInfo
 *   inputType: the element's `type` (for a <button> inside a form the DOM reports 'submit' by default);
 *   formHasProtectedField: the form this element would submit contains a field-rules protected field
 * @typedef {'normal'|'consequential'|'blocked'} ActionKind
 */

const CONSEQUENTIAL_RE = /\b(submit|send|pay|place\s*order|buy|purchase|checkout|check\s*out|confirm|delete|remove|transfer|apply|post|publish|sign\s*up|register|book|subscribe|unsubscribe|finish|reset)\b/i;
// Hindi buttons: submit, send, pay, buy, confirm, delete (EC-ACT-09).
const CONSEQUENTIAL_HI_RE = /जमा\s*करें|सबमिट|भेजें|भुगतान|खरीदें|पुष्टि|हटाएं|मिटाएं/;
// In a form with a protected field, these move the login, OTP or payment flow on, so they're blocked
// too, even as plain type="button" ("Verify OTP", "Continue", "Log in").
const PROTECTED_FLOW_RE = /\b(log\s*in|login|sign\s*in|signin|verify|validate|continue|proceed|next|authori[sz]e|otp)\b|लॉग\s*इन|सत्यापित/i;
// Links to payment or order-confirmation pages (EC-ACT-07).
const PAY_PATH_RE = /\/(checkout|payment|payments|pay|purchase|order\/confirm)(\/|\?|#|$)/i;
// Paying and logging in are never done for the user, in any form (P4.3, EC-INJ-02).
const PAYMENT_RE = /\b(pay(\s*now)?|make\s*(a\s*)?payment|place\s*(your\s*)?order|checkout|check\s*out|buy\s*now|purchase|proceed\s*to\s*(pay|payment|checkout))\b|भुगतान|खरीदें/i;
const LOGIN_RE = /\b(log\s*in|login|sign\s*in|signin)\b|लॉग\s*इन/i;

const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'reset', 'image']);

/** @param {ActionInfo} el */
function isButtonLike(el) {
  const tag = String(el.tag ?? '').toLowerCase();
  return tag === 'button' || el.role === 'button' || (tag === 'input' && BUTTON_INPUT_TYPES.has(String(el.inputType ?? '')));
}

/** @param {ActionInfo} el */
function isLink(el) {
  return String(el.tag ?? '').toLowerCase() === 'a' || el.role === 'link';
}

/** @param {ActionInfo} el does clicking it submit (or reset) its form? */
function submitsForm(el) {
  const tag = String(el.tag ?? '').toLowerCase();
  const type = String(el.inputType ?? '');
  if (type === 'reset') return true; // clears what the user typed (EC-ACT-14)
  if (el.isFormDefaultSubmit) return true; // EC-ACT-03
  // A <button> outside a form also reports type "submit", but submits nothing.
  return (type === 'submit' || type === 'image') && (tag === 'input' || Boolean(el.inForm));
}

/**
 * Should a click need a second confirmation? (§14.5)
 * Only buttons and links are judged; checkboxes and text fields never are (EC-ACT-10, EC-ACT-12).
 * @param {ActionInfo} el
 */
function isConsequential(el) {
  const label = String(el.label ?? '').trim();
  if (isButtonLike(el)) {
    if (submitsForm(el)) return true; // EC-ACT-02, EC-ACT-03, EC-ACT-14
    if (CONSEQUENTIAL_RE.test(label) || CONSEQUENTIAL_HI_RE.test(label)) return true; // EC-ACT-01, -05, -09
    // A button we can't name, inside a form, might submit it (EC-ACT-06).
    return !label && Boolean(el.inForm);
  }
  if (isLink(el)) {
    return PAY_PATH_RE.test(String(el.href ?? '')) || CONSEQUENTIAL_RE.test(label) || CONSEQUENTIAL_HI_RE.test(label);
  }
  return false;
}

/**
 * @param {ActionInfo} el
 * @returns {{ kind: ActionKind, reason: string|null }}
 */
function classifyAction(el) {
  const label = String(el.label ?? '');
  // Login, OTP and card forms: a click that could submit them is blocked, not just confirmed (EC-ACT-08).
  const flows = PROTECTED_FLOW_RE.test(label);
  if (el.formHasProtectedField && (isButtonLike(el) || isLink(el)) && (submitsForm(el) || isConsequential(el) || flows)) {
    return { kind: 'blocked', reason: 'It would submit a form with a password, OTP or card field.' };
  }
  if (isButtonLike(el) || isLink(el)) {
    if (PAYMENT_RE.test(label) || (isLink(el) && PAY_PATH_RE.test(String(el.href ?? '')))) {
      return { kind: 'blocked', reason: 'It would pay or place an order. Pagewise never does that for you.' };
    }
    if (LOGIN_RE.test(label)) return { kind: 'blocked', reason: 'It would log in. Pagewise never logs in for you.' };
  }
  if (isConsequential(el)) return { kind: 'consequential', reason: 'It submits, sends, pays or deletes something.' };
  return { kind: 'normal', reason: null };
}

export { classifyAction, isConsequential };
