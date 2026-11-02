// @ts-check
// Template variables for skills and agent values (architecture §13.2): {{profile.<field>}},
// {{page}}, {{selection}}, {{url}}, {{title}} and {{language}}. Plain substitution in one pass:
// no expressions, and substituted values are never parsed again (EC-PRF-02). `\{{` stands for a
// literal `{{` (EC-SKL-04).

/** Variables a template may use besides {{profile.<field>}}. */
export const TEMPLATE_VARS = /** @type {const} */ (['page', 'selection', 'url', 'title', 'language']);

/** Profile fields a template may name (architecture §7.1). `{{profile.links}}` itself isn't one. */
export const PROFILE_PATHS = /** @type {const} */ ([
  'name', 'email', 'phone', 'college', 'degree', 'gradYear', 'skills',
  'links.linkedin', 'links.github', 'links.portfolio', 'preferredLanguage', 'preferredTone', 'about'
]);

/**
 * An escaped `\{{`, or `{{ name }}` / `{{ profile.links.github }}`. Anything else between braces
 * is left alone. The escape is matched first, so `\{{page}}` stays literal text.
 */
const TOKEN_RE = /\\\{\{|\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;

/**
 * @typedef {{
 *   profile?: Record<string, unknown>,
 *   page?: string, selection?: string, url?: string, title?: string, language?: string
 * }} TemplateContext
 */

export class TemplateError extends Error {
  /**
   * @param {'UNKNOWN_VARIABLE'|'EMPTY_VARIABLE'} code
   * @param {string[]} variables the offending names, e.g. ['profile.phone']
   */
  constructor(code, variables) {
    super(code === 'UNKNOWN_VARIABLE'
      ? `Unknown template variable: ${variables.map((v) => `{{${v}}}`).join(', ')}.`
      : `Nothing to fill in for: ${variables.map((v) => `{{${v}}}`).join(', ')}.`);
    this.name = 'TemplateError';
    this.code = code;
    this.variables = variables;
  }
}

/**
 * A profile field by dotted path ("links.github"), as trimmed text, or '' if missing or empty.
 * Lists read as "a, b"; objects aren't values. Own fields only, so "toString" is never a field.
 * @param {Record<string, unknown>} profile
 * @param {string} path
 */
export function profileValue(profile, path) {
  /** @type {unknown} */
  let v = profile;
  for (const key of path.split('.')) {
    if (typeof v !== 'object' || v === null || Array.isArray(v) || !Object.hasOwn(v, key)) return '';
    v = /** @type {Record<string, unknown>} */ (v)[key];
  }
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).join(', ');
  return '';
}

/**
 * Every variable a template uses, in order, without duplicates (pure).
 * @param {string} template
 * @returns {string[]} e.g. ['page', 'profile.name']
 */
export function templateVariables(template) {
  return [...new Set([...String(template ?? '').matchAll(TOKEN_RE)].filter((m) => m[1]).map((m) => m[1]))];
}

/** @param {string} name */
const isKnown = (name) => name.startsWith('profile.') || (/** @type {readonly string[]} */ (TEMPLATE_VARS)).includes(name);

/**
 * Variables a skill editor should warn about: not one of TEMPLATE_VARS or PROFILE_PATHS (EC-SKL-03).
 * @param {string} template
 */
export function unknownVariables(template) {
  return templateVariables(template).filter((name) => name.startsWith('profile.')
    ? !(/** @type {readonly string[]} */ (PROFILE_PATHS)).includes(name.slice('profile.'.length))
    : !isKnown(name));
}

/**
 * The value of one variable, or '' when the context doesn't have it (pure).
 * @param {string} name
 * @param {TemplateContext} ctx
 */
function lookup(name, ctx) {
  if (name.startsWith('profile.')) return profileValue(ctx.profile ?? {}, name.slice('profile.'.length));
  const v = /** @type {Record<string, unknown>} */ (ctx)[name];
  return typeof v === 'string' ? v : '';
}

/**
 * Fill in a template (pure).
 * - strict (agents): an unknown or empty variable throws a TemplateError naming every one of them.
 * - lenient (answers): they become ''.
 * - keepProfile: {{profile.x}} tokens stay as they are (still checked when strict), for an agent
 *   goal: the model sees field names, and the controller fills values in on the approval card.
 * @param {string} template
 * @param {TemplateContext} ctx
 * @param {{ strict?: boolean, keepProfile?: boolean }} [opts]
 * @returns {string}
 */
export function resolve(template, ctx, { strict = false, keepProfile = false } = {}) {
  const text = String(template ?? '');
  if (strict) {
    const names = templateVariables(text);
    const unknown = names.filter((n) => !isKnown(n));
    if (unknown.length) throw new TemplateError('UNKNOWN_VARIABLE', unknown);
    const empty = names.filter((n) => !lookup(n, ctx));
    if (empty.length) throw new TemplateError('EMPTY_VARIABLE', empty);
  }
  // One replace() call: a value that itself contains {{…}} is inserted as-is (EC-PRF-02).
  return text.replace(TOKEN_RE, (token, name) => {
    if (!name) return '{{'; // the \{{ escape
    if (keepProfile && name.startsWith('profile.')) return `{{${name}}}`;
    return isKnown(name) ? lookup(name, ctx) : '';
  });
}
