import { describe, it, expect } from 'vitest';
import { BACKOFF_MS, MAX_HTTP_ATTEMPTS, createGateway, decide, halveLongestText } from '../src/background/llm/gateway.js';
import { LlmError } from '../src/background/llm/errors.js';
import { createRateLimiter, memoryArea, nextMidnightPacific } from '../src/background/llm/rate-limiter.js';
import { MODELS } from '../src/shared/config.js';

describe('createGateway', () => {
  const turns = [{ role: 'user', parts: [{ text: 'hi' }] }];

  it('NO_API_KEY before any network call when no key is saved', async () => {
    const calls = [];
    const gateway = createGateway({
      getApiKey: async () => undefined,
      getModels: async () => ({ lite: MODELS.lite, flash: MODELS.flash }),
      stream: async (...args) => { calls.push(args); return { text: 'x', model: 'm', stopReason: 'end_turn' }; }
    });
    let caught;
    try {
      await gateway.stream({ task: 'explain', system: 's', turns, onDelta: () => {} });
    } catch (err) {
      caught = err;
    }
    expect(caught.code).toBe('NO_API_KEY');
    expect(calls).toHaveLength(0);
  });

  it('passes model, prompt and key to the provider and tags the result', async () => {
    const calls = [];
    const gateway = createGateway({
      getApiKey: async () => 'key-123',
      getModels: async () => ({ lite: 'gemini-3.5-flash-lite', flash: 'gemini-3.8-flash' }),
      stream: async (req, opts) => {
        calls.push({ req, opts });
        opts.onDelta('Hello');
        return { text: 'Hello', model: 'gemini-3.5-flash-lite', stopReason: 'end_turn' };
      }
    });
    const deltas = [];
    const result = await gateway.stream({ task: 'explain', system: 'sys', turns, maxTokens: 500, onDelta: (d) => deltas.push(d) });
    expect(result).toEqual({ text: 'Hello', model: 'gemini-3.5-flash-lite', stopReason: 'end_turn', provider: 'gemini', attempts: 1 });
    expect(deltas).toEqual(['Hello']);
    expect(calls[0].req).toEqual({ model: 'gemini-3.5-flash-lite', system: 'sys', turns, maxTokens: 500 });
    expect(calls[0].opts.apiKey).toBe('key-123');
  });
});

describe('gateway.stream escalation', () => {
  it('sends an escalated request to the Flash model', async () => {
    const calls = [];
    const gateway = createGateway({
      getApiKey: async () => 'key',
      getModels: async () => ({ lite: 'lite-x', flash: 'flash-x' }),
      stream: async (req) => { calls.push(req.model); return { text: 'ok', model: req.model, stopReason: 'end_turn' }; }
    });
    const turns = [{ role: 'user', parts: [{ text: 'hi' }] }];
    await gateway.stream({ task: 'vision', system: 's', turns, onDelta: () => {} });
    await gateway.stream({ task: 'vision', system: 's', turns, escalate: true, onDelta: () => {} });
    expect(calls).toEqual(['lite-x', 'flash-x']);
  });
});

describe('gateway.json (architecture §8.5)', () => {
  const turns = [{ role: 'user', parts: [{ text: 'Summarise' }] }];
  const validate = (v) => (v && v.n === 5 ? { ok: true, value: v } : { ok: false, error: 'n must be 5.' });

  /** Gateway whose provider returns the given replies in order (strings, or errors to throw). */
  function setup(replies) {
    const calls = [];
    const gateway = createGateway({
      getApiKey: async () => 'key',
      getModels: async () => ({ lite: 'gemini-3.5-flash-lite', flash: 'gemini-3.8-flash' }),
      generate: async (req, opts) => {
        calls.push({ req, opts });
        const next = replies.shift();
        if (next instanceof Error) throw next;
        return { text: next, model: req.model, stopReason: 'end_turn' };
      }
    });
    return { gateway, calls };
  }

  async function run(gateway) {
    try { return { result: await gateway.json({ task: 'summary', system: 's', turns, schema: { type: 'OBJECT' }, validate }) }; } catch (error) { return { error }; }
  }

  it('returns the validated value on the first try', async () => {
    const { gateway, calls } = setup(['{"n":5}']);
    const { result } = await run(gateway);
    expect(result).toEqual({ value: { n: 5 }, provider: 'gemini', model: 'gemini-3.5-flash-lite', attempts: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.json).toEqual({ schema: { type: 'OBJECT' } });
  });

  it('repairs once, quoting the validator error and the bad reply', async () => {
    const { gateway, calls } = setup(['{"n":4}', '```json\n{"n":5}\n```']);
    const { result } = await run(gateway);
    expect(result.value).toEqual({ n: 5 });
    expect(calls).toHaveLength(2);
    const repairTurns = calls[1].req.turns;
    expect(repairTurns).toHaveLength(3);
    expect(repairTurns[1]).toEqual({ role: 'assistant', parts: [{ text: '{"n":4}' }] });
    expect(repairTurns[2].parts[0].text).toMatch(/n must be 5\./);
  });

  it('after a failed repair, escalates to Flash; INVALID_OUTPUT only when that fails too', async () => {
    const { gateway, calls } = setup(['not json', '{"n":1}', '{"n":2}', '{"n":3}']);
    const { error } = await run(gateway);
    expect(error.code).toBe('INVALID_OUTPUT');
    expect(calls.map((c) => c.req.model)).toEqual(['gemini-3.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.8-flash']);
  });

  it('Flash can rescue output Flash-Lite got wrong twice', async () => {
    const { gateway } = setup(['nope', 'still nope', '{"n":5}']);
    const { result } = await run(gateway);
    expect(result).toMatchObject({ value: { n: 5 }, model: 'gemini-3.8-flash' });
  });

  it('retries without the schema if the API rejects it', async () => {
    const { LlmError } = await import('../src/background/llm/errors.js');
    const { gateway, calls } = setup([new LlmError('BAD_REQUEST', { status: 400 }), '{"n":5}']);
    const { result } = await run(gateway);
    expect(result.value).toEqual({ n: 5 });
    expect(calls[1].opts.json).toEqual({});
  });

  it('fails fast on errors no other model would fix', async () => {
    const { gateway, calls } = setup([new LlmError('SAFETY_BLOCKED')]);
    const { error } = await run(gateway);
    expect(error.code).toBe('SAFETY_BLOCKED');
    expect(calls).toHaveLength(1);
  });
});

describe('gateway chain (architecture §8.4)', () => {
  const NOW = 1_800_000_000_000;
  const models = { lite: 'lite', flash: 'flash', groq: 'llama' };
  const text = (t) => [{ role: 'user', parts: [{ text: t }] }];
  const rate = (ms) => new LlmError('RATE_LIMITED', { status: 429, retryAfterMs: ms });
  const down = () => new LlmError('PROVIDER_DOWN', { status: 500 });

  /** Each queue holds replies in order: a string, an error to throw, or a function (req, opts) → result. */
  function setup({ gemini = [], groq = [], groqKey = 'gsk-key', fault = null, area = memoryArea() } = {}) {
    const calls = [];
    const slept = [];
    const resets = [];
    const provider = (queue, name) => async (req, opts) => {
      calls.push({ name: `${name}:${req.model}`, req });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next(req, opts);
      opts.onDelta?.(next ?? 'ok');
      return { text: next ?? 'ok', model: req.model, stopReason: 'end_turn' };
    };
    const limiter = createRateLimiter({ area, now: () => NOW });
    const gateway = createGateway({
      getApiKey: async () => 'gemini-key',
      getGroqKey: async () => groqKey,
      getModels: async () => models,
      stream: provider(gemini, 'gemini'),
      generate: provider(gemini, 'gemini'),
      groqStream: provider(groq, 'groq'),
      groqGenerate: provider(groq, 'groq'),
      limiter,
      takeFault: async () => fault,
      sleep: async (ms) => { slept.push(ms); },
      now: () => NOW,
      random: () => 0
    });
    const run = async (extra = {}) => {
      try {
        return { result: await gateway.stream({ task: 'chat', system: 's', turns: text('hi'), onDelta: () => {}, onReset: () => resets.push(1), ...extra }) };
      } catch (error) {
        return { error };
      }
    };
    const names = () => calls.map((c) => c.name);
    return { run, calls, names, slept, resets, limiter };
  }

  it('a short 429 waits and retries the same model (EC-RTL-01)', async () => {
    const { run, names, slept } = setup({ gemini: [rate(3000), 'ok'] });
    const { result } = await run();
    expect(names()).toEqual(['gemini:lite', 'gemini:lite']);
    expect(slept).toEqual([3000]);
    expect(result.attempts).toBe(2);
  });

  it('a long 429 cools the model down and falls back to Groq, which the result says (EC-RTL-02, EC-RTL-09)', async () => {
    const { run, names, slept, limiter } = setup({ gemini: [rate(45_000)], groq: ['Namaste'] });
    const { result } = await run();
    expect(names()).toEqual(['gemini:lite', 'groq:llama']);
    expect(result).toMatchObject({ text: 'Namaste', provider: 'groq', model: 'llama' });
    expect(slept).toEqual([]);
    expect(await limiter.cooldown('gemini:lite')).toEqual({ until: NOW + 45_000, reason: 'rate' });
  });

  it('a 429 without a hint cools down for 10 s (EC-RTL-03)', async () => {
    const { run, limiter } = setup({ gemini: [new LlmError('RATE_LIMITED', { status: 429 })] });
    await run();
    expect((await limiter.cooldown('gemini:lite')).until).toBe(NOW + 10_000);
  });

  it('without a Groq key, Groq is skipped silently (EC-RTL-06)', async () => {
    const { run, names } = setup({ groqKey: null, gemini: [rate(45_000), 'ok'] });
    const { result } = await run();
    expect(names()).toEqual(['gemini:lite', 'gemini:flash']);
    expect(result.model).toBe('flash');
  });

  it('every model cooling down → RATE_LIMITED with the earliest retry time (EC-RTL-05)', async () => {
    const { run, names } = setup({ gemini: [rate(45_000), rate(20_000)], groq: [rate(30_000)] });
    const { error } = await run();
    expect(names()).toEqual(['gemini:lite', 'groq:llama', 'gemini:flash']);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.toPayload().retryAt).toBe(NOW + 20_000);
  });

  it('a daily quota cools down until midnight Pacific and suggests Groq (EC-RTL-04)', async () => {
    const quota = () => new LlmError('QUOTA_EXHAUSTED', { status: 429 });
    const { run } = setup({ groqKey: null, gemini: [quota(), quota()] });
    const { error } = await run();
    expect(error.code).toBe('QUOTA_EXHAUSTED');
    expect(error.retryAt).toBe(nextMidnightPacific(NOW));
    expect(error.hint).toBe('add-groq');
  });

  it('skips models still cooling down from an earlier request (EC-RTL-12)', async () => {
    const area = memoryArea();
    await createRateLimiter({ area, now: () => NOW }).setCooldown('gemini:lite', NOW + 5_000, 'rate');
    const { run, names } = setup({ area, groq: ['ok'] });
    await run();
    expect(names()).toEqual(['groq:llama']);
  });

  it('5xx: backs off 1 s, then 3 s, then moves on', async () => {
    const { run, names, slept } = setup({ gemini: [down(), down(), down()], groq: ['ok'] });
    const { result } = await run();
    expect(slept).toEqual(BACKOFF_MS);
    expect(names()).toEqual(['gemini:lite', 'gemini:lite', 'gemini:lite', 'groq:llama']);
    expect(result.provider).toBe('groq');
  });

  it(`never makes more than ${MAX_HTTP_ATTEMPTS} provider calls for one request (EC-RTL-10)`, async () => {
    const { run, calls } = setup({ gemini: Array.from({ length: 10 }, down), groq: [down(), down(), down()] });
    const { error } = await run();
    expect(calls).toHaveLength(MAX_HTTP_ATTEMPTS);
    expect(error.code).toBe('PROVIDER_DOWN');
  });

  it('auth and safety errors fail fast with no fallback (EC-LLM-05)', async () => {
    for (const code of ['AUTH_FAILED', 'SAFETY_BLOCKED']) {
      const { run, calls } = setup({ gemini: [new LlmError(code)], groq: ['ok'] });
      expect((await run()).error.code).toBe(code);
      expect(calls).toHaveLength(1);
    }
  });

  it('a rejected Groq key is skipped, not fatal', async () => {
    const { run, names } = setup({ gemini: [rate(45_000), 'ok'], groq: [new LlmError('AUTH_FAILED', { status: 401 })] });
    const { result } = await run();
    expect(names()).toEqual(['gemini:lite', 'groq:llama', 'gemini:flash']);
    expect(result.model).toBe('flash');
  });

  it('context too long: trims the longest text to half and retries once', async () => {
    const { run, calls } = setup({ gemini: [new LlmError('CONTEXT_TOO_LARGE', { status: 400 }), 'ok'] });
    await run({ turns: text('x'.repeat(10_000)) });
    expect(calls).toHaveLength(2);
    const sent = calls[1].req.turns[0].parts[0].text;
    expect(sent.length).toBeLessThan(5_200);
    expect(sent).toContain('cut to fit');
  });

  it('nothing is sent after Stop, even with retries left (EC-RTL-11)', async () => {
    const controller = new AbortController();
    const { run, calls } = setup({ gemini: [() => { controller.abort(); throw down(); }, 'ok'] });
    const { error } = await run({ signal: controller.signal });
    expect(error.code).toBe('CANCELLED');
    expect(calls).toHaveLength(1);
  });

  it('a stream that fails part-way is reset before the next attempt streams', async () => {
    const { run, resets } = setup({ gemini: [(req, opts) => { opts.onDelta('half an ans'); throw down(); }, 'whole answer'] });
    const { result } = await run();
    expect(result.text).toBe('whole answer');
    expect(resets).toHaveLength(1);
  });

  it('vision never falls back to Groq (EC-SCR-12)', async () => {
    const { run, names } = setup({ gemini: [rate(45_000), rate(45_000)], groq: ['x'] });
    const { error } = await run({ task: 'vision' });
    expect(names()).toEqual(['gemini:lite', 'gemini:flash']);
    expect(error.code).toBe('RATE_LIMITED');
  });

  it('an injected fault fails every Gemini call of one request (dev only)', async () => {
    const { run, names } = setup({ fault: '429', groq: ['ok'] });
    const { result } = await run();
    expect(names()).toEqual(['groq:llama']);
    expect(result.provider).toBe('groq');
  });
});

describe('decide', () => {
  const at = (attempt, provider = 'gemini') => ({ attempt, provider, trimmed: false });

  it('waits out short rate limits at most twice', () => {
    const e = new LlmError('RATE_LIMITED', { retryAfterMs: 8_000 });
    expect(decide(e, at(0))).toEqual({ action: 'retry', delayMs: 8_000 });
    expect(decide(e, at(2)).action).toBe('next');
    expect(decide(new LlmError('RATE_LIMITED', { retryAfterMs: 8_001 }), at(0)).action).toBe('next');
  });

  it('retries a timeout once', () => {
    expect(decide(new LlmError('TIMEOUT'), at(0)).action).toBe('retry');
    expect(decide(new LlmError('TIMEOUT'), at(1)).action).toBe('next');
  });

  it('trims a too-long request once, then gives up', () => {
    expect(decide(new LlmError('CONTEXT_TOO_LARGE'), at(0)).action).toBe('trim');
    expect(decide(new LlmError('CONTEXT_TOO_LARGE'), { attempt: 1, provider: 'gemini', trimmed: true }).action).toBe('fail');
  });

  it('moves past images Groq cannot read and models that are gone (EC-RTL-08)', () => {
    expect(decide(new LlmError('UNSUPPORTED_INPUT'), at(0, 'groq')).action).toBe('next');
    expect(decide(new LlmError('MODEL_UNAVAILABLE'), at(0, 'groq')).action).toBe('next');
  });
});

describe('halveLongestText', () => {
  it('keeps the start and end of the longest part and leaves the rest alone', () => {
    const turns = [{ role: 'user', parts: [{ text: 'short' }, { text: `HEAD${'m'.repeat(1000)}TAIL` }] }];
    const out = halveLongestText(turns);
    expect(out[0].parts[0].text).toBe('short');
    expect(out[0].parts[1].text.startsWith('HEAD')).toBe(true);
    expect(out[0].parts[1].text.endsWith('TAIL')).toBe(true);
    expect(turns[0].parts[1].text.length).toBe(1008); // input untouched
  });
});
