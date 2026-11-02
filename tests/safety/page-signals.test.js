// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { checkPage, pageTiers } from '../../src/shared/safety/policy.js';

let signals;

beforeAll(async () => {
  globalThis.__pagewise = { handlers: {} };
  await import('../../src/content/generated/field-rules.classic.js');
  await import('../../src/content/extractor.js');
  signals = () => globalThis.__pagewise.handlers.CS_PAGE_SIGNALS();
});

/** @param {string} html @param {string} [title] */
function load(html, title = 'Page') {
  document.title = title;
  document.body.innerHTML = html;
  return signals();
}

/** A practice page's body, as served. @param {string} path */
function practice(path) {
  const html = readFileSync(`practice/${path}`, 'utf8');
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '';
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return load(body.replace(/<script[\s\S]*?<\/script>/gi, ''), title);
}

const tiersOf = (s, url = 'http://localhost:3000/x/') => pageTiers({ url, signals: s });

describe('CS_PAGE_SIGNALS (architecture §14.2)', () => {
  it('registers the handler', () => {
    expect(typeof globalThis.__pagewise.handlers.CS_PAGE_SIGNALS).toBe('function');
  });

  it('finds card, OTP, UPI and password fields on the practice safety pages', () => {
    expect(practice('safety/card.html')).toMatchObject({ hasCardFields: true });
    expect(practice('safety/otp.html')).toMatchObject({ hasOtpField: true });
    expect(practice('safety/upi.html')).toMatchObject({ hasUpiField: true });
    expect(practice('safety/login.html')).toMatchObject({ hasPasswordField: true, hasCardFields: false });
  });

  it('the practice errand pages stay tier 0, so the agent can run there', () => {
    for (const page of ['internship/index.html', 'shop/index.html', 'directory/index.html', 'index.html', 'safety/index.html']) {
      expect(tiersOf(practice(page)), page).toEqual({ read: 0, act: 0, reason: null });
    }
  });

  it('S3/S5: card and OTP pages are off-limits to the agent and screenshots; S4: a login page only to reading', () => {
    const card = tiersOf(practice('safety/card.html'));
    expect(checkPage(card, 'agent', { url: 'http://localhost:3000/safety/card.html' }).allowed).toBe(false);
    expect(checkPage(card, 'screenshot', { url: 'http://localhost:3000/' }).allowed).toBe(false);
    const login = tiersOf(practice('safety/login.html'));
    expect(login).toMatchObject({ read: 2, act: 0, reason: 'login' });
    expect(checkPage(login, 'read', { url: 'http://localhost:3000/' }).allowed).toBe(false);
    expect(checkPage(login, 'agent', { url: 'http://localhost:3000/' }).allowed).toBe(true); // its fields and submit are blocked per action
  });

  it('banking words count in headings and labels of a page with fields', () => {
    const s = load('<h1>Net Banking login</h1><label for="u">Customer ID</label><input id="u">');
    expect(s.keywords).toEqual(['net banking']);
    expect(tiersOf(s)).toMatchObject({ read: 2, act: 3, reason: 'payment-fields' });
  });

  it('an article about UPI or OTPs, with no fields, stays tier 0 (EC-TIR-16)', () => {
    const s = load('<h1>How UPI PIN and OTP security works</h1><p>Never share your UPI PIN or enter OTP on calls. Your card number…</p>');
    expect(s.keywords).toEqual([]);
    expect(tiersOf(s, 'https://news.example.com/upi')).toEqual({ read: 0, act: 0, reason: null });
  });

  it('a newsletter box on an article doesn\'t make its body text count', () => {
    const s = load('<h1>Budget 2026</h1><p>Debit card and credit card rules changed.</p><label for="e">Your email</label><input id="e" type="email">');
    expect(s.keywords).toEqual([]);
  });

  it('a payment iframe is reported by host (EC-TIR-06)', () => {
    const s = load('<h1>Shop</h1><iframe src="https://api.razorpay.com/v1/checkout/embedded"></iframe><iframe src="/local"></iframe>');
    expect(s.frameHosts).toContain('api.razorpay.com');
    expect(tiersOf(s, 'https://shop.example.com/')).toMatchObject({ read: 3, act: 3, reason: 'financial-frame' });
  });

  it('hidden fields don\'t count (EC-TIR-14 is about a visible password field)', () => {
    const s = load(`
      <input type="hidden" name="password">
      <div hidden><input type="password"></div>
      <div style="display:none"><input autocomplete="cc-number"></div>
      <template><input type="password"></template>`);
    expect(s).toMatchObject({ hasPasswordField: false, hasCardFields: false });
  });

  it('a Hindi OTP label counts', () => {
    expect(load('<label for="o">ओटीपी दर्ज करें</label><input id="o" inputmode="numeric" maxlength="6">').hasOtpField).toBe(true);
  });

  it('a "PIN code" (postal) field is not an OTP (EC-FLD benign)', () => {
    expect(load('<label for="p">PIN code</label><input id="p" inputmode="numeric" maxlength="6">')).toMatchObject({ hasOtpField: false, keywords: [] });
  });
});
