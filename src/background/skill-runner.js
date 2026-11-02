// @ts-check
// RUN_SKILL (architecture §13.2, P4.2): run a saved skill on the current page. Collect what the
// skill needs (page, selection, profile), fill in its template, then either stream an answer into
// the Chat tab or start an agent task, which goes through every safety and approval rule.

import { AGENT_GOAL_MAX_CHARS, PAGE_TEXT_CHAR_BUDGET } from '../shared/config.js';
import { isLanguage } from '../shared/language.js';
import { ToPanel, ToSW, makeMessage } from '../shared/messages.js';
import { wrapUntrusted } from '../shared/prompts/_common.js';
import { buildSkillPrompt } from '../shared/prompts/skill.js';
import { createStorage } from '../shared/storage.js';
import { TemplateError, resolve, templateVariables } from '../shared/template.js';
import { FeatureError } from './feature-error.js';
import { createDefaultGateway } from './llm/default-gateway.js';
import { LlmError } from './llm/errors.js';
import { chromePageGuard } from './page-guard.js';
import { on } from './router.js';
import { streamInLanguage, streamingHandler } from './streaming.js';
import { readPageText, readSelection } from './tab-context.js';

/**
 * @typedef {import('../shared/schemas.js').Skill} Skill
 * @typedef {{ skillId?: string, tabId?: number, language?: string }} RunSkillPayload
 * @typedef {{
 *   page: { text: string, title: string, url: string, truncated: boolean } | null,
 *   selection: string, profile: Record<string, unknown>, url: string, title: string
 * }} Collected
 */

/**
 * @param {{
 *   gateway: ReturnType<typeof import('./llm/gateway.js').createGateway>,
 *   getSkills: () => Promise<Skill[]>,
 *   getProfile: () => Promise<Record<string, unknown>>,
 *   getLanguage: () => Promise<string>,
 *   getTab: (tabId: number) => Promise<{ url: string, title: string }>,
 *   getPage: (tabId: number) => Promise<{ text: string, title?: string, url?: string }>,
 *   getSelection: (tabId: number) => Promise<{ text: string, protected?: boolean }>,
 *   startAgent: (payload: { tabId: number, goal: string, options: { useProfile: boolean } }, ctx: { windowId: number }) => Promise<unknown>,
 *   checkPage?: (tabId: number) => Promise<unknown>
 * }} deps checkPage: the page-tier "read" check (§14.2); throws to refuse
 */
export function createSkillRunner({
  gateway, getSkills, getProfile, getLanguage, getTab, getPage, getSelection, startAgent, checkPage = async () => {}
}) {
  /** @param {RunSkillPayload} payload @returns {Promise<Skill>} */
  async function load(payload) {
    const skill = (await getSkills()).find((s) => s.id === payload?.skillId);
    if (!skill) throw new FeatureError('SKILL_NOT_FOUND', "That skill doesn't exist any more. It may have been deleted in another window.");
    return skill;
  }

  /**
   * Everything the skill's template needs, or a clear reason it can't run here.
   * @param {Skill} skill
   * @param {RunSkillPayload} payload
   * @returns {Promise<Collected>}
   */
  async function collect(skill, payload) {
    const needs = new Set(skill.needs);
    /** @type {Collected} */
    const out = { page: null, selection: '', profile: {}, url: '', title: '' };

    // Before touching the page: an empty profile is the user's to fix (EC-PRF-01).
    if (needs.has('profile')) {
      out.profile = await getProfile();
      if (Object.keys(out.profile).length === 0) {
        throw new FeatureError('PROFILE_EMPTY', 'This skill uses your profile, which is empty. Add your details in Settings → Profile.');
      }
    }

    const tabId = payload.tabId;
    // Anything taken from the page, even its address or title, needs a tier-0 page (§14.2).
    const vars = templateVariables(skill.prompt);
    const usesPage = needs.has('page') || needs.has('selection') || vars.includes('url') || vars.includes('title');
    if (typeof tabId !== 'number') {
      if (usesPage || skill.mode === 'agent') {
        throw new FeatureError('PAGE_RESTRICTED', 'Open a web page first, then run this skill.');
      }
      return out;
    }
    if (!usesPage) return out;
    const tab = await getTab(tabId);
    await checkPage(tabId);
    out.url = tab.url;
    out.title = tab.title;

    if (needs.has('selection')) {
      const sel = await getSelection(tabId);
      if (sel.protected) throw new FeatureError('PROTECTED_FIELD', 'Sahayak never reads password, OTP or card fields.');
      out.selection = (sel.text ?? '').trim();
      if (!out.selection) throw new FeatureError('NO_SELECTION', 'Select some text first, then run this skill.'); // EC-SKL-01
    }
    if (needs.has('page')) {
      const page = await getPage(tabId);
      const text = (page.text ?? '').trim();
      if (!text) throw new FeatureError('NOT_ENOUGH_TEXT', "This page doesn't have any text this skill can use.");
      out.page = {
        text: text.slice(0, PAGE_TEXT_CHAR_BUDGET), truncated: text.length > PAGE_TEXT_CHAR_BUDGET,
        title: page.title || tab.title, url: tab.url || page.url || ''
      };
    }
    return out;
  }

  /** @param {Skill} skill @param {RunSkillPayload} payload */
  async function languageFor(skill, payload) {
    if (skill.language !== 'inherit') return skill.language;
    return isLanguage(payload.language) ? /** @type {string} */ (payload.language) : getLanguage();
  }

  return {
    load,

    /**
     * Answer mode: one streamed answer. The profile's values reach the model only through the
     * template's own {{profile.*}} variables, and the panel shows a chip when they do.
     * @param {RunSkillPayload} payload
     * @param {import('./streaming.js').StreamIO} io
     */
    async runAnswer(payload, io) {
      const skill = await load(payload);
      if (skill.mode !== 'answer') throw new FeatureError('UNKNOWN_ACTION', 'This skill starts an agent task.');
      const got = await collect(skill, payload);
      const language = await languageFor(skill, payload);
      io.onStart({
        kind: 'skill', skillId: skill.id, name: skill.name, icon: skill.icon, profileUsed: skill.needs.includes('profile')
      });
      const { system, turns } = buildSkillPrompt({ prompt: skill.prompt, language, ...got });
      const { text, model, provider, stopReason } = await streamInLanguage(gateway, { task: 'skill', system, turns }, language, io);
      return { text, model, provider, stopReason };
    },

    /**
     * Agent mode: the filled-in template is the goal. {{profile.*}} tokens stay tokens, so the
     * model sees field names only; the approval card shows each value (architecture §12.5).
     * @param {RunSkillPayload} payload
     * @param {{ windowId: number }} ctx
     */
    async runAgent(payload, ctx) {
      const skill = await load(payload);
      if (skill.mode !== 'agent') throw new FeatureError('UNKNOWN_ACTION', 'This skill gives an answer, not an agent task.');
      const got = await collect(skill, payload);
      let goal;
      try {
        goal = resolve(skill.prompt, {
          profile: got.profile,
          page: got.page ? wrapUntrusted('page_content', got.page.text) : '',
          selection: got.selection ? wrapUntrusted('selection', got.selection) : '',
          url: got.url, title: got.title, language: await languageFor(skill, payload)
        }, { strict: true, keepProfile: true }); // EC-SKL-03: unknown or empty variables stop an agent skill
      } catch (err) {
        if (!(err instanceof TemplateError)) throw err;
        throw new FeatureError('SKILL_TEMPLATE', err.code === 'EMPTY_VARIABLE' && err.variables.every((v) => v.startsWith('profile.'))
          ? `${err.message} Add it in Settings → Profile, or edit the skill.`
          : `${err.message} Edit the skill to fix it.`);
      }
      if (goal.trim().length > AGENT_GOAL_MAX_CHARS) {
        throw new FeatureError('SKILL_TEMPLATE', `Filled in, this skill's goal is longer than ${AGENT_GOAL_MAX_CHARS.toLocaleString('en')} characters. Shorten the skill, or use a shorter selection.`);
      }
      return startAgent({ tabId: /** @type {number} */ (payload.tabId), goal, options: { useProfile: skill.needs.includes('profile') } }, ctx);
    }
  };
}

/**
 * Wire RUN_SKILL into the router. Call synchronously at the worker's top level.
 * @param {{ startAgent: (payload: any, ctx: { windowId: number }) => Promise<unknown> }} deps
 */
export function initSkillRunner({ startAgent }) {
  const storage = createStorage(chrome.storage.local);
  const guard = chromePageGuard();
  const runner = createSkillRunner({
    gateway: createDefaultGateway(),
    getSkills: () => storage.getSkills(),
    getProfile: () => storage.getProfile(),
    getLanguage: async () => (await storage.getSettings()).language,
    getTab: async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      return { url: tab.url ?? tab.pendingUrl ?? '', title: tab.title ?? '' };
    },
    getPage: readPageText,
    getSelection: readSelection,
    startAgent,
    checkPage: (tabId) => guard.assert(tabId, 'read')
  });

  const answer = streamingHandler((payload, io) => runner.runAnswer(payload, io));

  // One message for both modes: an answer streams back like a quick action; an agent skill
  // replies with the new task's AGENT_STATE.
  on(ToSW.RUN_SKILL, async (payload, ctx, msg) => {
    let skill;
    try {
      skill = await runner.load(payload);
    } catch (err) {
      if (!(err instanceof FeatureError)) throw err;
      ctx.port.postMessage(makeMessage(ToPanel.ERROR, err.toPayload(), msg.requestId));
      return;
    }
    if (skill.mode === 'answer') {
      await answer(payload, ctx, msg);
      return;
    }
    try {
      const task = await runner.runAgent(payload, { windowId: ctx.windowId });
      ctx.port.postMessage(makeMessage(ToPanel.AGENT_STATE, { task }, msg.requestId));
    } catch (err) {
      if (!(err instanceof FeatureError) && !(err instanceof LlmError)) throw err; // router: generic INTERNAL
      ctx.port.postMessage(makeMessage(ToPanel.ERROR, err.toPayload(), msg.requestId));
    }
  });
}
