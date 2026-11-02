import { describe, it, expect } from 'vitest';
import { createRpc } from '../src/sidepanel/rpc.js';

function setup({ connected = true } = {}) {
  const sent = [];
  const timers = [];
  const rpc = createRpc({
    send: (msg) => { if (connected) sent.push(msg); return connected; },
    progressTypes: new Set(['CHAT_DELTA']),
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimeout: (id) => { timers[id].cleared = true; }
  });
  return { rpc, sent, timers };
}

describe('createRpc', () => {
  it('resolves with the reply that carries the same requestId', async () => {
    const { rpc, sent, timers } = setup();
    const pending = rpc.request('SETTINGS_SAVE', { settings: { tone: 'formal' } });
    expect(sent[0].type).toBe('SETTINGS_SAVE');
    expect(rpc.handle({ type: 'SAVED', requestId: 'other' })).toBe(false);
    expect(rpc.handle({ type: 'SAVED', requestId: sent[0].requestId, payload: 1 })).toBe(true);
    expect(await pending).toEqual({ type: 'SAVED', requestId: sent[0].requestId, payload: 1 });
    expect(timers[0].cleared).toBe(true);
  });

  it('gives each request a unique id', () => {
    const { rpc, sent } = setup();
    rpc.request('A');
    rpc.request('A');
    expect(sent[0].requestId === sent[1].requestId).toBe(false);
  });

  it('does not consume broadcasts without a requestId', () => {
    const { rpc } = setup();
    expect(rpc.handle({ type: 'SETTINGS_STATE' })).toBe(false);
  });

  it('rejects immediately when not connected', async () => {
    const { rpc } = setup({ connected: false });
    let error;
    await rpc.request('X').catch((e) => { error = e; });
    expect(error.message).toMatch(/isn't connected/);
  });

  it('stream(): routes progress messages to onProgress, then resolves with the final reply', async () => {
    const { rpc, sent } = setup();
    const progress = [];
    const { requestId, done } = rpc.stream('QUICK_ACTION', { kind: 'explain' }, { onProgress: (m) => progress.push(m.payload.text) });
    expect(sent[0].requestId).toBe(requestId);
    expect(rpc.handle({ type: 'CHAT_DELTA', requestId, payload: { text: 'a' } })).toBe(true);
    expect(rpc.handle({ type: 'CHAT_DELTA', requestId, payload: { text: 'b' } })).toBe(true);
    rpc.handle({ type: 'CHAT_DONE', requestId, payload: { text: 'ab' } });
    expect(progress).toEqual(['a', 'b']);
    expect((await done).type).toBe('CHAT_DONE');
  });

  it('stream(): each progress message re-arms the idle timeout', () => {
    const { rpc, timers } = setup();
    const { requestId } = rpc.stream('QUICK_ACTION', {}, { onProgress: () => {} });
    rpc.handle({ type: 'CHAT_DELTA', requestId, payload: { text: 'a' } });
    expect(timers[0].cleared).toBe(true);
    expect(timers).toHaveLength(2);
    expect(timers[1].cleared).toBe(false);
  });

  it('progress messages for unknown requests are not consumed', () => {
    const { rpc } = setup();
    expect(rpc.handle({ type: 'CHAT_DELTA', requestId: 'nope' })).toBe(false);
  });

  it('rejects on timeout and ignores a late reply', async () => {
    const { rpc, sent, timers } = setup();
    const pending = rpc.request('X');
    timers[0].fn();
    let error;
    await pending.catch((e) => { error = e; });
    expect(error.message).toMatch(/too long/);
    expect(rpc.handle({ type: 'Y', requestId: sent[0].requestId })).toBe(false);
  });
});
