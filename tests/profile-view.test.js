// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mountProfileView } from '../src/sidepanel/views/profile-view.js';
import { createStore } from '../src/sidepanel/store.js';

const SAVED = { name: 'Asha Rao', email: 'asha@example.com', skills: ['JS', 'SQL'], links: { github: 'https://github.com/asha' }, gradYear: 2026 };
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(replies = {}) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const store = createStore({ profile: null, connection: 'connected' });
  const sent = [];
  const request = async (type, payload) => {
    sent.push({ type, payload });
    if (type === 'PROFILE_GET') return { type: 'PROFILE_STATE', payload: { profile: SAVED } };
    return replies[type] ?? { type: 'SAVED', payload: { profile: payload.profile, warnings: {} } };
  };
  const view = mountProfileView(root, { store, request });
  /** @param {string} f */
  const field = (f) => root.querySelector(`[data-field="${f}"]`);
  const submit = () => root.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  return { root, store, sent, view, field, submit };
}

describe('profile view (P4.1)', () => {
  it('loads the saved profile into the form, skills as chips', async () => {
    const { root, field } = setup();
    await tick();
    expect(field('name').value).toBe('Asha Rao');
    expect(field('links.github').value).toBe('https://github.com/asha');
    expect(field('gradYear').value).toBe('2026');
    expect([...root.querySelectorAll('.skill-chips .chip')].map((c) => c.firstChild.textContent)).toEqual(['JS', 'SQL']);
  });

  it('adds skills with Enter or comma without duplicates, and removes them', async () => {
    const { root, sent, submit } = setup();
    await tick();
    const skill = root.querySelector('[data-ref="skillInput"]');
    skill.value = 'React, js';
    skill.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    root.querySelector('[aria-label="Remove SQL"]').click();
    submit();
    await tick();
    const save = sent.find((m) => m.type === 'PROFILE_SAVE');
    expect(save.payload.profile.skills).toEqual(['JS', 'React']);
    expect(save.payload.profile.links).toEqual({ linkedin: '', github: 'https://github.com/asha', portfolio: '' });
  });

  it('shows inline errors and keeps the typing when some fields are invalid (EC-PRF-06)', async () => {
    const { root, field, submit } = setup({
      PROFILE_SAVE: { type: 'VALIDATION_ERROR', payload: { errors: { email: 'Enter an email address like name@example.com.' }, warnings: {}, profile: SAVED } }
    });
    await tick();
    field('email').value = 'asha@';
    field('email').dispatchEvent(new Event('input', { bubbles: true }));
    submit();
    await tick();
    expect(field('email').value).toBe('asha@');
    expect(field('email').getAttribute('aria-invalid')).toBe('true');
    expect(root.querySelector('[data-msg="email"]').textContent).toMatch(/name@example.com/);
    expect(root.querySelector('[data-ref="status"]').textContent).toMatch(/other fields were saved/);
  });

  it('does not overwrite unsaved edits with a profile pushed from another window, unless forced', async () => {
    const { store, field, view } = setup();
    await tick();
    field('name').value = 'Typing…';
    field('name').dispatchEvent(new Event('input', { bubbles: true }));
    store.set({ profile: { name: 'Other window' } });
    expect(field('name').value).toBe('Typing…');
    await view.load({ force: true });
    expect(field('name').value).toBe('Asha Rao');
  });

  it('counts the about field', async () => {
    const { root, field } = setup();
    await tick();
    field('about').value = 'hello';
    field('about').dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('[data-ref="aboutCount"]').textContent).toBe('5 / 2,000');
  });
});
