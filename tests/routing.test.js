import { describe, it, expect } from 'vitest';
import { CHAINS, chainFor } from '../src/background/llm/routing-policy.js';

const models = { lite: 'lite', flash: 'flash', groq: 'llama' };
const tiers = (chain) => chain.map((a) => a.tier);

describe('chainFor (architecture §8.2)', () => {
  it.each([
    ['explain', ['lite', 'groq', 'flash']],
    ['translate', ['lite', 'groq', 'flash']],
    ['draft', ['lite', 'groq', 'flash']],
    ['summary', ['lite', 'groq', 'flash']],
    ['chat', ['lite', 'groq', 'flash']],
    ['youtube', ['lite', 'flash']],
    ['vision', ['lite', 'flash']],
    ['find', ['lite', 'flash']],
    ['agent', ['lite', 'flash', 'groq']]
  ])('%s → %j', (task, expected) => {
    expect(tiers(chainFor(task, models, { groq: true }))).toEqual(expected);
  });

  it('maps tiers to providers and the configured models', () => {
    expect(chainFor('chat', models, { groq: true })).toEqual([
      { provider: 'gemini', model: 'lite', tier: 'lite' },
      { provider: 'groq', model: 'llama', tier: 'groq' },
      { provider: 'gemini', model: 'flash', tier: 'flash' }
    ]);
  });

  it('never routes images or YouTube to Groq (EC-SCR-12)', () => {
    for (const task of ['vision', 'youtube']) {
      expect(chainFor(task, models, { groq: true, escalate: true }).some((a) => a.provider === 'groq')).toBe(false);
    }
  });

  it('drops Groq without a key or model (EC-RTL-06)', () => {
    expect(tiers(chainFor('chat', models))).toEqual(['lite', 'flash']);
    expect(tiers(chainFor('chat', { lite: 'l', flash: 'f' }, { groq: true }))).toEqual(['lite', 'flash']);
  });

  it('"Try harder" starts at Flash and skips Flash-Lite', () => {
    expect(tiers(chainFor('vision', models, { escalate: true }))).toEqual(['flash']);
    expect(tiers(chainFor('chat', models, { escalate: true, groq: true }))).toEqual(['flash', 'groq']);
  });

  it('has a chain for every task kind', () => {
    for (const task of ['explain', 'translate', 'draft', 'summary', 'youtube', 'chat', 'vision', 'find', 'agent', 'skill']) {
      expect(CHAINS[task].length).toBeGreaterThan(0);
    }
  });
});
