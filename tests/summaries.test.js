import { describe, it, expect } from 'vitest';
import { MIN_SUMMARY_CHARS, createSummaries, summaryCacheKey, videoCacheKey } from '../src/background/summaries.js';
import { LlmError } from '../src/background/llm/errors.js';
import { FeatureError } from '../src/background/feature-error.js';
import { PAGE_TEXT_CHAR_BUDGET } from '../src/shared/config.js';

const SUMMARY = { tldr: 'About plants.', keyPoints: ['1', '2', '3', '4', '5'], nextSteps: ['Read more'] };
const ARTICLE = { source: 'article', title: 'Plants', byline: 'A. Writer', text: 'Plants make food. '.repeat(40), url: 'https://example.com/plants', isReadable: true };

const VIDEO_ID = 'dQw4w9WgXcQ';
const VIDEO_SUMMARY = { ...SUMMARY, chapters: [{ startSeconds: 0, title: 'Intro', notes: '' }, { startSeconds: 95, title: 'Main idea', notes: 'Why it matters.' }] };

function setup({ page = ARTICLE, language = 'en', tabUrl = ARTICLE.url, videoInfo = null, jsonError = null } = {}) {
  const calls = { gateway: [], pages: [], videoInfo: [] };
  const store = new Map();
  const summaries = createSummaries({
    gateway: {
      json: async (req) => {
        calls.gateway.push(req);
        if (jsonError) throw jsonError;
        return { value: req.task === 'youtube' ? VIDEO_SUMMARY : SUMMARY, model: 'gemini-3.5-flash-lite', provider: 'gemini' };
      }
    },
    getPageText: async (tabId) => { calls.pages.push(tabId); return page; },
    getTabUrl: async () => tabUrl,
    getVideoInfo: async (tabId) => { calls.videoInfo.push(tabId); return videoInfo; },
    getLanguage: async () => language,
    cache: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } }
  });
  return { summaries, calls, store };
}

async function attempt(fn) {
  try { return { result: await fn() }; } catch (error) { return { error }; }
}

describe('summarizePage', () => {
  it('summarises the article with the summary schema and validator', async () => {
    const { summaries, calls } = setup();
    const r = await summaries.summarizePage({ tabId: 3 });
    expect(calls.pages).toEqual([3]);
    expect(r.kind).toBe('page');
    expect(r.summary).toEqual(SUMMARY);
    expect(r.source).toBe('article');
    expect(r.title).toBe('Plants');
    expect(r.cached).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.model).toBe('gemini-3.5-flash-lite');
    expect(calls.gateway[0].task).toBe('summary');
    expect(typeof calls.gateway[0].validate).toBe('function');
    expect(calls.gateway[0].schema.required).toEqual(['tldr', 'keyPoints', 'nextSteps']);
  });

  it('too little text → NOT_ENOUGH_TEXT without calling the model (EC-ART-03)', async () => {
    const { summaries, calls } = setup({ page: { ...ARTICLE, text: 'x'.repeat(MIN_SUMMARY_CHARS - 1) } });
    const { error } = await attempt(() => summaries.summarizePage({ tabId: 1 }));
    expect(error instanceof FeatureError).toBe(true);
    expect(error.code).toBe('NOT_ENOUGH_TEXT');
    expect(calls.gateway).toHaveLength(0);
  });

  it('a second request is served from the cache (instant, no model call)', async () => {
    const { summaries, calls } = setup();
    await summaries.summarizePage({ tabId: 1 });
    const second = await summaries.summarizePage({ tabId: 1 });
    expect(second.cached).toBe(true);
    expect(calls.gateway).toHaveLength(1);
  });

  it('force skips the cache ("Summarise again")', async () => {
    const { summaries, calls } = setup();
    await summaries.summarizePage({ tabId: 1 });
    const again = await summaries.summarizePage({ tabId: 1, force: true });
    expect(again.cached).toBe(false);
    expect(calls.gateway).toHaveLength(2);
  });

  it('trims very long pages to the budget and says so (EC-ART-04)', async () => {
    const { summaries, calls } = setup({ page: { ...ARTICLE, text: 'word '.repeat(PAGE_TEXT_CHAR_BUDGET) } });
    const r = await summaries.summarizePage({ tabId: 1 });
    expect(r.truncated).toBe(true);
    const sent = calls.gateway[0].turns[0].parts[0].text;
    expect(sent.length < PAGE_TEXT_CHAR_BUDGET + 2000).toBe(true);
    expect(sent).toMatch(/middle part was left out/);
  });

  it('passes the visible-text fallback through and notes it (EC-ART-01)', async () => {
    const { summaries, calls } = setup({ page: { ...ARTICLE, source: 'visible', isReadable: false } });
    const r = await summaries.summarizePage({ tabId: 1 });
    expect(r.source).toBe('visible');
    expect(calls.gateway[0].turns[0].parts[0].text).toMatch(/not a typical article/);
  });

  it('uses the saved language in the prompt', async () => {
    const { summaries, calls } = setup({ language: 'hinglish' });
    const r = await summaries.summarizePage({ tabId: 1 });
    expect(r.language).toBe('hinglish');
    expect(calls.gateway[0].system).toMatch(/Hinglish/);
  });

  it('no tab → PAGE_RESTRICTED', async () => {
    const { summaries } = setup();
    const { error } = await attempt(() => summaries.summarizePage({}));
    expect(error.code).toBe('PAGE_RESTRICTED');
  });
});

describe('summaryCacheKey (EC-ART-09, EC-ART-10)', () => {
  const text = 'Some article text';
  it('ignores the #fragment', () => {
    expect(summaryCacheKey('https://a.com/x#part2', text, 'en')).toBe(summaryCacheKey('https://a.com/x', text, 'en'));
  });

  it('changes with the content, the language and the URL', () => {
    const base = summaryCacheKey('https://a.com/x', text, 'en');
    expect(summaryCacheKey('https://a.com/x', text + ' updated', 'en') === base).toBe(false);
    expect(summaryCacheKey('https://a.com/x', text, 'hinglish') === base).toBe(false);
    expect(summaryCacheKey('https://a.com/y', text, 'en') === base).toBe(false);
  });
});

describe('summarizeVideo (P1.5)', () => {
  it('summarises a pasted link with the video schema, a long timeout and the canonical URL', async () => {
    const { summaries, calls } = setup();
    const r = await summaries.summarizeVideo({ url: `https://youtu.be/${VIDEO_ID}?si=share` });
    expect(r.kind).toBe('video');
    expect(r.videoId).toBe(VIDEO_ID);
    expect(r.url).toBe(`https://www.youtube.com/watch?v=${VIDEO_ID}`);
    expect(r.title).toBe('YouTube video');
    expect(r.summary.chapters).toHaveLength(2);
    const req = calls.gateway[0];
    expect(req.task).toBe('youtube');
    expect(req.schema.required).toEqual(['tldr', 'keyPoints', 'nextSteps', 'chapters']);
    expect(req.timeoutMs).toBe(90000);
    expect(req.turns[0].parts[0]).toEqual({ youtubeUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}` });
  });

  it('"Summarise this page" on a YouTube watch page summarises the video, not the page (EC-YT-14)', async () => {
    const { summaries, calls } = setup({ tabUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}&t=30s` });
    const r = await summaries.summarizePage({ tabId: 4 });
    expect(r.kind).toBe('video');
    expect(calls.pages).toHaveLength(0);
    expect(calls.videoInfo).toEqual([4]);
  });

  it('uses the open video\'s title and length, so chapters past the end are dropped', async () => {
    const { summaries, calls } = setup({
      tabUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      videoInfo: { videoId: VIDEO_ID, title: 'Never Gonna', durationSeconds: 60, isLive: false }
    });
    const r = await summaries.summarizeVideo({ tabId: 1 });
    expect(r.title).toBe('Never Gonna');
    const check = calls.gateway[0].validate(VIDEO_SUMMARY);
    expect(check.value.chapters.map((c) => c.startSeconds)).toEqual([0]);
  });

  it('ignores page info for a different video than the one requested', async () => {
    const { summaries } = setup({ videoInfo: { videoId: 'aaaaaaaaaaa', title: 'Other', durationSeconds: 10, isLive: false } });
    const r = await summaries.summarizeVideo({ url: `https://www.youtube.com/watch?v=${VIDEO_ID}`, tabId: 1 });
    expect(r.title).toBe('YouTube video');
  });

  it('live streams are refused before calling the model (EC-YT-06)', async () => {
    const { summaries, calls } = setup({
      tabUrl: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      videoInfo: { videoId: VIDEO_ID, title: 'Live', durationSeconds: null, isLive: true }
    });
    const { error } = await attempt(() => summaries.summarizeVideo({ tabId: 1 }));
    expect(error.code).toBe('YOUTUBE_UNSUPPORTED');
    expect(calls.gateway).toHaveLength(0);
  });

  it('a 400 from Gemini (private, removed, too long) → YOUTUBE_UNSUPPORTED (EC-YT-05)', async () => {
    for (const code of ['BAD_REQUEST', 'CONTEXT_TOO_LARGE']) {
      const { summaries } = setup({ jsonError: new LlmError(code, { status: 400 }) });
      const { error } = await attempt(() => summaries.summarizeVideo({ url: `https://www.youtube.com/watch?v=${VIDEO_ID}` }));
      expect(error.code).toBe('YOUTUBE_UNSUPPORTED');
    }
  });

  it('other errors pass through unchanged', async () => {
    const { summaries } = setup({ jsonError: new LlmError('RATE_LIMITED', { status: 429 }) });
    const { error } = await attempt(() => summaries.summarizeVideo({ url: `https://www.youtube.com/watch?v=${VIDEO_ID}` }));
    expect(error.code).toBe('RATE_LIMITED');
  });

  it('bad or non-YouTube links → INVALID_YOUTUBE_URL with a helpful message', async () => {
    const { summaries, calls } = setup();
    for (const [url, msg] of [['https://vimeo.com/123', /Only public YouTube/], ['https://www.youtube.com/@channel', /single YouTube video/], ['', /Paste a YouTube link/]]) {
      const { error } = await attempt(() => summaries.summarizeVideo({ url }));
      expect(error.code).toBe('INVALID_YOUTUBE_URL');
      expect(error.message).toMatch(msg);
    }
    expect(calls.gateway).toHaveLength(0);
  });

  it('caches per video and language; force skips the cache', async () => {
    const { summaries, calls } = setup();
    const url = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
    await summaries.summarizeVideo({ url });
    expect((await summaries.summarizeVideo({ url: `https://youtu.be/${VIDEO_ID}` })).cached).toBe(true);
    expect((await summaries.summarizeVideo({ url, force: true })).cached).toBe(false);
    expect(calls.gateway).toHaveLength(2);
    expect(videoCacheKey(VIDEO_ID, 'en') === videoCacheKey(VIDEO_ID, 'hinglish')).toBe(false);
  });
});

describe('summary language (P1.6)', () => {
  const ENGLISH_SUMMARY = {
    tldr: 'This page explains how plants turn sunlight into food and why that process matters for life on Earth.',
    keyPoints: ['Plants use sunlight to make food', 'Chlorophyll absorbs the light', 'Water and carbon dioxide are inputs', 'Oxygen is released as a by-product', 'The process supports most life'],
    nextSteps: ['Read the section on chlorophyll']
  };
  const HINGLISH_SUMMARY = {
    tldr: 'Yeh page batata hai ki plants sunlight se apna khana kaise banate hain aur yeh kyun zaroori hai.',
    keyPoints: ['Plants sunlight se khana banate hain', 'Chlorophyll light ko absorb karta hai', 'Paani aur carbon dioxide inputs hain', 'Oxygen bhi nikalti hai', 'Yeh process zyada tar life ko support karta hai'],
    nextSteps: ['Chlorophyll wala section padho']
  };

  /** Gateway that returns the given summaries in order (or throws errors). */
  function langSetup(replies, language = 'hinglish') {
    const calls = [];
    const summaries = createSummaries({
      gateway: {
        json: async (req) => {
          calls.push(req);
          const next = replies.shift();
          if (next instanceof Error) throw next;
          return { value: next, model: 'gemini-3.5-flash-lite', provider: 'gemini' };
        }
      },
      getPageText: async () => ARTICLE,
      getTabUrl: async () => ARTICLE.url,
      getVideoInfo: async () => null,
      getLanguage: async () => language,
      cache: { get: async () => undefined, set: async () => {} }
    });
    return { summaries, calls };
  }

  it('a per-request language overrides the saved setting (⇄ on the card)', async () => {
    const { summaries, calls } = langSetup([HINGLISH_SUMMARY], 'en');
    const r = await summaries.summarizePage({ tabId: 1, language: 'hinglish' });
    expect(r.language).toBe('hinglish');
    expect(calls[0].system).toMatch(/Hinglish/);
  });

  it('ignores an unknown language override', async () => {
    const { summaries } = langSetup([ENGLISH_SUMMARY], 'en');
    expect((await summaries.summarizePage({ tabId: 1, language: 'klingon' })).language).toBe('en');
  });

  it('a "Hinglish" summary that came back in English is retried once with a stronger rule (EC-LNG-02)', async () => {
    const { summaries, calls } = langSetup([ENGLISH_SUMMARY, HINGLISH_SUMMARY]);
    const r = await summaries.summarizePage({ tabId: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[1].system).toMatch(/previous answer was in plain English/);
    expect(r.summary).toEqual(HINGLISH_SUMMARY);
  });

  it('retries at most once, keeping the second answer even if it is still off (never loops)', async () => {
    const { summaries, calls } = langSetup([ENGLISH_SUMMARY, ENGLISH_SUMMARY]);
    const r = await summaries.summarizePage({ tabId: 1 });
    expect(calls).toHaveLength(2);
    expect(r.summary).toEqual(ENGLISH_SUMMARY);
  });

  it('keeps the first answer if the retry fails', async () => {
    const { summaries } = langSetup([ENGLISH_SUMMARY, new LlmError('RATE_LIMITED', { status: 429 })]);
    expect((await summaries.summarizePage({ tabId: 1 })).summary).toEqual(ENGLISH_SUMMARY);
  });

  it('English requests are never retried for language', async () => {
    const { summaries, calls } = langSetup([ENGLISH_SUMMARY], 'en');
    await summaries.summarizePage({ tabId: 1 });
    expect(calls).toHaveLength(1);
  });

  it('good Hinglish is accepted first time', async () => {
    const { summaries, calls } = langSetup([HINGLISH_SUMMARY]);
    await summaries.summarizePage({ tabId: 1 });
    expect(calls).toHaveLength(1);
  });
});
