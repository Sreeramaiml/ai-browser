// @ts-check
// Chat tab: questions about the current page, answered only from the page and streamed (P2.1),
// plus results of the right-click actions with their refinement chips (P2.2), and of answer-mode
// skills run from the Skills tab (P4.2).
// Page-chat history lives in storage.session (written by the service worker), so it survives a
// panel reload. Quick-action results aren't part of that history.

import { CHAT_MAX_QUESTION_CHARS, TRANSLATE_TARGETS } from '../../shared/config.js';
import { conversationKey, readConversation } from '../../shared/conversations.js';
import { ToPanel, ToSW, makeMessage } from '../../shared/messages.js';
import { MEDIUMS } from '../../shared/prompts/draft.js';
import { createMessageList } from '../components/message-list.js';

const STARTERS = ['What is this page about?', 'List the main facts', 'What are the dates/numbers mentioned?'];

const TEMPLATE = /* html */ `
  <div class="chat">
    <div data-ref="log"></div>
    <div class="chat-starters" data-ref="starters">
      <p class="hint">Ask anything about this page. Answers come only from what the page says.</p>
      <div class="chip-row">
        ${STARTERS.map((q) => `<button type="button" class="chip chip-btn" data-starter>${q}</button>`).join('')}
      </div>
    </div>
    <form class="composer" data-ref="form">
      <textarea data-ref="input" rows="2" maxlength="${CHAT_MAX_QUESTION_CHARS}" placeholder="Ask about this page…"
                aria-label="Question about this page" aria-describedby="chat-counter"></textarea>
      <div class="composer-bar">
        <span id="chat-counter" class="counter" data-ref="counter" hidden></span>
        <button type="submit" class="btn btn-primary" data-ref="send">Send</button>
      </div>
    </form>
  </div>
`;

/** Show the character counter once a question gets this long (EC-CHT-12). */
const COUNTER_FROM = 3_000;
/** A freshly opened panel waits this long for the active tab before running a right-click action. */
const READY_TIMEOUT_MS = 3_000;
/** Medium chips under a draft. 'message' is only the fallback when nothing fits (EC-CTX-08). */
const MEDIUM_CHOICES = /** @type {const} */ (['email', 'linkedin', 'forum']);

/**
 * @typedef {{
 *   kind: 'explain'|'translate'|'draft', text: string, tabId?: number|null, frameId?: number, url?: string,
 *   pageTitle?: string, targetLang?: string, medium?: string, tone?: string,
 *   refine?: 'shorter'|'formal', previousDraft?: string
 * }} QuickRequest
 * @typedef {{
 *   kind: QuickRequest['kind'], excerpt: string, source?: { text: string, url: string, pageTitle: string },
 *   targetLang?: string, medium?: string, tone?: string, refine?: string, profileUsed?: boolean
 * }} QuickInfo profileUsed: the draft's prompt included the profile's name or tone
 */

/** @param {string} text */
const shorten = (text) => (text.length > 140 ? `${text.slice(0, 140)}…` : text);

/**
 * What the user asked for, shown as their message.
 * @param {QuickInfo} info
 */
function quickLabel(info) {
  const quote = `“${info.excerpt}”`;
  if (info.kind === 'translate') {
    const target = TRANSLATE_TARGETS[info.targetLang ?? ''];
    return target ? `Translate to ${target}: ${quote}` : `Translate: ${quote}`;
  }
  if (info.kind === 'draft') {
    if (info.refine === 'shorter') return 'Make the reply shorter';
    if (info.refine === 'formal') return 'Make the reply more formal';
    const medium = MEDIUMS[info.medium ?? ''];
    return medium ? `Draft a reply (${medium}): ${quote}` : `Draft a reply: ${quote}`;
  }
  return `Explain: ${quote}`;
}

/** @param {string} label @param {() => void} onClick */
function chipButton(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip chip-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * Remarks under an answer, from the flags the service worker sets.
 * @param {{ notFound?: boolean, truncated?: boolean, unverifiedQuotes?: number }} answer
 */
function notesFor(answer) {
  const notes = [];
  if (answer.notFound && answer.truncated) {
    notes.push('This page is long, so I searched the most relevant parts. Try rephrasing with specific words from the page.'); // EC-CHT-05
  }
  if (answer.unverifiedQuotes) {
    notes.push(answer.unverifiedQuotes === 1
      ? '⚠ A quote in this answer wasn’t found on the page.'
      : `⚠ ${answer.unverifiedQuotes} quotes in this answer weren’t found on the page.`); // EC-CHT-14
  }
  return notes;
}

/**
 * @param {HTMLElement} root
 * @param {{
 *   store: import('../store.js').Store<{ activeTab: import('../../background/tab-context.js').ActiveTabInfo|null }>,
 *   client: Awaited<ReturnType<typeof import('../client.js').startClient>>,
 *   openSettings: () => void
 * }} deps
 */
export function mountChatView(root, { store, client, openSettings }) {
  root.innerHTML = TEMPLATE;
  /** @param {string} name @returns {any} */
  const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
  const log = /** @type {HTMLElement} */ (ref('log'));
  const starters = /** @type {HTMLElement} */ (ref('starters'));
  const form = /** @type {HTMLFormElement} */ (ref('form'));
  const input = /** @type {HTMLTextAreaElement} */ (ref('input'));
  const counter = /** @type {HTMLElement} */ (ref('counter'));
  const sendBtn = /** @type {HTMLButtonElement} */ (ref('send'));
  const list = createMessageList(log);

  let streaming = false;
  /** Right-click actions in flight; they run one at a time, queued. */
  let quickBusy = 0;
  let quickQueue = Promise.resolve();
  /** Resolves when the current page's history is on screen. */
  let currentLoad = Promise.resolve();
  /** The conversation on screen: `tabId:url` without the #fragment. */
  let currentKey = /** @type {string|null} */ (null);
  let currentTabId = /** @type {number|null} */ (null);
  /** Bumped on every page change so a slow history read can't land on the wrong page. */
  let loadToken = 0;

  const hasMessages = () => log.querySelector('.msg') !== null;

  function render() {
    const length = input.value.length;
    sendBtn.disabled = streaming || quickBusy > 0 || !input.value.trim() || currentKey === null;
    counter.hidden = length < COUNTER_FROM;
    counter.textContent = `${length.toLocaleString()} / ${CHAT_MAX_QUESTION_CHARS.toLocaleString()}`;
    starters.hidden = streaming || quickBusy > 0 || hasMessages() || currentKey === null;
    for (const chip of starters.querySelectorAll('button')) /** @type {HTMLButtonElement} */ (chip).disabled = streaming || quickBusy > 0;
  }

  // ---- Following the active page ----

  /** @param {import('../../shared/conversations.js').ChatMessage[]} messages */
  function renderHistory(messages) {
    for (const m of messages) {
      if (m.role === 'user') list.addUser(m.text);
      else if (m.role === 'assistant') list.addAssistant({}).finish(m, { notes: notesFor(m) });
      else if (m.role === 'event' && m.kind === 'content-updated') list.addDivider('Page content updated');
    }
  }

  /** @param {string|null} key */
  async function showConversation(key) {
    const token = ++loadToken;
    const tabId = store.get().activeTab?.tabId ?? null;
    // Navigating within a tab starts a fresh chat under a divider; switching tabs shows that tab's chat.
    if (key !== null && tabId === currentTabId && hasMessages()) {
      list.addDivider('New page — context reset');
    } else {
      list.clear();
    }
    currentKey = key;
    currentTabId = tabId;
    render();
    if (key === null) return;

    let conversation = null;
    try {
      conversation = await readConversation(chrome.storage.session, key);
    } catch {
      /* no history is fine */
    }
    if (token !== loadToken || !conversation) return;
    renderHistory(conversation.messages);
    render();
  }

  store.subscribe((s) => {
    const tab = s.activeTab;
    return tab?.tabId != null && !tab.access.restricted ? conversationKey(tab.tabId, tab.url) : null;
  }, (key) => { currentLoad = showConversation(key); });

  // ---- Asking ----

  /** @param {string} question */
  async function send(question) {
    const text = question.trim().slice(0, CHAT_MAX_QUESTION_CHARS);
    const tabId = currentTabId;
    if (streaming || quickBusy > 0 || !text || tabId === null || currentKey === null) return;
    streaming = true;
    input.value = '';
    render();

    const user = list.addUser(text);
    const reply = list.addAssistant({
      onRetry: () => {
        user.remove();
        reply.remove();
        send(text);
      },
      onOpenSettings: openSettings,
      stopLabel: 'Stop generating'
    });
    render();

    const { requestId, done } = client.stream(ToSW.CHAT_SEND, { tabId, conversationId: currentKey, text }, {
      onProgress(msg) {
        if (msg.type === ToPanel.CHAT_START && msg.payload?.contentChanged) {
          list.addDivider('Page content updated', { before: user.el }); // EC-CHT-08
        } else if (msg.type === ToPanel.CHAT_DELTA) {
          reply.append(msg.payload.text);
        } else if (msg.type === ToPanel.CHAT_RESET) {
          reply.reset();
        }
      }
    });
    reply.onStop(() => client.send(makeMessage(ToSW.CANCEL, { requestId })));

    try {
      const msg = await done;
      if (msg.type === ToPanel.CHAT_DONE) {
        reply.finish(msg.payload, { notes: notesFor(msg.payload) });
      } else {
        reply.fail(msg.payload ?? { code: 'INTERNAL', message: 'Something went wrong. Please try again.', retryable: true });
      }
    } catch (err) {
      // Timed out or disconnected on the panel side.
      reply.fail({ code: 'INTERRUPTED', message: err instanceof Error ? err.message : 'Connection interrupted.', retryable: true });
    } finally {
      streaming = false;
      render();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send(input.value);
  });

  // Enter sends; Shift+Enter adds a line. Not while an IME is composing (Hindi keyboards).
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send(input.value);
    }
  });
  input.addEventListener('input', render);

  starters.addEventListener('click', (event) => {
    const chip = /** @type {HTMLElement} */ (event.target).closest?.('[data-starter]');
    if (chip) send(chip.textContent ?? '');
  });

  // ---- Quick actions (right-click menu) ----

  /** Wait until the active page is known and its history shown, so a result isn't wiped or buried. */
  function whenReady() {
    return new Promise((resolve) => {
      if (store.get().activeTab !== null) {
        resolve(currentLoad);
        return;
      }
      let unsubscribe = () => {};
      const finish = () => {
        clearTimeout(timer);
        unsubscribe();
        resolve(currentLoad); // set by the key subscriber, which runs before this one
      };
      const timer = setTimeout(finish, READY_TIMEOUT_MS);
      unsubscribe = store.subscribe((s) => s.activeTab !== null, (known) => { if (known) finish(); }, { immediate: false });
    });
  }

  /**
   * Chips under an answer: Re-translate into another language, or reshape a draft.
   * @param {QuickInfo} info
   * @param {string} answer
   */
  function followUps(info, answer) {
    if (!info.source || (info.kind !== 'translate' && info.kind !== 'draft')) return null;
    const base = { text: info.source.text, url: info.source.url, pageTitle: info.source.pageTitle };
    const row = document.createElement('div');
    row.className = 'quick-followups';

    if (info.kind === 'translate') {
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Translate into');
      for (const [value, label] of Object.entries(TRANSLATE_TARGETS)) select.append(new Option(label, value));
      select.value = info.targetLang ?? 'hi';
      row.append(select, chipButton('Re-translate', () => runQuickAction({ kind: 'translate', ...base, targetLang: select.value })));
      return row;
    }

    const draft = { kind: /** @type {const} */ ('draft'), ...base, medium: info.medium, tone: info.tone };
    row.append(
      chipButton('Shorter', () => runQuickAction({ ...draft, refine: 'shorter', previousDraft: answer })),
      chipButton('More formal', () => runQuickAction({ ...draft, refine: 'formal', previousDraft: answer }))
    );
    const label = document.createElement('span');
    label.className = 'followups-label';
    label.textContent = 'Reply as:';
    row.append(label);
    for (const medium of MEDIUM_CHOICES) {
      const chip = chipButton(MEDIUMS[medium], () => runQuickAction({ ...draft, medium, refine: undefined }));
      chip.setAttribute('aria-pressed', String(info.medium === medium));
      row.append(chip);
    }
    return row;
  }

  /** @param {QuickRequest} req */
  async function quickAction(req) {
    quickBusy++;
    render();
    const user = list.addUser(quickLabel({ ...req, excerpt: shorten((req.text ?? '').trim()) }));
    const reply = list.addAssistant({
      onRetry: () => {
        user.remove();
        reply.remove();
        runQuickAction(req);
      },
      onOpenSettings: openSettings,
      // A private page: the user agrees once per site to send only the selected text (EC-TIR-09).
      onAck: async (domain) => {
        try {
          const ack = await client.request(ToSW.SAFETY_ACK, { domain });
          if (ack.type !== ToPanel.SAFETY_STATE) throw new Error(ack.payload?.errors?.domain ?? ack.payload?.message ?? "Couldn't save that.");
        } catch (err) {
          reply.fail({ code: 'INTERNAL', message: err instanceof Error ? err.message : "Couldn't save that." });
          return;
        }
        user.remove();
        reply.remove();
        runQuickAction(req);
      },
      stopLabel: 'Stop generating'
    });
    /** @type {QuickInfo|null} */
    let info = null;

    const { kind, text, tabId, frameId, url, pageTitle, targetLang, medium, tone, refine, previousDraft } = req;
    const payload = { kind, text, tabId: tabId ?? undefined, frameId, url, pageTitle, targetLang, medium, tone, refine, previousDraft };
    const { requestId, done } = client.stream(ToSW.QUICK_ACTION, payload, {
      onProgress(msg) {
        if (msg.type === ToPanel.CHAT_START) {
          info = msg.payload;
          user.setText(quickLabel(msg.payload));
        } else if (msg.type === ToPanel.CHAT_DELTA) {
          reply.append(msg.payload.text);
        } else if (msg.type === ToPanel.CHAT_RESET) {
          reply.reset();
        }
      }
    });
    reply.onStop(() => client.send(makeMessage(ToSW.CANCEL, { requestId })));

    try {
      const msg = await done;
      if (msg.type === ToPanel.CHAT_DONE) {
        reply.finish(msg.payload, { chips: info?.profileUsed ? ['Profile used'] : [] });
        const row = info && followUps(info, msg.payload.text);
        if (row) reply.attach(row);
      } else if (msg.payload?.code === 'ALREADY_IN_TARGET') {
        // EC-CTX-10: offer the obvious alternative instead of translating into the same language.
        reply.fail(msg.payload);
        const { suggestTarget, source } = msg.payload;
        const row = document.createElement('div');
        row.className = 'quick-followups';
        row.append(chipButton(`Translate to ${TRANSLATE_TARGETS[suggestTarget] ?? 'English'} instead`, () => runQuickAction({
          kind: 'translate', text: source?.text ?? text, url: source?.url ?? url, pageTitle: source?.pageTitle ?? pageTitle,
          targetLang: suggestTarget
        })));
        reply.attach(row);
      } else {
        reply.fail(msg.payload ?? { code: 'INTERNAL', message: 'Something went wrong. Please try again.', retryable: true });
      }
    } catch (err) {
      reply.fail({ code: 'INTERRUPTED', message: err instanceof Error ? err.message : 'Connection interrupted.', retryable: true });
    } finally {
      quickBusy--;
      render();
    }
  }

  /**
   * Run Explain / Translate / Draft a reply and show it here. Requests queue one after another.
   * @param {QuickRequest} req
   */
  function runQuickAction(req) {
    quickQueue = quickQueue
      .then(async () => {
        await whenReady();
        await quickAction(req);
      })
      .catch((err) => console.error('[Pagewise] quick action failed', err));
    return quickQueue;
  }

  /**
   * One answer-mode skill run, shown as a quick action is: the skill's name as the user's message.
   * @param {{ id: string, name: string, icon?: string }} skill
   */
  async function skillRun(skill) {
    quickBusy++;
    render();
    const label = `${skill.icon ? `${skill.icon} ` : ''}${skill.name}`;
    const user = list.addUser(label);
    const reply = list.addAssistant({
      onRetry: () => {
        user.remove();
        reply.remove();
        runSkill(skill);
      },
      onOpenSettings: openSettings,
      stopLabel: 'Stop generating'
    });
    let profileUsed = false;

    const tabId = store.get().activeTab?.tabId ?? undefined;
    const { requestId, done } = client.stream(ToSW.RUN_SKILL, { skillId: skill.id, tabId }, {
      onProgress(msg) {
        if (msg.type === ToPanel.CHAT_START) profileUsed = Boolean(msg.payload?.profileUsed);
        else if (msg.type === ToPanel.CHAT_DELTA) reply.append(msg.payload.text);
        else if (msg.type === ToPanel.CHAT_RESET) reply.reset();
      }
    });
    reply.onStop(() => client.send(makeMessage(ToSW.CANCEL, { requestId })));

    try {
      const msg = await done;
      if (msg.type === ToPanel.CHAT_DONE) reply.finish(msg.payload, { chips: profileUsed ? ['Profile shared with model'] : [] });
      else reply.fail(msg.payload ?? { code: 'INTERNAL', message: 'Something went wrong. Please try again.', retryable: true });
    } catch (err) {
      reply.fail({ code: 'INTERRUPTED', message: err instanceof Error ? err.message : 'Connection interrupted.', retryable: true });
    } finally {
      quickBusy--;
      render();
    }
  }

  /**
   * Run an answer-mode skill and stream its result here, after anything already queued.
   * @param {{ id: string, name: string, icon?: string }} skill
   * @returns {Promise<void>} resolves when the answer is complete (or failed)
   */
  function runSkill(skill) {
    quickQueue = quickQueue
      .then(async () => {
        await whenReady();
        await skillRun(skill);
      })
      .catch((err) => console.error('[Pagewise] skill failed', err));
    return quickQueue;
  }

  render();
  return { runQuickAction, runSkill };
}
