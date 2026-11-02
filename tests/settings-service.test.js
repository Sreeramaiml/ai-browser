import { describe, it, expect } from 'vitest';
import { createSettingsService } from '../src/background/settings-service.js';
import { SCHEMA_VERSION, createStorage } from '../src/shared/storage.js';
import { MODELS } from '../src/shared/config.js';

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
function memoryArea(initial = {}) {
  const data = clone(initial);
  return {
    data,
    async get(keys) {
      const out = {};
      for (const k of keys) if (k in data) out[k] = clone(data[k]);
      return out;
    },
    async set(items) { Object.assign(data, clone(items)); },
    async remove(keys) { for (const k of keys) delete data[k]; }
  };
}

const GEMINI_KEY = 'AIza' + 'z'.repeat(35);
const GROQ_KEY = 'gsk_' + 'q'.repeat(30);

function setup(initial = {}) {
  const area = memoryArea(initial);
  const checks = [];
  const service = createSettingsService({
    storage: createStorage(area),
    checkKey: async (key, opts) => {
      checks.push({ key, opts });
      return { ok: true, message: '✓ Key works.' };
    }
  });
  return { area, service, checks };
}

describe('settings service: save', () => {
  it('saves preferences and returns the new state', async () => {
    const { service, area } = setup();
    const reply = await service.save({ settings: { language: 'hinglish', tone: 'friendly' } });
    expect(reply.type).toBe('SAVED');
    expect(reply.payload.state.settings.language).toBe('hinglish');
    expect(area.data.settings.tone).toBe('friendly');
  });

  it('rejects invalid values without saving anything (all-or-nothing)', async () => {
    const { service, area } = setup();
    const reply = await service.save({ settings: { language: 'klingon' }, secrets: { gemini: GEMINI_KEY } });
    expect(reply.type).toBe('VALIDATION_ERROR');
    expect(Object.keys(reply.payload.errors)).toEqual(['language']);
    expect(area.data.secrets).toBeUndefined();
  });

  it('trims and saves a key, but only ever returns it masked (EC-SET-13)', async () => {
    const { service, area } = setup();
    const reply = await service.save({ secrets: { gemini: `  ${GEMINI_KEY}  ` } });
    expect(reply.type).toBe('SAVED');
    expect(area.data.secrets.geminiKey).toBe(GEMINI_KEY);
    expect(JSON.stringify(reply).includes(GEMINI_KEY)).toBe(false);
    expect(reply.payload.state.secrets.gemini.saved).toBe(true);
  });

  it('refuses a Groq key in the Gemini field (EC-SET-02)', async () => {
    const { service } = setup();
    const reply = await service.save({ secrets: { gemini: GROQ_KEY } });
    expect(reply.type).toBe('VALIDATION_ERROR');
    expect(reply.payload.errors.geminiKey).toMatch(/Groq key/);
  });

  it('removes a key with null', async () => {
    const { service, area } = setup({ secrets: { geminiKey: GEMINI_KEY } });
    const reply = await service.save({ secrets: { gemini: null } });
    expect(reply.payload.state.secrets.gemini).toEqual({ saved: false, masked: null });
    expect(area.data.secrets).toEqual({});
  });

  it('returns a typed error when data is from a newer version (EC-SET-11)', async () => {
    const { service } = setup({ schemaVersion: SCHEMA_VERSION + 1 });
    const reply = await service.save({ settings: { tone: 'formal' } });
    expect(reply.type).toBe('ERROR');
    expect(reply.payload.code).toBe('READ_ONLY');
    expect((await service.buildState()).readOnly).toBe(true);
  });
});

describe('settings service: testKey', () => {
  it('tests the typed key when given one', async () => {
    const { service, checks } = setup({ secrets: { geminiKey: 'AIza' + 'a'.repeat(35) } });
    const reply = await service.testKey({ provider: 'gemini', key: ` ${GEMINI_KEY} ` });
    expect(reply.type).toBe('KEY_TEST_RESULT');
    expect(checks[0].key).toBe(GEMINI_KEY);
  });

  it('falls back to the saved key', async () => {
    const { service, checks } = setup({ secrets: { geminiKey: GEMINI_KEY } });
    await service.testKey({ provider: 'gemini' });
    expect(checks[0].key).toBe(GEMINI_KEY);
  });

  it('checks both configured Gemini models', async () => {
    const { service, checks } = setup({ secrets: { geminiKey: GEMINI_KEY } });
    await service.testKey({});
    expect(checks[0].opts).toEqual({ requiredModels: [MODELS.lite, MODELS.flash] });
  });

  it('checks a user override of a model', async () => {
    const { service, checks } = setup({ secrets: { geminiKey: GEMINI_KEY }, settings: { models: { lite: 'my-lite' } } });
    await service.testKey({});
    expect(checks[0].opts).toEqual({ requiredModels: ['my-lite', MODELS.flash] });
  });

  it('tests a saved Groq key against the configured Groq model', async () => {
    const groqChecks = [];
    const service = createSettingsService({
      storage: createStorage(memoryArea({ secrets: { groqKey: GROQ_KEY } })),
      checkKey: async () => { throw new Error('not Gemini'); },
      checkGroq: async (key, opts) => { groqChecks.push({ key, opts }); return { ok: true, message: '✓ Key works.' }; }
    });
    const reply = await service.testKey({ provider: 'groq' });
    expect(reply.payload.ok).toBe(true);
    expect(groqChecks).toEqual([{ key: GROQ_KEY, opts: { model: MODELS.groq } }]);
  });

  it('refuses a Gemini key typed into the Groq test', async () => {
    const { service } = setup();
    const reply = await service.testKey({ provider: 'groq', key: GEMINI_KEY });
    expect(reply.payload.code).toBe('INVALID_INPUT');
  });

  it('rejects an unknown provider', async () => {
    const { service, checks } = setup({ secrets: { geminiKey: GEMINI_KEY } });
    const reply = await service.testKey({ provider: 'openai' });
    expect(reply.payload.code).toBe('UNSUPPORTED');
    expect(checks).toHaveLength(0);
  });

  it('NO_API_KEY when nothing is typed or saved', async () => {
    const { service, checks } = setup();
    const reply = await service.testKey({ provider: 'gemini' });
    expect(reply.payload.code).toBe('NO_API_KEY');
    expect(checks).toHaveLength(0);
  });

  it('reports bad input before calling Google', async () => {
    const { service, checks } = setup();
    const reply = await service.testKey({ provider: 'gemini', key: GROQ_KEY });
    expect(reply.payload.code).toBe('INVALID_INPUT');
    expect(checks).toHaveLength(0);
  });
});

describe('settings service: Groq backup (P2.4)', () => {
  it('saving a Groq key turns the backup on; removing it turns it off', async () => {
    const { service, area } = setup();
    await service.save({ secrets: { groq: GROQ_KEY } });
    expect(area.data.secrets.groqKey).toBe(GROQ_KEY);
    expect(area.data.settings.groqEnabled).toBe(true);
    await service.save({ secrets: { groq: null } });
    expect(area.data.secrets.groqKey).toBeUndefined();
    expect(area.data.settings.groqEnabled).toBe(false);
  });

  it('an explicit choice in the same save wins', async () => {
    const { service, area } = setup();
    await service.save({ secrets: { groq: GROQ_KEY }, settings: { groqEnabled: false } });
    expect(area.data.settings.groqEnabled).toBe(false);
  });

  it('the switch can be flipped on its own', async () => {
    const { service, area } = setup({ secrets: { groqKey: GROQ_KEY } });
    await service.save({ settings: { groqEnabled: true } });
    expect(area.data.settings.groqEnabled).toBe(true);
  });
});
