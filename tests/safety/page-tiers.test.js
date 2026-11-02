import { describe, it, expect } from 'vitest';
import { checkAgentAllowed, checkPage, pageTiers, safetyBadge } from '../../src/shared/safety/policy.js';
import {
  FINANCIAL_DOMAINS, SENSITIVE_DOMAINS, hostMatches, hostOf, isFinancialHost, isSensitiveHost, normalizeDomainInput
} from '../../src/shared/safety/site-rules.js';

const NONE = { hasPasswordField: false, hasCardFields: false, hasOtpField: false, hasUpiField: false, keywords: [], frameHosts: [] };
const tiers = (url, signals = NONE, userBlockedDomains = []) => pageTiers({ url, signals, userBlockedDomains });
const allowed = (t, feature, url = 'https://example.com/', ack = []) => checkPage(t, feature, { url, sensitiveAckDomains: ack }).allowed;
const FEATURES = ['read', 'selection', 'screenshot', 'agent'];

describe('site lists (site-rules.js)', () => {
  it('has about 80 financial domains and the documented sensitive ones', () => {
    expect(FINANCIAL_DOMAINS.length).toBeGreaterThanOrEqual(80);
    for (const d of ['razorpay.com', 'paytm.com', 'phonepe.com', 'pay.google.com', 'paypal.com', 'checkout.stripe.com', 'payu.in', 'billdesk.com']) {
      expect(FINANCIAL_DOMAINS, d).toContain(d);
    }
    for (const d of ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'docs.google.com', 'drive.google.com', 'web.whatsapp.com', 'uidai.gov.in', 'incometax.gov.in', 'digilocker.gov.in']) {
      expect(SENSITIVE_DOMAINS, d).toContain(d);
    }
    expect(new Set(FINANCIAL_DOMAINS).size).toBe(FINANCIAL_DOMAINS.length);
  });

  it.each([
    ['https://netbanking.hdfcbank.com/netbanking/', true], // EC-TIR-01
    ['https://retail.onlinesbi.sbi/retail/login.htm', true],
    ['https://HDFCBANK.COM./', true], // EC-TIR-04
    ['https://www.hdfcbank.com:8443/x', true], // EC-TIR-05: port ignored
    ['https://netbanking.anybank.co.in/', true], // keyword host (§14.2 rule 2)
    ['https://upi.somepsp.com/pay', true],
    ['https://hdfcbank.com.example.net/', false], // EC-TIR-02: anchored, not a substring
    ['https://nothdfcbank.com/', false],
    ['https://sbi-login.xyz/', false],
    ['https://upimagazine.com/', false],
    ['https://192.168.1.10/', false] // raw IP: tier 0 unless signals say otherwise
  ])('%s financial: %s', (url, expected) => {
    expect(isFinancialHost(hostOf(url))).toBe(expected);
  });

  it('normalises punycode hosts before matching (EC-TIR-03)', () => {
    expect(hostOf('https://bücher.example/')).toBe('xn--bcher-kva.example');
  });

  it('matches a domain and its subdomains only', () => {
    expect(hostMatches('a.b.example.com', 'example.com')).toBe(true);
    expect(hostMatches('example.com', 'EXAMPLE.com.')).toBe(true);
    expect(hostMatches('notexample.com', 'example.com')).toBe(false);
    expect(hostMatches('example.com', '')).toBe(false);
    expect(isSensitiveHost('mail.google.com')).toBe(true);
    expect(isSensitiveHost('google.com')).toBe(false);
  });

  it.each([
    ['example.com', 'example.com'],
    ['  WWW.Example.COM ', 'example.com'],
    ['https://shop.example.co.in/path?q=1', 'shop.example.co.in'],
    ['asha.github.io', 'asha.github.io']
  ])('accepts %j as %s', (raw, domain) => {
    expect(normalizeDomainInput(raw)).toEqual({ ok: true, domain });
  });

  it.each(['', '*', '*.example.com', 'com', 'co.in', 'github.io', 'localhost', '192.168.1.1', 'exa mple.com', '-bad-.com', 42])(
    'refuses %j (EC-TIR-12)', (raw) => {
      expect(normalizeDomainInput(raw).ok).toBe(false);
    }
  );
});

describe('pageTiers (architecture §14.2, highest match wins)', () => {
  it('a normal page is tier 0', () => {
    expect(tiers('https://en.wikipedia.org/wiki/India')).toEqual({ read: 0, act: 0, reason: null });
  });

  it('banks and gateways are tier 3 for everything', () => {
    expect(tiers('https://www.onlinesbi.sbi/')).toEqual({ read: 3, act: 3, reason: 'financial' });
    expect(tiers('https://checkout.stripe.com/c/pay/cs_test')).toEqual({ read: 3, act: 3, reason: 'financial' });
  });

  it('the user blocklist is tier 3 and covers subdomains (EC-TIR-17)', () => {
    expect(tiers('https://news.example.com/a', NONE, ['example.com'])).toMatchObject({ read: 3, act: 3, reason: 'blocked' });
  });

  it('private sites are tier 2 (EC-TIR-08, EC-TIR-15)', () => {
    expect(tiers('https://mail.google.com/mail/u/0/')).toEqual({ read: 2, act: 2, reason: 'sensitive' });
    expect(tiers('https://www.digilocker.gov.in/')).toMatchObject({ read: 2, act: 2 });
  });

  it('card, OTP and UPI signals: tier 2 for reading, tier 3 for acting', () => {
    for (const s of [{ hasCardFields: true }, { hasOtpField: true }, { hasUpiField: true }, { keywords: ['net banking'] }]) {
      expect(tiers('https://shop.example.com/', { ...NONE, ...s })).toEqual({ read: 2, act: 3, reason: 'payment-fields' });
    }
  });

  it('a look-alike bank page is caught by its signals (EC-TIR-02)', () => {
    expect(tiers('https://hdfcbank.com.example.net/', { ...NONE, hasPasswordField: true, keywords: ['net banking'] })).toMatchObject({ read: 2, act: 3 });
  });

  it('a login form is tier 2 for reading only (EC-TIR-14)', () => {
    expect(tiers('https://forum.example.com/login', { ...NONE, hasPasswordField: true })).toEqual({ read: 2, act: 0, reason: 'login' });
  });

  it('a page that couldn\'t be checked fails closed (EC-TIR-19)', () => {
    expect(tiers('https://example.com/', null)).toEqual({ read: 2, act: 3, reason: 'unchecked' });
  });

  it('the strongest reason explains a page that matches several rules', () => {
    expect(tiers('https://mail.google.com/', { ...NONE, hasPasswordField: true }).reason).toBe('sensitive');
    expect(tiers('https://paytm.com/', { ...NONE, hasPasswordField: true }, ['paytm.com']).reason).toBe('blocked');
  });
});

describe('checkPage: which feature runs where', () => {
  // [page, read, selection, screenshot, agent]
  const MATRIX = [
    ['tier 0', tiers('https://example.com/'), [true, true, true, true]],
    ['tier 2 (private)', tiers('https://mail.google.com/'), [false, false, false, false]],
    ['tier 2 (login)', tiers('https://forum.example.com/', { ...NONE, hasPasswordField: true }), [false, false, false, true]],
    ['card fields', tiers('https://shop.example.com/', { ...NONE, hasCardFields: true }), [false, false, false, false]],
    ['tier 3 (bank)', tiers('https://hdfcbank.com/'), [false, false, false, false]],
    ['unchecked', tiers('https://example.com/', null), [false, false, false, false]]
  ];
  for (const [name, t, expected] of MATRIX) {
    it(`${name}: ${FEATURES.map((f, i) => `${f}=${expected[i]}`).join(', ')}`, () => {
      expect(FEATURES.map((f) => allowed(t, f))).toEqual(expected);
    });
  }

  it('a private page asks once, then lets only the selection through (EC-TIR-09)', () => {
    const gmail = tiers('https://mail.google.com/mail/u/0/');
    const first = checkPage(gmail, 'selection', { url: 'https://mail.google.com/mail/u/0/', sensitiveAckDomains: [] });
    expect(first).toMatchObject({ allowed: false, code: 'NEEDS_ACK', domain: 'mail.google.com' });
    expect(first.message).toMatch(/Only the text you selected/);
    expect(checkPage(gmail, 'selection', { url: 'https://mail.google.com/x', sensitiveAckDomains: ['mail.google.com'] }))
      .toEqual({ allowed: true, scope: 'selection-only' });
    // The acknowledgment never opens anything else on that site.
    expect(allowed(gmail, 'read', 'https://mail.google.com/', ['mail.google.com'])).toBe(false);
  });

  it('tier 3 has no override, not even an acknowledgment', () => {
    expect(checkPage(tiers('https://paytm.com/'), 'selection', { url: 'https://paytm.com/', sensitiveAckDomains: ['paytm.com'] }))
      .toMatchObject({ allowed: false, code: 'PAGE_BLOCKED' });
  });

  it('explains every refusal in plain words', () => {
    expect(checkPage(tiers('https://hdfcbank.com/'), 'read', { url: '' }).message)
      .toBe('Pagewise is switched off on payment and banking pages to keep your money safe.');
    expect(checkPage(tiers('https://mail.google.com/'), 'read', { url: '' }).message).toMatch(/private content.*right-click/);
    expect(checkPage(tiers('https://mail.google.com/'), 'agent', { url: '' }).message).toMatch(/agent doesn't run on private pages/);
    expect(checkPage(tiers('https://x.com/', NONE, ['x.com']), 'read', { url: '' }).message).toMatch(/Settings → Safety/);
    expect(checkPage(tiers('https://x.com/', null), 'read', { url: '' }).message).toMatch(/couldn't check/);
  });
});

describe('safetyBadge', () => {
  it('🟢 / 🟡 / 🔴', () => {
    expect(safetyBadge(tiers('https://example.com/')).level).toBe('ok');
    expect(safetyBadge(tiers('https://mail.google.com/')).level).toBe('sensitive');
    expect(safetyBadge(tiers('https://forum.example.com/', { ...NONE, hasPasswordField: true })).level).toBe('sensitive');
    expect(safetyBadge(tiers('https://onlinesbi.sbi/'))).toEqual({
      level: 'blocked', label: 'Pagewise is switched off on payment and banking pages to keep your money safe.'
    });
    expect(safetyBadge(tiers('https://shop.example.com/', { ...NONE, hasCardFields: true })).level).toBe('blocked');
  });
});

describe('safety acceptance matrix (P4.3), unit level', () => {
  it('S1/S2: bank login and payment checkout block summary, chat, screenshot and agent', () => {
    for (const url of ['https://retail.onlinesbi.sbi/retail/login.htm', 'https://checkout.stripe.com/pay/cs_test_123']) {
      const t = tiers(url, { ...NONE, hasPasswordField: true, hasCardFields: true });
      expect(FEATURES.map((f) => allowed(t, f, url))).toEqual([false, false, false, false]);
      expect(safetyBadge(t).level).toBe('blocked');
    }
  });

  it('S7/S8: Gmail blocks Summarise; a selection needs the one-time acknowledgment', () => {
    const t = tiers('https://mail.google.com/mail/u/0/#inbox');
    expect(allowed(t, 'read')).toBe(false);
    expect(checkPage(t, 'selection', { url: 'https://mail.google.com/mail/u/0/' }).code).toBe('NEEDS_ACK');
  });

  it('S9: the agent refuses wikipedia.org (not owned), and an owned bank is still tier 3 (EC-TIR-11)', () => {
    expect(checkAgentAllowed('https://en.wikipedia.org/wiki/India').allowed).toBe(false);
    expect(checkAgentAllowed('https://hdfcbank.com/', { ownedDomains: ['hdfcbank.com'] }).allowed).toBe(true); // the list says yes…
    expect(allowed(tiers('https://hdfcbank.com/'), 'agent')).toBe(false); // …the tier says no, and the tier wins
  });
});
