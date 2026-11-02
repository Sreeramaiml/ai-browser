// @ts-check
// Header EN | Hinglish toggle, bound to settings.language and saved through the service worker.
// Applies to new answers only; existing cards keep their language and offer ⇄ (EC-LNG-03, EC-LNG-04).

import { ToPanel, ToSW } from '../../shared/messages.js';

/**
 * @param {HTMLElement} group the `.lang` button group in the header
 * @param {{
 *   store: import('../store.js').Store<{ settingsState: import('../../background/settings-service.js').SettingsState|null }>,
 *   request: (type: string, payload?: any) => Promise<import('../../shared/messages.js').Message>
 * }} deps
 */
export function mountLangToggle(group, { store, request }) {
  const buttons = /** @type {HTMLButtonElement[]} */ ([...group.querySelectorAll('button[data-lang]')]);

  store.subscribe((s) => s.settingsState?.settings?.language ?? 'en', (lang) => {
    for (const btn of buttons) btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang));
  });

  for (const btn of buttons) {
    btn.addEventListener('click', async () => {
      const state = store.get().settingsState;
      const lang = btn.dataset.lang;
      if (!state || state.settings.language === lang) return;
      // Optimistic: flip now; the SETTINGS_STATE broadcast confirms (or corrects) it.
      store.set({ settingsState: { ...state, settings: { ...state.settings, language: lang } } });
      try {
        const reply = await request(ToSW.SETTINGS_SAVE, { settings: { language: lang } });
        if (reply.type !== ToPanel.SAVED) store.set({ settingsState: state });
      } catch {
        store.set({ settingsState: state });
      }
    });
  }
}
