import { describe, it, expect } from 'vitest';
import { ToSW, ToPanel, ToContent, makeMessage, isMessage } from '../src/shared/messages.js';

describe('message constants', () => {
  it('each value equals its key, and every type is unique across channels', () => {
    const all = [ToSW, ToPanel, ToContent].flatMap((group) => Object.entries(group));
    for (const [key, value] of all) expect(value).toBe(key);
    const values = all.map(([, v]) => v);
    expect(new Set(values).size).toBe(values.length);
  });

  it('content-script messages are prefixed CS_', () => {
    for (const v of Object.values(ToContent)) expect(v.startsWith('CS_')).toBe(true);
  });

  it('constant groups are frozen', () => {
    expect(Object.isFrozen(ToSW) && Object.isFrozen(ToPanel) && Object.isFrozen(ToContent)).toBe(true);
  });
});

describe('makeMessage / isMessage', () => {
  it('omits absent fields', () => {
    expect(makeMessage('X')).toEqual({ type: 'X' });
    expect(makeMessage('X', { a: 1 }, 'r1')).toEqual({ type: 'X', payload: { a: 1 }, requestId: 'r1' });
  });

  it('recognises message-shaped values only', () => {
    expect(isMessage({ type: 'X' })).toBe(true);
    expect(isMessage({ type: 1 })).toBe(false);
    expect(isMessage(null)).toBe(false);
    expect(isMessage('X')).toBe(false);
  });
});
