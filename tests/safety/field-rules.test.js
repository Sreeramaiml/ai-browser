import { describe, it, expect } from 'vitest';
import { classifyField, looksLikeSecretValue, luhnValid, verhoeffValid } from '../../src/shared/safety/field-rules.js';

// [description, field info, expected classification]
const FIELD_CASES = [
  // Passwords
  ['input type=password (EC-FLD-01)', { type: 'password' }, 'password'],
  ['autocomplete=current-password (EC-FLD-02)', { type: 'text', autocomplete: 'current-password' }, 'password'],
  ['autocomplete=new-password (EC-FLD-02)', { type: 'text', autocomplete: 'new-password' }, 'password'],
  ['password shown as text by "show password" (EC-FLD-03)', { type: 'text', label: 'Password' }, 'password'],
  ['camelCase name attribute', { type: 'text', name: 'loginPassword' }, 'password'],
  ['snake_case "pwd" id', { type: 'text', id: 'user_pwd' }, 'password'],
  ['Hindi label "पासवर्ड" (EC-FLD-16)', { type: 'text', label: 'पासवर्ड' }, 'password'],
  ['a real password input labelled "PIN code" is still a password', { type: 'password', label: 'PIN code' }, 'password'],
  // OTPs
  ['autocomplete=one-time-code (EC-FLD-04)', { type: 'text', autocomplete: 'one-time-code' }, 'otp'],
  ['"Enter OTP" (EC-FLD-05)', { type: 'text', label: 'Enter OTP' }, 'otp'],
  ['"Verification code" (EC-FLD-05)', { type: 'text', label: 'Verification code' }, 'otp'],
  ['"6-digit code" (EC-FLD-05)', { type: 'text', label: '6-digit code' }, 'otp'],
  ['"Security code" (EC-FLD-05)', { type: 'text', label: 'Security code' }, 'otp'],
  ['"2FA code" (EC-FLD-05)', { type: 'text', label: '2FA code' }, 'otp'],
  ['name="otp_input"', { type: 'text', name: 'otp_input' }, 'otp'],
  ['Hindi "ओटीपी दर्ज करें" (EC-FLD-16)', { type: 'text', label: 'ओटीपी दर्ज करें' }, 'otp'],
  ['split OTP: 6 one-digit numeric boxes (EC-FLD-06)', { type: 'text', inputMode: 'numeric', maxLength: 1, groupSize: 6 }, 'otp'],
  ['split OTP: 4 unlabelled tel boxes (EC-FLD-06)', { type: 'tel', maxLength: 1, groupSize: 4 }, 'otp'],
  ['unlabelled 6-digit box on a "Verify your phone" page (EC-FLD-07)', { type: 'text', inputMode: 'numeric', maxLength: 6, pageOtp: true }, 'otp'],
  ['numeric box whose name mentions a code', { type: 'tel', maxLength: 6, name: 'code' }, 'otp'],
  ['"PIN" on its own is an ATM/UPI PIN (EC-FLD-13)', { type: 'text', label: 'PIN' }, 'otp'],
  ['"ATM PIN" (EC-FLD-13)', { type: 'text', label: 'ATM PIN' }, 'otp'],
  // Cards and UPI
  ['autocomplete=cc-number (EC-FLD-08)', { type: 'text', autocomplete: 'cc-number' }, 'card'],
  ['autocomplete=cc-csc (EC-FLD-08)', { type: 'text', autocomplete: 'cc-csc' }, 'card'],
  ['autocomplete=cc-exp (EC-FLD-08)', { type: 'text', autocomplete: 'cc-exp' }, 'card'],
  ['autocomplete with a section token: "billing cc-name"', { type: 'text', autocomplete: 'billing cc-name' }, 'card'],
  ['"Card number" (EC-FLD-09)', { type: 'text', label: 'Card number' }, 'card'],
  ['"CVV" (EC-FLD-09)', { type: 'text', label: 'CVV' }, 'card'],
  ['"CVC" (EC-FLD-09)', { type: 'text', label: 'CVC' }, 'card'],
  ['"Expiry (MM/YY)" (EC-FLD-09)', { type: 'text', label: 'Expiry (MM/YY)' }, 'card'],
  ['"Name on card" (EC-FLD-09)', { type: 'text', label: 'Name on card' }, 'card'],
  ['name="cardnumber"', { type: 'text', name: 'cardnumber' }, 'card'],
  ['"UPI ID" (EC-FLD-11)', { type: 'text', label: 'UPI ID' }, 'card'],
  ['"VPA" (EC-FLD-11)', { type: 'text', label: 'VPA' }, 'card'],
  ['"UPI PIN" is financial, not just an OTP (EC-FLD-11)', { type: 'text', label: 'UPI PIN' }, 'card'],
  ['Hindi "कार्ड नंबर"', { type: 'text', label: 'कार्ड नंबर' }, 'card'],
  // Benign: postal codes (EC-FLD-12). Policy: Indian "PIN code" is a postal code, never protected.
  ['"PIN code" is a postal code (EC-FLD-12)', { type: 'text', label: 'PIN code' }, null],
  ['"Pincode" (EC-FLD-12)', { type: 'text', label: 'Pincode', inputMode: 'numeric', maxLength: 6 }, null],
  ['name="pin_code" (EC-FLD-12)', { type: 'text', name: 'pin_code' }, null],
  ['"Postal code" (EC-FLD-12)', { type: 'text', label: 'Postal code' }, null],
  ['"ZIP" (EC-FLD-12)', { type: 'text', label: 'ZIP' }, null],
  ['Hindi "पिन कोड" (EC-FLD-12)', { type: 'text', label: 'पिन कोड' }, null],
  // Benign: look-alike words (EC-FLD-14, EC-FLD-15) and ordinary fields
  ['"Passport number" is not a password (EC-FLD-14)', { type: 'text', label: 'Passport number' }, null],
  ['"Bypass road" (EC-FLD-15)', { type: 'text', label: 'Bypass road' }, null],
  ['"Company" (EC-FLD-15)', { type: 'text', label: 'Company' }, null],
  ['"Compass heading" (EC-FLD-15)', { type: 'text', label: 'Compass heading' }, null],
  ['"Email"', { type: 'email', label: 'Email', autocomplete: 'email' }, null],
  ['"Full name"', { type: 'text', label: 'Full name' }, null],
  ['"Graduation year" (numeric, 4 digits)', { type: 'text', label: 'Graduation year', inputMode: 'numeric', maxLength: 4 }, null],
  ['three one-digit boxes are not a split OTP', { type: 'text', inputMode: 'numeric', maxLength: 1, groupSize: 3 }, null],
  ['unlabelled 6-digit box on an ordinary page', { type: 'text', inputMode: 'numeric', maxLength: 6 }, null]
];

describe('classifyField (architecture §14.4, edge cases §15.1)', () => {
  it(`covers at least 25 cases (has ${FIELD_CASES.length})`, () => {
    expect(FIELD_CASES.length).toBeGreaterThanOrEqual(25);
  });

  for (const [name, field, expected] of FIELD_CASES) {
    it(`${name} → ${expected ?? 'not protected'}`, () => {
      expect(classifyField(field)).toBe(expected);
    });
  }
});

describe('checksums', () => {
  it('Luhn', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
  });

  it('Verhoeff', () => {
    expect(verhoeffValid('234123412346')).toBe(true);
    expect(verhoeffValid('234123412347')).toBe(false);
  });
});

// [description, value, context, expected]
const VALUE_CASES = [
  ['card number with spaces (EC-RED-01)', '4111 1111 1111 1111', {}, 'card'],
  ['card number with dashes (EC-RED-01)', '4111-1111-1111-1111', {}, 'card'],
  ['card number inside a sentence', 'My card is 4242 4242 4242 4242, thanks', { label: 'Notes' }, 'card'],
  ['16 digits failing Luhn, e.g. an order ID (EC-RED-02)', '4111111111111112', { label: 'Order ID' }, null],
  ['Aadhaar with spaces (EC-RED-03)', '2341 2341 2346', { label: 'ID' }, 'aadhaar'],
  ['Aadhaar without spaces (EC-RED-03)', '234123412346', { label: 'ID' }, 'aadhaar'],
  ['12 digits failing Verhoeff are kept (EC-RED-03)', '234123412347', { label: 'ID' }, null],
  ['6 digits into an OTP field', '482913', { label: 'Enter OTP' }, 'otp'],
  ['6 digits on a page asking for an OTP', '482913', { label: 'Reference', pageOtp: true }, 'otp'],
  ['6 digits with no field context, not from the profile', '482913', {}, 'otp'],
  ['6 digits with no field context, from the profile', '482913', { fromProfile: true }, null],
  ['6-digit Indian PIN code in a postal field (EC-RED-12)', '500032', { label: 'PIN code', pageOtp: true }, null],
  ['4-digit year in a year field (EC-RED-12)', '2026', { label: 'Graduation year' }, null],
  ['3 digits into a CVV field', '123', { label: 'CVV' }, 'cvv'],
  ['3 digits on a card page', '123', { label: 'Code', pageCard: true }, 'cvv'],
  ['3 digits in a quantity field', '3', { label: 'Quantity' }, null],
  ['10-digit phone number', '9876543210', { label: 'Phone' }, null],
  ['ordinary text', 'IIT Hyderabad', { label: 'College' }, null]
];

describe('looksLikeSecretValue (architecture §14.4, edge cases §26)', () => {
  for (const [name, value, ctx, expected] of VALUE_CASES) {
    it(`${name} → ${expected ?? 'allowed'}`, () => {
      expect(looksLikeSecretValue(value, ctx)).toBe(expected);
    });
  }
});
