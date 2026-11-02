// @ts-check
// Full-page settings (chrome://extensions → Details → Extension options).

import { ToPanel } from '../shared/messages.js';
import { startClient } from './client.js';
import { createStore } from './store.js';
import { mountSettingsView } from './views/settings-view.js';

const store = createStore({
  /** @type {import('../background/settings-service.js').SettingsState|null} */
  settingsState: null,
  /** @type {import('../shared/storage.js').Profile|null} */
  profile: null,
  /** @type {import('./views/safety-view.js').SafetyState|null} */
  safety: null,
  /** @type {import('./connection.js').ConnectionStatus} */
  connection: 'connecting'
});

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

store.subscribe((s) => s.connection, (status) => {
  $('conn-banner').hidden = status !== 'failed' && status !== 'invalidated';
  $('conn-banner-text').textContent = status === 'invalidated'
    ? 'Pagewise was updated. Reload this page to continue.'
    : "Pagewise's background stopped responding.";
  $('conn-retry').hidden = status !== 'failed';
});

async function boot() {
  const client = await startClient({
    surface: 'options',
    onMessage: (msg) => {
      if (msg.type === ToPanel.SETTINGS_STATE) store.set({ settingsState: msg.payload });
      else if (msg.type === ToPanel.PROFILE_STATE) store.set({ profile: msg.payload?.profile ?? {} });
      else if (msg.type === ToPanel.SAFETY_STATE) store.set({ safety: msg.payload?.safety ?? null });
    },
    onStatus: (connection) => store.set({ connection })
  });
  $('conn-retry').addEventListener('click', () => client.connection.retry());
  mountSettingsView($('settings-root'), { store, request: client.request });
}

boot();
