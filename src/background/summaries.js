// @ts-check
// Summaries (architecture §9.2–9.3):
//   page:  extract → budget → cache lookup → strict-JSON summary
//   video: YouTube link → Gemini watches the public video → summary + chapter notes

import { PAGE_TEXT_CHAR_BUDGET, YOUTUBE_TIMEOUT_MS } from '../shared/config.js';
import { ToContent, ToPanel, ToSW, makeMessage } from '../shared/messages.js';
import { checkHinglish, isLanguage, summaryText } from '../shared/language.js';
import { hinglishRetryRule } from '../shared/prompts/_common.js';
import { buildSummaryPrompt } from '../shared/prompts/summary.js';
import { buildYouTubePrompt } from '../shared/prompts/youtube.js';
import { SummarySchema, VideoSummarySchema, validateSummary, validateVideoSummary } from '../shared/schemas.js';
import { createStorage } from '../shared/storage.js';
import { fitToBudget, hashString } from '../shared/text.js';
import { parseYouTubeUrl } from '../shared/youtube-url.js';
import { FeatureError } from './feature-error.js';
import { LlmError } from './llm/errors.js';
import { createDefaultGateway } from './llm/default-gateway.js';
import { createGateway } from './llm/gateway.js';
import { on } from './router.js';
import { chromePageGuard } from './page-guard.js';
import { ensureInjected, readPageText, sendToTab } from './tab-context.js';

/** Below this, there's nothing worth summarising and no model call is made (EC-ART-03). */
export const MIN_SUMMARY_CHARS = 300;
const CACHE_KEY = 'summaryCache';
const CACHE_LIMIT = 20;

/**
 * @typedef {{ source: 'article'|'visible', title: string, byline: string|null, text: string,
 *   url: string, isReadable?: boolean, stillLoading?: boolean }} PageText
 * @typedef {{ videoId: string|null, title: string|null, durationSeconds: number|null, isLive: boolean }} VideoInfo
 * @typedef {{
 *   kind: 'page'|'video',
 *   summary: import('../shared/schemas.js').Summary | import('../shared/schemas.js').VideoSummary,
 *   source: 'article'|'visible'|'video', title: string, url: string, videoId?: string,
 *   truncated: boolean, language: string, model: string, provider: string, cached: boolean, stillLoading: boolean
 * }} SummaryResult
 * @typedef {{ get: (key: string) => Promise<SummaryResult|undefined>, set: (key: string, value: SummaryResult) => Promise<void> }} SummaryCache
 */

/**
 * Cache key: same URL (minus #fragment) + same content + same language (EC-ART-09/10).
 * @param {string} url
 * @param {string} text
 * @param {string} language
 */
export function summaryCacheKey(url, text, language) {
  return hashString(`${url.replace(/#.*$/, '')}\n${hashString(text)}\n${text.length}\n${language}`);
}

/** @param {string} videoId @param {string} language */
export function videoCacheKey(videoId, language) {
  return hashString(`youtube\n${videoId}\n${language}`);
}

/**
 * @param {{
 *   gateway: ReturnType<typeof createGateway>,
 *   getPageText: (tabId: number) => Promise<PageText>,
 *   getTabUrl: (tabId: number) => Promise<string>,
 *   getVideoInfo: (tabId: number) => Promise<VideoInfo|null>,
 *   getLanguage: () => Promise<string>,
 *   cache: SummaryCache,
 *   checkVideoUrl?: (url: string) => Promise<unknown>
 * }} deps checkVideoUrl: the page-tier check for a video link (P4.3); throws to refuse
 */
export function createSummaries({ gateway, getPageText, getTabUrl, getVideoInfo, getLanguage, cache, checkVideoUrl = async () => {} }) {
  /** The language for this request: an explicit override (the card's ⇄ button) or the saved setting. */
  async function pickLanguage(payload) {
    return isLanguage(payload?.language) ? payload.language : getLanguage();
  }

  /**
   * gateway.json, plus one retry with a stronger instruction if a Hinglish answer came back in
   * Devanagari or plain English (EC-LNG-01/02). Never loops; if the retry fails, the first answer stands.
   * @param {Parameters<ReturnType<typeof createGateway>['json']>[0]} req
   * @param {string} language
   */
  async function jsonInLanguage(req, language) {
    const first = await gateway.json(req);
    if (language !== 'hinglish') return first;
    const check = checkHinglish(summaryText(/** @type {any} */ (first.value)));
    if (check.ok) return first;
    try {
      return await gateway.json({ ...req, system: `${req.system}\n${hinglishRetryRule(check.problem)}` });
    } catch {
      return first;
    }
  }

  /**
   * @param {{ url?: string, tabId?: number, force?: boolean, language?: string }} payload a pasted link, or the
   *   video open in tabId; language overrides the saved setting
   * @param {{ signal?: AbortSignal }} [io]
   * @returns {Promise<SummaryResult>}
   */
  async function summarizeVideo(payload, io = {}) {
    const tabId = typeof payload?.tabId === 'number' ? payload.tabId : undefined;
    let parsed;
    if (typeof payload?.url === 'string') {
      parsed = parseYouTubeUrl(payload.url);
    } else if (tabId !== undefined) {
      parsed = parseYouTubeUrl(await getTabUrl(tabId));
    } else {
      throw new FeatureError('INVALID_YOUTUBE_URL', 'Paste a YouTube link.');
    }
    if (!parsed.ok) throw new FeatureError('INVALID_YOUTUBE_URL', parsed.message);
    await checkVideoUrl(parsed.url);

    // If the open tab is showing this video, use its title and length; otherwise go without.
    let info = null;
    if (tabId !== undefined) {
      info = await getVideoInfo(tabId).catch(() => null);
      if (info?.videoId !== parsed.videoId) info = null;
    }
    if (info?.isLive) throw new LlmError('YOUTUBE_UNSUPPORTED'); // EC-YT-06

    const language = await pickLanguage(payload);
    const key = videoCacheKey(parsed.videoId, language);
    if (!payload.force) {
      const hit = await cache.get(key);
      if (hit) return { ...hit, cached: true };
    }

    const { system, turns } = buildYouTubePrompt({ url: parsed.url, title: info?.title, language });
    let reply;
    try {
      reply = await jsonInLanguage({
        task: 'youtube',
        system,
        turns,
        schema: VideoSummarySchema,
        validate: (v) => validateVideoSummary(v, { durationSeconds: info?.durationSeconds }),
        signal: io.signal,
        timeoutMs: YOUTUBE_TIMEOUT_MS
      }, language);
    } catch (err) {
      // Gemini answers 400 for private, removed, restricted or over-long videos (EC-YT-05, EC-YT-07).
      if (err instanceof LlmError && (err.code === 'BAD_REQUEST' || err.code === 'CONTEXT_TOO_LARGE')) {
        throw new LlmError('YOUTUBE_UNSUPPORTED');
      }
      throw err;
    }

    /** @type {SummaryResult} */
    const result = {
      kind: 'video',
      summary: reply.value,
      source: 'video',
      title: info?.title || 'YouTube video',
      url: parsed.url,
      videoId: parsed.videoId,
      truncated: false,
      language,
      model: reply.model,
      provider: reply.provider,
      cached: false,
      stillLoading: false
    };
    await cache.set(key, result);
    return result;
  }

  return {
    summarizeVideo,

    /**
     * @param {{ tabId?: number, force?: boolean, language?: string }} payload force skips the cache
     *   ("Summarise again"); language overrides the saved setting for this request (⇄ on the card)
     * @param {{ signal?: AbortSignal }} [io]
     * @returns {Promise<SummaryResult>}
     */
    async summarizePage(payload, io = {}) {
      if (typeof payload?.tabId !== 'number') throw new FeatureError('PAGE_RESTRICTED', 'Open a web page to summarise it.');

      // On a YouTube video page, summarise the video, not the comments around it (EC-YT-14).
      if (parseYouTubeUrl(await getTabUrl(payload.tabId)).ok) return summarizeVideo(payload, io);

      const page = await getPageText(payload.tabId);
      if (page.text.length < MIN_SUMMARY_CHARS) {
        throw new FeatureError('NOT_ENOUGH_TEXT', "There isn't enough text on this page to summarise.");
      }

      const language = await pickLanguage(payload);
      const key = summaryCacheKey(page.url, page.text, language);
      if (!payload.force) {
        const hit = await cache.get(key);
        if (hit) return { ...hit, cached: true };
      }

      const { text, truncated } = fitToBudget(page.text, PAGE_TEXT_CHAR_BUDGET);
      const { system, turns } = buildSummaryPrompt({ ...page, text, truncated, language });
      const { value, model, provider } = await jsonInLanguage({
        task: 'summary', system, turns, schema: SummarySchema, validate: validateSummary, signal: io.signal
      }, language);

      /** @type {SummaryResult} */
      const result = {
        kind: 'page',
        summary: value,
        source: page.source,
        title: page.title,
        url: page.url,
        truncated,
        language,
        model,
        provider,
        cached: false,
        stillLoading: Boolean(page.stillLoading)
      };
      await cache.set(key, result);
      return result;
    }
  };
}

/** Summary cache in storage.session: cleared when the browser closes, kept across worker restarts. */
function createSessionCache() {
  return {
    async get(key) {
      const { [CACHE_KEY]: entries = {} } = await chrome.storage.session.get(CACHE_KEY);
      return entries[key]?.value;
    },
    async set(key, value) {
      const { [CACHE_KEY]: entries = {} } = await chrome.storage.session.get(CACHE_KEY);
      entries[key] = { value, at: Date.now() };
      // Keep only the most recent entries.
      const keep = Object.entries(entries).sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_LIMIT);
      try {
        await chrome.storage.session.set({ [CACHE_KEY]: Object.fromEntries(keep) });
      } catch {
        /* cache is best-effort */
      }
    }
  };
}

/** Wire summaries into the router. Call synchronously at the worker's top level. */
export function initSummaries() {
  const storage = createStorage(chrome.storage.local);
  const guard = chromePageGuard();
  const gateway = createDefaultGateway();

  const summaries = createSummaries({
    gateway,
    cache: createSessionCache(),
    getLanguage: async () => (await storage.getSettings()).language,
    getTabUrl: async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      return tab.url ?? tab.pendingUrl ?? '';
    },
    async getVideoInfo(tabId) {
      await ensureInjected(tabId, [ToContent.CS_YT_INFO]);
      return sendToTab(tabId, ToContent.CS_YT_INFO);
    },
    // Nothing leaves the browser until the page passes its tier check (§14.2).
    async getPageText(tabId) {
      const page = await readPageText(tabId);
      await guard.assert(tabId, 'read');
      return page;
    },
    checkVideoUrl: (url) => guard.assertUrl(url, 'read')
  });

  /**
   * @param {(payload: any) => Promise<SummaryResult>} run
   * @returns {import('./router.js').Handler}
   */
  const reply = (run) => async (payload, { port }, msg) => {
    try {
      port.postMessage(makeMessage(ToPanel.SUMMARY_RESULT, await run(payload), msg.requestId));
    } catch (err) {
      if (err instanceof LlmError || err instanceof FeatureError) {
        port.postMessage(makeMessage(ToPanel.ERROR, err.toPayload(), msg.requestId));
      } else {
        throw err; // router turns this into a generic INTERNAL error
      }
    }
  };

  on(ToSW.SUMMARIZE_PAGE, reply((p) => summaries.summarizePage(p)));
  on(ToSW.SUMMARIZE_YOUTUBE, reply((p) => summaries.summarizeVideo(p)));

  // Chapter chips: jump the open video if it's the same one; the panel opens a link otherwise.
  on(ToSW.YT_SEEK, async (payload, { port }, msg) => {
    let result = { ok: false };
    try {
      await ensureInjected(payload.tabId, [ToContent.CS_YT_SEEK]);
      result = await sendToTab(payload.tabId, ToContent.CS_YT_SEEK, { videoId: payload.videoId, seconds: payload.seconds });
    } catch {
      /* tab closed or not scriptable: the panel falls back to opening a link */
    }
    port.postMessage(makeMessage(ToPanel.YT_SEEK_RESULT, result, msg.requestId));
  });
}
