// @ts-check
// Service worker entry: wires listeners only, no feature logic.
// All listeners are registered synchronously at top level (architecture §5.2).

import { ToPanel, makeMessage } from '../shared/messages.js';
import { initAgent } from './agent/agent-controller.js';
import { initCapture } from './capture.js';
import { initCommands } from './commands.js';
import { initContextMenus } from './context-menus.js';
import { initFind } from './find.js';
import { initPageChat } from './page-chat.js';
import { chromePageGuard } from './page-guard.js';
import { initPageScan } from './page-scan.js';
import { initProfileService } from './profile-service.js';
import { initQuickActions } from './quick-actions.js';
import { initRouter, onPanelConnected, sendToWindow } from './router.js';
import { initSafetyService } from './safety-service.js';
import { initSettingsService } from './settings-service.js';
import { initSkillRunner } from './skill-runner.js';
import { initSkillsService } from './skills-service.js';
import { initCancel } from './streaming.js';
import { initSummaries } from './summaries.js';
import { getActiveTabInfo, toActiveTabInfo, watchActiveTabs } from './tab-context.js';
import { initVision } from './vision.js';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[Sahayak] setPanelBehavior failed', err));

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[Sahayak] installed', { reason: details.reason, version: chrome.runtime.getManifest().version });
});

const pageGuard = chromePageGuard();

initRouter();
initSettingsService();
initSafetyService();
initCancel();
initContextMenus();
initQuickActions();
initSummaries();
initPageChat();
initCapture();
initVision();
initPageScan();
initFind();
const agent = initAgent();
initCommands({ stopAgent: () => agent.stop('Stopped with Alt+Shift+X.') });
initProfileService({ stopAgent: () => agent.stop('Stopped: you cleared your data.') });
initSkillsService();
initSkillRunner({ startAgent: (payload, ctx) => agent.start(payload, ctx) });

/** @param {number} windowId */
async function pushActiveTab(windowId) {
  let info;
  try {
    info = await getActiveTabInfo(windowId);
  } catch (err) {
    // The window may have closed between the event and the query. Still answer, so the panel
    // knows the worker is alive and shows the "no page" state (EC-PNL-10).
    console.debug('[Sahayak] active tab lookup failed', windowId, err);
    info = toActiveTabInfo(undefined, windowId);
  }
  sendToWindow(windowId, makeMessage(ToPanel.ACTIVE_TAB, info));
  // Then the safety badge (🟢 / 🟡 / 🔴), which needs a look at the loaded page (architecture §14.2).
  if (info.tabId !== null && !info.access.restricted && info.status === 'complete') {
    const safety = await pageGuard.badge(info.tabId).catch(() => null);
    // Only if that's still the page on show: a newer push must not be overwritten with an old one.
    const current = await getActiveTabInfo(windowId).catch(() => null);
    if (current?.tabId === info.tabId && current.url === info.url) {
      sendToWindow(windowId, makeMessage(ToPanel.ACTIVE_TAB, { ...current, safety }));
    }
  }
}

watchActiveTabs(pushActiveTab);
onPanelConnected(({ windowId, surface }) => {
  if (surface === 'sidepanel') pushActiveTab(windowId);
});

// EC-X-12: never leave a rejected promise unobserved.
self.addEventListener('unhandledrejection', (event) => {
  console.error('[Sahayak] unhandled rejection', event.reason);
});
