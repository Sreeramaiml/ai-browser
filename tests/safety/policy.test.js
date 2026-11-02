import { describe, it, expect } from 'vitest';
import { checkAction, checkAgentAllowed } from '../../src/shared/safety/policy.js';

describe('checkAgentAllowed (architecture §14.3)', () => {
  it.each([
    'http://localhost:3000/internship/',
    'http://localhost:3001/', // EC-PRC-01: another port
    'http://127.0.0.1:5173/shop/',
    'http://[::1]:3000/'
  ])('allows the local practice site: %s', (url) => {
    expect(checkAgentAllowed(url)).toEqual({ allowed: true, reason: null, via: 'practice' });
  });

  it.each([
    'https://en.wikipedia.org/wiki/India', // S9
    'https://localhost.evil.com/',
    'chrome://settings/',
    'not a url'
  ])('refuses everywhere else: %s', (url) => {
    expect(checkAgentAllowed(url).allowed).toBe(false);
  });

  it('refuses the practice site opened as a file, saying how to serve it (EC-PRC-02)', () => {
    const r = checkAgentAllowed('file:///Users/me/sahayak/practice/index.html');
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/npx serve practice/);
  });

  it('allows owned domains and their subdomains, never look-alikes', () => {
    const opts = { ownedDomains: ['example.org'] };
    expect(checkAgentAllowed('https://example.org/', opts)).toMatchObject({ allowed: true, via: 'owned' });
    expect(checkAgentAllowed('https://shop.example.org/cart', opts).allowed).toBe(true);
    expect(checkAgentAllowed('https://notexample.org/', opts).allowed).toBe(false);
    expect(checkAgentAllowed('https://example.org.evil.com/', opts).allowed).toBe(false);
  });

  it('allows the published practice site only under its path', () => {
    const opts = { practiceSiteUrl: 'https://me.github.io/sahayak/practice/' };
    expect(checkAgentAllowed('https://me.github.io/sahayak/practice/shop/', opts)).toMatchObject({ allowed: true, via: 'practice' });
    expect(checkAgentAllowed('https://me.github.io/sahayak/practice-evil/', opts).allowed).toBe(false);
    expect(checkAgentAllowed('https://me.github.io/other/', opts).allowed).toBe(false);
  });
});

describe('checkAction (architecture §14.1)', () => {
  const field = (label, extra = {}) => ({ tag: 'input', inputType: 'text', label, ...extra });

  it('never types into a protected field', () => {
    const r = checkAction({ type: 'type', value: 'hunter2' }, field('Password', { inputType: 'password' }));
    expect(r).toEqual({ allowed: false, reason: 'Sahayak never types into password fields.', requiresConfirm: false });
  });

  it('trusts a protected flag from the scan even if the label now looks harmless (fail closed)', () => {
    expect(checkAction({ type: 'type', value: 'x' }, field('Notes', { protected: 'otp' })).allowed).toBe(false);
  });

  it('never selects in a card field', () => {
    expect(checkAction({ type: 'select', value: '08' }, { tag: 'select', label: 'Expiry month' }).allowed).toBe(false);
  });

  it('blocks secret-looking values in any field', () => {
    const card = checkAction({ type: 'type', value: '4111 1111 1111 1111' }, field('Notes'));
    expect(card.allowed).toBe(false);
    expect(card.reason).toMatch(/card number/);
    expect(checkAction({ type: 'type', value: '482913' }, field('Reference'), { pageOtp: true }).allowed).toBe(false);
  });

  it('allows ordinary typing', () => {
    expect(checkAction({ type: 'type', value: 'Asha Rao' }, field('Full name'))).toEqual({ allowed: true, reason: null, requiresConfirm: false });
    expect(checkAction({ type: 'type', value: '500032' }, field('PIN code'))).toMatchObject({ allowed: true });
  });

  it('consequential clicks need a second confirmation', () => {
    const r = checkAction({ type: 'click' }, { tag: 'button', inputType: 'submit', inForm: true, label: 'Submit' });
    expect(r.allowed).toBe(true);
    expect(r.requiresConfirm).toBe(true);
  });

  it('login, OTP and payment submits are blocked', () => {
    const r = checkAction({ type: 'click' }, { tag: 'button', inputType: 'submit', inForm: true, label: 'Sign in', formHasProtectedField: true });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/won't click/);
  });

  it('ordinary clicks and steps without a target are fine', () => {
    expect(checkAction({ type: 'click' }, { tag: 'button', inputType: 'button', label: 'Next' })).toEqual({ allowed: true, reason: null, requiresConfirm: false });
    expect(checkAction({ type: 'scroll' }, null).allowed).toBe(true);
    expect(checkAction({ type: 'done' }, null).allowed).toBe(true);
  });

  it('refuses targetless typing and unknown steps', () => {
    expect(checkAction({ type: 'type', value: 'x' }, null).allowed).toBe(false);
    expect(checkAction({ type: 'navigate' }, null).allowed).toBe(false);
  });
});
