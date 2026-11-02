// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mountSafetyView } from '../../src/sidepanel/views/safety-view.js';
import { createStore } from '../../src/sidepanel/store.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const SAFETY = { userBlockedDomains: ['<img src=x onerror=alert(1)>.com'], ownedDomains: [], sensitiveAckDomains: ['mail.google.com'] };

function setup(replies = {}) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const store = createStore({ safety: null, settingsState: { settings: { redactContacts: false }, readOnly: false }, connection: 'connected' });
  const sent = [];
  const request = async (type, payload) => {
    sent.push({ type, payload });
    if (type === 'SAFETY_GET') return { type: 'SAFETY_STATE', payload: { safety: SAFETY } };
    return replies[type]?.(payload) ?? { type: 'SAFETY_STATE', payload: { safety: SAFETY } };
  };
  mountSafetyView(root, { store, request });
  return { root, store, sent, $: (s) => root.querySelector(s) };
}

describe('Settings → Safety view (P4.3)', () => {
  it('lists domains as text only', async () => {
    const { root } = setup();
    await tick();
    expect(root.querySelector('[data-list="userBlockedDomains"] code').textContent).toBe('<img src=x onerror=alert(1)>.com');
    expect(root.querySelectorAll('img')).toHaveLength(0);
    expect(root.querySelector('[data-list="ownedDomains"]').textContent).toMatch(/No sites added/);
  });

  it('sends the "I own or control this site" confirmation with an owned site', async () => {
    const { $, sent } = setup({
      SAFETY_UPDATE: (p) => (p.confirmOwned ? { type: 'SAFETY_STATE', payload: { safety: SAFETY } } : { type: 'VALIDATION_ERROR', payload: { errors: { domain: 'Tick "I own or control this site" to add it.' } } })
    });
    await tick();
    const form = $('[data-add="ownedDomains"]');
    form.querySelector('input[type="text"]').value = 'mysite.dev';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect($('[data-ref="status"]').textContent).toMatch(/I own or control/);
    $('[data-ref="ownConfirm"]').checked = true;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(sent.filter((m) => m.type === 'SAFETY_UPDATE').map((m) => m.payload)).toEqual([
      { list: 'ownedDomains', action: 'add', domain: 'mysite.dev', confirmOwned: false },
      { list: 'ownedDomains', action: 'add', domain: 'mysite.dev', confirmOwned: true }
    ]);
  });

  it('revokes a private-site acknowledgment (EC-TIR-10)', async () => {
    const { $, sent } = setup();
    await tick();
    $('[aria-label="Revoke mail.google.com"]').click();
    await tick();
    expect(sent.at(-1)).toEqual({ type: 'SAFETY_UPDATE', payload: { list: 'sensitiveAckDomains', action: 'remove', domain: 'mail.google.com' } });
  });

  it('switches on hiding emails and phone numbers (EC-RED-09)', async () => {
    const { $, sent } = setup({ SETTINGS_SAVE: () => ({ type: 'SAVED', payload: { state: { settings: { redactContacts: true }, readOnly: false } } }) });
    await tick();
    const box = $('[data-ref="redactContacts"]');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await tick();
    expect(sent.at(-1)).toEqual({ type: 'SETTINGS_SAVE', payload: { settings: { redactContacts: true } } });
    expect($('[data-ref="redactContacts"]').checked).toBe(true);
  });
});
