import { describe, it, expect } from 'vitest';
import { classifyAction, isConsequential } from '../../src/shared/safety/action-rules.js';

const button = (label, extra = {}) => ({ tag: 'button', inputType: 'button', label, ...extra });

// [description, element info, expected kind]
const ACTION_CASES = [
  // Consequential: double-confirm (EC-ACT-01)
  ...['Submit', 'Send', 'Confirm', 'Delete', 'Apply', 'Post', 'Register', 'Finish', 'Sign up', 'Book', 'Transfer']
    .map((label) => [`"${label}" button (EC-ACT-01)`, button(label), 'consequential']),
  ['<input type=submit value="Go"> (EC-ACT-02)', { tag: 'input', inputType: 'submit', label: 'Go' }, 'consequential'],
  ['the form\'s default submit button (EC-ACT-03)', button('Go', { inForm: true, isFormDefaultSubmit: true }), 'consequential'],
  ['a <button> in a form, type defaulting to submit (EC-ACT-03)', { tag: 'button', inputType: 'submit', inForm: true, label: 'Go' }, 'consequential'],
  ['icon button with aria-label "Send" (EC-ACT-05)', button('Send', { role: 'button' }), 'consequential'],
  ['unnamed button inside a form (EC-ACT-06)', button('', { inForm: true }), 'consequential'],
  ['Hindi "जमा करें" (EC-ACT-09)', button('जमा करें'), 'consequential'],
  ['Hindi "भेजें" (EC-ACT-09)', button('भेजें'), 'consequential'],
  ['"Delete account" on an owned site is confirmed, never blocked (EC-ACT-13)', button('Delete account'), 'consequential'],
  ['<button type=reset> clears the form (EC-ACT-14)', { tag: 'button', inputType: 'reset', inForm: true, label: 'Clear' }, 'consequential'],
  ['div role=button "Post"', { tag: 'div', role: 'button', label: 'Post' }, 'consequential'],
  // Blocked: submits a form with a protected field (EC-ACT-08)
  ['"Sign in" submitting a login form (EC-ACT-08)', { tag: 'button', inputType: 'submit', inForm: true, label: 'Sign in', formHasProtectedField: true }, 'blocked'],
  ['"Verify OTP" as type=button (EC-ACT-08)', button('Verify OTP', { inForm: true, formHasProtectedField: true }), 'blocked'],
  ['"Pay ₹499" on a card form (EC-ACT-08)', button('Pay ₹499', { inForm: true, formHasProtectedField: true }), 'blocked'],
  ['"Continue" on a login form', button('Continue', { inForm: true, formHasProtectedField: true }), 'blocked'],
  // Blocked anywhere: paying, checking out and logging in (P4.3 step 8, EC-INJ-02)
  ...['Pay', 'Pay now', 'Pay ₹499', 'Place order', 'Place your order', 'Buy now', 'Checkout', 'Check out', 'Purchase',
    'Make payment', 'Proceed to payment', 'Log in', 'Login', 'Sign in', 'Sign in with Google']
    .map((label) => [`"${label}" button outside any protected form`, button(label), 'blocked']),
  ['link to /checkout (EC-ACT-07)', { tag: 'a', href: '/checkout', label: 'Continue' }, 'blocked'],
  ['link to /payment?id=1 (EC-ACT-07)', { tag: 'a', href: '/payment?id=1', label: 'Go on' }, 'blocked'],
  ['link to /order/confirm (EC-ACT-07)', { tag: 'a', href: '/order/confirm', label: 'Review' }, 'blocked'],
  ['Hindi "भुगतान करें" (EC-ACT-09)', button('भुगतान करें'), 'blocked'],
  ['Hindi "लॉग इन"', button('लॉग इन'), 'blocked'],
  ['submit button labelled "Pay now" in a plain form', { tag: 'button', inputType: 'submit', inForm: true, label: 'Pay now' }, 'blocked'],
  // Normal
  ['"Show password" toggle on a login form', button('Show password', { inForm: true, formHasProtectedField: true }), 'normal'],
  ['"Forgot password?" link on a login form', { tag: 'a', href: '/forgot', label: 'Forgot password?', formHasProtectedField: true }, 'normal'],
  ['"Next" between form steps', button('Next', { inForm: true }), 'normal'],
  ['"Show more"', button('Show more'), 'normal'],
  ['unnamed button outside any form', button(''), 'normal'],
  ['a type=submit <button> outside any form submits nothing', { tag: 'button', inputType: 'submit', inForm: false, label: 'Open menu' }, 'normal'],
  ['"I agree to subscribe" checkbox (EC-ACT-12)', { tag: 'input', inputType: 'checkbox', label: 'I agree to subscribe' }, 'normal'],
  ['"Submit your application" heading is not an action (EC-ACT-10)', { tag: 'h2', label: 'Submit your application' }, 'normal'],
  ['link to an article about paying less', { tag: 'a', href: '/blog/how-to-pay-less', label: 'Read more' }, 'normal'],
  ['"Payment history" link is only navigation', { tag: 'a', href: '/account/history', label: 'Payment history' }, 'normal'],
  ['"PayPal help" link', { tag: 'a', href: '/help', label: 'PayPal help' }, 'normal'],
  ['"Add to cart" needs no confirmation', button('Add to cart'), 'normal'],
  ['a "Log in" heading is not an action', { tag: 'h1', label: 'Log in to your account' }, 'normal']
];

describe('classifyAction (architecture §14.5, edge cases §15.2)', () => {
  it(`covers at least 15 cases (has ${ACTION_CASES.length})`, () => {
    expect(ACTION_CASES.length).toBeGreaterThanOrEqual(15);
  });

  for (const [name, el, expected] of ACTION_CASES) {
    it(`${name} → ${expected}`, () => {
      expect(classifyAction(el).kind).toBe(expected);
    });
  }

  it('explains why', () => {
    expect(classifyAction(button('Pay', { formHasProtectedField: true })).reason).toMatch(/password, OTP or card/);
    expect(classifyAction(button('Pay now')).reason).toMatch(/pay or place an order/);
    expect(classifyAction(button('Log in')).reason).toMatch(/log in/);
    expect(classifyAction(button('Submit')).reason).toMatch(/submits/);
    expect(classifyAction(button('Next')).reason).toBeNull();
  });

  it('isConsequential agrees with classifyAction for unprotected forms', () => {
    expect(isConsequential(button('Submit'))).toBe(true);
    expect(isConsequential(button('Next'))).toBe(false);
  });
});
