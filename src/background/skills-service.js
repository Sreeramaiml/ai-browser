// @ts-check
// Saved skills (architecture §13.2, P4.2): the only writer of `skills`. Create, edit, delete and
// import go through here so every skill is validated in one place, whatever the panel sent.

import { ToPanel, ToSW, makeMessage } from '../shared/messages.js';
import { SKILLS_MAX, applyImport, validateSkill } from '../shared/schemas.js';
import { StorageError, createStorage } from '../shared/storage.js';
import { broadcast, on } from './router.js';

/**
 * @typedef {import('../shared/schemas.js').Skill} Skill
 * @typedef {import('../shared/schemas.js').ImportChoice} ImportChoice
 * @typedef {{ type: string, payload: any }} Reply
 */

const CHOICES = new Set(['add', 'replace', 'keep-both', 'skip']);
const TOO_MANY = `You can keep up to ${SKILLS_MAX} skills. Delete some first.`;

/** @param {string} name */
const nameKey = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * @param {{
 *   storage: ReturnType<typeof createStorage>,
 *   now?: () => number,
 *   newId?: () => string
 * }} deps
 */
export function createSkillsService({ storage, now = Date.now, newId = () => crypto.randomUUID() }) {
  /** @param {unknown} err @returns {Reply} */
  function storageFailure(err) {
    if (err instanceof StorageError) return { type: ToPanel.ERROR, payload: { code: err.code, message: err.message } };
    throw err;
  }

  return {
    /** @returns {Promise<Reply>} */
    async get() {
      return { type: ToPanel.SKILLS_STATE, payload: { skills: await storage.getSkills() } };
    },

    /**
     * Create a skill (no id, or an id that's gone) or update one.
     * @param {{ skill?: unknown }} payload
     * @returns {Promise<Reply>}
     */
    async save(payload) {
      const t = now();
      const checked = validateSkill(payload?.skill, { newId, now: t });
      if (!checked.ok) return { type: ToPanel.VALIDATION_ERROR, payload: { errors: checked.errors } };
      const warnings = { ...checked.warnings };
      try {
        const result = await storage.updateSkills((skills) => {
          const at = skills.findIndex((s) => s.id === checked.value.id);
          if (at === -1 && skills.length >= SKILLS_MAX) return { skills, result: null };
          const skill = at === -1
            ? { ...checked.value, createdAt: t, updatedAt: t }
            : { ...checked.value, createdAt: skills[at].createdAt, updatedAt: t };
          // A duplicate name is allowed, with a hint (EC-SKL-05).
          if (skills.some((s) => s.id !== skill.id && nameKey(s.name) === nameKey(skill.name))) {
            warnings.name = 'Another skill already has this name.';
          }
          const next = at === -1 ? [...skills, skill] : skills.map((s, i) => (i === at ? skill : s));
          return { skills: next, result: { skill, skills: next } };
        });
        if (!result) return { type: ToPanel.VALIDATION_ERROR, payload: { errors: { _: TOO_MANY } } };
        return { type: ToPanel.SAVED, payload: { ...result, warnings } };
      } catch (err) {
        return storageFailure(err);
      }
    },

    /**
     * @param {{ skillId?: unknown }} payload
     * @returns {Promise<Reply>}
     */
    async remove(payload) {
      try {
        const skills = await storage.updateSkills((all) => {
          const next = all.filter((s) => s.id !== payload?.skillId);
          return { skills: next, result: next };
        });
        return { type: ToPanel.SKILLS_STATE, payload: { skills } };
      } catch (err) {
        return storageFailure(err);
      }
    },

    /**
     * Save the skills the user kept in the import preview. The panel parsed the file, but every
     * skill is checked again here, and imported ids are never reused (architecture §13.2).
     * @param {{ items?: Array<{ skill?: unknown, choice?: unknown }> }} payload
     * @returns {Promise<Reply>}
     */
    async import(payload) {
      const t = now();
      const items = Array.isArray(payload?.items) ? payload.items.slice(0, SKILLS_MAX) : [];
      /** @type {Array<{ skill: Skill, choice: ImportChoice }>} */
      const valid = [];
      let invalid = 0;
      for (const item of items) {
        const checked = validateSkill(item?.skill, { newId, now: t });
        if (!checked.ok) invalid++;
        else valid.push({ skill: checked.value, choice: CHOICES.has(/** @type {string} */ (item.choice)) ? /** @type {ImportChoice} */ (item.choice) : 'skip' });
      }
      try {
        const outcome = await storage.updateSkills((skills) => {
          const merged = applyImport(skills, valid, { newId, now: t });
          return { skills: merged.skills, result: merged };
        });
        return { type: ToPanel.SAVED, payload: { ...outcome, skipped: outcome.skipped + invalid } };
      } catch (err) {
        return storageFailure(err);
      }
    }
  };
}

/** Wire the service into the router. Call synchronously at the worker's top level. */
export function initSkillsService() {
  const storage = createStorage(chrome.storage.local);
  const service = createSkillsService({ storage });

  /** @param {(payload: any) => Promise<Reply>} run @returns {import('./router.js').Handler} */
  const reply = (run) => async (payload, { port }, msg) => {
    const r = await run(payload);
    port.postMessage(makeMessage(r.type, r.payload, msg.requestId));
  };

  on(ToSW.SKILLS_GET, reply(() => service.get()));
  on(ToSW.SKILLS_SAVE, reply((p) => service.save(p)));
  on(ToSW.SKILLS_DELETE, reply((p) => service.remove(p)));
  on(ToSW.SKILLS_IMPORT, reply((p) => service.import(p)));

  // Keep every open panel's list current, whichever window changed it (or Clear all my data).
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== 'local' || !('skills' in changes)) return;
    broadcast(makeMessage(ToPanel.SKILLS_STATE, { skills: await storage.getSkills() }));
  });

  return service;
}
