import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CONVERSATIONS_KEY, MAX_CONVERSATIONS, MAX_STORED_MESSAGES,
  conversationKey, createConversationStore, readConversation, recentTurns
} from '../src/shared/conversations.js';

function fakeArea(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    get: async (key) => ({ [key]: structuredClone(data[key]) }),
    set: async (items) => { Object.assign(data, structuredClone(items)); }
  };
}

const PAGE = { url: 'https://example.com/a', title: 'A', contentHash: 'h1' };
const u = (text) => ({ role: 'user', text, at: 1 });
const a = (text) => ({ role: 'assistant', text, at: 1, model: 'm', provider: 'gemini', stopReason: 'end_turn', notFound: false, truncated: false, unverifiedQuotes: 0 });

afterEach(() => vi.restoreAllMocks());

describe('conversationKey', () => {
  it('ignores the #fragment (EC-CHT-10) but not the query (EC-CHT-11)', () => {
    expect(conversationKey(3, 'https://e.com/a?page=2#sec')).toBe('3:https://e.com/a?page=2');
    expect(conversationKey(3, 'https://e.com/a#x')).toBe(conversationKey(3, 'https://e.com/a'));
    expect(conversationKey(3, 'https://e.com/a?page=2')).not.toBe(conversationKey(3, 'https://e.com/a?page=3'));
  });

  it('gives the same URL in two tabs separate chats (EC-CHT-09)', () => {
    expect(conversationKey(1, 'https://e.com/')).not.toBe(conversationKey(2, 'https://e.com/'));
  });
});

describe('recentTurns', () => {
  it('keeps answered pairs only, oldest first', () => {
    const messages = [u('q1'), a('a1'), { role: 'event', kind: 'content-updated', at: 1 }, u('q2'), a('a2'), u('unanswered')];
    expect(recentTurns(messages).map((m) => m.text)).toEqual(['q1', 'a1', 'q2', 'a2']);
  });

  it('keeps only the last 10 pairs (EC-CHT-07)', () => {
    const messages = Array.from({ length: 12 }, (_, i) => [u(`q${i}`), a(`a${i}`)]).flat();
    const turns = recentTurns(messages);
    expect(turns).toHaveLength(20);
    expect(turns[0].text).toBe('q2');
    expect(turns.at(-1).text).toBe('a11');
  });
});

describe('conversation store', () => {
  it('creates a conversation, then appends to it', async () => {
    const area = fakeArea();
    const store = createConversationStore(area);
    await store.append('1:https://example.com/a', PAGE, [u('q1'), a('a1')]);
    await store.append('1:https://example.com/a', { ...PAGE, contentHash: 'h2' }, [u('q2'), a('a2')]);
    const conv = await store.get('1:https://example.com/a');
    expect(conv.messages.map((m) => m.text)).toEqual(['q1', 'a1', 'q2', 'a2']);
    expect(conv.contentHash).toBe('h2');
    expect(conv.url).toBe(PAGE.url);
  });

  it('caps stored messages per conversation', async () => {
    const store = createConversationStore(fakeArea());
    const many = Array.from({ length: MAX_STORED_MESSAGES + 10 }, (_, i) => u(`q${i}`));
    await store.append('k', PAGE, many);
    const conv = await store.get('k');
    expect(conv.messages).toHaveLength(MAX_STORED_MESSAGES);
    expect(conv.messages.at(-1).text).toBe(`q${MAX_STORED_MESSAGES + 9}`);
  });

  it('keeps only the most recently used conversations', async () => {
    let t = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => ++t);
    const area = fakeArea();
    const store = createConversationStore(area);
    for (let i = 0; i <= MAX_CONVERSATIONS; i++) await store.append(`${i}:x`, PAGE, [u('q')]);
    const keys = Object.keys(area.data[CONVERSATIONS_KEY]);
    expect(keys).toHaveLength(MAX_CONVERSATIONS);
    expect(keys).not.toContain('0:x');
    expect(keys).toContain(`${MAX_CONVERSATIONS}:x`);
  });

  it('forgets a closed tab without touching tabs with similar ids', async () => {
    const area = fakeArea();
    const store = createConversationStore(area);
    await store.append('3:https://a.com/', PAGE, [u('q')]);
    await store.append('3:https://b.com/', PAGE, [u('q')]);
    await store.append('33:https://a.com/', PAGE, [u('q')]);
    await store.removeTab(3);
    expect(Object.keys(area.data[CONVERSATIONS_KEY])).toEqual(['33:https://a.com/']);
  });
});

describe('readConversation', () => {
  it('returns null for missing or malformed data', async () => {
    expect(await readConversation(fakeArea(), 'k')).toBeNull();
    expect(await readConversation(fakeArea({ [CONVERSATIONS_KEY]: 'junk' }), 'k')).toBeNull();
    expect(await readConversation(fakeArea({ [CONVERSATIONS_KEY]: { k: { messages: 'no' } } }), 'k')).toBeNull();
  });
});
