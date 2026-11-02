// @ts-check
// Side panel shell: connection to the service worker, tab routing, and the context header.

import { ToPanel } from '../shared/messages.js';
import { PENDING_KEY, createPendingWatcher } from '../shared/pending-request.js';
import { startClient } from './client.js';
import { mountLangToggle } from './components/lang-toggle.js';
import { createStore } from './store.js';
import { mountAgentView } from './views/agent-view.js';
import { mountChatView } from './views/chat-view.js';
import { mountReadView } from './views/read-view.js';
import { mountSeeView } from './views/see-view.js';
import { mountSettingsView } from './views/settings-view.js';
import { mountSkillsView } from './views/skills-view.js';

/** @typedef {import('../background/tab-context.js').ActiveTabInfo} ActiveTabInfo */
/** @typedef {import('../background/settings-service.js').SettingsState} SettingsState */
/** @typedef {'read'|'chat'|'see'|'agent'|'skills'|'settings'} ViewId */

/** Views that need a readable page. Skills and Settings work everywhere (EC-PNL-01). */
const PAGE_VIEWS = new Set(['read', 'chat', 'see', 'agent']);
const TAB_VIEWS = /** @type {ViewId[]} */ (['read', 'chat', 'see', 'agent', 'skills']);

/** @type {Record<string, { title: string, detail: string, action?: string }>} */
const RESTRICTED_COPY = {
  browser: {
    title: "Sahayak can't read this kind of page",
    detail: "Chrome doesn't let extensions read its own pages, like Settings or the New Tab page. Open a website to use Sahayak."
  },
  webstore: {
    title: "Sahayak can't read this kind of page",
    detail: 'The Chrome Web Store is protected from all extensions.'
  },
  file: {
    title: "Sahayak can't read local files yet",
    detail: 'Turn on "Allow access to file URLs" for Sahayak on the extensions page, then reload this file.',
    action: 'Open extension settings'
  },
  pdf: {
    title: "Sahayak can't read PDFs yet",
    detail: "PDFs open in Chrome's built-in viewer, which extensions can't read. You can still ask about what's on screen in the See tab."
  },
  none: {
    title: 'No page selected',
    detail: 'Switch to a browser tab with a website to use Sahayak.'
  }
};

const store = createStore({
  /** @type {ViewId} */
  view: 'read',
  /** @type {import('./connection.js').ConnectionStatus} */
  connection: 'connecting',
  /** @type {ActiveTabInfo|null} */
  activeTab: null,
  /** @type {SettingsState|null} */
  settingsState: null,
  /** @type {import('../shared/storage.js').Profile|null} */
  profile: null,
  /** @type {import('../shared/schemas.js').Skill[]|null} */
  skills: null,
  /** @type {import('./views/safety-view.js').SafetyState|null} */
  safety: null
});

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

function openExtensionsPage() {
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
}

// ---- Context header ----

store.subscribe((s) => s.activeTab, (tab) => {
  const title = $('page-title');
  const favicon = /** @type {HTMLImageElement} */ ($('favicon'));
  const fallback = $('favicon-fallback');

  // Always textContent: page titles are untrusted (EC-PNL-15).
  title.textContent = tab ? (tab.title || 'Untitled page') : 'Connecting…';
  title.title = tab?.url || '';
  $('page-status').hidden = tab?.status !== 'loading';

  if (tab?.favIconUrl) {
    favicon.src = tab.favIconUrl;
    favicon.hidden = false;
    fallback.hidden = true;
  } else {
    favicon.removeAttribute('src');
    favicon.hidden = true;
    fallback.hidden = false;
  }
});

// Safety badge (architecture §14.2): 🟢 usable, 🟡 private page, 🔴 banking or blocked. The label
// says why, for the tooltip and for screen readers.
const BADGE_ICON = { ok: '🟢', sensitive: '🟡', blocked: '🔴' };
store.subscribe((s) => s.activeTab?.safety ?? null, (safety) => {
  const badge = $('safety-badge');
  badge.hidden = !safety;
  if (!safety) return;
  badge.textContent = BADGE_ICON[safety.level] ?? '🟡';
  badge.title = safety.label;
  badge.setAttribute('aria-label', safety.label);
  badge.dataset.level = safety.level;
});

/** @type {HTMLImageElement} */ ($('favicon')).addEventListener('error', () => {
  $('favicon').hidden = true;
  $('favicon-fallback').hidden = false;
});

// ---- Tabs and views ----

const tabButtons = /** @type {HTMLButtonElement[]} */ ([...document.querySelectorAll('[role="tab"]')]);

for (const btn of tabButtons) {
  btn.addEventListener('click', () => store.set({ view: /** @type {ViewId} */ (btn.dataset.view) }));
}

// Arrow-key navigation between tabs (WAI-ARIA tabs pattern).
$('tab-read').parentElement?.addEventListener('keydown', (event) => {
  const i = tabButtons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
  if (i === -1) return;
  const last = tabButtons.length - 1;
  const next = { ArrowRight: i === last ? 0 : i + 1, ArrowLeft: i === 0 ? last : i - 1, Home: 0, End: last }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  tabButtons[next].focus();
  tabButtons[next].click();
});

$('settings-btn').addEventListener('click', () => {
  store.set({ view: store.get().view === 'settings' ? 'read' : 'settings' });
});

/** @param {{ view: ViewId, activeTab: ActiveTabInfo|null }} s */
function renderViews(s) {
  const { view, activeTab } = s;
  const restrictedReason = activeTab?.access.restricted ? activeTab.access.reason ?? 'none' : null;
  // A PDF can't be read as text, but it can be captured, so See still works there (EC-PNL-04).
  const showRestricted = PAGE_VIEWS.has(view) && restrictedReason !== null && !(view === 'see' && restrictedReason === 'pdf');

  for (const btn of tabButtons) {
    const selected = btn.dataset.view === view;
    btn.setAttribute('aria-selected', String(selected));
    btn.tabIndex = selected || (view === 'settings' && btn.dataset.view === 'read') ? 0 : -1;
  }
  $('settings-btn').setAttribute('aria-pressed', String(view === 'settings'));

  for (const id of [...TAB_VIEWS, 'settings']) {
    $(`view-${id}`).hidden = id !== view || showRestricted;
  }

  const restricted = $('restricted');
  restricted.hidden = !showRestricted;
  if (showRestricted && restrictedReason) {
    const copy = RESTRICTED_COPY[restrictedReason] ?? RESTRICTED_COPY.browser;
    $('restricted-title').textContent = copy.title;
    $('restricted-detail').textContent = copy.detail;
    const action = $('restricted-action');
    action.hidden = !copy.action;
    action.textContent = copy.action ?? '';
  }
}

store.subscribe((s) => s.view, () => renderViews(store.get()));
store.subscribe((s) => s.activeTab, () => renderViews(store.get()), { immediate: false });
$('restricted-action').addEventListener('click', openExtensionsPage);

// ---- Connection banner ----

store.subscribe((s) => s.connection, (status) => {
  const banner = $('conn-banner');
  // Reconnecting after normal worker sleep is silent (EC-PNL-12); only persistent problems show.
  banner.hidden = status !== 'failed' && status !== 'invalidated';
  if (status === 'failed') {
    $('conn-banner-text').textContent = "Sahayak's background stopped responding. Try again, or reload Sahayak from the extensions page.";
  } else if (status === 'invalidated') {
    $('conn-banner-text').textContent = 'Sahayak was updated. Close and reopen this panel to continue.';
  }
  // Chrome APIs are gone once the extension context is invalidated, so hide the actions (EC-INS-06).
  $('conn-retry').hidden = status !== 'failed';
  $('conn-open-extensions').hidden = status !== 'failed';
});

/** @type {ReturnType<typeof mountAgentView>|null} */
let agentView = null;

/** @param {import('../shared/messages.js').Message} msg @param {number} windowId */
function handleMessage(msg, windowId) {
  switch (msg.type) {
    case ToPanel.ACTIVE_TAB:
      // Each window has its own panel; ignore anything meant for another window (EC-PNL-07).
      if (msg.payload?.windowId === windowId) store.set({ activeTab: msg.payload });
      break;
    case ToPanel.SETTINGS_STATE:
      store.set({ settingsState: msg.payload });
      break;
    case ToPanel.PROFILE_STATE:
      store.set({ profile: msg.payload?.profile ?? {} });
      break;
    case ToPanel.SKILLS_STATE:
      store.set({ skills: msg.payload?.skills ?? [] });
      break;
    case ToPanel.SAFETY_STATE:
      store.set({ safety: msg.payload?.safety ?? null });
      break;
    case ToPanel.AGENT_STATE:
      agentView?.onAgentState(msg.payload);
      break;
    case ToPanel.ERROR:
      console.warn('[Sahayak] error from background', msg.payload?.code);
      break;
    default:
      break;
  }
}

async function boot() {
  const client = await startClient({
    surface: 'sidepanel',
    onMessage: handleMessage,
    onStatus: (connection) => store.set({ connection })
  });

  $('conn-retry').addEventListener('click', () => client.connection.retry());
  $('conn-open-extensions').addEventListener('click', openExtensionsPage);

  mountSettingsView($('view-settings'), { store, request: client.request });
  mountReadView($('view-read'), { store, client, openSettings: () => store.set({ view: 'settings' }) });
  const chat = mountChatView($('view-chat'), { store, client, openSettings: () => store.set({ view: 'settings' }) });
  mountSeeView($('view-see'), { store, client, openSettings: () => store.set({ view: 'settings' }) });
  agentView = mountAgentView($('view-agent'), { store, client, openSettings: () => store.set({ view: 'settings' }) });
  mountSkillsView($('view-skills'), {
    store,
    client,
    openSettings: () => store.set({ view: 'settings' }),
    // An answer streams into Chat; an agent skill's task shows in Agent (P4.2).
    runAnswer: (skill) => {
      store.set({ view: 'chat' });
      return chat.runSkill(skill);
    },
    onAgentState: (payload) => {
      store.set({ view: 'agent' });
      agentView?.onAgentState(payload);
    }
  });
  mountLangToggle(/** @type {HTMLElement} */ (document.querySelector('.lang')), { store, request: client.request });

  // Right-click actions: the service worker leaves the request in storage.session, because this
  // panel may only just be opening (architecture §6.3). Checked at boot and on every change (EC-CTX-02).
  const pending = createPendingWatcher({
    area: chrome.storage.session,
    windowId: client.windowId,
    onRequest: (req) => {
      store.set({ view: 'chat' });
      chat.runQuickAction(req);
    }
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'session' && changes[PENDING_KEY]?.newValue) pending.check().catch(() => {});
  });
  pending.check().catch(() => {});
}

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Sahayak] unhandled rejection in panel', event.reason);
});

boot();
