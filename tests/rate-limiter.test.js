import { describe, it, expect } from 'vitest';
import { MAX_COOLDOWN_MS, abortableSleep, createRateLimiter, memoryArea, nextMidnightPacific } from '../src/background/llm/rate-limiter.js';
import { parseRetryAfter } from '../src/background/llm/errors.js';

const iso = (s) => Date.parse(s);

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('1.5')).toBe(1500);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', iso('2026-10-21T07:27:30Z'))).toBe(30_000);
  });

  it('ignores junk and missing values', () => {
    for (const v of [undefined, null, '', 'soon']) expect(parseRetryAfter(v)).toBeUndefined();
  });
});

describe('nextMidnightPacific (EC-RTL-04)', () => {
  it('summer (PDT, UTC−7) and winter (PST, UTC−8)', () => {
    expect(nextMidnightPacific(iso('2026-07-15T12:00:00Z'))).toBe(iso('2026-07-16T07:00:00Z'));
    expect(nextMidnightPacific(iso('2026-01-15T12:00:00Z'))).toBe(iso('2026-01-16T08:00:00Z'));
  });

  it('just before midnight still means the coming midnight', () => {
    expect(nextMidnightPacific(iso('2026-01-16T07:59:00Z'))).toBe(iso('2026-01-16T08:00:00Z'));
  });

  it('handles the 23- and 25-hour days around daylight saving', () => {
    // 1:00 PST on 8 March 2026, the day clocks spring forward: the next midnight is in PDT.
    expect(nextMidnightPacific(iso('2026-03-08T09:00:00Z'))).toBe(iso('2026-03-09T07:00:00Z'));
    // 0:30 PDT on 1 November 2026, the day clocks fall back: the next midnight is in PST.
    expect(nextMidnightPacific(iso('2026-11-01T07:30:00Z'))).toBe(iso('2026-11-02T08:00:00Z'));
  });
});

describe('createRateLimiter', () => {
  function setup(start = 1_000_000) {
    const clock = { t: start };
    const slept = [];
    const area = memoryArea();
    const make = () => createRateLimiter({
      area, gaps: { lite: 1500 }, now: () => clock.t, sleep: async (ms) => { slept.push(ms); clock.t += ms; }
    });
    return { clock, slept, area, make };
  }

  it('remembers cooldowns until they expire', async () => {
    const { clock, make } = setup();
    const limiter = make();
    await limiter.setCooldown('gemini:lite', clock.t + 45_000, 'rate');
    expect(await limiter.cooldown('gemini:lite')).toEqual({ until: clock.t + 45_000, reason: 'rate' });
    expect(await limiter.cooldown('gemini:flash')).toBeNull();
    clock.t += 45_000;
    expect(await limiter.cooldown('gemini:lite')).toBeNull();
  });

  it('cooldowns survive a restarted worker (EC-RTL-12)', async () => {
    const { clock, make } = setup();
    await make().setCooldown('gemini:lite', clock.t + 60_000, 'daily');
    expect((await make().cooldown('gemini:lite')).reason).toBe('daily');
  });

  it('caps cooldowns at 24 hours (EC-LLM-15)', async () => {
    const { clock, make } = setup();
    const limiter = make();
    await limiter.setCooldown('gemini:lite', clock.t + 10 * MAX_COOLDOWN_MS, 'rate');
    expect((await limiter.cooldown('gemini:lite')).until).toBe(clock.t + MAX_COOLDOWN_MS);
  });

  it('paces calls to the same model by its minimum gap', async () => {
    const { slept, make } = setup();
    const limiter = make();
    await limiter.pace('gemini:lite', 'lite');
    await limiter.pace('gemini:lite', 'lite');
    await limiter.pace('gemini:flash', 'flash'); // no gap configured for flash here
    expect(slept).toEqual([1500]);
  });
});

describe('abortableSleep', () => {
  it('refuses to wait once Stop was pressed (EC-RTL-11)', async () => {
    const controller = new AbortController();
    controller.abort();
    let caught;
    try { await abortableSleep(10_000, controller.signal); } catch (err) { caught = err; }
    expect(caught.code).toBe('CANCELLED');
  });
});
