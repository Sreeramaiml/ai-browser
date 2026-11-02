// @ts-check
// Task → ordered chain of provider attempts (architecture §8.2). Feature code never picks a
// provider; it names a task and the gateway walks this chain, retrying, cooling down and falling
// back per the rules in gateway.js.

/**
 * @typedef {'explain'|'translate'|'draft'|'summary'|'youtube'|'chat'|'vision'|'find'|'agent'|'skill'} TaskKind
 * @typedef {'lite'|'flash'|'groq'} Tier
 * @typedef {{ provider: 'gemini'|'groq', model: string, tier: Tier }} Attempt
 */

/** @type {Record<TaskKind, Tier[]>} */
export const CHAINS = Object.freeze({
  explain: ['lite', 'groq', 'flash'],
  translate: ['lite', 'groq', 'flash'],
  draft: ['lite', 'groq', 'flash'],
  summary: ['lite', 'groq', 'flash'],
  chat: ['lite', 'groq', 'flash'],
  skill: ['lite', 'groq', 'flash'],
  youtube: ['lite', 'flash'], // needs Gemini's YouTube input
  vision: ['lite', 'flash'], // image input: never Groq (EC-SCR-12)
  find: ['lite', 'flash'],
  agent: ['lite', 'flash', 'groq']
});

/**
 * @param {TaskKind} task
 * @param {{ lite: string, flash: string, groq?: string }} models resolved model IDs (config defaults + user overrides)
 * @param {{ escalate?: boolean, groq?: boolean }} [opts]
 *   escalate: the user asked to try harder, so start at Flash and skip Lite;
 *   groq: a Groq key is saved and enabled (otherwise Groq links are skipped silently, EC-RTL-06)
 * @returns {Attempt[]}
 */
export function chainFor(task, models, { escalate = false, groq = false } = {}) {
  let tiers = CHAINS[task] ?? CHAINS.chat;
  if (escalate) tiers = ['flash', ...tiers.filter((t) => t !== 'lite' && t !== 'flash')];
  return tiers
    .filter((t) => t !== 'groq' || (groq && models.groq))
    .map((tier) => (tier === 'groq'
      ? { provider: 'groq', model: /** @type {string} */ (models.groq), tier }
      : { provider: 'gemini', model: models[tier], tier }));
}
