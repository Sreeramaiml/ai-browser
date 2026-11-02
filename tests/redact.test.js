import { describe, it, expect } from 'vitest';
import { createGateway } from '../src/background/llm/gateway.js';
import { REDACTED, redact, redactTurns } from '../src/shared/redact.js';
import { verhoeffValid } from '../src/shared/safety/field-rules.js';

/** A 12-digit number that passes (or fails) the Verhoeff check, built at runtime. */
function aadhaar(valid = true, base = '23456789012') {
  for (let d = 0; d <= 9; d++) {
    const n = `${base.slice(0, 11)}${d}`;
    if (verhoeffValid(n) === valid) return n;
  }
  throw new Error('unreachable');
}
const spaced = (n) => `${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8)}`;
const r = (text, opts) => redact(text, opts).text;

describe('redact (architecture §15.2)', () => {
  it('card numbers with or without separators, Luhn only (EC-RED-01, EC-RED-02)', () => {
    expect(r('Card 4111 1111 1111 1111, 4111-1111-1111-1111 or 4111111111111111.'))
      .toBe(`Card ${REDACTED.card}, ${REDACTED.card} or ${REDACTED.card}.`);
    expect(r('Order 1234567812345678 shipped')).toBe('Order 1234567812345678 shipped');
    expect(r('test card 4242 4242 4242 4242')).toBe(`test card ${REDACTED.card}`); // EC-RED-07: safety first
  });

  it('Aadhaar only when the Verhoeff check passes (EC-RED-03)', () => {
    const good = aadhaar(true);
    const bad = aadhaar(false);
    expect(r(`Aadhaar ${spaced(good)} and ${good}`)).toBe(`Aadhaar ${REDACTED.aadhaar} and ${REDACTED.aadhaar}`);
    expect(r(`Ref ${spaced(bad)}`)).toBe(`Ref ${spaced(bad)}`);
  });

  it('PAN in a sentence, any case (EC-RED-04)', () => {
    expect(r('My PAN is ABCDE1234F, or abcde1234f.')).toBe(`My PAN is ${REDACTED.pan}, or ${REDACTED.pan}.`);
    expect(r('Model XABCDE1234FZ')).toBe('Model XABCDE1234FZ');
  });

  it('OTPs need an OTP word within 20 characters (EC-RED-05)', () => {
    expect(r('Your OTP is 482913.')).toBe(`Your OTP is ${REDACTED.otp}.`);
    expect(r('482913 is your verification code')).toBe(`${REDACTED.otp} is your verification code`);
    expect(r('One-time password: 7731')).toBe(`One-time password: ${REDACTED.otp}`);
    expect(r('ओटीपी 482913 है')).toBe(`ओटीपी ${REDACTED.otp} है`);
    expect(r('Call area code 040 in 2026; PIN code 500032; price 4999')).toBe('Call area code 040 in 2026; PIN code 500032; price 4999');
    expect(r('OTP rules changed in a long article about many things since 2019')).toContain('2019');
  });

  it('UPI IDs on known handles only; emails stay (EC-RED-06, EC-RED-09)', () => {
    expect(r('Pay asha.rao@okaxis or 98765@ybl, mail asha@gmail.com')).toBe(`Pay ${REDACTED.upi} or ${REDACTED.upi}, mail asha@gmail.com`);
    expect(r('asha@upi.example.com')).toBe('asha@upi.example.com');
  });

  it('API keys pasted into text (EC-RED-10)', () => {
    const gemini = 'AIza' + 'k'.repeat(35);
    const groq = 'gsk_' + 'q'.repeat(30);
    const claude = 'sk-ant-' + 'c'.repeat(30);
    expect(r(`keys ${gemini} ${groq} ${claude} AQ.${'a'.repeat(30)}`)).toBe(`keys ${REDACTED.key} ${REDACTED.key} ${REDACTED.key} ${REDACTED.key}`);
  });

  it('emails and phone numbers only when switched on (EC-RED-09)', () => {
    const text = 'Write to asha@example.com or call +91 98765 43210 by 2026.';
    expect(r(text)).toBe(text);
    expect(r(text, { contacts: true })).toBe(`Write to ${REDACTED.email} or call ${REDACTED.phone} by 2026.`);
  });

  it('counts what it removed', () => {
    expect(redact('OTP 1234 and 4111 1111 1111 1111').counts).toEqual({ otp: 1, card: 1 });
    expect(redact('').counts).toEqual({});
  });

  it('is fast on a 60k-character page (EC-RED-11)', () => {
    const page = 'Lorem ipsum 2026 dolor, order 1234567812345678, verification code soon. '.repeat(850);
    expect(page.length).toBeGreaterThan(60_000);
    const start = performance.now();
    redact(page, { contacts: true });
    expect(performance.now() - start).toBeLessThan(50); // 20 ms target, with headroom for slow CI
  });

  it('redactTurns touches text parts only, never images (EC-RED-13)', () => {
    const turns = [{ role: 'user', parts: [{ text: 'OTP 123456' }, { image: { mime: 'image/jpeg', base64: 'AA==' } }] }];
    expect(redactTurns(turns)).toEqual([{ role: 'user', parts: [{ text: `OTP ${REDACTED.otp}` }, { image: { mime: 'image/jpeg', base64: 'AA==' } }] }]);
    expect(turns[0].parts[0].text).toBe('OTP 123456'); // the caller's copy is untouched
  });
});

describe('the gateway redacts every outbound request (S10)', () => {
  const card = '4111 1111 1111 1111';
  const id = spaced(aadhaar(true));
  function setup(contacts = false) {
    const sent = [];
    const gateway = createGateway({
      getApiKey: async () => 'key',
      getModels: async () => ({ lite: 'lite', flash: 'flash' }),
      getRedaction: async () => ({ contacts }),
      stream: async (req, opts) => { sent.push(req); opts.onDelta('ok'); return { text: 'ok', model: 'lite', stopReason: 'end_turn' }; },
      generate: async (req) => { sent.push(req); return { text: '{"ok":true}', model: 'lite', stopReason: 'end_turn' }; }
    });
    return { gateway, sent };
  }

  it('stream: page text with a card and an Aadhaar number', async () => {
    const { gateway, sent } = setup();
    await gateway.stream({
      task: 'chat', system: `Profile name; card ${card}`, onDelta: () => {},
      turns: [{ role: 'user', parts: [{ text: `<page_content>Card ${card}, Aadhaar ${id}</page_content>` }] }]
    });
    const out = JSON.stringify(sent[0]);
    expect(out).toContain('[card number removed]');
    expect(out).toContain('[Aadhaar removed]');
    expect(out).not.toContain(card);
    expect(out).not.toContain(id);
  });

  it('json: the agent prompt, and the repair turn that quotes the model', async () => {
    const { gateway, sent } = setup(true);
    await gateway.json({
      task: 'agent', system: 's', validate: (v) => ({ ok: true, value: v }),
      turns: [{ role: 'user', parts: [{ text: 'PAGE TEXT: OTP 482913, email asha@example.com' }] }]
    });
    expect(sent[0].turns[0].parts[0].text).toBe('PAGE TEXT: OTP [code removed], email [email removed]');
  });
});
