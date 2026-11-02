import { describe, it, expect } from 'vitest';
import { FeatureError, createQuickActions } from '../src/background/quick-actions.js';

function setup({ selection = { text: 'Selected words', contextBefore: 'Before', contextAfter: 'After' }, language = 'en' } = {}) {
  const calls = { gateway: [], selection: [] };
  const actions = createQuickActions({
    gateway: {
      stream: async (req) => {
        calls.gateway.push(req);
        req.onDelta('Answer');
        return { text: 'Answer', model: 'gemini-3.5-flash-lite', provider: 'gemini', stopReason: 'end_turn' };
      }
    },
    getSelection: async (tabId) => { calls.selection.push(tabId); return selection; },
    getLanguage: async () => language
  });
  return { actions, calls };
}

async function run(actions, payload) {
  const events = { starts: [], deltas: [] };
  try {
    const result = await actions.run(payload, {
      onStart: (info) => events.starts.push(info),
      onDelta: (d) => events.deltas.push(d)
    });
    return { result, events };
  } catch (error) {
    return { error, events };
  }
}

describe('quick actions: explain', () => {
  it('reads the selection from the tab, announces it, and streams the answer', async () => {
    const { actions, calls } = setup();
    const { result, events } = await run(actions, { kind: 'explain', tabId: 7 });
    expect(calls.selection).toEqual([7]);
    expect(events.starts).toHaveLength(1);
    expect(events.starts[0]).toMatchObject({ kind: 'explain', excerpt: 'Selected words', scope: 'selection-only' });
    expect(events.deltas).toEqual(['Answer']);
    expect(result.text).toBe('Answer');
    expect(calls.gateway[0].task).toBe('explain');
    expect(calls.gateway[0].turns[0].parts[0].text).toMatch(/Selected words/);
  });

  it('uses text passed directly (context menu) without touching the page', async () => {
    const { actions, calls } = setup();
    await run(actions, { kind: 'explain', text: '  Given text  ' });
    expect(calls.selection).toEqual([]);
    expect(calls.gateway[0].turns[0].parts[0].text).toMatch(/<selection>\nGiven text\n<\/selection>/);
  });

  it('uses the saved language', async () => {
    const { actions, calls } = setup({ language: 'hinglish' });
    await run(actions, { kind: 'explain', tabId: 1 });
    expect(calls.gateway[0].system).toMatch(/Hinglish/);
  });

  it('empty selection → NO_SELECTION without calling the model (EC-SEL-01)', async () => {
    const { actions, calls } = setup({ selection: { text: '' } });
    const { error } = await run(actions, { kind: 'explain', tabId: 1 });
    expect(error instanceof FeatureError).toBe(true);
    expect(error.code).toBe('NO_SELECTION');
    expect(calls.gateway).toHaveLength(0);
  });

  it('protected field → PROTECTED_FIELD without calling the model (EC-SEL-03)', async () => {
    const { actions, calls } = setup({ selection: { text: '', protected: true } });
    const { error } = await run(actions, { kind: 'explain', tabId: 1 });
    expect(error.code).toBe('PROTECTED_FIELD');
    expect(calls.gateway).toHaveLength(0);
  });

  it('caps very long text and shortens the excerpt (EC-SEL-06)', async () => {
    const { actions, calls } = setup();
    const { events } = await run(actions, { kind: 'explain', text: 'a'.repeat(25_000) });
    expect(events.starts[0].excerpt.length).toBe(141);
    expect(calls.gateway[0].turns[0].parts[0].text).toMatch(/only the first part/);
  });

  it('unknown kinds are refused', async () => {
    const { actions } = setup();
    const { error } = await run(actions, { kind: 'summon', tabId: 1 });
    expect(error.code).toBe('UNKNOWN_ACTION');
  });
});

describe('explain language (P1.6)', () => {
  const ENGLISH = 'Mitochondria are tiny structures inside cells that turn the food you eat into energy your body can use every day.';
  const HINGLISH = 'Mitochondria cells ke andar chhote parts hain jo khane ko energy mein badalte hain, aur yeh body ke liye zaroori hai.';

  function langSetup(texts, language = 'hinglish') {
    const calls = [];
    const actions = createQuickActions({
      gateway: {
        stream: async (req) => {
          calls.push(req);
          const next = texts.shift();
          if (next instanceof Error) throw next;
          req.onDelta(next);
          return { text: next, model: 'gemini-3.5-flash-lite', provider: 'gemini', stopReason: 'end_turn' };
        }
      },
      getSelection: async () => ({ text: 'Mitochondria' }),
      getLanguage: async () => language
    });
    const events = [];
    const io = { onStart: () => {}, onDelta: (d) => events.push(['delta', d]), onReset: () => events.push(['reset']) };
    return { actions, calls, events, io };
  }

  it('retries a plain-English "Hinglish" answer once, resetting the streamed text first', async () => {
    const { actions, calls, events, io } = langSetup([ENGLISH, HINGLISH]);
    const r = await actions.run({ kind: 'explain', tabId: 1 }, io);
    expect(r.text).toBe(HINGLISH);
    expect(calls).toHaveLength(2);
    expect(calls[1].system).toMatch(/plain English/);
    expect(events).toEqual([['delta', ENGLISH], ['reset'], ['delta', HINGLISH]]);
  });

  it('if the retry fails, shows the first answer again', async () => {
    const { LlmError } = await import('../src/background/llm/errors.js');
    const { actions, events, io } = langSetup([ENGLISH, new LlmError('OVERLOADED', { status: 503 })]);
    const r = await actions.run({ kind: 'explain', tabId: 1 }, io);
    expect(r.text).toBe(ENGLISH);
    expect(events).toEqual([['delta', ENGLISH], ['reset'], ['reset'], ['delta', ENGLISH]]);
  });

  it('a per-request language overrides the setting, and English is never retried', async () => {
    const { actions, calls, io } = langSetup([ENGLISH], 'hinglish');
    await actions.run({ kind: 'explain', tabId: 1, language: 'en' }, io);
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toMatch(/clear, simple English/);
  });
});

function p22Setup({ page = null, prefs = {}, language = 'en' } = {}) {
  const calls = { gateway: [], selection: [] };
  const actions = createQuickActions({
    gateway: {
      stream: async (req) => {
        calls.gateway.push(req);
        req.onDelta('Out');
        return { text: 'Out', model: 'gemini-3.5-flash-lite', provider: 'gemini', stopReason: 'end_turn' };
      }
    },
    getSelection: async (tabId) => {
      calls.selection.push(tabId);
      if (page instanceof Error) throw page;
      return page ?? { text: '' };
    },
    getLanguage: async () => language,
    getPreferences: async () => ({ translateTarget: 'hi', tone: 'polite', name: null, ...prefs })
  });
  return { actions, calls };
}

describe('context-menu text (P2.2)', () => {
  it("prefers the page's own copy of the selection when it is the same text (EC-CTX-05)", async () => {
    const page = { text: 'Line one.\nLine two, and more.', contextBefore: 'Before', pageTitle: 'T', url: 'https://e.com/' };
    const { actions, calls } = p22Setup({ page });
    const { events } = await run(actions, { kind: 'explain', text: 'Line one. Line two,', tabId: 5 });
    expect(calls.selection).toEqual([5]);
    expect(events.starts[0].source.text).toBe(page.text);
    expect(calls.gateway[0].turns[0].parts[0].text).toMatch(/<context_before>/);
  });

  it("keeps Chrome's text when the page selection is different, missing, or unreachable", async () => {
    for (const page of [{ text: 'Something else entirely' }, { text: '' }, new Error('no access')]) {
      const { actions } = p22Setup({ page });
      const { events } = await run(actions, { kind: 'explain', text: 'Menu text', tabId: 5 });
      expect(events.starts[0].source.text).toBe('Menu text');
    }
  });

  it('does not ask the page for selections made inside a frame (EC-SEL-04)', async () => {
    const { actions, calls } = p22Setup();
    await run(actions, { kind: 'explain', text: 'In a frame', tabId: 5, frameId: 3 });
    expect(calls.selection).toEqual([]);
  });

  it('refuses when the page reports a protected field', async () => {
    const { actions, calls } = p22Setup({ page: { text: '', protected: true } });
    const { error } = await run(actions, { kind: 'translate', text: 'secret', tabId: 5 });
    expect(error.code).toBe('PROTECTED_FIELD');
    expect(calls.gateway).toHaveLength(0);
  });
});

describe('translate (P2.2)', () => {
  it('translates into the saved target, Hindi by default, with a romanised line', async () => {
    const { actions, calls } = p22Setup();
    const { events } = await run(actions, { kind: 'translate', text: 'Good morning' });
    expect(calls.gateway[0].task).toBe('translate');
    expect(calls.gateway[0].system).toMatch(/into Hindi/);
    expect(calls.gateway[0].system).toMatch(/Romanised:/);
    expect(events.starts[0].targetLang).toBe('hi');
  });

  it('uses a target picked in the panel over the setting', async () => {
    const { actions, calls } = p22Setup({ prefs: { translateTarget: 'hi' } });
    const { events } = await run(actions, { kind: 'translate', text: 'Good morning', targetLang: 'ta' });
    expect(calls.gateway[0].system).toMatch(/into Tamil/);
    expect(calls.gateway[0].system).not.toMatch(/Romanised/);
    expect(events.starts[0].targetLang).toBe('ta');
  });

  it('ignores an unknown target (EC-CTX-11)', async () => {
    const { actions, calls } = p22Setup({ prefs: { translateTarget: 'bn' } });
    await run(actions, { kind: 'translate', text: 'Hello', targetLang: 'klingon' });
    expect(calls.gateway[0].system).toMatch(/into Bengali/);
  });

  it('text already in the target language → suggests English instead (EC-CTX-10)', async () => {
    const { actions, calls } = p22Setup();
    const { error } = await run(actions, { kind: 'translate', text: 'नमस्ते, आप कैसे हैं?' });
    expect(error.code).toBe('ALREADY_IN_TARGET');
    expect(error.message).toMatch(/already looks like Hindi/);
    expect(error.toPayload()).toMatchObject({ code: 'ALREADY_IN_TARGET', suggestTarget: 'en', source: { text: 'नमस्ते, आप कैसे हैं?' } });
    expect(calls.gateway).toHaveLength(0);
  });

  it('an explicitly chosen target is never second-guessed', async () => {
    const { actions, calls } = p22Setup();
    await run(actions, { kind: 'translate', text: 'नमस्ते, आप कैसे हैं?', targetLang: 'hi' });
    expect(calls.gateway).toHaveLength(1);
  });
});

describe('draft a reply (P2.2)', () => {
  const lastText = (calls) => calls.gateway[0].turns.at(-1).parts[0].text;

  it('infers the medium from the page and signs emails with the profile name', async () => {
    const { actions, calls } = p22Setup({ prefs: { name: 'Asha Rao', tone: 'formal' } });
    const { events } = await run(actions, { kind: 'draft', text: 'Can we meet Friday?', url: 'https://mail.google.com/mail/u/0/' });
    expect(calls.gateway[0].task).toBe('draft');
    expect(events.starts[0]).toMatchObject({ medium: 'email', tone: 'formal' });
    expect(calls.gateway[0].system).toMatch(/email reply/);
    expect(calls.gateway[0].system).toContain('"Asha Rao"');
    expect(calls.gateway[0].system).toMatch(/Tone: formal/);
  });

  it('uses a [Your name] placeholder when there is no profile name (EC-CTX-09)', async () => {
    const { actions, calls } = p22Setup();
    await run(actions, { kind: 'draft', text: 'Dear team, please confirm.' });
    expect(calls.gateway[0].system).toMatch(/\[Your name\]/);
    expect(calls.gateway[0].system).toMatch(/Never invent a name/);
  });

  it('LinkedIn replies get no signature', async () => {
    const { actions, calls } = p22Setup({ prefs: { name: 'Asha Rao' } });
    const { events } = await run(actions, { kind: 'draft', text: 'Excited to share my new role!', url: 'https://www.linkedin.com/feed/' });
    expect(events.starts[0].medium).toBe('linkedin');
    expect(calls.gateway[0].system).toMatch(/LinkedIn/);
    expect(calls.gateway[0].system).not.toContain('Asha Rao');
  });

  it('a medium chosen in the panel overrides the guess', async () => {
    const { actions } = p22Setup();
    const { events } = await run(actions, { kind: 'draft', text: 'Hi', url: 'https://www.linkedin.com/feed/', medium: 'forum' });
    expect(events.starts[0].medium).toBe('forum');
  });

  it('Shorter and More formal rewrite the previous draft', async () => {
    const { actions, calls } = p22Setup();
    await run(actions, { kind: 'draft', text: 'Can we meet?', refine: 'shorter', previousDraft: 'A long draft.' });
    const turns = calls.gateway[0].turns;
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
    expect(turns[1].parts[0].text).toBe('A long draft.');
    expect(lastText(calls)).toMatch(/shorter/);

    const formal = p22Setup();
    await run(formal.actions, { kind: 'draft', text: 'Can we meet?', refine: 'formal', previousDraft: 'Hey!' });
    expect(lastText(formal.calls)).toMatch(/more formal/);
  });

  it('follows the EN | Hinglish toggle', async () => {
    const { actions, calls } = p22Setup({ language: 'hinglish' });
    await run(actions, { kind: 'draft', text: 'Can we meet?' });
    expect(calls.gateway[0].system).toMatch(/Hinglish/);
  });

  it('uses the profile tone over the Settings tone, and a tone picked in the panel over both (P4.1)', async () => {
    const { actions, calls } = p22Setup({ prefs: { tone: 'friendly', profileTone: 'formal' } });
    const { events } = await run(actions, { kind: 'draft', text: 'Can we meet?' });
    expect(events.starts[0]).toMatchObject({ tone: 'formal', profileUsed: true });
    expect(calls.gateway[0].system).toMatch(/Tone: formal/);

    const picked = p22Setup({ prefs: { tone: 'friendly', profileTone: 'formal' } });
    const { events: e2 } = await run(picked.actions, { kind: 'draft', text: 'Can we meet?', tone: 'polite' });
    expect(e2.starts[0]).toMatchObject({ tone: 'polite', profileUsed: false });
  });

  it('flags "Profile used" only when the profile reached the prompt', async () => {
    const email = p22Setup({ prefs: { name: 'Asha Rao' } });
    const { events: e1 } = await run(email.actions, { kind: 'draft', text: 'Hi', url: 'https://mail.google.com/mail/u/0/' });
    expect(e1.starts[0].profileUsed).toBe(true);

    // Not an email, so the name isn't sent.
    const linkedin = p22Setup({ prefs: { name: 'Asha Rao' } });
    const { events: e2 } = await run(linkedin.actions, { kind: 'draft', text: 'Hi', url: 'https://www.linkedin.com/feed/' });
    expect(e2.starts[0].profileUsed).toBe(false);

    const none = p22Setup();
    const { events: e3 } = await run(none.actions, { kind: 'draft', text: 'Dear team', url: 'https://mail.google.com/' });
    expect(e3.starts[0].profileUsed).toBe(false);
  });

  it('explain and translate never get profile data', async () => {
    const { actions, calls } = p22Setup({ prefs: { name: 'Asha Rao', profileTone: 'formal' } });
    const ex = await run(actions, { kind: 'explain', text: 'Dear team, words' });
    await run(actions, { kind: 'translate', text: 'Dear team, words', targetLang: 'hi' });
    expect(JSON.stringify(calls.gateway)).not.toContain('Asha Rao');
    expect(ex.events.starts[0].profileUsed).toBeUndefined();
  });
});
