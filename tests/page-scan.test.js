import { describe, it, expect } from 'vitest';
import { createPageScan } from '../src/background/page-scan.js';
import { FeatureError } from '../src/background/feature-error.js';

const SCAN = {
  snapshotId: 's1', url: 'https://example.com/', title: 'Example', modal: false, framesNotScanned: 0, truncated: false, total: 2, forms: [],
  elements: [
    { id: 1, tag: 'a', role: 'link', name: 'Home', href: '/', inViewport: true, fingerprint: 'a' },
    { id: 2, tag: 'input', role: 'textbox', name: 'Password', protected: 'password', inViewport: true, fingerprint: 'b' }
  ]
};

/** @param {Map<number, number>} map */
const windowTabs = (map) => ({ get: async (w) => map.get(w) ?? null, set: async (w, t) => { if (t === null) map.delete(w); else map.set(w, t); } });

function setup({ url = 'https://example.com/', prepareFails = false, badgeTab = null, ringTab = null, highlightReply = { ok: true } } = {}) {
  const sent = [];
  const prepared = [];
  const store = new Map(badgeTab === null ? [] : [[1, badgeTab]]);
  const rings = new Map(ringTab === null ? [] : [[1, ringTab]]);
  const pageScan = createPageScan({
    getTab: async () => ({ url }),
    prepare: async (tabId) => { prepared.push(tabId); if (prepareFails) throw new Error('Cannot access'); },
    send: async (tabId, type, payload) => {
      sent.push(payload === undefined ? [tabId, type] : [tabId, type, payload]);
      if (type === 'CS_SCAN') return SCAN;
      if (type === 'CS_HIGHLIGHT' && payload?.style) {
        if (highlightReply instanceof Error) throw highlightReply;
        return highlightReply;
      }
      return { ok: true };
    },
    badgeTabs: windowTabs(store),
    highlightTabs: windowTabs(rings)
  });
  const attempt = async (fn) => { try { return { result: await fn() }; } catch (error) { return { error }; } };
  return { pageScan, sent, prepared, store, rings, attempt };
}

describe('createPageScan', () => {
  it('scans and returns the action map with counts', async () => {
    const { pageScan, sent } = setup();
    const r = await pageScan.scan(7, { windowId: 1 });
    expect(sent).toEqual([[7, 'CS_SCAN']]);
    expect(r).toMatchObject({ snapshotId: 's1', count: 2, protectedCount: 1, truncated: false, badges: false });
    expect(r.map).toContain('[2] textbox "Password" 🔒protected:password');
    expect(r.tokens).toBe(Math.ceil(r.map.length / 4));
  });

  it('refuses restricted pages without touching them', async () => {
    const { pageScan, prepared, attempt } = setup({ url: 'chrome://settings/' });
    const { error } = await attempt(() => pageScan.scan(7, { windowId: 1 }));
    expect(error).toBeInstanceOf(FeatureError);
    expect(error.code).toBe('PAGE_RESTRICTED');
    expect(prepared).toEqual([]);
  });

  it("reports a page Chrome won't let us script", async () => {
    const { pageScan, attempt } = setup({ prepareFails: true });
    expect((await attempt(() => pageScan.scan(7, { windowId: 1 }))).error.code).toBe('PAGE_RESTRICTED');
  });

  it('numbers the page and moves badges off the previous tab in the window', async () => {
    const { pageScan, sent, store } = setup({ badgeTab: 3 });
    await pageScan.scan(7, { windowId: 1, badges: true });
    expect(sent).toEqual([[7, 'CS_SCAN'], [3, 'CS_HIDE_BADGES'], [7, 'CS_SHOW_BADGES']]);
    expect(store.get(1)).toBe(7);
  });

  it('turning badges off hides them and forgets the tab', async () => {
    const { pageScan, sent, store } = setup({ badgeTab: 7 });
    expect(await pageScan.setBadges(1, 7, false)).toEqual({ tabId: 7, shown: false });
    expect(sent).toEqual([[7, 'CS_HIDE_BADGES']]);
    expect(store.has(1)).toBe(false);
  });

  it('a closed panel takes its badges off the page (§11.5)', async () => {
    const { pageScan, sent, store } = setup({ badgeTab: 7 });
    await pageScan.hideWindow(1);
    expect(sent).toEqual([[7, 'CS_HIDE_BADGES']]);
    expect(store.has(1)).toBe(false);
    await pageScan.hideWindow(2); // nothing shown there
    expect(sent).toHaveLength(1);
  });

  it('observe returns the raw scan and its action map', async () => {
    const { pageScan } = setup();
    const { result, map } = await pageScan.observe(7);
    expect(result).toBe(SCAN);
    expect(map).toContain('[1] link "Home"');
  });

  it('rings an element, clearing a ring in another tab of the window first (P3.4)', async () => {
    const { pageScan, sent, rings } = setup({ ringTab: 3 });
    const target = { snapshotId: 's1', elementId: 1, style: 'find' };
    expect(await pageScan.highlight(1, 7, target)).toEqual({ ok: true });
    expect(sent).toEqual([[3, 'CS_HIGHLIGHT', { style: null }], [7, 'CS_HIGHLIGHT', target]]);
    expect(rings.get(1)).toBe(7);
  });

  it('clearing the ring forgets the tab', async () => {
    const { pageScan, sent, rings } = setup({ ringTab: 7 });
    expect(await pageScan.highlight(1, 7, null)).toEqual({ ok: true });
    expect(sent).toEqual([[7, 'CS_HIGHLIGHT', { style: null }]]);
    expect(rings.has(1)).toBe(false);
  });

  it('reports a gone element or a closed tab as STALE_TARGET instead of throwing', async () => {
    const gone = setup({ highlightReply: { ok: false, reason: 'STALE_TARGET' } });
    expect(await gone.pageScan.highlight(1, 7, { snapshotId: 's1', elementId: 9, style: 'find' })).toEqual({ ok: false, reason: 'STALE_TARGET' });
    expect(gone.rings.has(1)).toBe(false);
    const closed = setup({ highlightReply: new Error('No tab with id 7') });
    expect(await closed.pageScan.highlight(1, 7, { snapshotId: 's1', elementId: 1, style: 'find' })).toEqual({ ok: false, reason: 'STALE_TARGET' });
  });

  it('a closed panel takes its rings off the page too, once per tab', async () => {
    const both = setup({ badgeTab: 7, ringTab: 7 });
    await both.pageScan.hideWindow(1);
    expect(both.sent).toEqual([[7, 'CS_HIDE_BADGES']]);
    expect(both.rings.has(1)).toBe(false);
    const apart = setup({ badgeTab: 3, ringTab: 7 });
    await apart.pageScan.hideWindow(1);
    expect(apart.sent).toEqual([[3, 'CS_HIDE_BADGES'], [7, 'CS_HIDE_BADGES']]);
  });
});
