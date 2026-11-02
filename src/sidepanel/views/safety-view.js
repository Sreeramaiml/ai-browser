// @ts-check
// Settings → Safety (P4.3): sites the user blocked, sites they own (where the agent may act), the
// private sites where they agreed to send selected text, and whether to hide emails and phone
// numbers from the AI. Built-in rules can't be changed here. Writes go through the service worker.

import { ToPanel, ToSW } from '../../shared/messages.js';

/**
 * @typedef {'userBlockedDomains'|'ownedDomains'|'sensitiveAckDomains'} SafetyList
 * @typedef {Record<SafetyList, string[]>} SafetyState
 * @typedef {(type: string, payload?: any) => Promise<import('../../shared/messages.js').Message>} Request
 */

const TEMPLATE = /* html */ `
    <p class="hint">Sahayak never works on banking and payment sites, and never types passwords, OTPs or card numbers.
      Those rules are built in. The lists below are your own additions.</p>

    <h4>Blocked sites</h4>
    <p class="field-hint">Sahayak is switched off completely on these sites and their subdomains.</p>
    <ul class="domain-list" data-list="userBlockedDomains" aria-label="Blocked sites"></ul>
    <form class="domain-add" data-add="userBlockedDomains" novalidate>
      <input type="text" aria-label="Site to block" placeholder="example.com" autocomplete="off" spellcheck="false" />
      <button type="submit">Block</button>
    </form>

    <h4>Your own sites</h4>
    <p class="field-hint">The agent can act on these, as well as on the practice site. Add only sites you own or control.
      Banking, payment and private sites can't be added.</p>
    <ul class="domain-list" data-list="ownedDomains" aria-label="Your own sites"></ul>
    <form class="domain-add" data-add="ownedDomains" novalidate>
      <input type="text" aria-label="Site you own" placeholder="mysite.dev" autocomplete="off" spellcheck="false" />
      <label class="check"><input type="checkbox" data-ref="ownConfirm" /> I own or control this site</label>
      <button type="submit">Add</button>
    </form>

    <h4>Private sites: selected text only</h4>
    <p class="field-hint">On these private sites you agreed to send the text you select, and nothing else from the page.
      Revoke one to be asked again.</p>
    <ul class="domain-list" data-list="sensitiveAckDomains" aria-label="Private sites where you send selected text"></ul>

    <h4>Hiding personal details</h4>
    <p class="field-hint">Card numbers, Aadhaar, PAN, OTPs, UPI IDs and API keys are always removed before anything is sent to the AI.</p>
    <label class="check"><input type="checkbox" data-ref="redactContacts" /> Also hide emails and phone numbers</label>
    <p class="status" role="status" data-ref="status"></p>`;

const EMPTY = { userBlockedDomains: 'No blocked sites.', ownedDomains: 'No sites added.', sensitiveAckDomains: 'None yet.' };
const REMOVE_LABEL = { userBlockedDomains: 'Unblock', ownedDomains: 'Remove', sensitiveAckDomains: 'Revoke' };

/**
 * @param {HTMLElement} root
 * @param {{
 *   store: import('../store.js').Store<{
 *     safety: SafetyState|null,
 *     settingsState: import('../../background/settings-service.js').SettingsState|null,
 *     connection: import('../connection.js').ConnectionStatus
 *   }>,
 *   request: Request
 * }} deps
 */
export function mountSafetyView(root, { store, request }) {
  root.innerHTML = TEMPLATE; // static markup only; domains are set as text below
  /** @param {string} name @returns {any} */
  const ref = (name) => root.querySelector(`[data-ref="${name}"]`);

  /** @param {string} text @param {'ok'|'warn'|'error'|''} [tone] */
  function setStatus(text, tone = '') {
    const el = ref('status');
    el.textContent = text;
    el.className = `status ${tone}`.trim();
  }

  /** @param {import('../../shared/messages.js').Message} reply @param {string} done */
  function handle(reply, done) {
    if (reply.type === ToPanel.SAFETY_STATE) {
      store.set({ safety: reply.payload.safety });
      setStatus(done, 'ok');
      return true;
    }
    setStatus(reply.payload?.errors?.domain ?? reply.payload?.message ?? "Couldn't save that.", 'error');
    return false;
  }

  function render() {
    const safety = store.get().safety;
    for (const list of /** @type {SafetyList[]} */ (['userBlockedDomains', 'ownedDomains', 'sensitiveAckDomains'])) {
      const ul = /** @type {HTMLElement} */ (root.querySelector(`[data-list="${list}"]`));
      const domains = safety?.[list] ?? [];
      if (!domains.length) {
        const li = document.createElement('li');
        li.className = 'field-hint';
        li.textContent = EMPTY[list];
        ul.replaceChildren(li);
        continue;
      }
      ul.replaceChildren(...domains.map((domain) => {
        const li = document.createElement('li');
        const name = document.createElement('code');
        name.textContent = domain;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'secondary';
        remove.textContent = REMOVE_LABEL[list];
        remove.setAttribute('aria-label', `${REMOVE_LABEL[list]} ${domain}`);
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try {
            handle(await request(ToSW.SAFETY_UPDATE, { list, action: 'remove', domain }), `${REMOVE_LABEL[list] === 'Revoke' ? 'Revoked' : 'Removed'} ${domain}.`);
          } catch (err) {
            setStatus(err instanceof Error ? err.message : "Couldn't save that.", 'error');
            remove.disabled = false;
          }
        });
        li.append(name, remove);
        return li;
      }));
    }
    const box = /** @type {HTMLInputElement} */ (ref('redactContacts'));
    box.checked = Boolean(store.get().settingsState?.settings?.redactContacts);
    box.disabled = !store.get().settingsState || Boolean(store.get().settingsState?.readOnly);
  }

  for (const form of /** @type {HTMLFormElement[]} */ ([...root.querySelectorAll('[data-add]')])) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const list = /** @type {SafetyList} */ (form.dataset.add);
      const input = /** @type {HTMLInputElement} */ (form.querySelector('input[type="text"]'));
      const confirm = /** @type {HTMLInputElement|null} */ (form.querySelector('[data-ref="ownConfirm"]'));
      const button = /** @type {HTMLButtonElement} */ (form.querySelector('button'));
      button.disabled = true;
      try {
        const reply = await request(ToSW.SAFETY_UPDATE, {
          list, action: 'add', domain: input.value, ...(confirm ? { confirmOwned: confirm.checked } : {})
        });
        if (handle(reply, list === 'ownedDomains' ? 'Added. The agent can now act on that site.' : 'Blocked.')) {
          input.value = '';
          if (confirm) confirm.checked = false;
        } else {
          input.focus();
        }
      } catch (err) {
        setStatus(err instanceof Error ? err.message : "Couldn't save that.", 'error');
      } finally {
        button.disabled = false;
      }
    });
  }

  ref('redactContacts').addEventListener('change', async () => {
    const box = /** @type {HTMLInputElement} */ (ref('redactContacts'));
    try {
      const reply = await request(ToSW.SETTINGS_SAVE, { settings: { redactContacts: box.checked } });
      if (reply.type === ToPanel.SAVED) {
        store.set({ settingsState: reply.payload.state });
        setStatus(box.checked ? 'Emails and phone numbers will be hidden from the AI.' : 'Emails and phone numbers will be sent as written.', 'ok');
      } else {
        setStatus(reply.payload?.message ?? "Couldn't save.", 'error');
        render();
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Couldn't save.", 'error');
      render();
    }
  });

  async function load() {
    try {
      const reply = await request(ToSW.SAFETY_GET, {});
      if (reply.type === ToPanel.SAFETY_STATE) store.set({ safety: reply.payload.safety });
    } catch {
      /* not connected yet: the next "connected" retries */
    }
  }

  store.subscribe((s) => s.safety, render);
  store.subscribe((s) => s.settingsState, render);
  store.subscribe((s) => s.connection, (status) => { if (status === 'connected') load(); });
  return { load };
}
