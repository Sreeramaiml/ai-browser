// @ts-check
// Skills tab (architecture §13.2, P4.2): saved prompt recipes, one click to run on the current
// page. Answer skills stream into the Chat tab; agent skills start a task in the Agent tab, with
// every step still approved by the user. Skills export to and import from a small JSON file.
// Everything a skill holds is user or file data, so it's only ever set as text (EC-SKL-10).

import { LANGUAGES } from '../../shared/config.js';
import { ToPanel, ToSW } from '../../shared/messages.js';
import {
  SKILL_FILE_MAX_BYTES, SKILL_NAME_MAX, SKILL_PROMPT_MAX, buildSkillExport, needsOf, parseSkillFile, planImport,
  skillExportFileName
} from '../../shared/schemas.js';
import { PROFILE_PATHS, TEMPLATE_VARS, unknownVariables } from '../../shared/template.js';
import { createErrorBanner } from '../components/error-banner.js';

/**
 * @typedef {import('../../shared/schemas.js').Skill} Skill
 * @typedef {import('../../shared/schemas.js').ImportChoice} ImportChoice
 */

const NEED_LABELS = { page: 'Page', selection: 'Selection', profile: 'Profile' };
const VAR_HINTS = {
  page: 'the page text', selection: 'the selected text', url: 'the page address', title: 'the page title',
  language: 'en or hinglish'
};

const TEMPLATE = /* html */ `
  <div class="skills">
    <div class="skills-head">
      <h2>Skills</h2>
      <button type="button" class="btn btn-primary" data-ref="newBtn">+ New skill</button>
    </div>
    <p class="hint">One-click recipes that run on the page you're on. Answers appear in Chat; agent skills
      start a task you approve step by step.</p>
    <div data-ref="notice" aria-live="polite"></div>
    <p class="status" role="status" data-ref="status"></p>

    <div data-ref="listPane">
      <ul class="skill-list" data-ref="list" aria-label="Your skills"></ul>
      <p class="hint" data-ref="empty" hidden>No skills yet. Create one, or import a skills file.</p>
      <div class="row skills-io">
        <button type="button" class="btn btn-secondary" data-ref="exportBtn">Export</button>
        <button type="button" class="btn btn-secondary" data-ref="importBtn">Import…</button>
        <input type="file" accept=".json,application/json" data-ref="file" hidden />
      </div>
      <p class="hint" data-ref="exportHint" hidden>No skills to export.</p>
    </div>

    <form class="card skill-editor" data-ref="editor" novalidate hidden aria-labelledby="skill-editor-heading">
      <h3 id="skill-editor-heading" data-ref="editorHeading">New skill</h3>
      <div class="skill-name-row">
        <div>
          <label for="skill-icon">Emoji</label>
          <input id="skill-icon" data-field="icon" type="text" maxlength="8" placeholder="⚡" autocomplete="off" />
        </div>
        <div>
          <label for="skill-name">Name</label>
          <input id="skill-name" data-field="name" type="text" maxlength="${SKILL_NAME_MAX}" autocomplete="off"
                 placeholder="e.g. Make flashcards from this page" aria-describedby="skill-name-msg" />
        </div>
      </div>
      <p id="skill-name-msg" class="field-msg" data-msg="name" hidden></p>

      <label for="skill-mode">What it does</label>
      <select id="skill-mode" data-field="mode" aria-describedby="skill-mode-hint">
        <option value="answer">Gives an answer (shown in Chat)</option>
        <option value="agent">Starts an agent task</option>
      </select>
      <p id="skill-mode-hint" class="field-hint" data-ref="modeHint"></p>
      <p class="field-msg" data-msg="mode" hidden></p>

      <label for="skill-prompt">Prompt</label>
      <div class="var-helper" role="group" aria-label="Insert a variable">
        ${TEMPLATE_VARS.map((v) => `<button type="button" class="chip chip-btn" data-insert="{{${v}}}" title="${VAR_HINTS[v]}">{{${v}}}</button>`).join('')}
        <select data-ref="profileVar" aria-label="Insert a profile field">
          <option value="">+ profile field</option>
          ${PROFILE_PATHS.map((p) => `<option value="{{profile.${p}}}">profile.${p}</option>`).join('')}
        </select>
      </div>
      <textarea id="skill-prompt" data-field="prompt" rows="6" maxlength="${SKILL_PROMPT_MAX}"
                aria-describedby="skill-prompt-count skill-prompt-msg"
                placeholder="e.g. Make 10 flashcards (question → answer) from this page: {{page}}"></textarea>
      <p id="skill-prompt-count" class="field-hint counter" data-ref="promptCount"></p>
      <p id="skill-prompt-msg" class="field-msg" data-msg="prompt" hidden></p>
      <p class="field-hint">Write \\{{ for a literal {{.</p>

      <fieldset class="skill-needs">
        <legend>Needs</legend>
        ${Object.entries(NEED_LABELS).map(([k, label]) => `<label class="check"><input type="checkbox" data-need="${k}" /> ${label}</label>`).join('')}
      </fieldset>
      <p class="field-hint">Ticked for you when the prompt uses that variable. A skill that needs the selection only runs
        when some text is selected.</p>

      <label for="skill-language">Answer language</label>
      <select id="skill-language" data-field="language">
        <option value="inherit">Same as the EN | Hinglish toggle</option>
        ${Object.entries(LANGUAGES).map(([v, label]) => `<option value="${v}">${label}</option>`).join('')}
      </select>

      <div class="row">
        <button type="submit" data-ref="saveBtn">Save skill</button>
        <button type="button" class="secondary" data-ref="cancelBtn">Cancel</button>
      </div>
      <p class="status" role="status" data-ref="editorStatus"></p>
    </form>

    <section class="card import-preview" data-ref="preview" hidden aria-labelledby="import-heading">
      <h3 id="import-heading">Import skills</h3>
      <p class="hint" data-ref="previewSummary"></p>
      <ul class="skill-list" data-ref="previewList"></ul>
      <div class="row">
        <button type="button" data-ref="importConfirm">Import</button>
        <button type="button" class="secondary" data-ref="importCancel">Cancel</button>
      </div>
    </section>
  </div>
`;

/** @param {string} tag @param {string} [className] @param {string} [text] */
function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** @param {string} label @param {string} className @param {() => void} onClick */
function button(label, className, onClick) {
  const b = /** @type {HTMLButtonElement} */ (h('button', className, label));
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** @param {Skill} skill */
const modeChip = (skill) => (skill.mode === 'agent'
  ? h('span', 'chip chip-warn', '⚠ Agent task')
  : h('span', 'chip chip-muted', 'Answer'));

/**
 * @param {HTMLElement} root
 * @param {{
 *   store: import('../store.js').Store<{
 *     skills: Skill[]|null,
 *     activeTab: import('../../background/tab-context.js').ActiveTabInfo|null,
 *     connection: import('../connection.js').ConnectionStatus
 *   }>,
 *   client: Awaited<ReturnType<typeof import('../client.js').startClient>>,
 *   runAnswer: (skill: Skill) => Promise<void>,
 *   onAgentState: (payload: any) => void,
 *   openSettings: () => void
 * }} deps
 */
export function mountSkillsView(root, { store, client, runAnswer, onAgentState, openSettings }) {
  root.innerHTML = TEMPLATE; // static markup only; skills are rendered below as text
  /** @param {string} name @returns {any} */
  const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
  /** @param {string} name @returns {any} */
  const field = (name) => root.querySelector(`[data-field="${name}"]`);
  const editor = /** @type {HTMLFormElement} */ (ref('editor'));
  const promptInput = /** @type {HTMLTextAreaElement} */ (field('prompt'));
  const needBoxes = /** @type {HTMLInputElement[]} */ ([...root.querySelectorAll('[data-need]')]);

  /** Skills running now: a second click on one is ignored (EC-SKL-15). */
  const running = new Set();
  /** @type {string|null} the skill being edited; null for a new one */
  let editingId = null;
  /** @type {Array<{ skill: Skill, conflict: Skill|null, choice: ImportChoice }>} */
  let importPlan = [];
  /** Delete waits for a second click. */
  let armedDelete = /** @type {string|null} */ (null);
  let armTimer = 0;

  const skills = () => store.get().skills ?? [];

  /** @param {string} text @param {'ok'|'warn'|'error'|''} [tone] @param {string} [name] */
  function setStatus(text, tone = '', name = 'status') {
    const el = ref(name);
    el.textContent = text;
    el.className = `status ${tone}`.trim();
  }

  /** @param {any} error */
  function showError(error) {
    ref('notice').replaceChildren(createErrorBanner(
      error ?? { code: 'INTERNAL', message: 'Something went wrong. Please try again.' }, { onOpenSettings: openSettings }
    ));
  }

  /** @param {'list'|'editor'|'preview'} pane */
  function show(pane) {
    ref('listPane').hidden = pane !== 'list';
    editor.hidden = pane !== 'editor';
    ref('preview').hidden = pane !== 'preview';
    ref('newBtn').hidden = pane !== 'list';
  }

  // ---- List ----

  function renderList() {
    const all = skills();
    const list = ref('list');
    list.replaceChildren(...all.map((skill) => {
      const li = h('li', 'skill-item');
      const head = h('div', 'skill-item-head');
      head.append(h('span', 'skill-icon', skill.icon || '⚡'), h('strong', 'skill-name', skill.name), modeChip(skill));
      const needs = h('p', 'field-hint', skill.needs.length ? `Needs: ${skill.needs.map((n) => NEED_LABELS[n]).join(', ')}` : 'Needs nothing from the page');

      const busy = running.has(skill.id);
      const run = button(busy ? 'Running…' : 'Run', 'btn btn-primary', () => runSkill(skill));
      run.disabled = busy || store.get().connection !== 'connected';
      run.setAttribute('aria-label', `Run ${skill.name}`);
      const edit = button('Edit', 'btn btn-secondary', () => openEditor(skill));
      const dup = button('Duplicate', 'btn btn-secondary', () => duplicate(skill));
      const del = button(armedDelete === skill.id ? 'Click again to delete' : 'Delete', 'btn btn-secondary btn-danger-text', () => remove(skill));
      for (const [b, verb] of /** @type {const} */ ([[edit, 'Edit'], [dup, 'Duplicate'], [del, 'Delete']])) b.setAttribute('aria-label', `${verb} ${skill.name}`);
      const row = h('div', 'row skill-actions');
      row.append(run, edit, dup, del);
      li.append(head, needs, row);
      return li;
    }));
    ref('empty').hidden = all.length > 0;
    ref('exportBtn').disabled = all.length === 0; // EC-SKL-13
    ref('exportHint').hidden = all.length > 0;
  }

  /** @param {Skill} skill */
  async function runSkill(skill) {
    if (running.has(skill.id)) return;
    running.add(skill.id);
    ref('notice').replaceChildren();
    setStatus('');
    renderList();
    try {
      if (skill.mode === 'answer') {
        await runAnswer(skill); // the Chat tab shows the answer, or why it couldn't run
        return;
      }
      const reply = await client.request(ToSW.RUN_SKILL, { skillId: skill.id, tabId: store.get().activeTab?.tabId ?? undefined });
      if (reply.type === ToPanel.AGENT_STATE) onAgentState(reply.payload);
      else showError(reply.payload);
    } catch (err) {
      showError({ code: 'INTERRUPTED', message: err instanceof Error ? err.message : "Couldn't run the skill." });
    } finally {
      running.delete(skill.id);
      renderList();
    }
  }

  /** @param {Skill} skill */
  async function duplicate(skill) {
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = skill;
    const reply = await client.request(ToSW.SKILLS_SAVE, { skill: { ...rest, name: `${skill.name} (copy)`.slice(0, SKILL_NAME_MAX) } })
      .catch((err) => ({ type: ToPanel.ERROR, payload: { message: err instanceof Error ? err.message : "Couldn't duplicate." } }));
    if (reply.type === ToPanel.SAVED) {
      store.set({ skills: reply.payload.skills });
      setStatus(`Made a copy of "${skill.name}".`, 'ok');
    } else {
      setStatus(reply.payload?.errors?._ ?? reply.payload?.message ?? "Couldn't duplicate the skill.", 'error');
    }
  }

  /** @param {Skill} skill */
  async function remove(skill) {
    window.clearTimeout(armTimer);
    if (armedDelete !== skill.id) {
      armedDelete = skill.id;
      armTimer = window.setTimeout(() => { armedDelete = null; renderList(); }, 4000);
      renderList();
      return;
    }
    armedDelete = null;
    const reply = await client.request(ToSW.SKILLS_DELETE, { skillId: skill.id })
      .catch((err) => ({ type: ToPanel.ERROR, payload: { message: err instanceof Error ? err.message : "Couldn't delete." } }));
    if (reply.type === ToPanel.SKILLS_STATE) {
      store.set({ skills: reply.payload.skills });
      setStatus(`Deleted "${skill.name}".`, 'ok');
    } else {
      setStatus(reply.payload?.message ?? "Couldn't delete the skill.", 'error');
      renderList();
    }
  }

  // ---- Editor ----

  /** @param {Record<string, string>} [errors] @param {Record<string, string>} [warnings] */
  function showMessages(errors = {}, warnings = {}) {
    for (const el of /** @type {HTMLElement[]} */ ([...editor.querySelectorAll('[data-msg]')])) {
      const key = el.dataset.msg ?? '';
      const text = errors[key] ?? warnings[key] ?? '';
      el.textContent = text;
      el.hidden = !text;
      el.className = `field-msg ${errors[key] ? 'error' : 'warn'}`;
      field(key)?.setAttribute('aria-invalid', String(Boolean(errors[key])));
    }
  }

  /** Needs follow the prompt: a variable it uses can't be unticked. Unknown variables get a warning as you type. */
  function syncFromPrompt() {
    const derived = needsOf(promptInput.value);
    for (const box of needBoxes) {
      const need = /** @type {any} */ (box.dataset.need);
      if (derived.includes(need)) box.checked = true;
      box.disabled = derived.includes(need);
    }
    ref('promptCount').textContent = `${promptInput.value.length.toLocaleString()} / ${SKILL_PROMPT_MAX.toLocaleString()}`;
    const unknown = unknownVariables(promptInput.value);
    showMessages({}, unknown.length ? { prompt: `Sahayak doesn't know ${unknown.map((v) => `{{${v}}}`).join(', ')}.` } : {});
  }

  function syncModeHint() {
    ref('modeHint').textContent = field('mode').value === 'agent'
      ? 'The filled-in prompt becomes the agent\'s goal. It runs only on the practice site and your own sites, and you approve every step.'
      : 'The filled-in prompt is sent to the AI, and the answer appears in the Chat tab.';
  }

  /** @param {Skill|null} skill null for a new one */
  function openEditor(skill) {
    editingId = skill?.id ?? null;
    ref('editorHeading').textContent = skill ? 'Edit skill' : 'New skill';
    field('name').value = skill?.name ?? '';
    field('icon').value = skill?.icon ?? '';
    field('mode').value = skill?.mode ?? 'answer';
    field('language').value = skill?.language ?? 'inherit';
    promptInput.value = skill?.prompt ?? '';
    for (const box of needBoxes) box.checked = skill?.needs.includes(/** @type {any} */ (box.dataset.need)) ?? false;
    setStatus('', '', 'editorStatus');
    syncFromPrompt();
    syncModeHint();
    show('editor');
    field('name').focus();
  }

  /** @param {string} text */
  function insertAtCursor(text) {
    promptInput.focus();
    promptInput.setRangeText(text, promptInput.selectionStart, promptInput.selectionEnd, 'end');
    syncFromPrompt();
  }

  editor.addEventListener('click', (event) => {
    const chip = /** @type {HTMLElement} */ (event.target).closest?.('[data-insert]');
    if (chip) insertAtCursor(/** @type {HTMLElement} */ (chip).dataset.insert ?? '');
  });
  ref('profileVar').addEventListener('change', () => {
    const select = /** @type {HTMLSelectElement} */ (ref('profileVar'));
    if (select.value) insertAtCursor(select.value);
    select.value = '';
  });
  promptInput.addEventListener('input', syncFromPrompt);
  field('mode').addEventListener('change', syncModeHint);

  editor.addEventListener('submit', async (event) => {
    event.preventDefault();
    const skill = {
      ...(editingId ? { id: editingId } : {}),
      name: field('name').value,
      icon: field('icon').value,
      mode: field('mode').value,
      prompt: promptInput.value,
      language: field('language').value,
      needs: needBoxes.filter((b) => b.checked).map((b) => b.dataset.need)
    };
    ref('saveBtn').disabled = true;
    setStatus('Saving…', '', 'editorStatus');
    try {
      const reply = await client.request(ToSW.SKILLS_SAVE, { skill });
      if (reply.type === ToPanel.SAVED) {
        store.set({ skills: reply.payload.skills });
        const warnings = reply.payload.warnings ?? {};
        if (Object.keys(warnings).length) {
          // Saved, but worth a look before leaving (EC-SKL-03, EC-SKL-05).
          editingId = reply.payload.skill.id;
          showMessages({}, warnings);
          setStatus('Saved. Check the note above.', 'warn', 'editorStatus');
        } else {
          show('list');
          setStatus(`Saved "${reply.payload.skill.name}".`, 'ok');
        }
      } else if (reply.type === ToPanel.VALIDATION_ERROR) {
        showMessages(reply.payload.errors);
        setStatus(reply.payload.errors._ ?? 'Fix the fields marked above.', 'error', 'editorStatus');
      } else {
        setStatus(reply.payload?.message ?? "Couldn't save the skill.", 'error', 'editorStatus');
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Couldn't save the skill.", 'error', 'editorStatus');
    } finally {
      ref('saveBtn').disabled = false;
    }
  });

  ref('cancelBtn').addEventListener('click', () => show('list'));
  ref('newBtn').addEventListener('click', () => {
    setStatus('');
    openEditor(null);
  });

  // ---- Export ----

  ref('exportBtn').addEventListener('click', () => {
    if (skills().length === 0) return;
    // Built from the skills alone: settings, keys and the profile are never in this panel's export (EC-SKL-16).
    const json = JSON.stringify(buildSkillExport(skills(), Date.now()), null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = skillExportFileName(new Date());
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(`Exported ${skills().length} skill${skills().length === 1 ? '' : 's'}.`, 'ok');
  });

  // ---- Import ----

  ref('importBtn').addEventListener('click', () => ref('file').click());

  ref('file').addEventListener('change', async () => {
    const input = /** @type {HTMLInputElement} */ (ref('file'));
    const file = input.files?.[0];
    input.value = ''; // picking the same file again still fires change
    if (!file) return;
    ref('notice').replaceChildren();
    if (file.size > SKILL_FILE_MAX_BYTES) { // EC-SKL-11: don't even read it
      setStatus(`This file is too big. A skills file can be at most ${SKILL_FILE_MAX_BYTES / 1024} KB.`, 'error');
      return;
    }
    let text = '';
    try {
      text = await file.text();
    } catch {
      setStatus("Couldn't read that file.", 'error');
      return;
    }
    const parsed = parseSkillFile(text, { newId: () => crypto.randomUUID(), now: Date.now() });
    if (!parsed.ok) {
      setStatus(parsed.error, 'error');
      return;
    }
    importPlan = planImport(skills(), parsed.skills);
    const notes = [`${parsed.skills.length} skill${parsed.skills.length === 1 ? '' : 's'} in "${file.name}".`];
    if (parsed.skipped) notes.push(`${parsed.skipped} invalid one${parsed.skipped === 1 ? ' was' : 's were'} left out.`);
    if (parsed.warnings.length) notes.push(...parsed.warnings);
    ref('previewSummary').textContent = notes.join(' ');
    renderPreview();
    setStatus('');
    show('preview');
  });

  function renderPreview() {
    ref('previewList').replaceChildren(...importPlan.map((item, i) => {
      const li = h('li', 'skill-item');
      const head = h('div', 'skill-item-head');
      head.append(h('span', 'skill-icon', item.skill.icon || '⚡'), h('strong', 'skill-name', item.skill.name), modeChip(item.skill));
      const excerpt = item.skill.prompt.length > 160 ? `${item.skill.prompt.slice(0, 160)}…` : item.skill.prompt;
      li.append(head, h('p', 'skill-excerpt', excerpt));
      if (item.skill.mode === 'agent') {
        li.append(h('p', 'field-msg warn', 'This skill starts agent tasks. Read its goal before you run it: you still approve every step.'));
      }
      const id = `import-choice-${i}`;
      if (item.conflict) {
        const label = /** @type {HTMLLabelElement} */ (h('label', 'field-hint', `You already have a skill named "${item.conflict.name}".`));
        label.htmlFor = id;
        const select = /** @type {HTMLSelectElement} */ (h('select'));
        select.id = id;
        for (const [value, text] of [['skip', 'Skip it'], ['replace', 'Replace mine'], ['keep-both', 'Keep both']]) {
          const option = /** @type {HTMLOptionElement} */ (h('option', '', text));
          option.value = value;
          select.append(option);
        }
        select.value = item.choice;
        select.addEventListener('change', () => { item.choice = /** @type {ImportChoice} */ (select.value); renderConfirm(); });
        li.append(label, select);
      } else {
        const label = h('label', 'check');
        const box = /** @type {HTMLInputElement} */ (h('input'));
        box.type = 'checkbox';
        box.checked = item.choice === 'add';
        box.addEventListener('change', () => { item.choice = box.checked ? 'add' : 'skip'; renderConfirm(); });
        label.append(box, ' Import this skill');
        li.append(label);
      }
      return li;
    }));
    renderConfirm();
  }

  function renderConfirm() {
    const n = importPlan.filter((i) => i.choice !== 'skip').length;
    const btn = /** @type {HTMLButtonElement} */ (ref('importConfirm'));
    btn.textContent = n ? `Import ${n} skill${n === 1 ? '' : 's'}` : 'Nothing to import';
    btn.disabled = n === 0;
  }

  ref('importCancel').addEventListener('click', () => {
    importPlan = [];
    show('list');
    setStatus('Import cancelled. Nothing changed.');
  });

  ref('importConfirm').addEventListener('click', async () => {
    const btn = /** @type {HTMLButtonElement} */ (ref('importConfirm'));
    btn.disabled = true;
    try {
      const reply = await client.request(ToSW.SKILLS_IMPORT, { items: importPlan.map(({ skill, choice }) => ({ skill, choice })) });
      if (reply.type === ToPanel.SAVED) {
        store.set({ skills: reply.payload.skills });
        const { added, replaced, skipped } = reply.payload;
        const parts = [`Imported ${added}`];
        if (replaced) parts.push(`replaced ${replaced}`);
        if (skipped) parts.push(`skipped ${skipped}`);
        importPlan = [];
        show('list');
        setStatus(`${parts.join(', ')}.`, 'ok');
      } else {
        setStatus(reply.payload?.message ?? "Couldn't import the skills.", 'error');
        renderConfirm();
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Couldn't import the skills.", 'error');
      renderConfirm();
    }
  });

  // ---- Loading ----

  async function load() {
    try {
      const reply = await client.request(ToSW.SKILLS_GET, {});
      if (reply.type === ToPanel.SKILLS_STATE) store.set({ skills: reply.payload.skills });
    } catch {
      /* not connected yet: the next "connected" retries */
    }
  }

  store.subscribe((s) => s.skills, renderList);
  store.subscribe((s) => s.connection, (status) => {
    renderList();
    if (status === 'connected') load();
  });
  show('list');
  return { load };
}
