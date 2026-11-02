import { describe, it, expect } from 'vitest';
import { createPageChat } from '../src/background/page-chat.js';
import { FeatureError } from '../src/background/feature-error.js';
import { CHAT_MAX_QUESTION_CHARS, PAGE_TEXT_CHAR_BUDGET } from '../src/shared/config.js';
import { CONVERSATIONS_KEY, createConversationStore } from '../src/shared/conversations.js';
import { NOT_FOUND_SENTENCES } from '../src/shared/prompts/chat.js';

const PAGE = { source: 'article', title: 'Garden', url: 'https://example.com/garden', text: 'Tomatoes are harvested in August, after the summer rains.' };
const KEY = '4:https://example.com/garden';

function setup({ page = PAGE, replies = [], language = 'en' } = {}) {
  const calls = { gateway: [], pages: 0, starts: [] };
  const area = {
    data: {},
    get: async (key) => ({ [key]: structuredClone(area.data[key]) }),
    set: async (items) => { Object.assign(area.data, structuredClone(items)); }
  };
  const state = { page };
  const chat = createPageChat({
    gateway: {
      stream: async (req) => {
        calls.gateway.push(req);
        const text = replies.shift() ?? 'They are harvested in "August, after the summer rains".';
        req.onDelta(text);
        return { text, model: 'gemini-3.5-flash-lite', provider: 'gemini', stopReason: 'end_turn' };
      }
    },
    getPage: async () => { calls.pages++; return state.page; },
    getLanguage: async () => language,
    conversations: createConversationStore(area),
    now: () => 1000
  });
  const io = { onStart: (info) => calls.starts.push(info), onDelta: () => {}, onReset: () => {} };
  const send = async (payload) => {
    try { return { result: await chat.send({ tabId: 4, ...payload }, io) }; } catch (error) { return { error }; }
  };
  const stored = () => area.data[CONVERSATIONS_KEY]?.[KEY]?.messages ?? [];
  return { send, calls, stored, state };
}

describe('page chat', () => {
  it('answers from the page, streams, and saves the question and answer', async () => {
    const { send, calls, stored } = setup();
    const { result } = await send({ text: '  When is the harvest?  ' });
    const req = calls.gateway[0];
    expect(req.task).toBe('chat');
    expect(req.turns[0].parts[0].text).toContain('<page_content title="Garden"');
    expect(req.turns.at(-1).parts[0].text).toBe('When is the harvest?');
    expect(calls.starts).toEqual([{ conversationKey: KEY, contentChanged: false }]);
    expect(result).toMatchObject({
      conversationKey: KEY, notFound: false, truncated: false, unverifiedQuotes: 0, model: 'gemini-3.5-flash-lite'
    });
    expect(stored().map((m) => [m.role, m.text])).toEqual([
      ['user', 'When is the harvest?'],
      ['assistant', 'They are harvested in "August, after the summer rains".']
    ]);
  });

  it('sends earlier questions and answers so follow-ups make sense', async () => {
    const { send, calls } = setup({ replies: ['First answer.', 'Second answer.'] });
    await send({ text: 'List the vegetables' });
    await send({ text: 'and what about the second one?' });
    const turns = calls.gateway[1].turns.map((t) => [t.role, t.parts[0].text]);
    expect(turns).toHaveLength(5);
    expect(turns[2]).toEqual(['user', 'List the vegetables']);
    expect(turns[3]).toEqual(['assistant', 'First answer.']);
    expect(turns[4]).toEqual(['user', 'and what about the second one?']);
  });

  it('flags the not-found sentence', async () => {
    const { send, stored } = setup({ replies: [NOT_FOUND_SENTENCES.en] });
    const { result } = await send({ text: 'What is the capital of France?' });
    expect(result.notFound).toBe(true);
    expect(stored()[1].notFound).toBe(true);
  });

  it('flags quotes that are not on the page', async () => {
    const { send } = setup({ replies: ['The page says "tomatoes grow best in the winter months".'] });
    expect((await send({ text: 'When do tomatoes grow?' })).result.unverifiedQuotes).toBe(1);
  });

  it('uses the Hinglish not-found sentence when the toggle is Hinglish', async () => {
    const { send, calls } = setup({ language: 'hinglish', replies: [NOT_FOUND_SENTENCES.hinglish] });
    await send({ text: 'Capital kya hai?' });
    expect(calls.gateway[0].system).toContain(NOT_FOUND_SENTENCES.hinglish);
  });

  it('refuses an empty question without reading the page (EC-CHT-12)', async () => {
    const { send, calls } = setup();
    const { error } = await send({ text: '   ' });
    expect(error).toBeInstanceOf(FeatureError);
    expect(error.code).toBe('EMPTY_QUESTION');
    expect(calls.pages).toBe(0);
    expect(calls.gateway).toHaveLength(0);
  });

  it('caps very long questions (EC-CHT-12)', async () => {
    const { send, calls } = setup();
    await send({ text: 'q'.repeat(CHAT_MAX_QUESTION_CHARS + 1000) });
    expect(calls.gateway[0].turns.at(-1).parts[0].text).toHaveLength(CHAT_MAX_QUESTION_CHARS);
  });

  it('refuses a page with no text', async () => {
    const { send, calls } = setup({ page: { ...PAGE, text: '  \n ' } });
    expect((await send({ text: 'Hi?' })).error.code).toBe('NOT_ENOUGH_TEXT');
    expect(calls.gateway).toHaveLength(0);
  });

  it('refuses when the panel is showing a different page than the tab now has', async () => {
    const { send, calls } = setup();
    const { error } = await send({ text: 'Q?', conversationId: '4:https://example.com/old' });
    expect(error.code).toBe('PAGE_CHANGED');
    expect(calls.gateway).toHaveLength(0);
  });

  it('ignores the #fragment when matching the conversation (EC-CHT-10)', async () => {
    const { send } = setup({ page: { ...PAGE, url: `${PAGE.url}#harvest` } });
    const { result } = await send({ text: 'Q?', conversationId: KEY });
    expect(result.conversationKey).toBe(KEY);
  });

  it('keeps history but flags and records a content change on the same URL (EC-CHT-08)', async () => {
    const { send, calls, stored, state } = setup({ replies: ['A1.', 'A2.'] });
    await send({ text: 'Q1' });
    state.page = { ...PAGE, text: 'Live score: 3-1.' };
    await send({ text: 'Q2' });
    expect(calls.starts[1].contentChanged).toBe(true);
    expect(calls.gateway[1].turns).toHaveLength(5);
    expect(calls.gateway[1].turns[0].parts[0].text).toContain('Live score: 3-1.');
    expect(stored().map((m) => m.role)).toEqual(['user', 'assistant', 'event', 'user', 'assistant']);
  });

  it('sends the head and the most relevant parts of a long page (EC-CHT-05)', async () => {
    const filler = 'Nothing to see in this paragraph at all. '.repeat(40);
    const text = [`Intro. ${filler}`, ...Array(60).fill(filler), 'The tomato harvest begins in August.', ...Array(60).fill(filler)].join('\n');
    expect(text.length).toBeGreaterThan(PAGE_TEXT_CHAR_BUDGET);
    const { send, calls } = setup({ page: { ...PAGE, text } });
    const { result } = await send({ text: 'When does the tomato harvest begin?' });
    const sent = calls.gateway[0].turns[0].parts[0].text;
    expect(result.truncated).toBe(true);
    expect(sent.length).toBeLessThan(text.length);
    expect(sent).toContain('The tomato harvest begins in August.');
    expect(sent).toMatch(/parts most related to the question/);
  });
});
