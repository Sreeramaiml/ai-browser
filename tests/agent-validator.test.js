import { describe, it, expect } from 'vitest';
import {
  AgentActionSchema, profileRefs, profileValue, resolveProfileRefs, validateAgentAction
} from '../src/shared/schemas.js';

/** Internship step 1–2 style page (architecture §11.4). */
const ELEMENTS = [
  { id: 1, tag: 'a', role: 'link', name: 'Home', href: '/', inViewport: true, fingerprint: 'a1' },
  { id: 4, tag: 'input', role: 'textbox', name: 'College name', formId: 1, inViewport: true, fingerprint: 'a4' },
  { id: 5, tag: 'select', role: 'combobox', name: 'Degree', options: ['Select', 'B.Tech', 'B.Sc', 'BCA'], formId: 1, inViewport: true, fingerprint: 'a5' },
  { id: 6, tag: 'input', role: 'textbox', inputType: 'number', name: 'Graduation year', formId: 1, inViewport: true, fingerprint: 'a6' },
  { id: 7, tag: 'input', role: 'checkbox', inputType: 'checkbox', name: 'I am currently enrolled', checked: false, formId: 1, inViewport: true, fingerprint: 'a7' },
  { id: 8, tag: 'input', role: 'file', inputType: 'file', name: 'Upload resume (PDF)', formId: 1, inViewport: true, fingerprint: 'a8' },
  { id: 9, tag: 'input', role: 'radio', inputType: 'radio', name: 'Full time', group: 'Availability', formId: 1, inViewport: true, fingerprint: 'a9' },
  { id: 10, tag: 'input', role: 'radio', inputType: 'radio', name: 'Part time', group: 'Availability', formId: 1, inViewport: true, fingerprint: 'a10' },
  { id: 11, tag: 'button', role: 'button', name: 'Next', formId: 1, consequential: true, inViewport: true, fingerprint: 'a11' },
  { id: 12, tag: 'select', role: 'combobox', name: 'City', options: [...Array(20).keys()].map((i) => `City ${i}`).concat('…(30 more)'), inViewport: true, fingerprint: 'a12' },
  { id: 13, tag: 'textarea', role: 'textbox', name: 'Statement', formId: 1, inViewport: true, fingerprint: 'a13' },
  { id: 14, tag: 'input', role: 'combobox', name: 'Search', inViewport: true, fingerprint: 'a14' },
  { id: 15, tag: 'select', role: 'combobox', name: 'Branch', options: ['Computer Science and Engineering (Artificial Intelli…'], inViewport: true, fingerprint: 'a15' }
];
const PROFILE = { name: 'Asha Rao', email: 'asha@example.com', college: '', links: { github: 'https://github.com/asha' }, skills: ['JS', 'SQL'] };

const check = (v, extra = {}) => validateAgentAction(v, { elements: ELEMENTS, profile: PROFILE, useProfile: true, ...extra });
const ok = (v, extra) => {
  const r = check(v, extra);
  expect(r).toMatchObject({ ok: true });
  return r.value;
};
const code = (v, extra) => check(v, extra).code;

describe('validateAgentAction (architecture §12.3)', () => {
  it('normalises a valid step and drops fields that do not apply', () => {
    expect(ok({ action: 'type', target: 4, value: 'IIT Hyderabad', reason: ' Fills the college. ', direction: 'up', result: 'x' })).toEqual({
      type: 'type', target: 4, value: 'IIT Hyderabad', direction: null, reason: 'Fills the college.', note: null, result: null
    });
    expect(ok({ action: 'done', target: 4, reason: 'All filled.', result: '| a |\n|---|' })).toMatchObject({ type: 'done', target: null, result: '| a |\n|---|' });
    expect(ok({ action: 'CLICK', target: '[11]', reason: 'Next page.' })).toMatchObject({ type: 'click', target: 11 });
    expect(ok({ action: 'scroll', direction: 'Down', reason: 'See more.' })).toMatchObject({ direction: 'down', target: null, value: null });
    expect(ok({ action: 'click', target: 1, reason: 'r', note: '  Club A — a@x.in  ' }).note).toBe('Club A — a@x.in');
  });

  describe('BAD_ACTION', () => {
    it.each([
      [{ action: 'hover', target: 1, reason: 'r' }],
      [{ action: 'wait', reason: 'r' }], // not in the agent's enum
      [{ reason: 'r' }],
      [null], [[]], ['click']
    ])('%j', (v) => expect(code(v)).toBe('BAD_ACTION'));
  });

  describe('BAD_TARGET: click/type/select need a target in the snapshot', () => {
    it.each([
      [{ action: 'click', reason: 'r' }],
      [{ action: 'click', target: null, reason: 'r' }],
      [{ action: 'click', target: 99, reason: 'r' }],
      [{ action: 'type', target: 2, value: 'x', reason: 'r' }],
      [{ action: 'select', target: 4.5, value: 'B.Tech', reason: 'r' }],
      [{ action: 'click', target: 'the next button', reason: 'r' }]
    ])('%j', (v) => expect(code(v)).toBe('BAD_TARGET'));

    it('says which number was wrong, for the repair re-ask', () => {
      expect(check({ action: 'click', target: 99, reason: 'r' }).error).toMatch(/99 is not one of them/);
    });
  });

  describe('WRONG_ELEMENT_KIND', () => {
    it.each([
      [{ action: 'type', target: 11, value: 'x', reason: 'r' }], // button
      [{ action: 'type', target: 5, value: 'B.Tech', reason: 'r' }], // <select>
      [{ action: 'type', target: 8, value: 'resume.pdf', reason: 'r' }], // file input
      [{ action: 'type', target: 7, value: 'yes', reason: 'r' }], // checkbox
      [{ action: 'select', target: 4, value: 'x', reason: 'r' }], // textbox
      [{ action: 'select', target: 7, value: 'x', reason: 'r' }] // checkbox: click it instead
    ])('%j', (v) => expect(code(v)).toBe('WRONG_ELEMENT_KIND'));

    it('accepts textareas and text comboboxes for type, and radios for select', () => {
      ok({ action: 'type', target: 13, value: 'I like building things.', reason: 'r' });
      ok({ action: 'type', target: 14, value: 'wireless headphones', reason: 'r' });
      ok({ action: 'select', target: 9, value: 'Part time', reason: 'r' });
    });
  });

  describe('MISSING_VALUE', () => {
    it.each([
      [{ action: 'type', target: 4, reason: 'r' }],
      [{ action: 'type', target: 4, value: '   ', reason: 'r' }],
      [{ action: 'type', target: 4, value: 'x'.repeat(501), reason: 'r' }],
      [{ action: 'select', target: 5, value: null, reason: 'r' }]
    ])('%j', (v) => expect(code(v)).toBe('MISSING_VALUE'));

    it('accepts a number as the value', () => {
      expect(ok({ action: 'type', target: 6, value: 2027, reason: 'r' }).value).toBe('2027');
    });
  });

  describe('BAD_OPTION', () => {
    it('matches options case-insensitively and trimmed', () => {
      expect(ok({ action: 'select', target: 5, value: '  b.tech ', reason: 'r' }).value).toBe('b.tech');
      expect(code({ action: 'select', target: 5, value: 'M.Tech', reason: 'r' })).toBe('BAD_OPTION');
      expect(check({ action: 'select', target: 5, value: 'M.Tech', reason: 'r' }).error).toMatch(/Options: Select, B\.Tech, B\.Sc, BCA/);
    });

    it('checks radios against the labels in their group', () => {
      expect(code({ action: 'select', target: 9, value: 'Weekends', reason: 'r' })).toBe('BAD_OPTION');
    });

    it('lets a cut-short option list through for the executor to check', () => {
      ok({ action: 'select', target: 12, value: 'City 25', reason: 'r' });
    });

    it('matches an option label the scanner shortened with …', () => {
      ok({ action: 'select', target: 15, value: 'Computer Science and Engineering (Artificial Intelligence)', reason: 'r' });
    });
  });

  it('MISSING_DIRECTION: scroll needs up or down', () => {
    expect(code({ action: 'scroll', reason: 'r' })).toBe('MISSING_DIRECTION');
    expect(code({ action: 'scroll', direction: 'left', reason: 'r' })).toBe('MISSING_DIRECTION');
  });

  describe('MISSING_REASON', () => {
    it.each([
      [{ action: 'done', result: 'x' }],
      [{ action: 'done', reason: '  ' }],
      [{ action: 'done', reason: 'y'.repeat(201) }],
      [{ action: 'done', reason: 42 }]
    ])('%j', (v) => expect(code(v)).toBe('MISSING_REASON'));
  });

  describe('BAD_PROFILE_REF', () => {
    it('accepts existing, non-empty fields, including nested ones', () => {
      ok({ action: 'type', target: 4, value: '{{profile.name}}', reason: 'r' });
      ok({ action: 'type', target: 4, value: 'Find me on {{ profile.links.github }}', reason: 'r' });
    });

    it('rejects empty or missing fields', () => {
      expect(code({ action: 'type', target: 4, value: '{{profile.college}}', reason: 'r' })).toBe('BAD_PROFILE_REF');
      expect(code({ action: 'type', target: 4, value: '{{profile.phone}}', reason: 'r' })).toBe('BAD_PROFILE_REF');
    });

    it('rejects any profile reference when useProfile is off', () => {
      expect(code({ action: 'type', target: 4, value: '{{profile.name}}', reason: 'r' }, { useProfile: false })).toBe('BAD_PROFILE_REF');
    });

    it('rejects template variables other than profile fields (P4.1)', () => {
      expect(code({ action: 'type', target: 4, value: '{{page}}', reason: 'r' })).toBe('BAD_PROFILE_REF');
      expect(code({ action: 'type', target: 4, value: '{{profile.name}} {{selection}}', reason: 'r' })).toBe('BAD_PROFILE_REF');
      expect(code({ action: 'type', target: 4, value: '{{secret}}', reason: 'r' }, { useProfile: false })).toBe('BAD_PROFILE_REF');
    });

    it('rejects a field that does not exist, like {{profile.aadhaar}} (EC-AGT-13)', () => {
      expect(code({ action: 'type', target: 4, value: '{{profile.aadhaar}}', reason: 'r' })).toBe('BAD_PROFILE_REF');
    });

    it('checks a select with a profile value against the resolved value', () => {
      const degree = { ...PROFILE, degree: 'B.Sc' };
      ok({ action: 'select', target: 5, value: '{{profile.degree}}', reason: 'r' }, { profile: degree });
      expect(code({ action: 'select', target: 5, value: '{{profile.name}}', reason: 'r' })).toBe('BAD_OPTION');
    });
  });

  it('schema requires action and reason and lists the five actions', () => {
    expect(AgentActionSchema.required).toEqual(['action', 'reason']);
    expect(AgentActionSchema.properties.action.enum).toEqual(['click', 'type', 'select', 'scroll', 'done']);
  });
});

describe('profile references', () => {
  it('finds, reads and resolves {{profile.x}} tokens', () => {
    expect(profileRefs('{{profile.name}} <{{ profile.email }}>')).toEqual(['name', 'email']);
    expect(profileValue(PROFILE, 'links.github')).toBe('https://github.com/asha');
    expect(profileValue(PROFILE, 'skills')).toBe('JS, SQL');
    expect(profileValue(PROFILE, 'links')).toBe('');
    expect(profileValue(PROFILE, 'toString')).toBe(''); // own fields only
    expect(resolveProfileRefs('{{profile.name}} <{{ profile.email }}>', PROFILE)).toBe('Asha Rao <asha@example.com>');
    expect(() => resolveProfileRefs('{{profile.college}}', PROFILE)).toThrow(/profile.college/); // strict for agents
  });
});
