// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mountSkillsView } from '../src/sidepanel/views/skills-view.js';
import { createStore } from '../src/sidepanel/store.js';
import { starterSkills } from '../src/shared/default-skills.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const SKILLS = starterSkills(1);

function setup({ skills = SKILLS, replies = {} } = {}) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const store = createStore({ skills: null, activeTab: { tabId: 7 }, connection: 'connected' });
  const sent = [];
  const ran = [];
  const agentStates = [];
  let release = () => {};
  const client = {
    request: async (type, payload) => {
      sent.push({ type, payload });
      if (type === 'SKILLS_GET') return { type: 'SKILLS_STATE', payload: { skills } };
      return replies[type]?.(payload) ?? { type: 'ERROR', payload: { code: 'INTERNAL', message: 'no reply' } };
    }
  };
  mountSkillsView(root, {
    store, client, openSettings: () => {},
    runAnswer: (skill) => { ran.push(skill.id); return new Promise((r) => { release = r; }); },
    onAgentState: (p) => agentStates.push(p)
  });
  const $ = (sel) => root.querySelector(sel);
  const $$ = (sel) => [...root.querySelectorAll(sel)];
  return { root, store, sent, ran, agentStates, $, $$, release: () => release() };
}

describe('skills view (P4.2)', () => {
  it('lists skills with names as text only (EC-SKL-10)', async () => {
    const evil = { ...SKILLS[0], id: 'x', name: '<img src=x onerror=alert(1)>' };
    const { $, $$ } = setup({ skills: [evil] });
    await tick();
    expect($('.skill-name').textContent).toBe('<img src=x onerror=alert(1)>');
    expect($$('img')).toHaveLength(0);
  });

  it('runs an answer skill once, ignoring clicks while it runs (EC-SKL-15)', async () => {
    const { $, ran, release } = setup();
    await tick();
    const run = $('[aria-label="Run Exam notes"]');
    run.click();
    await tick();
    $('[aria-label="Run Exam notes"]').click();
    expect(ran).toEqual(['starter-exam-notes']);
    expect($('[aria-label="Run Exam notes"]').disabled).toBe(true);
    release();
    await tick();
    expect($('[aria-label="Run Exam notes"]').disabled).toBe(false);
  });

  it('runs an agent skill through RUN_SKILL and hands the task to the Agent tab', async () => {
    const { $, sent, agentStates } = setup({ replies: { RUN_SKILL: () => ({ type: 'AGENT_STATE', payload: { task: { taskId: 't1' } } }) } });
    await tick();
    $('[aria-label="Run Fill this form from my profile"]').click();
    await tick();
    expect(sent.find((m) => m.type === 'RUN_SKILL').payload).toEqual({ skillId: 'starter-fill-form', tabId: 7 });
    expect(agentStates).toEqual([{ task: { taskId: 't1' } }]);
  });

  it('shows why an agent skill could not start', async () => {
    const { $ } = setup({ replies: { RUN_SKILL: () => ({ type: 'ERROR', payload: { code: 'PROFILE_EMPTY', message: 'Your profile is empty.' } }) } });
    await tick();
    $('[aria-label="Run Fill this form from my profile"]').click();
    await tick();
    expect($('[data-ref="notice"]').textContent).toMatch(/profile is empty/);
  });

  it('disables Export with a hint when there are no skills (EC-SKL-13)', async () => {
    const { $ } = setup({ skills: [] });
    await tick();
    expect($('[data-ref="exportBtn"]').disabled).toBe(true);
    expect($('[data-ref="exportHint"]').hidden).toBe(false);
  });

  it('editor ticks needs from the prompt and warns about unknown variables (EC-SKL-03)', async () => {
    const { $ } = setup();
    await tick();
    $('[data-ref="newBtn"]').click();
    const prompt = $('[data-field="prompt"]');
    prompt.value = 'Flashcards from {{page}} for {{pagee}}';
    prompt.dispatchEvent(new Event('input'));
    expect($('[data-need="page"]').checked).toBe(true);
    expect($('[data-need="page"]').disabled).toBe(true);
    expect($('[data-msg="prompt"]').textContent).toMatch(/\{\{pagee\}\}/);
  });

  it('saves a new skill through the service worker and returns to the list', async () => {
    const { $, sent, store } = setup({
      replies: { SKILLS_SAVE: (p) => ({ type: 'SAVED', payload: { skill: { ...p.skill, id: 'n1' }, skills: [...SKILLS, { ...SKILLS[0], ...p.skill, id: 'n1' }], warnings: {} } }) }
    });
    await tick();
    $('[data-ref="newBtn"]').click();
    $('[data-field="name"]').value = 'Make flashcards from this page';
    $('[data-field="prompt"]').value = 'Ten flashcards from {{page}}';
    $('[data-field="prompt"]').dispatchEvent(new Event('input'));
    $('[data-ref="editor"]').dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(sent.find((m) => m.type === 'SKILLS_SAVE').payload.skill).toEqual({
      name: 'Make flashcards from this page', icon: '', mode: 'answer', prompt: 'Ten flashcards from {{page}}', language: 'inherit', needs: ['page']
    });
    expect($('[data-ref="editor"]').hidden).toBe(true);
    expect(store.get().skills).toHaveLength(5);
  });

  it('delete needs a second click', async () => {
    const { $, sent } = setup({ replies: { SKILLS_DELETE: () => ({ type: 'SKILLS_STATE', payload: { skills: SKILLS.slice(1) } }) } });
    await tick();
    $('[aria-label="Delete Exam notes"]').click();
    expect(sent.some((m) => m.type === 'SKILLS_DELETE')).toBe(false);
    $('[aria-label="Delete Exam notes"]').click();
    await tick();
    expect(sent.find((m) => m.type === 'SKILLS_DELETE').payload).toEqual({ skillId: 'starter-exam-notes' });
  });
});
