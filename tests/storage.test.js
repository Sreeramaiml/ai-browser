import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION, StorageError, clampMaxSteps, createStorage, defaultSettings, maskKey, mergeSettings,
  normalizeSettings, resolveModels, secretsStatus, validateKeyInput, validateSettingsPatch,
  PROFILE_TEXT_MAX, USER_DATA_KEYS, normalizeProfile, normalizeSkills, normalizeUrl, validateProfile
} from '../src/shared/storage.js';
import { MODELS } from '../src/shared/config.js';
import { STARTER_SKILLS } from '../src/shared/default-skills.js';

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** In-memory stand-in for chrome.storage.local. */
function memoryArea(initial = {}, { failWith } = {}) {
  const data = clone(initial);
  return {
    data,
    writes: 0,
    async get(keys) {
      const out = {};
      for (const k of keys) if (k in data) out[k] = clone(data[k]);
      return out;
    },
    async set(items) {
      if (failWith) throw new Error(failWith);
      this.writes++;
      Object.assign(data, clone(items));
    },
    async remove(keys) {
      for (const k of keys) delete data[k];
    }
  };
}

// Fakes, built at runtime so no key-shaped literal exists in the repo.
const GEMINI_KEY = 'AIza' + 'x'.repeat(35);
const GROQ_KEY = 'gsk_' + 'y'.repeat(30);

describe('normalizeSettings (EC-SET-10)', () => {
  it('returns defaults for missing or non-object values', () => {
    expect(normalizeSettings(undefined)).toEqual(defaultSettings());
    expect(normalizeSettings('oops')).toEqual(defaultSettings());
    expect(normalizeSettings([1, 2])).toEqual(defaultSettings());
  });

  it('keeps valid fields and replaces only the corrupted ones', () => {
    const s = normalizeSettings({ language: 'hinglish', tone: 42, translateTarget: 'xx', agent: { maxSteps: '7' }, useBuiltinAI: 'yes' });
    expect(s.language).toBe('hinglish');
    expect(s.tone).toBe('polite');
    expect(s.translateTarget).toBe('hi');
    expect(s.agent).toEqual({ maxSteps: 7, dryRunDefault: false });
    expect(s.useBuiltinAI).toBe(false);
  });

  it('drops unknown or malformed model overrides (including an old Claude one)', () => {
    const s = normalizeSettings({ models: { lite: 'gemini-x-lite', flash: 'bad id!', claude: 'claude-x', other: 'x' } });
    expect(s.models).toEqual({ lite: 'gemini-x-lite' });
  });
});

describe('clampMaxSteps (EC-SET-12)', () => {
  const cases = [[0, 1], [-5, 1], [15, 15], [30, 30], [31, 30], [999, 30], [7.6, 8], ['12', 12], ['abc', 15], [NaN, 15], [null, 15], ['', 15]];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => expect(clampMaxSteps(input)).toBe(expected));
  }
});

describe('validateSettingsPatch', () => {
  it('accepts valid fields', () => {
    const { value, errors } = validateSettingsPatch({ language: 'hinglish', tone: 'formal', translateTarget: 'ta' });
    expect(errors).toEqual({});
    expect(value).toEqual({ language: 'hinglish', tone: 'formal', translateTarget: 'ta' });
  });

  it('reports invalid choices with a readable message', () => {
    const { errors } = validateSettingsPatch({ language: 'french' });
    expect(errors.language).toMatch(/English, Hinglish/);
  });

  it('clamps step limits instead of rejecting them', () => {
    const { value, errors } = validateSettingsPatch({ agent: { maxSteps: 500 } });
    expect(errors).toEqual({});
    expect(value.agent).toEqual({ maxSteps: 30 });
  });

  it('ignores unknown keys and rejects non-objects', () => {
    expect(validateSettingsPatch({ evil: true }).value).toEqual({});
    expect(validateSettingsPatch(null).errors._).toBe('Invalid settings.');
  });

  it('lets a model override be reset with null', () => {
    expect(validateSettingsPatch({ models: { lite: null } }).value).toEqual({ models: { lite: null } });
  });
});

describe('mergeSettings / resolveModels', () => {
  it('merges nested agent settings per field', () => {
    const current = normalizeSettings({ agent: { maxSteps: 10, dryRunDefault: true } });
    const next = mergeSettings(current, { agent: { maxSteps: 20 } });
    expect(next.agent).toEqual({ maxSteps: 20, dryRunDefault: true });
  });

  it('applies and resets model overrides', () => {
    let s = mergeSettings(defaultSettings(), { models: { lite: 'custom-lite' } });
    expect(resolveModels(s).lite).toBe('custom-lite');
    expect(resolveModels(s).flash).toBe(MODELS.flash);
    s = mergeSettings(s, { models: { lite: null } });
    expect(resolveModels(s).lite).toBe(MODELS.lite);
  });
});

describe('validateKeyInput (EC-SET-01, EC-SET-02)', () => {
  it('accepts the newer "AQ." Gemini keys, which contain dots (regression: they were rejected)', () => {
    const aqKey = 'AQ.' + 'Ab8RN6' + 'x'.repeat(30) + '.' + 'y'.repeat(13); // 53 chars, like the real report
    expect(aqKey.length).toBe(53);
    expect(validateKeyInput('gemini', aqKey)).toEqual({ ok: true, key: aqKey });
    expect(validateKeyInput('gemini', `  ${aqKey}\n`)).toEqual({ ok: true, key: aqKey });
    expect(validateKeyInput('gemini', `my key: ${aqKey}`)).toEqual({ ok: true, key: aqKey });
    expect(validateKeyInput('groq', aqKey).error).toMatch(/Gemini key/);
  });

  it('still rejects keys containing quotes, angle brackets or other odd characters', () => {
    expect(validateKeyInput('gemini', 'AQ.' + 'x'.repeat(30) + '"').ok).toBe(false);
    expect(validateKeyInput('gemini', 'AQ.' + 'x'.repeat(30) + '<b>').ok).toBe(false);
  });

  it('trims surrounding whitespace and newlines', () => {
    expect(validateKeyInput('gemini', `  ${GEMINI_KEY}\n`)).toEqual({ ok: true, key: GEMINI_KEY });
  });

  it('extracts the key when extra words were pasted with it', () => {
    expect(validateKeyInput('gemini', `my key is ${GEMINI_KEY}`)).toEqual({ ok: true, key: GEMINI_KEY });
  });

  it('rejects a key broken by a space, or two keys at once', () => {
    expect(validateKeyInput('gemini', `${GEMINI_KEY.slice(0, 10)} ${GEMINI_KEY.slice(10)}`).ok).toBe(false);
    expect(validateKeyInput('gemini', `${GEMINI_KEY} ${GEMINI_KEY}`).ok).toBe(false);
  });

  it('rejects empty input', () => {
    expect(validateKeyInput('gemini', '   ').ok).toBe(false);
    expect(validateKeyInput('gemini', undefined).ok).toBe(false);
  });

  it('catches keys pasted into the wrong provider field', () => {
    const r1 = validateKeyInput('gemini', GROQ_KEY);
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/Groq key/);
    const r2 = validateKeyInput('groq', GEMINI_KEY);
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/Gemini key/);
  });

  it('explains that a Claude key is the wrong kind of key', () => {
    expect(validateKeyInput('gemini', 'sk-ant-api03-' + 'a'.repeat(60)).error).toMatch(/Claude key/);
  });

  it('rejects things that are clearly not keys', () => {
    expect(validateKeyInput('gemini', 'hello').ok).toBe(false);
    expect(validateKeyInput('gemini', 'not a key at all').ok).toBe(false);
    expect(validateKeyInput('groq', 'key<script>alert(1)</script>xxxxxxxx').ok).toBe(false);
  });
});

describe('maskKey / secretsStatus (EC-SET-13)', () => {
  it('reveals only the prefix and the last four characters', () => {
    const masked = maskKey(GEMINI_KEY);
    expect(masked).toBe(`${GEMINI_KEY.slice(0, 6)}…${GEMINI_KEY.slice(-4)}`);
    expect(masked.includes(GEMINI_KEY.slice(6, -4))).toBe(false);
  });

  it('fully masks short values and handles absence', () => {
    expect(maskKey('short')).toBe('••••');
    expect(maskKey(undefined)).toBeNull();
  });

  it('never includes the raw key in the status object', () => {
    const status = secretsStatus({ geminiKey: GEMINI_KEY });
    expect(JSON.stringify(status).includes(GEMINI_KEY)).toBe(false);
    expect(status).toEqual({ gemini: { saved: true, masked: maskKey(GEMINI_KEY) }, groq: { saved: false, masked: null } });
  });
});

describe('createStorage', () => {
  it('returns defaults when nothing is stored', async () => {
    const storage = createStorage(memoryArea());
    expect(await storage.getSettings()).toEqual(defaultSettings());
    expect(await storage.getSecrets()).toEqual({});
    expect(await storage.get('skills')).toEqual([]);
    expect(await storage.get('activeTaskId')).toBeNull();
  });

  it('keeps concurrent updates from two panels (EC-SET-08)', async () => {
    const area = memoryArea();
    const storage = createStorage(area);
    await Promise.all([
      storage.updateSettings({ language: 'hinglish' }),
      storage.updateSettings({ tone: 'formal' }),
      storage.updateSettings({ agent: { maxSteps: 9 } })
    ]);
    const s = await storage.getSettings();
    expect(s.language).toBe('hinglish');
    expect(s.tone).toBe('formal');
    expect(s.agent.maxSteps).toBe(9);
  });

  it('saves and removes secrets independently', async () => {
    const area = memoryArea();
    const storage = createStorage(area);
    await storage.setSecret('gemini', GEMINI_KEY);
    await storage.setSecret('groq', GROQ_KEY);
    await storage.setSecret('gemini', null);
    expect(area.data.secrets).toEqual({ groqKey: GROQ_KEY });
  });

  it('turns quota failures into a friendly StorageError (EC-SET-09)', async () => {
    const storage = createStorage(memoryArea({}, { failWith: 'QUOTA_BYTES quota exceeded' }));
    let caught;
    try {
      await storage.updateSettings({ tone: 'formal' });
    } catch (err) {
      caught = err;
    }
    expect(caught instanceof StorageError).toBe(true);
    expect(caught.code).toBe('QUOTA_EXCEEDED');
  });

  it('keeps working after a failed write', async () => {
    const area = memoryArea({}, { failWith: 'disk error' });
    const storage = createStorage(area);
    await storage.updateSettings({ tone: 'formal' }).catch(() => {});
    area.set = async function (items) { Object.assign(this.data, clone(items)); };
    await storage.updateSettings({ tone: 'friendly' });
    expect((await storage.getSettings()).tone).toBe('friendly');
  });
});

describe('migrate', () => {
  it('fresh install: writes defaults and the schema version', async () => {
    const area = memoryArea();
    const result = await createStorage(area).migrate();
    expect(result).toEqual({ status: 'migrated', from: 0, to: SCHEMA_VERSION });
    expect(area.data.schemaVersion).toBe(SCHEMA_VERSION);
    expect(area.data.settings).toEqual(defaultSettings());
    expect(area.data.skills.map((sk) => sk.name)).toEqual(STARTER_SKILLS.map((sk) => sk.name));
    expect(area.data.skillsSeeded).toBe(true);
  });

  it('starter skills are installed once: deleting them is final, even after an update (EC-SKL-06)', async () => {
    const area = memoryArea();
    const storage = createStorage(area);
    await storage.migrate();
    await storage.updateSkills(() => ({ skills: [], result: null }));
    await storage.migrate();
    expect(area.data.skills).toEqual([]);
    await storage.clearUserData();
    await storage.migrate();
    expect(await storage.getSkills()).toEqual([]);
  });

  it('an update from before skills existed leaves saved skills alone and sets the flag', async () => {
    const mine = { id: 'mine', name: 'Mine', icon: '', mode: 'answer', prompt: 'Do it', needs: [], language: 'inherit', createdAt: 1, updatedAt: 1 };
    const area = memoryArea({ schemaVersion: SCHEMA_VERSION, skills: [mine] });
    await createStorage(area).migrate();
    expect(area.data.skills).toEqual([mine]);
    expect(area.data.skillsSeeded).toBe(true);
  });

  it('getSkills drops stored skills that are no longer valid, and keeps ids stable', async () => {
    const good = { id: 'ok-1', name: 'Good', mode: 'answer', prompt: 'Summarise {{page}}', script: 'x' };
    const storage = createStorage(memoryArea({ skills: [good, { name: 'no id', mode: 'answer', prompt: 'p' }, { id: 'bad', mode: 'run' }, 'junk'] }));
    const skills = await storage.getSkills();
    expect(skills.map((sk) => sk.id)).toEqual(['ok-1']);
    expect(skills[0].needs).toEqual(['page']);
    expect('script' in skills[0]).toBe(false);
  });

  it('update: keeps existing profile, skills, keys and settings (EC-INS-04)', async () => {
    const existing = {
      schemaVersion: SCHEMA_VERSION,
      settings: { ...defaultSettings(), language: 'hinglish' },
      secrets: { geminiKey: GEMINI_KEY },
      profile: { name: 'Asha Rao' },
      skills: [{ id: 's1', name: 'Exam notes' }]
    };
    const area = memoryArea(existing);
    await createStorage(area).migrate();
    expect(area.data.settings.language).toBe('hinglish');
    expect(area.data.secrets).toEqual({ geminiKey: GEMINI_KEY });
    expect(area.data.profile).toEqual({ name: 'Asha Rao' });
    expect(area.data.skills).toEqual([{ id: 's1', name: 'Exam notes' }]);
  });

  it('v2 → v3: deletes the stored Claude key and its model override, keeps everything else (ADR-2)', async () => {
    const area = memoryArea({
      schemaVersion: 2,
      settings: { ...defaultSettings(), language: 'hinglish', models: { claude: 'claude-opus-5-5' } },
      secrets: { claudeKey: 'sk-ant-api03-' + 'c'.repeat(80), groqKey: GROQ_KEY },
      profile: { name: 'Asha Rao' }
    });
    const result = await createStorage(area).migrate();
    expect(result).toEqual({ status: 'migrated', from: 2, to: 3 });
    expect(area.data.secrets).toEqual({ groqKey: GROQ_KEY });
    expect(area.data.settings.models).toEqual({});
    expect(area.data.settings.language).toBe('hinglish');
    expect(area.data.profile).toEqual({ name: 'Asha Rao' });
  });

  it('v1 → v3: keeps a Gemini key saved before the Claude detour', async () => {
    const area = memoryArea({ schemaVersion: 1, secrets: { geminiKey: GEMINI_KEY } });
    await createStorage(area).migrate();
    expect(area.data.secrets).toEqual({ geminiKey: GEMINI_KEY });
    expect(area.data.schemaVersion).toBe(3);
  });

  it('is a no-op when everything is current', async () => {
    const area = memoryArea();
    const storage = createStorage(area);
    await storage.migrate();
    const writes = area.writes;
    expect((await storage.migrate()).status).toBe('current');
    expect(area.writes).toBe(writes);
  });

  it('pre-versioned data is normalised, not discarded', async () => {
    const area = memoryArea({ settings: { language: 'hinglish', tone: 'shouty' } });
    await createStorage(area).migrate();
    expect(area.data.settings.language).toBe('hinglish');
    expect(area.data.settings.tone).toBe('polite');
  });

  it('never touches data from a newer version and becomes read-only (EC-SET-11)', async () => {
    const area = memoryArea({ schemaVersion: SCHEMA_VERSION + 1, settings: { language: 'hinglish' } });
    const storage = createStorage(area);
    expect((await storage.migrate()).status).toBe('newer');
    expect(await storage.isReadOnly()).toBe(true);
    let caught;
    try {
      await storage.updateSettings({ tone: 'formal' });
    } catch (err) {
      caught = err;
    }
    expect(caught.code).toBe('READ_ONLY');
    expect(area.data.settings).toEqual({ language: 'hinglish' });
  });
});

describe('profile (P4.1)', () => {
  it('validateProfile trims, caps and keeps valid fields', () => {
    const { value, errors, warnings } = validateProfile({
      name: '  Asha Rao ', email: 'asha@example.com', phone: '+91 98765 43210', college: 'IIT Hyderabad', degree: 'B.Tech',
      gradYear: '2026', skills: ['JS', 'js', ' ', 'SQL'], links: { github: 'github.com/asha', portfolio: '' },
      preferredLanguage: 'hinglish', preferredTone: 'formal', about: 'x'.repeat(2500), extra: 'dropped'
    });
    expect(errors).toEqual({});
    expect(warnings).toEqual({});
    expect(value).toMatchObject({
      name: 'Asha Rao', email: 'asha@example.com', gradYear: 2026, skills: ['JS', 'SQL'],
      links: { github: 'https://github.com/asha' }, preferredLanguage: 'hinglish', preferredTone: 'formal'
    });
    expect(value.about).toHaveLength(PROFILE_TEXT_MAX.about); // EC-PRF-04
    expect('extra' in value).toBe(false);
  });

  it('reports invalid email, phone, year, links and choices, field by field (EC-PRF-06)', () => {
    const { value, errors } = validateProfile({
      name: 'Asha', email: 'asha@', phone: 'call me', gradYear: '26', links: { linkedin: 'javascript:alert(1)', github: 'not a url' },
      preferredLanguage: 'klingon', preferredTone: 'shouty'
    });
    expect(Object.keys(errors).sort()).toEqual(
      ['email', 'gradYear', 'links.github', 'links.linkedin', 'phone', 'preferredLanguage', 'preferredTone'].sort()
    );
    expect(value).toEqual({ name: 'Asha' });
  });

  it('rejects non-objects', () => {
    expect(validateProfile('x').errors._).toBeTruthy();
  });

  it('warns about ID and card numbers, but still keeps them (EC-PRF-07)', () => {
    const { value, warnings } = validateProfile({ about: 'PAN ABCDE1234F', degree: 'Card 4111 1111 1111 1111', name: 'Asha' });
    expect(Object.keys(warnings).sort()).toEqual(['about', 'degree']);
    expect(value.about).toBe('PAN ABCDE1234F');
  });

  it('normalizeSkills de-duplicates case-insensitively and drops empty chips (EC-PRF-05)', () => {
    expect(normalizeSkills(' React, react ,, Node.js ')).toEqual(['React', 'Node.js']);
    expect(normalizeSkills(Array.from({ length: 40 }, (_, i) => `s${i}`))).toHaveLength(30);
    expect(normalizeSkills(42)).toEqual([]);
  });

  it('normalizeUrl adds https:// and refuses other schemes', () => {
    expect(normalizeUrl('linkedin.com/in/asha')).toBe('https://linkedin.com/in/asha');
    expect(normalizeUrl('http://asha.dev')).toBe('http://asha.dev');
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('localhost')).toBeNull();
  });

  it('normalizeProfile keeps known fields of the right type only', () => {
    expect(normalizeProfile({ name: ' A ', gradYear: 'soon', skills: 'a, b', links: { github: 'x', evil: 'y' }, tone: 1, preferredTone: 'nope' }))
      .toEqual({ name: 'A', skills: ['a', 'b'], links: { github: 'x' } });
    expect(normalizeProfile(null)).toEqual({});
  });

  it('getProfile normalises what is stored', async () => {
    const storage = createStorage(memoryArea({ profile: { name: ' Asha ', junk: true } }));
    expect(await storage.getProfile()).toEqual({ name: 'Asha' });
  });

  it('clearUserData deletes profile, skills, logs and keys, but keeps settings and safety lists', async () => {
    const area = memoryArea({
      schemaVersion: SCHEMA_VERSION, settings: { language: 'hinglish' }, safety: { ownedDomains: ['me.dev'] },
      profile: { name: 'Asha' }, skills: [{ id: 's' }], agentTasks: { t1: {} }, activeTaskId: 't1', secrets: { geminiKey: GEMINI_KEY }
    });
    await createStorage(area).clearUserData();
    expect(Object.keys(area.data).sort()).toEqual(['safety', 'schemaVersion', 'settings']);
    for (const key of USER_DATA_KEYS) expect(key in area.data).toBe(false);
  });

  it('clearUserData works even when the data is read-only', async () => {
    const area = memoryArea({ schemaVersion: SCHEMA_VERSION + 1, profile: { name: 'Asha' } });
    await createStorage(area).clearUserData();
    expect(area.data.profile).toBeUndefined();
  });
});
