import { describe, it, expect } from 'vitest';
import {
  PENDING_KEY, PENDING_MAX_AGE_MS, classifyPending, createPendingWatcher, makePendingRequest
} from '../src/shared/pending-request.js';

const NOW = 1_000_000;
const req = (over = {}) => ({
  ...makePendingRequest({
    kind: 'explain', info: { selectionText: 'Hi', frameId: 0, pageUrl: 'https://e.com/' },
    tab: { id: 1, windowId: 9, title: 'E' }, id: 'a', now: NOW
  }),
  ...over
});

describe('classifyPending', () => {
  const ctx = (seen = new Set()) => ({ windowId: 9, now: NOW + 1000, seen });

  it('runs a fresh request for this window', () => {
    expect(classifyPending(req(), ctx())).toBe('run');
  });

  it('drops stale requests (EC-CTX-04) and malformed ones', () => {
    expect(classifyPending(req({ ts: NOW - PENDING_MAX_AGE_MS - 2000 }), ctx())).toBe('drop');
    expect(classifyPending(req({ kind: 'hack' }), ctx())).toBe('drop');
    expect(classifyPending(null, ctx())).toBe('drop');
    expect(classifyPending('x', ctx())).toBe('drop');
  });

  it("leaves another window's request for that window's panel (EC-X-11)", () => {
    expect(classifyPending(req({ windowId: 3 }), ctx())).toBe('skip');
  });

  it('runs each id only once (EC-CTX-02, EC-CTX-03)', () => {
    expect(classifyPending(req(), ctx(new Set(['a'])))).toBe('drop');
  });
});

describe('createPendingWatcher', () => {
  function setup(initial) {
    const data = { [PENDING_KEY]: initial };
    const area = {
      data,
      get: async (key) => ({ [key]: data[key] }),
      remove: async (key) => { delete data[key]; }
    };
    const ran = [];
    const watcher = createPendingWatcher({ area, windowId: 9, onRequest: (r) => ran.push(r.id), now: () => NOW });
    return { watcher, area, ran };
  }

  it('runs the request once and removes it, even if checked twice at the same time', async () => {
    const { watcher, area, ran } = setup(req());
    await Promise.all([watcher.check(), watcher.check()]);
    expect(ran).toEqual(['a']);
    expect(PENDING_KEY in area.data).toBe(false);
  });

  it('leaves a request for another window untouched', async () => {
    const { watcher, area, ran } = setup(req({ windowId: 3 }));
    await watcher.check();
    expect(ran).toEqual([]);
    expect(area.data[PENDING_KEY].id).toBe('a');
  });

  it('removes a stale request without running it', async () => {
    const { watcher, area, ran } = setup(req({ ts: NOW - PENDING_MAX_AGE_MS - 1 }));
    await watcher.check();
    expect(ran).toEqual([]);
    expect(PENDING_KEY in area.data).toBe(false);
  });

  it('does not remove a newer request that arrived meanwhile', async () => {
    const { watcher, area, ran } = setup(req());
    const get = area.get;
    let first = true;
    area.get = async (key) => {
      const value = await get(key);
      if (first) { first = false; area.data[PENDING_KEY] = req({ id: 'b' }); }
      return value;
    };
    await watcher.check();
    expect(ran).toEqual(['a']);
    expect(area.data[PENDING_KEY].id).toBe('b');
  });

  it('does nothing when there is no request', async () => {
    const { watcher, ran } = setup(undefined);
    await watcher.check();
    expect(ran).toEqual([]);
  });
});
