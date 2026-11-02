import { describe, it, expect } from 'vitest';
import { SESSION_DATA_KEYS, createProfileService } from '../src/background/profile-service.js';
import { SCHEMA_VERSION, createStorage } from '../src/shared/storage.js';

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
function memoryArea(initial = {}) {
  const data = clone(initial);
  return {
    data,
    async get(keys) {
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = clone(data[k]);
      return out;
    },
    async set(items) { Object.assign(data, clone(items)); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; }
  };
}

const GEMINI_KEY = 'AIza' + 'z'.repeat(35);

function setup(initial = {}, sessionInitial = {}) {
  const area = memoryArea({ schemaVersion: SCHEMA_VERSION, ...initial });
  const session = memoryArea(sessionInitial);
  const events = [];
  const service = createProfileService({
    storage: createStorage(area),
    session,
    stopAgent: async () => { events.push(`stop:${area.data.agentTasks ? 'before-wipe' : 'after-wipe'}`); }
  });
  return { area, session, service, events };
}

describe('profile service: get and save', () => {
  it('returns an empty profile before anything is saved', async () => {
    const { service } = setup();
    expect(await service.get()).toEqual({ type: 'PROFILE_STATE', payload: { profile: {} } });
  });

  it('saves a valid profile and returns what was stored', async () => {
    const { service, area } = setup();
    const reply = await service.save({ profile: { name: ' Asha Rao ', email: 'asha@example.com', links: { github: 'github.com/asha' } } });
    expect(reply.type).toBe('SAVED');
    expect(reply.payload.profile).toEqual({ name: 'Asha Rao', email: 'asha@example.com', links: { github: 'https://github.com/asha' } });
    expect(area.data.profile).toEqual(reply.payload.profile);
  });

  it('saves the valid fields and keeps the old value of an invalid one (EC-PRF-06)', async () => {
    const { service, area } = setup({ profile: { email: 'old@example.com', links: { github: 'https://github.com/old' } } });
    const reply = await service.save({ profile: { name: 'Asha', email: 'broken@', links: { github: 'javascript:x', linkedin: 'linkedin.com/in/asha' } } });
    expect(reply.type).toBe('VALIDATION_ERROR');
    expect(Object.keys(reply.payload.errors).sort()).toEqual(['email', 'links.github']);
    expect(area.data.profile).toEqual({
      name: 'Asha', email: 'old@example.com', links: { github: 'https://github.com/old', linkedin: 'https://linkedin.com/in/asha' }
    });
    expect(reply.payload.profile).toEqual(area.data.profile);
  });

  it('an emptied field is removed', async () => {
    const { service, area } = setup({ profile: { name: 'Asha', phone: '98765 43210' } });
    await service.save({ profile: { name: 'Asha', phone: '' } });
    expect(area.data.profile).toEqual({ name: 'Asha' });
  });

  it('passes on warnings about ID numbers but still saves (EC-PRF-07)', async () => {
    const { service, area } = setup();
    const reply = await service.save({ profile: { about: 'My PAN is ABCDE1234F' } });
    expect(reply.type).toBe('SAVED');
    expect(reply.payload.warnings.about).toMatch(/Avoid storing ID or card numbers/);
    expect(area.data.profile.about).toBe('My PAN is ABCDE1234F');
  });

  it('rejects a payload that is not a profile without writing', async () => {
    const { service, area } = setup({ profile: { name: 'Asha' } });
    expect((await service.save({ profile: 'nope' })).type).toBe('VALIDATION_ERROR');
    expect(area.data.profile).toEqual({ name: 'Asha' });
  });

  it('preferredLanguage seeds the language setting on first save only (EC-PRF-09)', async () => {
    const { service, area } = setup({ settings: { language: 'en' } });
    await service.save({ profile: { preferredLanguage: 'hinglish' } });
    expect(area.data.settings.language).toBe('hinglish');

    area.data.settings.language = 'en'; // the user flips the header toggle back
    await service.save({ profile: { preferredLanguage: 'hinglish', name: 'Asha' } });
    expect(area.data.settings.language).toBe('en');
  });

  it('read-only data (newer version) returns an ERROR, not a crash', async () => {
    const { service } = setup({ schemaVersion: SCHEMA_VERSION + 1 });
    const reply = await service.save({ profile: { name: 'Asha' } });
    expect(reply).toMatchObject({ type: 'ERROR', payload: { code: 'READ_ONLY' } });
  });
});

describe('profile service: clear all my data (EC-SET-14)', () => {
  it('stops the agent first, then deletes profile, skills, logs, chats and keys', async () => {
    const { service, area, session, events } = setup(
      {
        settings: { language: 'hinglish' }, safety: { ownedDomains: ['me.dev'] }, profile: { name: 'Asha' },
        skills: [{ id: 's1' }], agentTasks: { t1: {} }, activeTaskId: 't1', secrets: { geminiKey: GEMINI_KEY }
      },
      { conversations: { '1:https://e.com': {} }, summaryCache: { a: 1 }, pendingRequest: { kind: 'explain' }, cooldowns: { x: 1 } }
    );
    expect(await service.clearAll()).toEqual({ type: 'DATA_CLEARED', payload: {} });
    expect(events).toEqual(['stop:before-wipe']);
    expect(Object.keys(area.data).sort()).toEqual(['safety', 'schemaVersion', 'settings']);
    expect(area.data.settings.language).toBe('hinglish');
    for (const key of SESSION_DATA_KEYS) expect(key in session.data).toBe(false);
    expect(session.data.cooldowns).toEqual({ x: 1 });
  });

  it('still clears when there is no agent task to stop', async () => {
    const { area, session } = setup({ profile: { name: 'Asha' } });
    const service = createProfileService({ storage: createStorage(area), session, stopAgent: async () => { throw new Error('none'); } });
    expect((await service.clearAll()).type).toBe('DATA_CLEARED');
    expect(area.data.profile).toBeUndefined();
  });
});
