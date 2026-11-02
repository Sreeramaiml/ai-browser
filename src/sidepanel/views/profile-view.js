// @ts-check
// Settings → Profile (architecture §13.1, P4.1): the user's details, kept only on this device and
// used to fill forms (each value is shown on the approval card) and to sign drafted replies.
// Writes go through the service worker, which validates them; this view only shows its verdict.

import { LANGUAGES, TONES } from '../../shared/config.js';
import { ToPanel, ToSW } from '../../shared/messages.js';
import { PROFILE_LINKS, PROFILE_SKILLS_MAX, PROFILE_SKILL_MAX_CHARS, PROFILE_TEXT_MAX, normalizeSkills } from '../../shared/storage.js';

/** @typedef {import('../../shared/storage.js').Profile} Profile */
/** @typedef {(type: string, payload?: any) => Promise<import('../../shared/messages.js').Message>} Request */

/** @param {string} id @param {string} label @param {string} attrs */
const field = (id, label, attrs) => /* html */ `
      <label for="profile-${id}">${label}</label>
      <input id="profile-${id}" data-field="${id}" ${attrs} aria-describedby="profile-${id}-msg" />
      <p id="profile-${id}-msg" class="field-msg" data-msg="${id}" hidden></p>`;

const LINK_LABELS = { linkedin: 'LinkedIn', github: 'GitHub', portfolio: 'Portfolio or website' };

const TEMPLATE = /* html */ `
    <form class="profile-form" data-ref="form" novalidate autocomplete="off">
${field('name', 'Full name', `type="text" maxlength="${PROFILE_TEXT_MAX.name}" autocomplete="off"`)}
${field('email', 'Email', `type="email" maxlength="${PROFILE_TEXT_MAX.email}" autocomplete="off" spellcheck="false"`)}
${field('phone', 'Phone', `type="tel" maxlength="${PROFILE_TEXT_MAX.phone}" autocomplete="off"`)}
${field('college', 'College', `type="text" maxlength="${PROFILE_TEXT_MAX.college}"`)}
${field('degree', 'Degree', `type="text" maxlength="${PROFILE_TEXT_MAX.degree}" placeholder="e.g. B.Tech"`)}
${field('gradYear', 'Graduation year', 'type="number" min="1950" max="2100" step="1" inputmode="numeric"')}

      <label for="profile-skills">Skills</label>
      <ul class="skill-chips" data-ref="skillChips" aria-label="Your skills"></ul>
      <input id="profile-skills" data-ref="skillInput" type="text" maxlength="${PROFILE_SKILL_MAX_CHARS}"
             placeholder="Type a skill and press Enter" aria-describedby="profile-skills-msg" />
      <p id="profile-skills-msg" class="field-msg" data-msg="skills" hidden></p>

${PROFILE_LINKS.map((k) => field(`links.${k}`, LINK_LABELS[k], 'type="url" maxlength="300" spellcheck="false" placeholder="https://…"')).join('')}

      <label for="profile-preferredLanguage">Preferred language</label>
      <select id="profile-preferredLanguage" data-field="preferredLanguage" aria-describedby="profile-preferredLanguage-hint">
        <option value="">Not set</option>
      </select>
      <p id="profile-preferredLanguage-hint" class="field-hint">Sets the response language the first time you save it.</p>

      <label for="profile-preferredTone">Tone for drafted replies</label>
      <select id="profile-preferredTone" data-field="preferredTone" aria-describedby="profile-preferredTone-hint">
        <option value="">Not set (use Preferences)</option>
      </select>
      <p id="profile-preferredTone-hint" class="field-hint">When set, it's used instead of the tone in Preferences.</p>

      <label for="profile-about">About you</label>
      <textarea id="profile-about" data-field="about" rows="4" maxlength="${PROFILE_TEXT_MAX.about}"
                aria-describedby="profile-about-count profile-about-msg"></textarea>
      <p id="profile-about-count" class="field-hint counter" data-ref="aboutCount"></p>
      <p id="profile-about-msg" class="field-msg" data-msg="about" hidden></p>

      <div class="row">
        <button type="submit" data-ref="save">Save profile</button>
      </div>
      <p class="status" role="status" data-ref="status"></p>
    </form>`;

/**
 * @param {HTMLElement} root
 * @param {{
 *   store: import('../store.js').Store<{ profile: Profile|null, connection: import('../connection.js').ConnectionStatus }>,
 *   request: Request
 * }} deps
 * @returns {{ load: (opts?: { force?: boolean }) => Promise<void> }}
 */
export function mountProfileView(root, { store, request }) {
  root.innerHTML = TEMPLATE; // static markup only; values are set via .value / textContent below
  /** @param {string} name @returns {any} */
  const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
  /** @returns {Array<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>} */
  const inputs = () => [...root.querySelectorAll('[data-field]')];
  /** @param {string} name @returns {any} */
  const input = (name) => root.querySelector(`[data-field="${name}"]`);
  const skillInput = /** @type {HTMLInputElement} */ (ref('skillInput'));

  for (const [name, choices] of /** @type {const} */ ([['preferredLanguage', LANGUAGES], ['preferredTone', TONES]])) {
    for (const [value, label] of Object.entries(choices)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      input(name).append(option);
    }
  }

  /** @type {string[]} */
  let skills = [];
  /** Unsaved edits: a profile pushed from another window mustn't overwrite them. */
  let dirty = false;
  let saving = false;

  /** @param {string} text @param {'ok'|'warn'|'error'|''} [tone] */
  function setStatus(text, tone = '') {
    const el = ref('status');
    el.textContent = text;
    el.className = `status ${tone}`.trim();
  }

  /** @param {Record<string, string>} errors @param {Record<string, string>} warnings */
  function showMessages(errors = {}, warnings = {}) {
    for (const el of /** @type {HTMLElement[]} */ ([...root.querySelectorAll('[data-msg]')])) {
      const key = el.dataset.msg ?? '';
      const text = errors[key] ?? warnings[key] ?? '';
      el.textContent = text;
      el.hidden = !text;
      el.className = `field-msg ${errors[key] ? 'error' : 'warn'}`;
      const control = key === 'skills' ? skillInput : input(key);
      control?.setAttribute('aria-invalid', String(Boolean(errors[key])));
    }
  }

  function renderSkills() {
    const list = ref('skillChips');
    list.replaceChildren(...skills.map((skill) => {
      const li = document.createElement('li');
      li.className = 'chip';
      li.append(skill); // typed by the user, but still plain text
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chip-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${skill}`);
      remove.addEventListener('click', () => {
        skills = skills.filter((s) => s !== skill);
        dirty = true;
        renderSkills();
        skillInput.focus();
      });
      li.append(remove);
      return li;
    }));
    list.hidden = skills.length === 0;
    skillInput.disabled = skills.length >= PROFILE_SKILLS_MAX;
    skillInput.placeholder = skills.length >= PROFILE_SKILLS_MAX ? `Up to ${PROFILE_SKILLS_MAX} skills` : 'Type a skill and press Enter';
  }

  /** Turn what's typed in the skill box into chips ("a, b" makes two). */
  function commitSkillInput() {
    if (!skillInput.value.trim()) return;
    skills = normalizeSkills([...skills, ...skillInput.value.split(',')]);
    skillInput.value = '';
    dirty = true;
    renderSkills();
  }

  function renderCount() {
    const about = /** @type {HTMLTextAreaElement} */ (input('about'));
    ref('aboutCount').textContent = `${about.value.length.toLocaleString()} / ${PROFILE_TEXT_MAX.about.toLocaleString()}`;
  }

  /** @param {Profile} profile */
  function fill(profile) {
    for (const el of inputs()) {
      const name = el.dataset.field ?? '';
      const v = name.startsWith('links.')
        ? profile.links?.[/** @type {'linkedin'|'github'|'portfolio'} */ (name.slice(6))]
        : profile[/** @type {keyof Profile} */ (name)];
      el.value = v === undefined || v === null ? '' : String(v);
    }
    skills = [...(profile.skills ?? [])];
    skillInput.value = '';
    dirty = false;
    renderSkills();
    renderCount();
    showMessages();
  }

  /** The form as a profile for PROFILE_SAVE. The service worker trims and checks it. */
  function collect() {
    commitSkillInput();
    /** @type {Record<string, any>} */
    const out = { skills, links: {} };
    for (const el of inputs()) {
      const name = el.dataset.field ?? '';
      if (name.startsWith('links.')) out.links[name.slice(6)] = el.value;
      else out[name] = el.value;
    }
    return out;
  }

  function render() {
    const offline = store.get().connection !== 'connected';
    ref('save').disabled = saving || offline;
    ref('save').textContent = saving ? 'Saving…' : 'Save profile';
  }

  root.addEventListener('input', (event) => {
    if (event.target !== skillInput) dirty = true;
    if (/** @type {HTMLElement} */ (event.target).dataset.field === 'about') renderCount();
  });
  root.addEventListener('change', (event) => {
    if (event.target !== skillInput) dirty = true;
  });

  skillInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault(); // Enter here adds a chip; it doesn't submit the form
      commitSkillInput();
    } else if (event.key === 'Backspace' && !skillInput.value && skills.length) {
      skills = skills.slice(0, -1);
      dirty = true;
      renderSkills();
    }
  });
  skillInput.addEventListener('blur', commitSkillInput);

  ref('form').addEventListener('submit', async (/** @type {Event} */ event) => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    setStatus('Saving…');
    render();
    try {
      const reply = await request(ToSW.PROFILE_SAVE, { profile: collect() });
      if (reply.type === ToPanel.SAVED) {
        store.set({ profile: reply.payload.profile });
        fill(reply.payload.profile); // shows what was stored, e.g. https:// added to a link
        const warnings = reply.payload.warnings ?? {};
        showMessages({}, warnings);
        setStatus(Object.keys(warnings).length ? 'Saved, but check the warning above.' : 'Saved. Kept only on this device.',
          Object.keys(warnings).length ? 'warn' : 'ok');
      } else if (reply.type === ToPanel.VALIDATION_ERROR) {
        // The valid fields were saved; keep the user's typing so they can fix the rest (EC-PRF-06).
        if (reply.payload.profile) store.set({ profile: reply.payload.profile });
        showMessages(reply.payload.errors, reply.payload.warnings);
        setStatus(reply.payload.errors._ ?? 'Fix the fields marked above. The other fields were saved.', 'error');
        /** @type {HTMLElement|null} */ (root.querySelector('[aria-invalid="true"]'))?.focus();
      } else {
        setStatus(reply.payload?.message ?? "Couldn't save your profile.", 'error');
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Couldn't save your profile.", 'error');
    } finally {
      saving = false;
      render();
    }
  });

  // A save or clear from another window, or the first load.
  store.subscribe((s) => s.profile, (profile) => {
    if (profile && !dirty) fill(profile);
  });
  store.subscribe((s) => s.connection, (status) => {
    render();
    if (status === 'connected' && !dirty) load();
  });

  /** Fetch the saved profile. `force` also throws away unsaved edits (after Clear all my data). */
  async function load({ force = false } = {}) {
    try {
      const reply = await request(ToSW.PROFILE_GET, {});
      if (reply.type !== ToPanel.PROFILE_STATE) return;
      if (force) dirty = false;
      store.set({ profile: reply.payload.profile }); // the subscriber fills the form unless it has edits
    } catch {
      /* not connected yet: the next "connected" retries */
    }
  }

  renderSkills();
  renderCount();
  return { load };
}
