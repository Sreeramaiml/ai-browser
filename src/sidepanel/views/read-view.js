// @ts-check
// Read tab: page and YouTube summaries (P1.4, P1.5) and "Explain selection" (P1.3).

import { otherLanguage } from '../../shared/language.js';
import { ToPanel, ToSW, makeMessage } from '../../shared/messages.js';
import { parseYouTubeUrl, videoUrlAt } from '../../shared/youtube-url.js';
import { createErrorBanner } from '../components/error-banner.js';
import { createMessageList } from '../components/message-list.js';
import { createSummaryCard } from '../components/summary-card.js';

const TEMPLATE = /* html */ `
  <div class="read">
    <div class="read-actions">
      <div class="row">
        <button type="button" class="btn btn-primary" data-ref="summarize">Summarise this page</button>
        <button type="button" class="btn btn-secondary" data-ref="explain">Explain selection</button>
      </div>
      <p class="hint">Get a quick summary of the page, or select text and click Explain.</p>
      <form class="yt-form" data-ref="ytForm">
        <input type="text" inputmode="url" data-ref="ytInput" spellcheck="false" autocomplete="off"
               placeholder="Or paste a YouTube link" aria-label="YouTube link to summarise" />
        <button type="submit" class="btn btn-secondary" data-ref="ytSubmit">Summarise video</button>
      </form>
    </div>
    <div data-ref="summary" aria-live="polite"></div>
    <div data-ref="notice"></div>
    <div data-ref="messages"></div>
  </div>
`;

/** Errors that mean "nothing was asked", so the empty exchange is removed and a hint is shown instead. */
const NOT_STARTED = new Set(['NO_SELECTION', 'PROTECTED_FIELD', 'PAGE_RESTRICTED']);

/** The SW may try a video twice (schema fallback, repair), each up to 90 s. */
const VIDEO_TIMEOUT_MS = 200_000;

/**
 * @param {HTMLElement} root
 * @param {{
 *   store: import('../store.js').Store<{ activeTab: import('../../background/tab-context.js').ActiveTabInfo|null }>,
 *   client: Awaited<ReturnType<typeof import('../client.js').startClient>>,
 *   openSettings: () => void
 * }} deps
 */
export function mountReadView(root, { store, client, openSettings }) {
  root.innerHTML = TEMPLATE;
  /** @param {string} name @returns {any} */
  const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
  const summarizeBtn = /** @type {HTMLButtonElement} */ (ref('summarize'));
  const explainBtn = /** @type {HTMLButtonElement} */ (ref('explain'));
  const ytInput = /** @type {HTMLInputElement} */ (ref('ytInput'));
  const ytSubmit = /** @type {HTMLButtonElement} */ (ref('ytSubmit'));
  const summarySlot = /** @type {HTMLElement} */ (ref('summary'));
  const notice = /** @type {HTMLElement} */ (ref('notice'));
  const list = createMessageList(ref('messages'));
  let explaining = false;
  let summarizing = false;
  /** What the summary slot is showing: page summaries belong to one page, video summaries don't. */
  let slotKind = /** @type {'page'|'video'|null} */ (null);

  const activeVideo = () => parseYouTubeUrl(store.get().activeTab?.url ?? '');

  function render() {
    const noTab = store.get().activeTab?.tabId == null;
    explainBtn.disabled = explaining || noTab;
    explainBtn.textContent = explaining ? 'Explaining…' : 'Explain selection';
    summarizeBtn.disabled = summarizing || noTab;
    summarizeBtn.textContent = summarizing ? 'Summarising…' : activeVideo().ok ? 'Summarise this video' : 'Summarise this page';
    ytSubmit.disabled = summarizing;
  }
  store.subscribe((s) => s.activeTab?.url, render);
  store.subscribe((s) => s.activeTab?.tabId, render);

  // A page summary belongs to one page: clear it when the user moves on. Video summaries stay,
  // because clicking a chapter can open the video in a new tab.
  store.subscribe((s) => s.activeTab?.url?.replace(/#.*$/, ''), () => {
    if (!summarizing && slotKind === 'page') {
      summarySlot.replaceChildren();
      slotKind = null;
    }
  }, { immediate: false });

  // ---- Summaries ----

  /**
   * @param {string} type SUMMARIZE_PAGE or SUMMARIZE_YOUTUBE
   * @param {Record<string, unknown>} payload
   * @param {string} loadingText
   */
  async function runSummary(type, payload, loadingText) {
    if (summarizing) return;
    summarizing = true;
    render();
    const loading = document.createElement('div');
    loading.className = 'summary-card loading';
    loading.textContent = loadingText;
    summarySlot.replaceChildren(loading);
    slotKind = null;
    const retry = () => runSummary(type, payload, loadingText);

    try {
      const msg = await client.request(type, payload, { timeoutMs: VIDEO_TIMEOUT_MS });
      if (msg.type === ToPanel.SUMMARY_RESULT) {
        const result = msg.payload;
        slotKind = result.kind === 'video' ? 'video' : 'page';
        summarySlot.replaceChildren(createSummaryCard(result, {
          onRefresh: () => runSummary(type, { ...payload, force: true }, loadingText),
          onSeek: (seconds) => seek(result.videoId, seconds),
          // Same source, other language; cached separately, so switching back is instant.
          onSwitchLanguage: () => runSummary(type, { ...payload, force: false, language: otherLanguage(result.language) }, loadingText)
        }));
      } else {
        summarySlot.replaceChildren(createErrorBanner(
          msg.payload ?? { code: 'INTERNAL', message: 'Something went wrong. Please try again.', retryable: true },
          { onRetry: retry, onOpenSettings: openSettings }
        ));
      }
    } catch (err) {
      summarySlot.replaceChildren(createErrorBanner(
        { code: 'INTERRUPTED', message: err instanceof Error ? err.message : 'Something went wrong.', retryable: true },
        { onRetry: retry }
      ));
    } finally {
      summarizing = false;
      render();
    }
  }

  function summarizeActiveTab() {
    const tabId = store.get().activeTab?.tabId;
    if (tabId == null) return;
    const video = activeVideo().ok;
    // On a YouTube video page the service worker summarises the video itself (EC-YT-14).
    runSummary(ToSW.SUMMARIZE_PAGE, { tabId }, video ? 'Watching the video and summarising… this can take a minute.' : 'Reading the page and summarising…');
  }

  ref('ytForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const parsed = parseYouTubeUrl(ytInput.value);
    if (!parsed.ok) {
      summarySlot.replaceChildren(createErrorBanner({ code: 'INVALID_YOUTUBE_URL', message: parsed.message }, {}));
      slotKind = null;
      ytInput.focus();
      return;
    }
    const tabId = store.get().activeTab?.tabId ?? undefined;
    runSummary(ToSW.SUMMARIZE_YOUTUBE, { url: parsed.url, tabId }, 'Watching the video and summarising… this can take a minute.');
  });

  /**
   * Chapter chip: seek the open video if it's the same one, otherwise open it at that moment.
   * @param {string|undefined} videoId
   * @param {number} seconds
   */
  async function seek(videoId, seconds) {
    if (!videoId) return;
    const tab = store.get().activeTab;
    const open = parseYouTubeUrl(tab?.url ?? '');
    if (tab?.tabId != null && open.ok && open.videoId === videoId) {
      try {
        const reply = await client.request(ToSW.YT_SEEK, { tabId: tab.tabId, videoId, seconds });
        if (reply.payload?.ok) return;
      } catch {
        /* fall through to opening a link */
      }
    }
    chrome.tabs.create({ url: videoUrlAt(videoId, seconds) }); // different video or player not ready (EC-YT-10/11)
  }

  // ---- Explain ----

  async function explain() {
    const tabId = store.get().activeTab?.tabId;
    if (explaining || tabId == null) return;
    explaining = true;
    render();
    notice.replaceChildren();

    const user = list.addUser('Explain selection');
    const reply = list.addAssistant({ onRetry: explain, onOpenSettings: openSettings });

    const { requestId, done } = client.stream(ToSW.QUICK_ACTION, { kind: 'explain', tabId }, {
      onProgress(msg) {
        if (msg.type === ToPanel.CHAT_START) user.setText(`Explain: “${msg.payload.excerpt}”`);
        else if (msg.type === ToPanel.CHAT_DELTA) reply.append(msg.payload.text);
        else if (msg.type === ToPanel.CHAT_RESET) reply.reset();
      }
    });
    reply.onStop(() => client.send(makeMessage(ToSW.CANCEL, { requestId })));

    try {
      const msg = await done;
      if (msg.type === ToPanel.CHAT_DONE) {
        reply.finish(msg.payload);
      } else if (NOT_STARTED.has(msg.payload?.code)) {
        user.remove();
        reply.remove();
        notice.replaceChildren(createErrorBanner(msg.payload, {}));
      } else {
        reply.fail(msg.payload ?? { code: 'INTERNAL', message: 'Something went wrong. Please try again.', retryable: true });
      }
    } catch (err) {
      // Timed out or disconnected on the panel side.
      reply.fail({ code: 'INTERRUPTED', message: err instanceof Error ? err.message : 'Something went wrong.', retryable: true });
    } finally {
      explaining = false;
      render();
    }
  }

  summarizeBtn.addEventListener('click', summarizeActiveTab);
  explainBtn.addEventListener('click', explain);
}
