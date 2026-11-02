// @ts-check
// Typed access to chrome.storage.local (architecture §7.1): defaults, validation, migrations.
// Only the service worker writes; the area is injected so everything here is unit testable.

import {
  AGENT_DEFAULT_MAX_STEPS, AGENT_HARD_MAX_STEPS, LANGUAGES, MODELS, TONES, TRANSLATE_TARGETS
} from './config.js';
import { starterSkills } from './default-skills.js';
import { looksLikeSecretValue } from './safety/field-rules.js';
import { SKILLS_MAX, validateSkill } from './schemas.js';

export const SCHEMA_VERSION = 3;

/**
 * @typedef {{
 *   language: keyof typeof LANGUAGES,
 *   translateTarget: keyof typeof TRANSLATE_TARGETS,
 *   tone: keyof typeof TONES,
 *   models: Partial<Record<keyof typeof MODELS, string>>,
 *   agent: { maxSteps: number, dryRunDefault: boolean },
 *   useBuiltinAI: boolean,
 *   groqEnabled: boolean,
 *   redactContacts: boolean
 * }} Settings redactContacts: also hide emails and phone numbers from the AI (EC-RED-09)
 * @typedef {{ geminiKey?: string, groqKey?: string }} Secrets
 * @typedef {'gemini'|'groq'} KeyProvider
 * @typedef {{ saved: boolean, masked: string|null }} SecretStatus
 * @typedef {{
 *   get: (keys: string[]) => Promise<Record<string, any>>,
 *   set: (items: Record<string, any>) => Promise<void>,
 *   remove: (keys: string[]) => Promise<void>
 * }} StorageArea
 */

/** @returns {Settings} */
export function defaultSettings() {
  return {
    language: 'en',
    translateTarget: 'hi',
    tone: 'polite',
    models: {},
    agent: { maxSteps: AGENT_DEFAULT_MAX_STEPS, dryRunDefault: false },
    useBuiltinAI: false,
    groqEnabled: false,
    redactContacts: false
  };
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = (value, allowed, fallback) => (Object.hasOwn(allowed, value) ? value : fallback);
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

/** Clamp an agent step limit to [1, AGENT_HARD_MAX_STEPS] (EC-SET-12). */
export function clampMaxSteps(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return AGENT_DEFAULT_MAX_STEPS;
  return Math.min(AGENT_HARD_MAX_STEPS, Math.max(1, Math.round(n)));
}

const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** @returns {Settings['models']} */
function normalizeModels(raw) {
  /** @type {Settings['models']} */
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const key of Object.keys(MODELS)) {
    const v = typeof raw[key] === 'string' ? raw[key].trim() : '';
    if (MODEL_ID_RE.test(v)) out[key] = v;
  }
  return out;
}

/**
 * Coerce whatever is stored into valid settings, field by field (EC-SET-10).
 * @param {unknown} raw
 * @returns {Settings}
 */
export function normalizeSettings(raw) {
  const d = defaultSettings();
  if (!isPlainObject(raw)) return d;
  const r = /** @type {Record<string, any>} */ (raw);
  const agent = isPlainObject(r.agent) ? r.agent : {};
  return {
    language: oneOf(r.language, LANGUAGES, d.language),
    translateTarget: oneOf(r.translateTarget, TRANSLATE_TARGETS, d.translateTarget),
    tone: oneOf(r.tone, TONES, d.tone),
    models: normalizeModels(r.models),
    agent: {
      maxSteps: agent.maxSteps === undefined ? d.agent.maxSteps : clampMaxSteps(agent.maxSteps),
      dryRunDefault: bool(agent.dryRunDefault, d.agent.dryRunDefault)
    },
    useBuiltinAI: bool(r.useBuiltinAI, d.useBuiltinAI),
    groqEnabled: bool(r.groqEnabled, d.groqEnabled),
    redactContacts: bool(r.redactContacts, d.redactContacts)
  };
}

/**
 * Validate a partial settings update from the UI. Unknown keys are ignored.
 * @param {unknown} patch
 * @returns {{ value: Partial<Settings>, errors: Record<string, string> }}
 */
export function validateSettingsPatch(patch) {
  /** @type {Record<string, any>} */
  const value = {};
  /** @type {Record<string, string>} */
  const errors = {};
  if (!isPlainObject(patch)) return { value, errors: { _: 'Invalid settings.' } };
  const p = /** @type {Record<string, any>} */ (patch);

  /** @param {string} key @param {Record<string, string>} allowed @param {string} label */
  const choice = (key, allowed, label) => {
    if (!(key in p)) return;
    if (Object.hasOwn(allowed, p[key])) value[key] = p[key];
    else errors[key] = `${label} must be one of: ${Object.values(allowed).join(', ')}.`;
  };
  choice('language', LANGUAGES, 'Language');
  choice('translateTarget', TRANSLATE_TARGETS, 'Translation language');
  choice('tone', TONES, 'Tone');

  for (const key of ['useBuiltinAI', 'groqEnabled', 'redactContacts']) {
    if (!(key in p)) continue;
    if (typeof p[key] === 'boolean') value[key] = p[key];
    else errors[key] = 'Must be on or off.';
  }

  if ('agent' in p) {
    if (!isPlainObject(p.agent)) {
      errors.agent = 'Invalid agent settings.';
    } else {
      value.agent = {};
      if ('maxSteps' in p.agent) value.agent.maxSteps = clampMaxSteps(p.agent.maxSteps);
      if ('dryRunDefault' in p.agent) {
        if (typeof p.agent.dryRunDefault === 'boolean') value.agent.dryRunDefault = p.agent.dryRunDefault;
        else errors.agent = 'Dry run must be on or off.';
      }
    }
  }

  if ('models' in p) {
    if (!isPlainObject(p.models)) {
      errors.models = 'Invalid model settings.';
    } else {
      value.models = {};
      for (const [key, id] of Object.entries(p.models)) {
        if (!Object.hasOwn(MODELS, key)) continue;
        if (id === null || id === '') value.models[key] = null; // reset to default
        else if (typeof id === 'string' && MODEL_ID_RE.test(id.trim())) value.models[key] = id.trim();
        else errors.models = `"${String(id).slice(0, 40)}" isn't a valid model ID.`;
      }
    }
  }

  return { value, errors };
}

/**
 * Apply a validated patch: nested objects merge per field so concurrent saves don't clobber (EC-SET-08).
 * @param {Settings} current
 * @param {Partial<Settings>} patch
 * @returns {Settings}
 */
export function mergeSettings(current, patch) {
  const models = { ...current.models };
  for (const [k, v] of Object.entries(patch.models ?? {})) {
    if (v === null) delete models[k];
    else models[k] = v;
  }
  return normalizeSettings({
    ...current,
    ...patch,
    agent: { ...current.agent, ...(patch.agent ?? {}) },
    models
  });
}

/** Effective model IDs: user overrides on top of config defaults. */
export function resolveModels(settings) {
  return { ...MODELS, ...settings.models };
}

// ---- Secrets ----

/**
 * Gemini keys come in two shapes: classic "AIza…" keys (39 chars) and the newer "AQ." auth keys that
 * Google AI Studio now issues, which are longer and contain dots.
 */
const GEMINI_KEY_RE = /^(?:AIza[0-9A-Za-z_-]{35}|AQ\.[A-Za-z0-9._~+/=-]{20,})$/;
const GROQ_KEY_RE = /^gsk_[A-Za-z0-9]{20,}$/;
const CLAUDE_KEY_RE = /^sk-ant-/;
/** Characters any supported key may contain. Deliberately excludes quotes, spaces and angle brackets. */
const KEY_CHARS_RE = /^[A-Za-z0-9._~+/=-]{20,300}$/;

/** Secret field name in storage for each provider. */
export const SECRET_FIELDS = Object.freeze({ gemini: 'geminiKey', groq: 'groqKey' });

/**
 * Clean and check a pasted key (EC-SET-01, EC-SET-02).
 * @param {KeyProvider} provider
 * @param {unknown} raw
 * @returns {{ ok: true, key: string } | { ok: false, error: string }}
 */
export function validateKeyInput(provider, raw) {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return { ok: false, error: 'Enter a key first.' };
  let key = trimmed;
  if (/\s/.test(trimmed)) {
    // Extra text pasted along with the key: accept it only if exactly one word looks like a key.
    const candidates = trimmed.split(/\s+/).filter((t) => GEMINI_KEY_RE.test(t) || GROQ_KEY_RE.test(t));
    if (candidates.length !== 1) return { ok: false, error: 'Paste only the key itself. API keys don’t contain spaces.' };
    key = candidates[0];
  }
  if (provider === 'gemini' && GROQ_KEY_RE.test(key)) {
    return { ok: false, error: 'This looks like a Groq key. Paste it in the Groq field instead.' };
  }
  if (provider === 'gemini' && CLAUDE_KEY_RE.test(key)) {
    return { ok: false, error: 'This is a Claude key. Sahayak uses a Gemini key from Google AI Studio.' };
  }
  if (provider === 'groq' && GEMINI_KEY_RE.test(key)) {
    return { ok: false, error: 'This looks like a Gemini key. Paste it in the Gemini field instead.' };
  }
  if (!KEY_CHARS_RE.test(key)) {
    return { ok: false, error: "That doesn't look like an API key. Copy the whole key and try again." };
  }
  return { ok: true, key };
}

/**
 * Show only enough of a key to recognise it (EC-SET-13).
 * @param {string|undefined|null} key
 */
export function maskKey(key) {
  if (!key) return null;
  return key.length >= 16 ? `${key.slice(0, 6)}…${key.slice(-4)}` : '••••';
}

/** @param {unknown} raw @returns {Secrets} */
export function normalizeSecrets(raw) {
  /** @type {Secrets} */
  const out = {};
  if (!isPlainObject(raw)) return out;
  const r = /** @type {Record<string, any>} */ (raw);
  if (typeof r.geminiKey === 'string' && r.geminiKey) out.geminiKey = r.geminiKey;
  if (typeof r.groqKey === 'string' && r.groqKey) out.groqKey = r.groqKey;
  return out;
}

/** @param {Secrets} secrets @returns {Record<KeyProvider, SecretStatus>} */
export function secretsStatus(secrets) {
  return {
    gemini: { saved: Boolean(secrets.geminiKey), masked: maskKey(secrets.geminiKey) },
    groq: { saved: Boolean(secrets.groqKey), masked: maskKey(secrets.groqKey) }
  };
}

// ---- Profile (architecture §7.1, §13.1) ----

/**
 * Every field is optional; empty ones aren't stored.
 * @typedef {{
 *   name?: string, email?: string, phone?: string, college?: string, degree?: string, gradYear?: number,
 *   skills?: string[], links?: { linkedin?: string, github?: string, portfolio?: string },
 *   preferredLanguage?: keyof typeof LANGUAGES, preferredTone?: keyof typeof TONES, about?: string
 * }} Profile
 */

/** Longest value kept per text field. `about` has a counter in the form (EC-PRF-04). */
export const PROFILE_TEXT_MAX = Object.freeze({
  name: 100, email: 254, phone: 20, college: 150, degree: 100, about: 2_000
});
export const PROFILE_LINKS = /** @type {const} */ (['linkedin', 'github', 'portfolio']);
export const PROFILE_SKILLS_MAX = 30;
export const PROFILE_SKILL_MAX_CHARS = 50;
const PROFILE_LINK_MAX = 300;
const GRAD_YEAR_MIN = 1950;
const GRAD_YEAR_MAX = 2100;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9 ()-]+$/;
const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/;

/** @param {unknown} v */
const text = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Trim, drop empty chips and case-insensitive duplicates (EC-PRF-05). Takes a list or "a, b, c".
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeSkills(raw) {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const item of items) {
    const skill = text(item).replace(/\s+/g, ' ').slice(0, PROFILE_SKILL_MAX_CHARS);
    if (!skill || seen.has(skill.toLowerCase())) continue;
    seen.add(skill.toLowerCase());
    out.push(skill);
    if (out.length === PROFILE_SKILLS_MAX) break;
  }
  return out;
}

/**
 * A web address as typed, with https:// added when it has no scheme, or null if it isn't one.
 * @param {string} value
 */
export function normalizeUrl(value) {
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname.includes('.')) return null;
    return candidate.length <= PROFILE_LINK_MAX ? candidate : null;
  } catch {
    return null;
  }
}

/** @param {unknown} v @returns {number|null} */
function gradYearOf(v) {
  const n = typeof v === 'string' && /^\s*\d{4}\s*$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= GRAD_YEAR_MIN && n <= GRAD_YEAR_MAX ? n : null;
}

/**
 * Check a profile from the form, field by field (pure). Invalid fields are reported and left out
 * of `value`, so the valid ones can still be saved (EC-PRF-06). Text is trimmed and capped.
 * @param {unknown} raw
 * @returns {{ value: Profile, errors: Record<string, string>, warnings: Record<string, string> }}
 *   errors / warnings are keyed by field, with links as "links.github"
 */
export function validateProfile(raw) {
  /** @type {Record<string, any>} */
  const value = {};
  /** @type {Record<string, string>} */
  const errors = {};
  /** @type {Record<string, string>} */
  const warnings = {};
  if (!isPlainObject(raw)) return { value, errors: { _: 'Invalid profile.' }, warnings };
  const r = /** @type {Record<string, any>} */ (raw);

  for (const [field, max] of Object.entries(PROFILE_TEXT_MAX)) {
    const v = text(r[field]).slice(0, max);
    if (v) value[field] = v;
  }

  if (value.email && !EMAIL_RE.test(value.email)) {
    errors.email = 'Enter an email address like name@example.com.';
    delete value.email;
  }
  if (value.phone) {
    const digits = value.phone.replace(/\D/g, '').length;
    if (!PHONE_RE.test(value.phone) || digits < 7 || digits > 15) {
      errors.phone = 'Enter a phone number using digits, spaces, dashes and an optional + at the start.';
      delete value.phone;
    }
  }

  if (r.gradYear !== undefined && r.gradYear !== null && r.gradYear !== '') {
    const year = gradYearOf(r.gradYear);
    if (year === null) errors.gradYear = `Enter a year between ${GRAD_YEAR_MIN} and ${GRAD_YEAR_MAX}.`;
    else value.gradYear = year;
  }

  const skills = normalizeSkills(r.skills);
  if (skills.length) value.skills = skills;

  const links = isPlainObject(r.links) ? r.links : {};
  /** @type {Record<string, string>} */
  const outLinks = {};
  for (const key of PROFILE_LINKS) {
    const v = text(links[key]);
    if (!v) continue;
    const url = normalizeUrl(v);
    if (url) outLinks[key] = url;
    else errors[`links.${key}`] = 'Enter a web address like https://example.com/you.';
  }
  if (Object.keys(outLinks).length) value.links = outLinks;

  if (r.preferredLanguage) {
    if (Object.hasOwn(LANGUAGES, r.preferredLanguage)) value.preferredLanguage = r.preferredLanguage;
    else errors.preferredLanguage = `Language must be one of: ${Object.values(LANGUAGES).join(', ')}.`;
  }
  if (r.preferredTone) {
    if (Object.hasOwn(TONES, r.preferredTone)) value.preferredTone = r.preferredTone;
    else errors.preferredTone = `Tone must be one of: ${Object.values(TONES).join(', ')}.`;
  }

  // ID and card numbers don't belong here (EC-PRF-07). Only a warning: it's the user's call.
  for (const field of ['name', 'college', 'degree', 'about', 'skills']) {
    const v = field === 'skills' ? (value.skills ?? []).join(' ') : value[field] ?? '';
    if (v && (looksLikeSecretValue(v, { fromProfile: true }) || PAN_RE.test(v))) {
      warnings[field] = 'This looks like an ID or card number. Avoid storing ID or card numbers in your profile.';
    }
  }

  return { value, errors, warnings };
}

/**
 * Coerce a stored profile into shape: known fields only, of the right type (pure). Formats were
 * checked when it was saved, so this is lenient.
 * @param {unknown} raw
 * @returns {Profile}
 */
export function normalizeProfile(raw) {
  if (!isPlainObject(raw)) return {};
  const r = /** @type {Record<string, any>} */ (raw);
  /** @type {Record<string, any>} */
  const out = {};
  for (const [field, max] of Object.entries(PROFILE_TEXT_MAX)) {
    const v = text(r[field]).slice(0, max);
    if (v) out[field] = v;
  }
  const year = gradYearOf(r.gradYear);
  if (year !== null) out.gradYear = year;
  const skills = normalizeSkills(r.skills);
  if (skills.length) out.skills = skills;
  if (isPlainObject(r.links)) {
    const links = Object.fromEntries(PROFILE_LINKS.map((k) => [k, text(r.links[k]).slice(0, PROFILE_LINK_MAX)]).filter(([, v]) => v));
    if (Object.keys(links).length) out.links = links;
  }
  if (Object.hasOwn(LANGUAGES, r.preferredLanguage)) out.preferredLanguage = r.preferredLanguage;
  if (Object.hasOwn(TONES, r.preferredTone)) out.preferredTone = r.preferredTone;
  return out;
}

/**
 * Stored skills that still pass validation; anything else is dropped (pure). Never invents ids,
 * so a skill keeps the same id on every read.
 * @param {unknown} raw
 * @returns {import('./schemas.js').Skill[]}
 */
export function normalizeSkillList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const r = validateSkill(item, { newId: () => '', now: 0 });
    return r.ok && r.value.id ? [r.value] : [];
  }).slice(0, SKILLS_MAX);
}

/** Keys in storage.local that "Clear all my data" deletes. Settings and safety lists stay. */
export const USER_DATA_KEYS = Object.freeze(['profile', 'skills', 'agentTasks', 'activeTaskId', 'secrets']);

// ---- Key registry ----

const SAFETY_LISTS = ['userBlockedDomains', 'ownedDomains', 'sensitiveAckDomains'];

/** Defaults and shape checks for every key in chrome.storage.local. */
export const KEYS = Object.freeze({
  settings: { default: defaultSettings, normalize: normalizeSettings },
  secrets: { default: () => ({}), normalize: normalizeSecrets },
  profile: { default: () => ({}), normalize: normalizeProfile },
  skills: { default: () => [], normalize: normalizeSkillList },
  /** The starter skills were installed once; they're never installed again (EC-SKL-06). */
  skillsSeeded: { default: () => false, normalize: (v) => v === true },
  safety: {
    default: () => Object.fromEntries(SAFETY_LISTS.map((k) => [k, []])),
    normalize: (v) => Object.fromEntries(
      SAFETY_LISTS.map((k) => [k, isPlainObject(v) && Array.isArray(v[k]) ? v[k].filter((d) => typeof d === 'string') : []])
    )
  },
  agentTasks: { default: () => ({}), normalize: (v) => (isPlainObject(v) ? v : {}) },
  activeTaskId: { default: () => null, normalize: (v) => (typeof v === 'string' ? v : null) }
});

/** @typedef {keyof typeof KEYS} StorageKey */

// ---- Errors ----

export class StorageError extends Error {
  /** @param {'QUOTA_EXCEEDED'|'READ_ONLY'|'WRITE_FAILED'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

/** @param {unknown} err */
function toStorageError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/quota/i.test(msg)) {
    return new StorageError('QUOTA_EXCEEDED', 'Sahayak’s storage is full. Export and clear old logs, then try again.');
  }
  return new StorageError('WRITE_FAILED', 'Couldn’t save. Please try again.');
}

// ---- Storage service ----

/**
 * @param {StorageArea} area usually chrome.storage.local
 */
export function createStorage(area) {
  /** Serialises read-modify-write operations within this worker. */
  let queue = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  async function write(items) {
    if (await isReadOnly()) {
      throw new StorageError('READ_ONLY', 'This data was saved by a newer version of Sahayak. Update Sahayak to change settings.');
    }
    try {
      await area.set(items);
    } catch (err) {
      throw toStorageError(err);
    }
  }

  async function isReadOnly() {
    const { schemaVersion } = await area.get(['schemaVersion']);
    return typeof schemaVersion === 'number' && schemaVersion > SCHEMA_VERSION;
  }

  /** @template {StorageKey} K @param {K} key */
  async function get(key) {
    const raw = await area.get([key]);
    return key in raw ? KEYS[key].normalize(raw[key]) : KEYS[key].default();
  }

  /** @template {StorageKey} K @param {K} key @param {any} value */
  function set(key, value) {
    return serial(() => write({ [key]: KEYS[key].normalize(value) }));
  }

  return {
    get,
    set,
    isReadOnly,

    /** @returns {Promise<Settings>} */
    getSettings: () => get('settings'),

    /**
     * @param {Partial<Settings>} validPatch output of validateSettingsPatch
     * @returns {Promise<Settings>}
     */
    updateSettings(validPatch) {
      return serial(async () => {
        const next = mergeSettings(await get('settings'), validPatch);
        await write({ settings: next });
        return next;
      });
    },

    /** @returns {Promise<Secrets>} */
    getSecrets: () => get('secrets'),

    /**
     * @param {KeyProvider} provider
     * @param {string|null} key already validated, or null to remove
     */
    setSecret(provider, key) {
      const field = SECRET_FIELDS[provider];
      return serial(async () => {
        const secrets = { ...(await get('secrets')) };
        if (key) secrets[field] = key;
        else delete secrets[field];
        await write({ secrets });
      });
    },

    /** @returns {Promise<Profile>} */
    getProfile: () => get('profile'),

    /** @returns {Promise<import('./schemas.js').Skill[]>} */
    getSkills: () => get('skills'),

    /**
     * Change the user's safety lists in one step (Settings → Safety).
     * @template T
     * @param {(safety: Record<'userBlockedDomains'|'ownedDomains'|'sensitiveAckDomains', string[]>) =>
     *   { safety: Record<'userBlockedDomains'|'ownedDomains'|'sensitiveAckDomains', string[]>, result: T }} fn
     * @returns {Promise<T>}
     */
    updateSafety(fn) {
      return serial(async () => {
        const { safety, result } = fn(await get('safety'));
        await write({ safety: KEYS.safety.normalize(safety) });
        return result;
      });
    },

    /**
     * Change the saved skills in one step, so two saves can't lose each other's changes.
     * @template T
     * @param {(skills: import('./schemas.js').Skill[]) => { skills: import('./schemas.js').Skill[], result: T }} fn
     * @returns {Promise<T>}
     */
    updateSkills(fn) {
      return serial(async () => {
        const { skills, result } = fn(await get('skills'));
        await write({ skills: normalizeSkillList(skills) });
        return result;
      });
    },

    /**
     * Delete the user's data (EC-SET-14). Removing is allowed even when the data is read-only:
     * it can't leave anything in a shape a newer version doesn't understand.
     */
    clearUserData() {
      return serial(async () => {
        try {
          await area.remove([...USER_DATA_KEYS]);
        } catch (err) {
          throw toStorageError(err);
        }
      });
    },

    /**
     * Bring stored data up to SCHEMA_VERSION. Never overwrites existing values (EC-INS-04)
     * and never touches data from a newer version (EC-SET-11).
     * @returns {Promise<{ status: 'current'|'migrated'|'newer', from: number, to: number }>}
     */
    migrate() {
      return serial(async () => {
        const all = await area.get([...Object.keys(KEYS), 'schemaVersion']);
        const from = typeof all.schemaVersion === 'number' ? all.schemaVersion : 0;
        if (from > SCHEMA_VERSION) return { status: 'newer', from, to: from };

        /** @type {Record<string, any>} */
        const updates = {};
        for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
          Object.assign(updates, MIGRATIONS[v]?.({ ...all, ...updates }) ?? {});
        }
        // Starter skills on first run (§13.2). An update from before skills existed sets the flag but
        // leaves any saved skills alone (EC-INS-04).
        if (all.skillsSeeded !== true) {
          if (!Array.isArray(all.skills) || all.skills.length === 0) updates.skills = starterSkills(Date.now());
          updates.skillsSeeded = true;
        }
        for (const [key, spec] of Object.entries(KEYS)) {
          if (!(key in all) && !(key in updates)) updates[key] = spec.default();
        }
        if (from === SCHEMA_VERSION && Object.keys(updates).length === 0) {
          return { status: 'current', from, to: from };
        }
        updates.schemaVersion = SCHEMA_VERSION;
        try {
          await area.set(updates);
        } catch (err) {
          throw toStorageError(err);
        }
        return { status: 'migrated', from, to: SCHEMA_VERSION };
      });
    }
  };
}

/**
 * MIGRATIONS[n] upgrades data from version n-1 to n and returns the keys to write.
 * @type {Record<number, (data: Record<string, any>) => Record<string, any>>}
 */
export const MIGRATIONS = {
  // 0 → 1: first versioned schema. Normalise anything an earlier dev build may have left behind.
  1: (data) => (data.settings === undefined ? {} : { settings: normalizeSettings(data.settings) }),

  // 1 → 2: was the switch to Claude (ADR-1). ADR-2 reverted it, so this step now only normalises
  // settings; it must no longer delete a Gemini key.
  2: (data) => (data.settings === undefined ? {} : { settings: normalizeSettings(data.settings) }),

  // 2 → 3: back to Gemini (ADR-2). Delete any stored Claude key — it's no longer used, and keeping
  // an unused secret around is a liability. A Claude model override is dropped by normalisation.
  3: (data) => {
    const updates = {};
    if (data.secrets && typeof data.secrets === 'object' && 'claudeKey' in data.secrets) {
      const { claudeKey: _removed, ...rest } = data.secrets;
      updates.secrets = rest;
    }
    if (data.settings !== undefined) updates.settings = normalizeSettings(data.settings);
    return updates;
  }
};
