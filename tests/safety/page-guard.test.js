import { describe, it, expect } from 'vitest';
import { NO_SIGNALS, createPageGuard } from '../../src/background/page-guard.js';
import { createSafetyService } from '../../src/background/safety-service.js';
import { SCHEMA_VERSION, createStorage } from '../../src/shared/storage.js';

function guardFor({ url = 'https://example.com/', signals = NO_SIGNALS, safety = {} } = {}) {
  return createPageGuard({
    getUrl: async () => url,
    getSignals: async () => signals,
    getSafety: async () => ({ userBlockedDomains: [], sensitiveAckDomains: [], ...safety })
  });
}
const codeOf = (p) => p.then(() => null, (err) => err.code);

describe('page guard (every feature entry point)', () => {
  it('lets a normal page through for every feature', async () => {
    const guard = guardFor();
    for (const f of ['read', 'selection', 'screenshot', 'agent']) expect(await guard.assert(7, f)).toEqual({ allowed: true, scope: 'page' });
  });

  it('refuses a bank page with the friendly copy', async () => {
    const err = await guardFor({ url: 'https://netbanking.hdfcbank.com/' }).assert(7, 'read').catch((e) => e);
    expect(err).toMatchObject({ code: 'PAGE_BLOCKED', message: 'Pagewise is switched off on payment and banking pages to keep your money safe.' });
    expect(err.toPayload()).toMatchObject({ tier: 3, retryable: false });
  });

  it('fails closed when the page couldn\'t be asked (EC-TIR-19)', async () => {
    const guard = guardFor({ signals: null });
    expect(await codeOf(guard.assert(7, 'read'))).toBe('PAGE_BLOCKED');
    expect(await codeOf(guard.assert(7, 'agent'))).toBe('PAGE_BLOCKED');
  });

  it('a private page asks for the acknowledgment, then allows the selection only', async () => {
    const err = await guardFor({ url: 'https://mail.google.com/mail/u/0/' }).assert(7, 'selection').catch((e) => e);
    expect(err.toPayload()).toMatchObject({ code: 'NEEDS_ACK', domain: 'mail.google.com' });
    const acked = guardFor({ url: 'https://mail.google.com/mail/u/0/', safety: { sensitiveAckDomains: ['mail.google.com'] } });
    expect(await acked.assert(7, 'selection')).toEqual({ allowed: true, scope: 'selection-only' });
    expect(await codeOf(acked.assert(7, 'read'))).toBe('PAGE_BLOCKED');
  });

  it('re-checks the page each time, so a payment box that opens later is caught (EC-TIR-07)', async () => {
    let signals = NO_SIGNALS;
    const guard = createPageGuard({ getUrl: async () => 'http://localhost:3000/shop/', getSignals: async () => signals, getSafety: async () => ({ userBlockedDomains: [], sensitiveAckDomains: [] }) });
    expect((await guard.check(7, 'agent')).verdict.allowed).toBe(true);
    signals = { ...NO_SIGNALS, hasCardFields: true };
    expect((await guard.check(7, 'agent')).verdict.allowed).toBe(false);
  });

  it('assertUrl judges a link by its address alone', async () => {
    const guard = guardFor({ safety: { userBlockedDomains: ['youtube.com'] } });
    expect(await guard.assertUrl('https://youtu.be/dQw4w9WgXcQ', 'read')).toEqual({ allowed: true, scope: 'page' });
    expect(await codeOf(guard.assertUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'read'))).toBe('PAGE_BLOCKED');
  });

  it('badge', async () => {
    expect((await guardFor().badge(7)).level).toBe('ok');
    expect((await guardFor({ url: 'https://paytm.com/' }).badge(7)).level).toBe('blocked');
  });
});

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
function memoryArea(initial = {}) {
  const data = clone(initial);
  return {
    data,
    async get(keys) { const out = {}; for (const k of [].concat(keys)) if (k in data) out[k] = clone(data[k]); return out; },
    async set(items) { Object.assign(data, clone(items)); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; }
  };
}

describe('Settings → Safety (safety service)', () => {
  const setup = (safety) => {
    const area = memoryArea({ schemaVersion: SCHEMA_VERSION, ...(safety ? { safety } : {}) });
    return { area, service: createSafetyService(createStorage(area)) };
  };
  const err = (reply) => reply.payload.errors?.domain;

  it('blocks a site, cleaned up', async () => {
    const { area, service } = setup();
    const reply = await service.update({ list: 'userBlockedDomains', action: 'add', domain: 'https://WWW.Example.com/page' });
    expect(reply.type).toBe('SAFETY_STATE');
    expect(area.data.safety.userBlockedDomains).toEqual(['example.com']);
  });

  it('an owned site needs "I own or control this site" (§14.3)', async () => {
    const { area, service } = setup();
    expect(err(await service.update({ list: 'ownedDomains', action: 'add', domain: 'mysite.dev' }))).toMatch(/I own or control/);
    await service.update({ list: 'ownedDomains', action: 'add', domain: 'mysite.dev', confirmOwned: true });
    expect(area.data.safety.ownedDomains).toEqual(['mysite.dev']);
  });

  it('refuses banks, private sites and bare suffixes as owned (EC-TIR-11, EC-TIR-12)', async () => {
    const { area, service } = setup();
    expect(err(await service.update({ list: 'ownedDomains', action: 'add', domain: 'netbanking.hdfcbank.com', confirmOwned: true }))).toMatch(/Banking/);
    expect(err(await service.update({ list: 'ownedDomains', action: 'add', domain: 'mail.google.com', confirmOwned: true }))).toMatch(/Private/);
    expect(err(await service.update({ list: 'ownedDomains', action: 'add', domain: '*.com', confirmOwned: true }))).toMatch(/Wildcards/);
    expect(err(await service.update({ list: 'ownedDomains', action: 'add', domain: 'github.io', confirmOwned: true }))).toMatch(/shared/);
    expect(area.data.safety).toBeUndefined();
  });

  it('acknowledges a private site, and revokes it (EC-TIR-10)', async () => {
    const { area, service } = setup();
    await service.acknowledge({ domain: 'mail.google.com' });
    await service.acknowledge({ domain: 'mail.google.com' }); // no duplicates
    expect(area.data.safety.sensitiveAckDomains).toEqual(['mail.google.com']);
    await service.update({ list: 'sensitiveAckDomains', action: 'remove', domain: 'mail.google.com' });
    expect(area.data.safety.sensitiveAckDomains).toEqual([]);
  });

  it('rejects unknown lists and actions', async () => {
    const { service } = setup();
    expect((await service.update({ list: 'settings', action: 'add', domain: 'x.com' })).type).toBe('VALIDATION_ERROR');
    expect((await service.update({ list: 'ownedDomains', action: 'wipe' })).type).toBe('VALIDATION_ERROR');
  });
});
