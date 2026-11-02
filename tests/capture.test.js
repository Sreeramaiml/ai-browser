import { describe, it, expect } from 'vitest';
import { CAPTURE_MIN_GAP_MS, CAPTURE_RETRY_DELAY_MS, createCapturer, createScreenCapture } from '../src/background/capture.js';
import { FeatureError } from '../src/background/feature-error.js';

/** A fake clock: sleep() advances time instantly and records how long it waited. */
function clock() {
  const c = { t: 10_000, slept: [] };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.slept.push(ms); c.t += ms; };
  return c;
}

describe('createCapturer (EC-SCR-01)', () => {
  it('spaces captures at least the minimum gap apart, even when asked at once', async () => {
    const c = clock();
    const at = [];
    const capturer = createCapturer({ captureVisibleTab: async () => { at.push(c.t); return 'data:image/png;base64,AA=='; }, now: c.now, sleep: c.sleep });
    await Promise.all([capturer.capture(1), capturer.capture(1), capturer.capture(1)]);
    expect(at).toHaveLength(3);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(CAPTURE_MIN_GAP_MS);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(CAPTURE_MIN_GAP_MS);
  });

  it("retries once after Chrome's rate-limit error", async () => {
    const c = clock();
    let calls = 0;
    const capturer = createCapturer({
      captureVisibleTab: async () => {
        calls++;
        if (calls === 1) throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
        return 'data:image/png;base64,AA==';
      },
      now: c.now,
      sleep: c.sleep
    });
    expect(await capturer.capture(1)).toBe('data:image/png;base64,AA==');
    expect(calls).toBe(2);
    expect(c.slept).toContain(CAPTURE_RETRY_DELAY_MS);
  });

  it('does not retry other errors, and a failure does not block the next capture', async () => {
    const c = clock();
    let calls = 0;
    const capturer = createCapturer({
      captureVisibleTab: async () => { calls++; if (calls === 1) throw new Error('boom'); return 'ok'; },
      now: c.now,
      sleep: c.sleep
    });
    let caught;
    try { await capturer.capture(1); } catch (err) { caught = err; }
    expect(caught.message).toBe('boom');
    expect(calls).toBe(1);
    expect(await capturer.capture(1)).toBe('ok');
  });
});

describe('createScreenCapture', () => {
  const tab = { id: 4, windowId: 2, url: 'https://example.com/chart', title: 'Chart' };

  function setup({ activeTab = tab, capture = async () => 'data:image/png;base64,AA==', checkPage = () => ({ allowed: true }) } = {}) {
    const calls = [];
    const screen = createScreenCapture({
      capturer: { capture: async (windowId) => { calls.push(windowId); return capture(); } },
      getActiveTab: async () => activeTab,
      checkPage
    });
    const attempt = async () => { try { return { result: await screen.captureScreen(2) }; } catch (error) { return { error }; } };
    return { attempt, calls };
  }

  it("captures the panel window's active tab and says which tab it was (EC-SCR-03)", async () => {
    const { attempt, calls } = setup();
    const { result } = await attempt();
    expect(result).toEqual({ dataUrl: 'data:image/png;base64,AA==', tabId: 4, title: 'Chart', url: 'https://example.com/chart' });
    expect(calls).toEqual([2]);
  });

  it('refuses browser pages without trying (EC-SCR-02)', async () => {
    const { attempt, calls } = setup({ activeTab: { ...tab, url: 'chrome://settings/' } });
    const { error } = await attempt();
    expect(error).toBeInstanceOf(FeatureError);
    expect(error.code).toBe('PAGE_RESTRICTED');
    expect(calls).toEqual([]);
  });

  it("allows PDFs: they can't be read as text, but they can be seen (EC-PNL-04)", async () => {
    const { attempt } = setup({ activeTab: { ...tab, url: 'https://example.com/report.pdf' } });
    expect((await attempt()).result.tabId).toBe(4);
  });

  it('honours the page policy hook (P4.3)', async () => {
    const { attempt, calls } = setup({ checkPage: () => ({ allowed: false, message: 'Not on banking pages.' }) });
    const { error } = await attempt();
    expect(error.code).toBe('PAGE_BLOCKED');
    expect(error.message).toBe('Not on banking pages.');
    expect(calls).toEqual([]);
  });

  it("maps Chrome's errors to friendly ones", async () => {
    const denied = setup({ capture: async () => { throw new Error('Cannot access contents of the page.'); } });
    expect((await denied.attempt()).error.code).toBe('PAGE_RESTRICTED');
    const other = setup({ capture: async () => { throw new Error('Tab is being dragged'); } });
    expect((await other.attempt()).error.code).toBe('CAPTURE_FAILED');
  });

  it('no active tab → a hint, not a crash', async () => {
    const { attempt } = setup({ activeTab: null });
    expect((await attempt()).error.code).toBe('PAGE_RESTRICTED');
  });
});
