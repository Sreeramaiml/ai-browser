// @ts-check
// Settings view: Gemini and Groq keys (save / test / replace / remove), the Groq backup switch,
// preferences, the profile (P4.1), safety lists (P4.3), the agent logs (P3.6), "Clear all my data" (P4.1), and a
// developer-only fault switch. Shared by the side panel and the options page.
// Writes always go through the service worker, except the dev fault, which is session-only.

import { DEV_FAULT_KEY, GEMINI_KEY_URL, GROQ_KEY_URL, LANGUAGES, TONES, TRANSLATE_TARGETS } from '../../shared/config.js';
import { ToPanel, ToSW } from '../../shared/messages.js';
import { mountLogView } from './log-view.js';
import { mountProfileView } from './profile-view.js';
import { mountSafetyView } from './safety-view.js';

/** @typedef {import('../../background/settings-service.js').SettingsState} SettingsState */
/** @typedef {(type: string, payload?: any) => Promise<import('../../shared/messages.js').Message>} Request */
/** @typedef {'gemini'|'groq'} Provider */

/**
 * The markup for one key card. Refs inside are looked up within the card, so both cards share them.
 * @param {{ provider: Provider, heading: string, hint: string, placeholder: string, extra?: string }} c
 */
const keyCard = (c) => /* html */ `
    <section class="card" data-card="${c.provider}" aria-labelledby="${c.provider}-heading">
      <h3 id="${c.provider}-heading">${c.heading}</h3>
      <p class="hint">${c.hint}</p>

      <div class="saved-key" data-ref="saved" hidden>
        <span>Saved key: <code data-ref="masked"></code></span>
        <div class="row">
          <button type="button" data-ref="testSaved">Test key</button>
          <button type="button" class="secondary" data-ref="replace">Replace</button>
          <button type="button" class="secondary danger" data-ref="remove">Remove</button>
        </div>
      </div>

      <form data-ref="form" autocomplete="off" hidden>
        <label for="${c.provider}-input">Paste your key</label>
        <div class="key-input">
          <input id="${c.provider}-input" data-ref="input" type="password" spellcheck="false" autocapitalize="off"
                 autocomplete="off" placeholder="${c.placeholder}" aria-describedby="${c.provider}-status" />
          <button type="button" class="secondary" data-ref="toggle" aria-pressed="false" aria-label="Show key">Show</button>
        </div>
        <div class="row">
          <button type="submit" data-ref="save">Save key</button>
          <button type="button" class="secondary" data-ref="testNew">Test without saving</button>
          <button type="button" class="secondary" data-ref="cancel" hidden>Cancel</button>
        </div>
      </form>

      <p id="${c.provider}-status" class="status" role="status" data-ref="keyStatus"></p>
      <p class="status warn" data-ref="keyWarning" hidden></p>
      ${c.extra ?? ''}
    </section>`;

const TEMPLATE = /* html */ `
  <div class="settings">
    <h2>Settings</h2>
    <p class="notice" data-ref="readonly" hidden>
      This data was saved by a newer version of Pagewise, so settings can't be changed here. Update Pagewise to edit them.
    </p>
${keyCard({
    provider: 'gemini',
    heading: 'Gemini API key',
    hint: "Pagewise uses your own free key from Google AI Studio. It's stored only on this device and sent only to Google. " +
      `<a href="${GEMINI_KEY_URL}" target="_blank" rel="noopener noreferrer">Get a free key</a>`,
    placeholder: 'AQ.… or AIza…'
  })}
${keyCard({
    provider: 'groq',
    heading: 'Groq API key <span class="chip">Optional</span>',
    hint: 'A free, text-only backup that Pagewise uses when Gemini is busy or out of quota. Screenshots and YouTube ' +
      "still need Gemini. It's stored only on this device and sent only to Groq. " +
      `<a href="${GROQ_KEY_URL}" target="_blank" rel="noopener noreferrer">Get a free key</a>`,
    placeholder: 'gsk_…',
    extra: '<label class="check" data-ref="enabledRow" hidden><input type="checkbox" data-ref="enabled" /> Use Groq when Gemini is busy</label>'
  })}

    <section class="card" aria-labelledby="prefs-heading">
      <h3 id="prefs-heading">Preferences</h3>
      <label for="pref-language">Response language</label>
      <select id="pref-language" data-ref="language" data-setting="language"></select>
      <label for="pref-translate">Translate into</label>
      <select id="pref-translate" data-ref="translateTarget" data-setting="translateTarget"></select>
      <label for="pref-tone">Tone for drafted replies</label>
      <select id="pref-tone" data-ref="tone" data-setting="tone"></select>
      <p class="status" role="status" data-ref="prefsStatus"></p>
    </section>

    <section class="card" id="profile" aria-labelledby="profile-heading">
      <h3 id="profile-heading">Profile</h3>
      <p class="hint">Kept only on this device. With "Use my profile" ticked, the agent fills forms from it, and you see
        every value before it's typed. Drafted replies use your name and tone. It's never sent with page chat,
        summaries or screenshots. All fields are optional.</p>
      <div data-ref="profileRoot"></div>
    </section>

    <section class="card" id="safety" aria-labelledby="safety-heading">
      <h3 id="safety-heading">Safety</h3>
      <div data-ref="safetyRoot"></div>
    </section>

    <section class="card" aria-labelledby="logs-heading">
      <h3 id="logs-heading">Agent logs</h3>
      <p class="hint">Every step of the agent's last 20 tasks, with what you decided. Kept only on this device.</p>
      <details data-ref="logs">
        <summary>Show logs</summary>
        <div data-ref="logsRoot"></div>
      </details>
    </section>

    <section class="card" aria-labelledby="data-heading">
      <h3 id="data-heading">Your data</h3>
      <p class="hint">Everything Pagewise keeps stays on this device. There's no Pagewise server.</p>
      <div class="row">
        <button type="button" class="secondary danger" data-ref="clearAll" aria-expanded="false" aria-controls="clear-confirm">Clear all my data…</button>
      </div>
      <div class="confirm-box" id="clear-confirm" data-ref="clearConfirm" role="group" aria-labelledby="clear-title" hidden>
        <p id="clear-title"><strong>Delete all your Pagewise data on this device?</strong></p>
        <ul>
          <li>Your profile</li>
          <li>Saved skills</li>
          <li>Agent tasks and logs (a running task is stopped first)</li>
          <li>Page chat history and saved summaries</li>
          <li>Your Gemini and Groq API keys</li>
        </ul>
        <p class="hint">Your preferences and the sites you've added as your own are kept. This can't be undone.</p>
        <div class="row">
          <button type="button" class="danger-solid" data-ref="clearYes">Delete everything</button>
          <button type="button" class="secondary" data-ref="clearNo">Cancel</button>
        </div>
      </div>
      <p class="status" role="status" data-ref="clearStatus"></p>
    </section>

    <section class="card" aria-labelledby="advanced-heading" data-ref="advanced" hidden>
      <h3 id="advanced-heading">Advanced <span class="chip">Developer</span></h3>
      <p class="hint">Force an error on the next AI request to check retries, fallback and error messages. Only in an unpacked install.</p>
      <label for="dev-fault">Next request gets</label>
      <select id="dev-fault" data-ref="fault">
        <option value="429">429 rate limit on every Gemini model</option>
        <option value="500">500 server error on every Gemini model</option>
        <option value="timeout">Timeout on every Gemini model</option>
        <option value="daily">Daily quota used up</option>
      </select>
      <div class="row"><button type="button" data-ref="arm">Arm for next request</button></div>
      <p class="status" role="status" data-ref="faultStatus"></p>
    </section>
  </div>
`;

/** Copy that differs between the two key cards. */
const PROVIDER_COPY = {
  gemini: { name: 'Google', removeLast: 'Key removed.' },
  groq: { name: 'Groq', removeLast: 'Key removed. Groq backup is off.' }
};

/**
 * @param {HTMLElement} root
 * @param {{
 *   store: import('../store.js').Store<{
 *     settingsState: SettingsState|null,
 *     profile: import('../../shared/storage.js').Profile|null,
 *     safety: import('./safety-view.js').SafetyState|null,
 *     connection: import('../connection.js').ConnectionStatus
 *   }>,
 *   request: Request
 * }} deps
 */
export function mountSettingsView(root, { store, request }) {
  root.innerHTML = TEMPLATE; // static markup only; all dynamic values are set via textContent/value below
  /** @param {string} name @returns {any} */
  const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
  const selects = /** @type {HTMLSelectElement[]} */ (['language', 'translateTarget', 'tone'].map(ref));

  fillSelect(ref('language'), LANGUAGES);
  fillSelect(ref('translateTarget'), TRANSLATE_TARGETS);
  fillSelect(ref('tone'), TONES);

  /**
   * @param {'prefsStatus'|'faultStatus'|'clearStatus'} name
   * @param {string} text
   * @param {'ok'|'warn'|'error'|''} [tone]
   */
  function setStatus(name, text, tone = '') {
    const el = ref(name);
    el.textContent = text;
    el.className = `status ${tone}`.trim();
  }

  /**
   * Save / test / replace / remove for one provider's key.
   * @param {Provider} provider
   */
  function mountKeyCard(provider) {
    const card = /** @type {HTMLElement} */ (root.querySelector(`[data-card="${provider}"]`));
    /** @param {string} name @returns {any} */
    const cref = (name) => card.querySelector(`[data-ref="${name}"]`);
    const input = /** @type {HTMLInputElement} */ (cref('input'));
    const copy = PROVIDER_COPY[provider];

    /** User clicked Replace on a saved key. */
    let replacing = false;
    let busy = false;
    let removeArmed = false;
    let removeTimer = 0;

    /** @param {string} text @param {'ok'|'warn'|'error'|''} [tone] */
    function setStatus(text, tone = '') {
      const el = cref('keyStatus');
      el.textContent = text;
      el.className = `status ${tone}`.trim();
    }

    function setWarning(text) {
      cref('keyWarning').textContent = text ?? '';
      cref('keyWarning').hidden = !text;
    }

    function render() {
      const state = store.get().settingsState;
      // Tolerate a state shape from a different build (e.g. right after an update) instead of crashing.
      const status = state?.secrets?.[provider] ?? { saved: false, masked: null };
      const saved = Boolean(status.saved);
      const readOnly = Boolean(state?.readOnly);
      const editing = !saved || replacing;

      cref('saved').hidden = editing;
      cref('form').hidden = !editing;
      cref('cancel').hidden = !(saved && replacing);
      cref('masked').textContent = status.masked ?? '';

      for (const name of ['testSaved', 'replace', 'remove', 'save', 'testNew', 'toggle']) {
        cref(name).disabled = busy || (readOnly && !['testSaved', 'testNew', 'toggle'].includes(name));
      }
      input.disabled = readOnly;

      const enabledRow = cref('enabledRow');
      if (enabledRow) {
        enabledRow.hidden = !saved;
        const box = /** @type {HTMLInputElement} */ (cref('enabled'));
        box.checked = Boolean(state?.settings?.groqEnabled);
        box.disabled = busy || readOnly;
      }
    }

    /** @param {import('../../shared/messages.js').Message} reply */
    function showKeyTestResult(reply) {
      if (reply.type === ToPanel.KEY_TEST_RESULT) {
        const r = reply.payload;
        setStatus(r.message, r.ok ? 'ok' : r.code === 'RATE_LIMITED' ? 'warn' : 'error');
        setWarning(r.ok ? r.warning : '');
      } else {
        setStatus(reply.payload?.message ?? 'Something went wrong. Please try again.', 'error');
        setWarning('');
      }
    }

    /** @param {() => Promise<void>} fn */
    async function withBusy(fn) {
      busy = true;
      render();
      try {
        await fn();
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'Something went wrong.', 'error');
      } finally {
        busy = false;
        render();
      }
    }

    /** @param {string|undefined} typedKey */
    async function testKey(typedKey) {
      setStatus('Testing…');
      setWarning('');
      const payload = typedKey === undefined ? { provider } : { provider, key: typedKey };
      showKeyTestResult(await request(ToSW.TEST_KEY, payload));
    }

    cref('form').addEventListener('submit', (event) => {
      event.preventDefault();
      withBusy(async () => {
        setStatus('Saving…');
        setWarning('');
        const reply = await request(ToSW.SETTINGS_SAVE, { secrets: { [provider]: input.value } });
        if (reply.type === ToPanel.SAVED) {
          input.value = '';
          replacing = false;
          store.set({ settingsState: reply.payload.state });
          await testKey(undefined); // confirm the saved key works straight away
        } else if (reply.type === ToPanel.VALIDATION_ERROR) {
          setStatus(reply.payload.errors[`${provider}Key`] ?? Object.values(reply.payload.errors)[0], 'error');
        } else {
          setStatus(reply.payload?.message ?? "Couldn't save the key.", 'error');
        }
      });
    });

    cref('testNew').addEventListener('click', () => {
      if (!input.value.trim()) {
        setStatus('Paste a key first.', 'error');
        input.focus();
        return;
      }
      withBusy(() => testKey(input.value));
    });

    cref('testSaved').addEventListener('click', () => withBusy(() => testKey(undefined)));

    cref('replace').addEventListener('click', () => {
      replacing = true;
      setStatus('');
      setWarning('');
      render();
      input.focus();
    });

    cref('cancel').addEventListener('click', () => {
      replacing = false;
      input.value = '';
      setStatus('');
      render();
    });

    // Two-step remove instead of confirm(), which side panels don't reliably support.
    cref('remove').addEventListener('click', () => {
      const btn = cref('remove');
      if (!removeArmed) {
        removeArmed = true;
        btn.textContent = 'Click again to remove';
        removeTimer = window.setTimeout(() => {
          removeArmed = false;
          btn.textContent = 'Remove';
        }, 4000);
        return;
      }
      window.clearTimeout(removeTimer);
      removeArmed = false;
      btn.textContent = 'Remove';
      withBusy(async () => {
        const reply = await request(ToSW.SETTINGS_SAVE, { secrets: { [provider]: null } });
        if (reply.type === ToPanel.SAVED) {
          store.set({ settingsState: reply.payload.state });
          setStatus(copy.removeLast, 'ok');
        } else {
          setStatus(reply.payload?.message ?? "Couldn't remove the key.", 'error');
        }
        setWarning('');
      });
    });

    cref('toggle').addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      const toggle = cref('toggle');
      toggle.textContent = show ? 'Hide' : 'Show';
      toggle.setAttribute('aria-pressed', String(show));
      toggle.setAttribute('aria-label', show ? 'Hide key' : 'Show key');
    });

    cref('enabled')?.addEventListener('change', () => {
      const box = /** @type {HTMLInputElement} */ (cref('enabled'));
      withBusy(async () => {
        const reply = await request(ToSW.SETTINGS_SAVE, { settings: { groqEnabled: box.checked } });
        if (reply.type === ToPanel.SAVED) {
          store.set({ settingsState: reply.payload.state });
          setStatus(box.checked ? 'Groq backup is on.' : 'Groq backup is off.', 'ok');
        } else {
          setStatus(reply.payload?.message ?? "Couldn't save.", 'error');
        }
      });
    });

    store.subscribe((s) => s.settingsState, render);
  }

  mountKeyCard('gemini');
  mountKeyCard('groq');

  function renderPrefs() {
    const state = store.get().settingsState;
    ref('readonly').hidden = !state?.readOnly;
    for (const select of selects) {
      const value = state?.settings?.[select.dataset.setting];
      if (value !== undefined) select.value = value;
      select.disabled = !state || Boolean(state?.readOnly);
    }
  }

  for (const select of selects) {
    select.addEventListener('change', async () => {
      const field = select.dataset.setting;
      setStatus('prefsStatus', 'Saving…');
      try {
        const reply = await request(ToSW.SETTINGS_SAVE, { settings: { [field]: select.value } });
        if (reply.type === ToPanel.SAVED) {
          store.set({ settingsState: reply.payload.state });
          setStatus('prefsStatus', 'Saved.', 'ok');
        } else {
          const message = reply.type === ToPanel.VALIDATION_ERROR ? reply.payload.errors[field] : reply.payload?.message;
          setStatus('prefsStatus', message ?? "Couldn't save.", 'error');
          renderPrefs(); // put the control back to the stored value
        }
      } catch (err) {
        setStatus('prefsStatus', err instanceof Error ? err.message : "Couldn't save.", 'error');
        renderPrefs();
      }
    });
  }

  store.subscribe((s) => s.settingsState, renderPrefs);
  mountDevFaults();

  const profile = mountProfileView(ref('profileRoot'), { store, request });
  mountSafetyView(ref('safetyRoot'), { store, request });

  // Loaded when opened, so a closed section costs nothing.
  const logs = mountLogView(ref('logsRoot'), { request });
  ref('logs').addEventListener('toggle', () => {
    if (ref('logs').open) logs.load();
  });

  // ---- Clear all my data (EC-SET-14): nothing is deleted until "Delete everything" is pressed. ----

  /** @param {boolean} open */
  function showClearConfirm(open) {
    ref('clearConfirm').hidden = !open;
    ref('clearAll').setAttribute('aria-expanded', String(open));
    if (open) ref('clearNo').focus(); // the safe choice has focus
  }

  ref('clearAll').addEventListener('click', () => {
    setStatus('clearStatus', '');
    showClearConfirm(true);
  });
  ref('clearNo').addEventListener('click', () => {
    showClearConfirm(false);
    ref('clearAll').focus();
  });
  ref('clearYes').addEventListener('click', async () => {
    const yes = /** @type {HTMLButtonElement} */ (ref('clearYes'));
    yes.disabled = true;
    setStatus('clearStatus', 'Deleting…');
    try {
      const reply = await request(ToSW.CLEAR_ALL_DATA, {});
      if (reply.type === ToPanel.DATA_CLEARED) {
        showClearConfirm(false);
        setStatus('clearStatus', 'Done. Your profile, skills, logs, chat history and keys were deleted.', 'ok');
        await profile.load({ force: true });
        if (ref('logs').open) logs.load();
      } else {
        setStatus('clearStatus', reply.payload?.message ?? "Couldn't delete your data. Please try again.", 'error');
      }
    } catch (err) {
      setStatus('clearStatus', err instanceof Error ? err.message : "Couldn't delete your data.", 'error');
    } finally {
      yes.disabled = false;
    }
  });

  /**
   * Developer-only: arm a fake error for the next AI request (P2.4). Shown only with ?dev=1 in an
   * unpacked install, and the service worker checks the install type again (EC-RTL-15).
   */
  async function mountDevFaults() {
    if (new URLSearchParams(location.search).get('dev') !== '1') return;
    try {
      if ((await chrome.management.getSelf()).installType !== 'development') return;
    } catch {
      return;
    }
    ref('advanced').hidden = false;
    ref('arm').addEventListener('click', async () => {
      const fault = /** @type {HTMLSelectElement} */ (ref('fault')).value;
      await chrome.storage.session.set({ [DEV_FAULT_KEY]: fault });
      setStatus('faultStatus', 'Armed. The next AI request will get this error.', 'warn');
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && DEV_FAULT_KEY in changes && changes[DEV_FAULT_KEY].newValue === undefined) {
        setStatus('faultStatus', 'Used by the last request.', 'ok');
      }
    });
  }
}

/**
 * @param {HTMLSelectElement} select
 * @param {Record<string, string>} options
 */
function fillSelect(select, options) {
  for (const [value, label] of Object.entries(options)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
}
