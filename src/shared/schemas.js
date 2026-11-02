// @ts-check
// JSON schemas sent to the model, plus hand-written validators (architecture §8.5).
// The schema guides the model; the validator is what the code trusts.

import { profileValue, resolve, templateVariables, unknownVariables } from './template.js';

/**
 * Gemini responseSchema (OpenAPI-style subset). Kept minimal — exact counts are enforced by
 * validateSummary, so a schema the API interprets differently can't break summaries.
 */
export const SummarySchema = Object.freeze({
  type: 'OBJECT',
  properties: {
    tldr: { type: 'STRING', description: 'One sentence, at most 30 words.' },
    keyPoints: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Exactly 5 key points.' },
    nextSteps: { type: 'ARRAY', items: { type: 'STRING' }, description: '1 to 3 practical next steps for the reader.' }
  },
  required: ['tldr', 'keyPoints', 'nextSteps']
});

/** Same shape in words, for the prompt (and for the no-schema fallback request). */
export const SUMMARY_SHAPE_TEXT =
  'Return only a JSON object: {"tldr": string, "keyPoints": [5 strings], "nextSteps": [1 to 3 strings]}.';

/** Video summary: the page summary plus chapter-style notes with start times (P1.5). */
export const VideoSummarySchema = Object.freeze({
  type: 'OBJECT',
  properties: {
    ...SummarySchema.properties,
    chapters: {
      type: 'ARRAY',
      description: '3 to 10 chapters covering the video in order.',
      items: {
        type: 'OBJECT',
        properties: {
          startSeconds: { type: 'INTEGER', description: 'Seconds from the start of the video where this part begins.' },
          title: { type: 'STRING', description: 'At most 8 words.' },
          notes: { type: 'STRING', description: 'One sentence about this part.' }
        },
        required: ['startSeconds', 'title']
      }
    }
  },
  required: ['tldr', 'keyPoints', 'nextSteps', 'chapters']
});

export const VIDEO_SUMMARY_SHAPE_TEXT =
  'Return only a JSON object: {"tldr": string, "keyPoints": [5 strings], "nextSteps": [1 to 3 strings], ' +
  '"chapters": [{"startSeconds": integer, "title": string, "notes": string}]}.';

/**
 * @typedef {{ tldr: string, keyPoints: string[], nextSteps: string[] }} Summary
 * @typedef {{ startSeconds: number, title: string, notes: string }} Chapter
 * @typedef {Summary & { chapters: Chapter[] }} VideoSummary
 * @typedef {{ ok: true, value: Summary } | { ok: false, error: string }} SummaryCheck
 */

/**
 * Accept 75, "75", "1:15" or "1:02:05" as a start time.
 * @param {unknown} value
 * @returns {number|null}
 */
function toSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/**
 * Validate a video summary. Chapters are cleaned rather than rejected: bad entries are dropped,
 * times past the end of the video are removed, and the rest are sorted and de-duplicated (EC-YT-09).
 * An empty chapter list is allowed — the card just hides it (EC-YT-08).
 * @param {unknown} value
 * @param {{ durationSeconds?: number|null }} [opts]
 * @returns {{ ok: true, value: VideoSummary } | { ok: false, error: string }}
 */
export function validateVideoSummary(value, opts = {}) {
  const base = validateSummary(value);
  if (!base.ok) return base;
  const raw = /** @type {Record<string, unknown>} */ (value).chapters;
  if (!Array.isArray(raw)) return { ok: false, error: '"chapters" must be an array of {startSeconds, title, notes}.' };

  const limit = opts.durationSeconds && Number.isFinite(opts.durationSeconds) ? opts.durationSeconds : Infinity;
  const seen = new Set();
  /** @type {Chapter[]} */
  const chapters = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const c = /** @type {Record<string, unknown>} */ (item);
    const start = toSeconds(c.startSeconds);
    const title = typeof c.title === 'string' ? c.title.trim() : '';
    if (start === null || !title || start >= limit || seen.has(start)) continue;
    seen.add(start);
    chapters.push({ startSeconds: start, title, notes: typeof c.notes === 'string' ? c.notes.trim() : '' });
  }
  chapters.sort((a, b) => a.startSeconds - b.startSeconds);
  return { ok: true, value: { ...base.value, chapters: chapters.slice(0, 20) } };
}

/** @param {unknown} list @returns {string[]|null} trimmed non-empty strings, or null if not a string array */
function cleanStrings(list) {
  if (!Array.isArray(list) || !list.every((s) => typeof s === 'string')) return null;
  // Drop list markers the model sometimes adds ("- ", "• ", "1. ", "2) "), but not real leading numbers.
  return list.map((s) => s.trim().replace(/^(?:[-*•]\s+|\d{1,2}[.)]\s+)/, '').trim()).filter(Boolean);
}

/**
 * Validate and normalise a model summary (EC-ART-15, EC-ART-16).
 * @param {unknown} value
 * @returns {SummaryCheck}
 */
export function validateSummary(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'Expected a JSON object with tldr, keyPoints and nextSteps.' };
  }
  const v = /** @type {Record<string, unknown>} */ (value);

  const tldr = typeof v.tldr === 'string' ? v.tldr.trim() : '';
  if (!tldr) return { ok: false, error: '"tldr" must be a non-empty string.' };
  if (tldr.length > 400) return { ok: false, error: '"tldr" must be one short sentence (at most 30 words).' };

  const keyPoints = cleanStrings(v.keyPoints);
  if (!keyPoints) return { ok: false, error: '"keyPoints" must be an array of strings.' };
  if (keyPoints.length !== 5) return { ok: false, error: `"keyPoints" must have exactly 5 items, but it has ${keyPoints.length}.` };

  const nextSteps = cleanStrings(v.nextSteps);
  if (!nextSteps) return { ok: false, error: '"nextSteps" must be an array of strings.' };
  if (nextSteps.length === 0) return { ok: false, error: '"nextSteps" must have at least 1 item.' };

  return { ok: true, value: { tldr, keyPoints, nextSteps: nextSteps.slice(0, 3) } };
}

/** Find it for me (architecture §11.6): which numbered element answers the user's question. */
export const FindSchema = Object.freeze({
  type: 'OBJECT',
  properties: {
    target: { type: 'INTEGER', nullable: true, description: 'The [number] of the one best element, or null if nothing matches.' },
    reason: { type: 'STRING', description: 'One short sentence: which element it is and why it fits.' },
    confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] }
  },
  required: ['target', 'reason', 'confidence']
});

export const FIND_SHAPE_TEXT =
  'Return only a JSON object: {"target": integer or null, "reason": string, "confidence": "high" | "medium" | "low"}.';

const CONFIDENCE = new Set(['high', 'medium', 'low']);

/**
 * @typedef {{ target: number|null, reason: string, confidence: 'high'|'medium'|'low' }} FindAnswer
 */

/**
 * Validate a find answer. A non-null target must be a numbered element of this snapshot, so a
 * made-up number is sent back for repair instead of highlighting nothing (P3.4).
 * @param {unknown} value
 * @param {{ ids: Set<number> }} snapshot the element ids of the scan the model was shown
 * @returns {{ ok: true, value: FindAnswer } | { ok: false, error: string }}
 */
export function validateFind(value, { ids }) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'Expected a JSON object with target, reason and confidence.' };
  }
  const v = /** @type {Record<string, unknown>} */ (value);

  if (!('target' in v)) return { ok: false, error: '"target" is required: an element number, or null.' };
  /** @type {number|null} */
  let target = null;
  if (typeof v.target === 'number') {
    target = v.target;
  } else if (typeof v.target === 'string' && v.target.trim() !== 'null') {
    const m = /^\[?\s*(\d+)\s*\]?$/.exec(v.target.trim()); // "8" or "[8]"
    if (!m) return { ok: false, error: '"target" must be an element number like 8, or null.' };
    target = Number(m[1]);
  } else if (v.target !== null && typeof v.target !== 'string') {
    return { ok: false, error: '"target" must be an element number like 8, or null.' };
  }
  if (target !== null && (!Number.isInteger(target) || !ids.has(target))) {
    return { ok: false, error: `"target" ${target} is not one of the [numbered] elements on this page. Use a number from the list, or null if nothing matches.` };
  }

  const reason = typeof v.reason === 'string' ? v.reason.trim() : '';
  if (!reason) return { ok: false, error: '"reason" must be a short sentence.' };

  const confidence = typeof v.confidence === 'string' ? v.confidence.trim().toLowerCase() : '';
  if (!CONFIDENCE.has(confidence)) return { ok: false, error: '"confidence" must be "high", "medium" or "low".' };

  return { ok: true, value: { target, reason: reason.slice(0, 300), confidence: /** @type {FindAnswer['confidence']} */ (confidence) } };
}

// ---- Agent step (architecture §12.3) ----

export const AGENT_ACTIONS = /** @type {const} */ (['click', 'type', 'select', 'scroll', 'done']);

/** The agent's next step. Nullable fields keep the schema flat enough for Gemini's subset. */
export const AgentActionSchema = Object.freeze({
  type: 'OBJECT',
  properties: {
    action: { type: 'STRING', enum: [...AGENT_ACTIONS] },
    target: { type: 'INTEGER', nullable: true, description: 'Element number from the action map. Required for click, type and select.' },
    value: { type: 'STRING', nullable: true, description: 'Text to type, or the option to select. May use {{profile.<field>}}.' },
    direction: { type: 'STRING', nullable: true, enum: ['up', 'down'], description: 'For scroll.' },
    reason: { type: 'STRING', description: 'One line, at most 120 characters, shown to the user.' },
    note: { type: 'STRING', nullable: true, description: 'A fact to remember for later steps, e.g. a collected row.' },
    result: { type: 'STRING', nullable: true, description: 'For done: the final answer. Markdown allowed, e.g. a table.' }
  },
  required: ['action', 'reason']
});

export const AGENT_ACTION_SHAPE_TEXT =
  'Return only a JSON object: {"action": "click" | "type" | "select" | "scroll" | "done", "target": integer or null, ' +
  '"value": string or null, "direction": "up" | "down" | null, "reason": string, "note": string or null, "result": string or null}.';

export const AGENT_VALUE_MAX = 500;
export const AGENT_REASON_MAX = 200;
const AGENT_NOTE_MAX = 500;
const AGENT_RESULT_MAX = 8_000;

/**
 * @typedef {typeof AGENT_ACTIONS[number]} AgentActionType
 * @typedef {{
 *   type: AgentActionType, target: number|null, value: string|null, direction: 'up'|'down'|null,
 *   reason: string, note: string|null, result: string|null
 * }} AgentAction
 * @typedef {'BAD_ACTION'|'BAD_TARGET'|'WRONG_ELEMENT_KIND'|'MISSING_VALUE'|'BAD_OPTION'|'MISSING_DIRECTION'
 *   |'MISSING_REASON'|'BAD_PROFILE_REF'} AgentActionError
 */

export { profileValue };

/** @param {string} value @returns {string[]} the profile paths a value refers to */
export function profileRefs(value) {
  return templateVariables(value).filter((v) => v.startsWith('profile.')).map((v) => v.slice('profile.'.length));
}

/**
 * Replace {{profile.x}} tokens with the user's values (pure). Call only after validateAgentAction,
 * which guarantees every token names a filled-in field; anything else throws a TemplateError.
 * @param {string} value
 * @param {Record<string, unknown>} profile
 */
export function resolveProfileRefs(value, profile) {
  return resolve(value, { profile }, { strict: true });
}

/** @param {string} s */
const norm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Does `value` name one of the options? Option labels may be cut short with '…' by the scanner.
 * @param {string} value
 * @param {string[]} options
 */
function matchesOption(value, options) {
  const v = norm(value);
  return options.some((o) => {
    const n = norm(o);
    return n === v || (n.endsWith('…') && v.startsWith(n.slice(0, -1)));
  });
}

/**
 * The options a `select` step may pick for this element, or null when any value must be allowed
 * (the list was cut short, so the executor has the final say).
 * @param {import('./action-map.js').ElementDescriptor} el
 * @param {import('./action-map.js').ElementDescriptor[]} elements
 * @returns {string[]|null}
 */
function optionsFor(el, elements) {
  if (el.role === 'radio') {
    // A radio stands for its whole group: the user picks one of its siblings by label.
    return elements
      .filter((d) => d.role === 'radio' && (d.group ?? '') === (el.group ?? '') && d.formId === el.formId)
      .map((d) => d.name);
  }
  const options = el.options ?? [];
  if (options.length === 0 || /^…\(\d+ more\)$/.test(options.at(-1) ?? '')) return null;
  return options;
}

const TYPE_ROLES = new Set(['textbox', 'searchbox']);
const SELECT_ROLES = new Set(['combobox', 'listbox', 'radio']);

/**
 * @param {unknown} v
 * @returns {string|null} a trimmed non-empty string, or null
 */
const optText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Validate the model's next step against the scan it was shown (architecture §12.3). Every failure
 * names what was wrong, so the gateway's repair re-ask can quote it back to the model.
 * @param {unknown} value
 * @param {{
 *   elements: import('./action-map.js').ElementDescriptor[],
 *   profile?: Record<string, unknown>,
 *   useProfile?: boolean
 * }} snapshot
 * @returns {{ ok: true, value: AgentAction } | { ok: false, code: AgentActionError, error: string }}
 */
export function validateAgentAction(value, { elements, profile = {}, useProfile = false }) {
  /** @param {AgentActionError} code @param {string} error */
  const fail = (code, error) => ({ ok: /** @type {const} */ (false), code, error });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('BAD_ACTION', 'Expected a JSON object with "action" and "reason".');
  }
  const v = /** @type {Record<string, unknown>} */ (value);

  const type = typeof v.action === 'string' ? v.action.trim().toLowerCase() : '';
  if (!(/** @type {readonly string[]} */ (AGENT_ACTIONS)).includes(type)) {
    return fail('BAD_ACTION', `"action" must be one of ${AGENT_ACTIONS.join(', ')}.`);
  }

  const reason = typeof v.reason === 'string' ? v.reason.trim() : '';
  if (!reason || reason.length > AGENT_REASON_MAX) {
    return fail('MISSING_REASON', `"reason" must be one short line (at most ${AGENT_REASON_MAX} characters).`);
  }

  /** @type {number|null} */
  let target = null;
  if (typeof v.target === 'number') target = v.target;
  else if (typeof v.target === 'string' && /^\[?\s*\d+\s*\]?$/.test(v.target.trim())) target = Number(v.target.replace(/\D/g, ''));

  const needsTarget = type === 'click' || type === 'type' || type === 'select';
  const el = target !== null && Number.isInteger(target) ? elements.find((d) => d.id === target) : undefined;
  if (needsTarget && !el) {
    return fail('BAD_TARGET', `"${type}" needs "target": the [number] of an element in the action map` +
      (target !== null ? `, and ${target} is not one of them.` : '.'));
  }

  // An <input role="combobox"> is a text box with suggestions (search fields), so it takes typing.
  if (type === 'type' && el && !TYPE_ROLES.has(el.role) && !(el.role === 'combobox' && el.tag === 'input')) {
    return fail('WRONG_ELEMENT_KIND', `[${el.id}] is a ${el.role}, not a text field. Use "type" only on text fields.`);
  }
  if (type === 'select' && el && !SELECT_ROLES.has(el.role) && el.tag !== 'select') {
    return fail('WRONG_ELEMENT_KIND', `[${el.id}] is a ${el.role}. Use "select" only on dropdowns and radio groups.`);
  }

  let text = typeof v.value === 'string' ? v.value : typeof v.value === 'number' ? String(v.value) : '';
  if (type === 'type' || type === 'select') {
    if (!text.trim() || text.length > AGENT_VALUE_MAX) {
      return fail('MISSING_VALUE', `"${type}" needs a non-empty "value" of at most ${AGENT_VALUE_MAX} characters.`);
    }
    for (const name of templateVariables(text)) {
      if (!name.startsWith('profile.')) return fail('BAD_PROFILE_REF', `{{${name}}} can't be used in a value. Only {{profile.<field>}} can.`);
    }
    for (const ref of profileRefs(text)) {
      if (!useProfile) return fail('BAD_PROFILE_REF', 'Profile values are switched off for this task. Write the value itself, or finish with "done".');
      if (!profileValue(profile, ref)) return fail('BAD_PROFILE_REF', `The profile has no "${ref}". Use only the profile fields listed.`);
    }
    if (type === 'select') {
      text = text.trim();
      const options = optionsFor(/** @type {import('./action-map.js').ElementDescriptor} */ (el), elements);
      const resolved = resolveProfileRefs(text, profile);
      if (options && !matchesOption(resolved, options)) {
        return fail('BAD_OPTION', `"${text}" is not an option of [${el?.id}]. Options: ${options.join(', ')}.`);
      }
    }
  }

  const direction = typeof v.direction === 'string' ? v.direction.trim().toLowerCase() : '';
  if (type === 'scroll' && direction !== 'up' && direction !== 'down') {
    return fail('MISSING_DIRECTION', '"scroll" needs "direction": "up" or "down".');
  }

  return {
    ok: true,
    value: {
      type: /** @type {AgentActionType} */ (type),
      // Scroll may name the box to scroll; done and stray targets on other steps are dropped.
      target: needsTarget || (type === 'scroll' && el) ? /** @type {number} */ (target) : null,
      value: type === 'type' || type === 'select' ? text : null,
      direction: type === 'scroll' ? /** @type {'up'|'down'} */ (direction) : null,
      reason,
      note: optText(v.note)?.slice(0, AGENT_NOTE_MAX) ?? null,
      result: type === 'done' ? optText(v.result)?.slice(0, AGENT_RESULT_MAX) ?? null : null
    }
  };
}

// ---- Skills (architecture §13.2, P4.2) ----

export const SKILL_MODES = /** @type {const} */ (['answer', 'agent']);
export const SKILL_NEEDS = /** @type {const} */ (['page', 'selection', 'profile']);
export const SKILL_LANGUAGES = /** @type {const} */ (['inherit', 'en', 'hinglish']);
export const SKILL_NAME_MAX = 60;
export const SKILL_PROMPT_MAX = 4_000;
/** One or two emoji, or a short symbol. */
const SKILL_ICON_MAX = 8;
const SKILL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The only fields a skill has. Anything else, in storage or in an imported file, is dropped (EC-SKL-09).
 * @typedef {{
 *   id: string, name: string, icon: string, mode: typeof SKILL_MODES[number], prompt: string,
 *   needs: Array<typeof SKILL_NEEDS[number]>, language: typeof SKILL_LANGUAGES[number],
 *   createdAt: number, updatedAt: number
 * }} Skill
 */
export const SkillSchema = Object.freeze({
  id: { type: 'string', pattern: SKILL_ID_RE.source },
  name: { type: 'string', minLength: 1, maxLength: SKILL_NAME_MAX },
  icon: { type: 'string', maxLength: SKILL_ICON_MAX },
  mode: { type: 'string', enum: [...SKILL_MODES] },
  prompt: { type: 'string', minLength: 1, maxLength: SKILL_PROMPT_MAX },
  needs: { type: 'array', items: [...SKILL_NEEDS] },
  language: { type: 'string', enum: [...SKILL_LANGUAGES] },
  createdAt: { type: 'number' },
  updatedAt: { type: 'number' }
});
const SKILL_FIELDS = Object.keys(SkillSchema);

export const SKILL_FILE_FORMAT = 'pagewise-skills';
export const SKILL_FILE_VERSION = 1;
export const SKILL_FILE_MAX_BYTES = 256 * 1024;
export const SKILLS_MAX = 200;
/** The export file (architecture §13.2). Nothing else is ever written to it (EC-SKL-16). */
export const SkillFileSchema = Object.freeze({
  format: { type: 'string', const: SKILL_FILE_FORMAT },
  version: { type: 'number', const: SKILL_FILE_VERSION },
  exportedAt: { type: 'string', format: 'date-time' },
  skills: { type: 'array', maxItems: SKILLS_MAX, items: SkillSchema }
});

/**
 * What a template needs collected before it runs: `{{page}}` needs the page, and so on.
 * @param {string} prompt
 * @returns {Array<typeof SKILL_NEEDS[number]>}
 */
export function needsOf(prompt) {
  const vars = templateVariables(prompt);
  return SKILL_NEEDS.filter((need) => need === 'profile' ? vars.some((v) => v.startsWith('profile.')) : vars.includes(need));
}

/**
 * Check one skill, from the editor, storage or a file (pure). Unknown fields are dropped. `needs`
 * always includes what the template uses. A missing id is made with `newId`, missing times with `now`.
 * @param {unknown} raw
 * @param {{ newId: () => string, now: number }} opts
 * @returns {{ ok: true, value: Skill, warnings: Record<string, string> } | { ok: false, errors: Record<string, string> }}
 */
export function validateSkill(raw, { newId, now }) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: { _: 'Not a skill.' } };
  const r = /** @type {Record<string, unknown>} */ (raw);
  /** @type {Record<string, string>} */
  const errors = {};
  /** @type {Record<string, string>} */
  const warnings = {};

  const name = typeof r.name === 'string' ? r.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) errors.name = 'Give the skill a name.';
  else if (name.length > SKILL_NAME_MAX) errors.name = `Keep the name to ${SKILL_NAME_MAX} characters.`;

  const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : '';
  if (!prompt) errors.prompt = 'Write what the skill should do.';
  else if (prompt.length > SKILL_PROMPT_MAX) errors.prompt = `Keep the prompt to ${SKILL_PROMPT_MAX.toLocaleString('en')} characters.`;

  const mode = (/** @type {readonly unknown[]} */ (SKILL_MODES)).includes(r.mode) ? /** @type {Skill['mode']} */ (r.mode) : null;
  if (!mode) errors.mode = 'Choose "answer" or "agent".';

  if (Object.keys(errors).length) return { ok: false, errors };

  const unknown = unknownVariables(prompt);
  if (unknown.length) {
    warnings.prompt = `Pagewise doesn't know ${unknown.map((v) => `{{${v}}}`).join(', ')}. ` +
      (mode === 'agent' ? 'An agent skill stops with an error when it runs.' : 'It will be left blank.');
  }

  const declared = Array.isArray(r.needs) ? r.needs : [];
  const needs = SKILL_NEEDS.filter((n) => declared.includes(n) || needsOf(prompt).includes(n));
  const icon = typeof r.icon === 'string' ? [...r.icon.trim()].slice(0, 2).join('').slice(0, SKILL_ICON_MAX) : '';
  const time = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : now);
  const createdAt = time(r.createdAt);

  return {
    ok: true,
    warnings,
    value: {
      id: typeof r.id === 'string' && SKILL_ID_RE.test(r.id) ? r.id : newId(),
      name,
      icon,
      mode,
      prompt,
      needs,
      language: (/** @type {readonly unknown[]} */ (SKILL_LANGUAGES)).includes(r.language) ? /** @type {Skill['language']} */ (r.language) : 'inherit',
      createdAt,
      updatedAt: Math.max(time(r.updatedAt), createdAt)
    }
  };
}

/** Only the whitelisted fields, in a fixed order (EC-SKL-16). @param {Skill} skill @returns {Skill} */
const pickSkill = (skill) => /** @type {Skill} */ (Object.fromEntries(SKILL_FIELDS.map((k) => [k, /** @type {any} */ (skill)[k]])));

/**
 * The export file's contents (pure). Only skills: never settings, keys or the profile (EC-SKL-16).
 * @param {Skill[]} skills
 * @param {number} now
 */
export function buildSkillExport(skills, now) {
  return { format: SKILL_FILE_FORMAT, version: SKILL_FILE_VERSION, exportedAt: new Date(now).toISOString(), skills: skills.map(pickSkill) };
}

/** `pagewise-skills-20261102.json`, by the local date. @param {Date} date */
export function skillExportFileName(date) {
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `pagewise-skills-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}.json`;
}

/** Keys an import never keeps, at any depth (prototype-pollution guard, EC-SKL-09). */
const POISON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Read a skills file (pure): size, JSON, format and version, then each skill (architecture §13.2).
 * Invalid skills are skipped and counted; the file is rejected only if nothing in it is usable.
 * @param {string} text the file's contents
 * @param {{ newId: () => string, now: number }} opts
 * @returns {{ ok: true, skills: Skill[], skipped: number, warnings: string[] } | { ok: false, error: string }}
 */
export function parseSkillFile(text, opts) {
  const NOT_A_FILE = "This isn't a Pagewise skills file.";
  if (typeof text !== 'string') return { ok: false, error: NOT_A_FILE };
  if (new TextEncoder().encode(text).length > SKILL_FILE_MAX_BYTES) {
    return { ok: false, error: `This file is too big. A skills file can be at most ${SKILL_FILE_MAX_BYTES / 1024} KB.` };
  }
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(text, (key, value) => (POISON_KEYS.has(key) ? undefined : value));
  } catch {
    return { ok: false, error: NOT_A_FILE }; // EC-SKL-07: not JSON, e.g. an image renamed to .json
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ok: false, error: NOT_A_FILE };
  const d = /** @type {Record<string, unknown>} */ (data);
  if (d.format !== SKILL_FILE_FORMAT) return { ok: false, error: NOT_A_FILE };
  if (typeof d.version === 'number' && d.version > SKILL_FILE_VERSION) {
    return { ok: false, error: 'This file was made with a newer Pagewise. Update Pagewise, then import it again.' };
  }
  if (d.version !== SKILL_FILE_VERSION) return { ok: false, error: "This skills file's version isn't supported." };
  if (!Array.isArray(d.skills)) return { ok: false, error: NOT_A_FILE };
  if (d.skills.length > SKILLS_MAX) return { ok: false, error: `This file has more than ${SKILLS_MAX} skills.` };

  /** @type {Skill[]} */
  const skills = [];
  /** @type {string[]} */
  const warnings = [];
  for (const raw of d.skills) {
    const result = validateSkill(raw, opts);
    if (!result.ok) continue;
    skills.push(result.value);
    if (result.warnings.prompt) warnings.push(`${result.value.name}: ${result.warnings.prompt}`);
  }
  const skipped = d.skills.length - skills.length;
  if (skills.length === 0) {
    return { ok: false, error: d.skills.length ? "None of the skills in this file are valid, so nothing was imported." : 'This file has no skills in it.' };
  }
  return { ok: true, skills, skipped, warnings };
}

/** @param {string} name */
const nameKey = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * @typedef {'add'|'replace'|'keep-both'|'skip'} ImportChoice add: no conflict; the others answer a conflict
 */

/**
 * Which imported skills clash with saved ones by name (pure). Each conflict defaults to 'skip'.
 * @param {Skill[]} existing
 * @param {Skill[]} incoming
 * @returns {Array<{ skill: Skill, conflict: Skill|null, choice: ImportChoice }>}
 */
export function planImport(existing, incoming) {
  const byName = new Map(existing.map((s) => [nameKey(s.name), s]));
  return incoming.map((skill) => {
    const conflict = byName.get(nameKey(skill.name)) ?? null;
    return { skill, conflict, choice: conflict ? 'skip' : 'add' };
  });
}

/**
 * Merge imported skills into the saved list (pure). Imported ids are never trusted: added skills
 * get new ids, and a replaced skill keeps the id of the one it replaces.
 * @param {Skill[]} existing
 * @param {Array<{ skill: Skill, choice: ImportChoice }>} items
 * @param {{ newId: () => string, now: number }} opts
 * @returns {{ skills: Skill[], added: number, replaced: number, skipped: number }}
 */
export function applyImport(existing, items, { newId, now }) {
  const skills = [...existing];
  let added = 0;
  let replaced = 0;
  let skipped = 0;
  for (const { skill, choice } of items) {
    const at = skills.findIndex((s) => nameKey(s.name) === nameKey(skill.name));
    if (choice === 'skip' || (choice === 'add' && at !== -1)) {
      skipped++;
    } else if (choice === 'replace' && at !== -1) {
      skills[at] = { ...pickSkill(skill), id: skills[at].id, createdAt: skills[at].createdAt, updatedAt: now };
      replaced++;
    } else if (skills.length >= SKILLS_MAX) {
      skipped++;
    } else {
      // 'keep-both' marks the copy so the two can be told apart (EC-SKL-05).
      const name = choice === 'keep-both' && at !== -1 ? `${skill.name} (imported)`.slice(0, SKILL_NAME_MAX) : skill.name;
      skills.push({ ...pickSkill(skill), id: newId(), name, createdAt: now, updatedAt: now });
      added++;
    }
  }
  return { skills, added, replaced, skipped };
}
