import { describe, it, expect } from 'vitest';
import { TemplateError, profileValue, resolve, templateVariables } from '../src/shared/template.js';

const PROFILE = {
  name: 'Asha Rao', email: 'asha@example.com', college: '  ', gradYear: 2026,
  skills: ['JS', ' ', 'SQL'], links: { github: 'https://github.com/asha' }
};
const CTX = { profile: PROFILE, page: 'Page text', selection: 'Picked words', url: 'https://e.com/a', title: 'A page', language: 'en' };

/** @param {() => unknown} fn */
function thrown(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

describe('resolve', () => {
  it('fills in every variable', () => {
    expect(resolve('{{page}}|{{selection}}|{{url}}|{{title}}|{{language}}', CTX)).toBe('Page text|Picked words|https://e.com/a|A page|en');
    expect(resolve('{{profile.name}} <{{ profile.email }}>', CTX)).toBe('Asha Rao <asha@example.com>');
    expect(resolve('{{profile.links.github}}', CTX)).toBe('https://github.com/asha');
  });

  it('formats lists and numbers', () => {
    expect(resolve('{{profile.skills}}', CTX)).toBe('JS, SQL');
    expect(resolve('Class of {{profile.gradYear}}', CTX)).toBe('Class of 2026');
  });

  it('lenient: unknown and empty variables become blank (answers)', () => {
    expect(resolve('a{{nope}}b{{profile.phone}}c{{profile.college}}d', CTX)).toBe('abcd');
    expect(resolve('{{page}}', {})).toBe('');
  });

  it('strict: an unknown variable throws and names it (agents)', () => {
    const err = thrown(() => resolve('{{profile.name}} {{secret}} {{env.KEY}}', CTX, { strict: true }));
    expect(err).toBeInstanceOf(TemplateError);
    expect(err.code).toBe('UNKNOWN_VARIABLE');
    expect(err.variables).toEqual(['secret', 'env.KEY']);
  });

  it('strict: an empty or missing variable throws and names every one', () => {
    const err = thrown(() => resolve('{{profile.phone}} {{profile.college}} {{profile.name}}', CTX, { strict: true }));
    expect(err.code).toBe('EMPTY_VARIABLE');
    expect(err.variables).toEqual(['profile.phone', 'profile.college']);
    expect(err.message).toContain('{{profile.phone}}');
  });

  it('strict: a fully filled template resolves', () => {
    expect(resolve('{{profile.name}}', CTX, { strict: true })).toBe('Asha Rao');
  });

  it('is single-pass: values are never parsed again (EC-PRF-02)', () => {
    const ctx = { profile: { name: '{{profile.email}}', email: 'asha@example.com' }, page: '{{selection}}', selection: 'x' };
    expect(resolve('{{profile.name}} {{page}}', ctx)).toBe('{{profile.email}} {{selection}}');
    expect(resolve('{{profile.name}}', ctx, { strict: true })).toBe('{{profile.email}}');
  });

  it('inserts quotes, newlines, emoji and $ patterns exactly (EC-PRF-03)', () => {
    const profile = { about: 'Says "hi"\nand 👋 $& $1 $$' };
    expect(resolve('[{{profile.about}}]', { profile })).toBe('[Says "hi"\nand 👋 $& $1 $$]');
  });

  it('has no expressions: other brace text is left alone', () => {
    expect(resolve('{{ 1 + 1 }} {{profile.name | upper}} {page} {{}}', CTX)).toBe('{{ 1 + 1 }} {{profile.name | upper}} {page} {{}}');
  });

  it('never reads inherited properties', () => {
    expect(resolve('{{profile.constructor}}{{profile.__proto__}}{{profile.name.length}}', CTX)).toBe('');
    expect(thrown(() => resolve('{{constructor}}', CTX, { strict: true })).code).toBe('UNKNOWN_VARIABLE');
  });
});

describe('templateVariables', () => {
  it('lists each variable once, in order', () => {
    expect(templateVariables('{{page}} {{ profile.name }} {{page}} {{x.y}}')).toEqual(['page', 'profile.name', 'x.y']);
    expect(templateVariables('no variables')).toEqual([]);
  });
});

describe('profileValue', () => {
  it('reads dotted paths as trimmed text, own fields only', () => {
    expect(profileValue(PROFILE, 'links.github')).toBe('https://github.com/asha');
    expect(profileValue(PROFILE, 'college')).toBe('');
    expect(profileValue(PROFILE, 'links')).toBe('');
    expect(profileValue(PROFILE, 'missing.deep')).toBe('');
    expect(profileValue(PROFILE, 'hasOwnProperty')).toBe('');
  });
});
