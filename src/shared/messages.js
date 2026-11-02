// @ts-check
// Message type constants for every channel (architecture §6). Defined up front so later slices don't rename.

/**
 * @typedef {{ type: string, requestId?: string, payload?: any }} Message
 */

export const PORT_NAME = 'panel';

/** Side panel → service worker (over the `panel` port). */
export const ToSW = Object.freeze({
  PANEL_HELLO: 'PANEL_HELLO', // { windowId, surface: 'sidepanel'|'options' } — sent on every (re)connect
  PING: 'PING', // heartbeat every 20 s: incoming port traffic keeps the service worker alive mid-stream
  SUMMARIZE_PAGE: 'SUMMARIZE_PAGE', // { tabId, force? } — force skips the summary cache
  SUMMARIZE_YOUTUBE: 'SUMMARIZE_YOUTUBE', // { url?, tabId?, force? } — a pasted link, or the video open in tabId
  YT_SEEK: 'YT_SEEK', // { tabId, videoId, seconds } → { ok } — jump the open video to a chapter
  CHAT_SEND: 'CHAT_SEND', // { tabId, text, conversationId?, language? } → CHAT_START, CHAT_DELTA*, CHAT_DONE | ERROR
  // { kind: 'explain'|'translate'|'draft', text? | tabId?, frameId?, url?, pageTitle?, targetLang?, medium?, tone?,
  //   refine?: 'shorter'|'formal', previousDraft? } → CHAT_START, CHAT_DELTA*, CHAT_DONE | ERROR
  QUICK_ACTION: 'QUICK_ACTION',
  CAPTURE_SCREEN: 'CAPTURE_SCREEN', // {} → CAPTURE_RESULT | ERROR — the active tab of the panel's window
  ASK_SCREENSHOT: 'ASK_SCREENSHOT', // { imageDataUrl, question?, language?, escalate? } → CHAT_START, CHAT_DELTA*, CHAT_DONE | ERROR
  FIND_ELEMENT: 'FIND_ELEMENT', // { tabId, query, language? } → FIND_RESULT | ERROR — point at one element, never act
  FIND_SHOW_AGAIN: 'FIND_SHOW_AGAIN', // { tabId, snapshotId, elementId, fingerprint? } → FIND_SHOWN
  SCAN_PAGE: 'SCAN_PAGE', // { tabId, badges? } → SCAN_RESULT | ERROR — number the page's elements (Agent tab)
  SET_BADGES: 'SET_BADGES', // { tabId, show } → BADGES_STATE | ERROR
  AGENT_START: 'AGENT_START', // { tabId, goal, options?: { maxSteps?, dryRun?, useProfile? } } → AGENT_STATE | ERROR
  // { taskId?, stepId, decision: 'approve'|'skip'|'stop'|'cancel'|'retry'|'resume', confirmConsequential?, hint? } → AGENT_STATE
  AGENT_DECISION: 'AGENT_DECISION',
  AGENT_GET_STATE: 'AGENT_GET_STATE', // { taskId? } → AGENT_STATE (the active task if no id)
  AGENT_LIST: 'AGENT_LIST', // {} → AGENT_LIST_RESULT — saved tasks for Settings → Logs
  // { skillId, tabId?, language? } → answer skill: CHAT_START { kind: 'skill', … }, CHAT_DELTA*, CHAT_DONE | ERROR;
  //   agent skill: AGENT_STATE | ERROR
  RUN_SKILL: 'RUN_SKILL',
  SETTINGS_SAVE: 'SETTINGS_SAVE', // { settings?: Partial<Settings>, secrets?: { gemini?: string|null, groq?: string|null } }
  TEST_KEY: 'TEST_KEY', // { provider: 'gemini'|'groq', key?: string } — tests the typed key, or the saved one
  PROFILE_GET: 'PROFILE_GET', // {} → PROFILE_STATE
  // { profile } → SAVED { profile, warnings } | VALIDATION_ERROR { errors, warnings, profile? } (valid fields are still saved)
  PROFILE_SAVE: 'PROFILE_SAVE',
  CLEAR_ALL_DATA: 'CLEAR_ALL_DATA', // {} → DATA_CLEARED | ERROR — profile, skills, logs, chats and keys
  SKILLS_GET: 'SKILLS_GET', // {} → SKILLS_STATE
  SKILLS_SAVE: 'SKILLS_SAVE', // { skill } (no id = new) → SAVED { skill, skills, warnings } | VALIDATION_ERROR { errors }
  SKILLS_DELETE: 'SKILLS_DELETE', // { skillId } → SKILLS_STATE
  // { items: Array<{ skill, choice: 'add'|'replace'|'keep-both'|'skip' }> } → SAVED { skills, added, replaced, skipped }
  SKILLS_IMPORT: 'SKILLS_IMPORT',
  SAFETY_GET: 'SAFETY_GET', // {} → SAFETY_STATE
  // { list: 'userBlockedDomains'|'ownedDomains'|'sensitiveAckDomains', action: 'add'|'remove', domain, confirmOwned? }
  //   → SAFETY_STATE | VALIDATION_ERROR { errors: { domain } }
  SAFETY_UPDATE: 'SAFETY_UPDATE',
  SAFETY_ACK: 'SAFETY_ACK', // { domain } → SAFETY_STATE — "only my selection" on a private page (EC-TIR-09)
  CANCEL: 'CANCEL'
});

/** Service worker → side panel. */
export const ToPanel = Object.freeze({
  ACTIVE_TAB: 'ACTIVE_TAB', // ActiveTabInfo (see background/tab-context.js)
  SETTINGS_STATE: 'SETTINGS_STATE', // SettingsState: settings + masked key status, pushed on connect and on change
  KEY_TEST_RESULT: 'KEY_TEST_RESULT', // KeyCheckResult
  SUMMARY_RESULT: 'SUMMARY_RESULT', // SummaryResult (see background/summaries.js)
  YT_SEEK_RESULT: 'YT_SEEK_RESULT', // { ok, reason? }
  // quick action: { kind, excerpt, source: { text, url, pageTitle }, scope, targetLang?, medium?, tone?, profileUsed? };
  // page chat: { conversationKey, contentChanged }
  CHAT_START: 'CHAT_START',
  CHAT_RESET: 'CHAT_RESET', // {} — discard the text streamed so far; a retry follows
  CHAT_DELTA: 'CHAT_DELTA', // { text } — next piece of streamed answer
  CHAT_DONE: 'CHAT_DONE', // { text, model, provider, stopReason }; page chat adds { notFound, truncated, unverifiedQuotes, conversationKey }
  CAPTURE_RESULT: 'CAPTURE_RESULT', // { dataUrl (PNG), tabId, title, url }
  // { query, elementId|null, reason, confidence, snapshotId, fingerprint, name, role, protected, highlighted,
  //   escalated, model, provider, language, message|null } — message is the "couldn't find" copy when elementId is null
  FIND_RESULT: 'FIND_RESULT',
  FIND_SHOWN: 'FIND_SHOWN', // { ok, reason? } — reason 'STALE_TARGET' when the element is gone
  SCAN_RESULT: 'SCAN_RESULT', // { snapshotId, count, protectedCount, map, tokens, truncated, badges }
  BADGES_STATE: 'BADGES_STATE', // { tabId, shown }
  AGENT_STATE: 'AGENT_STATE', // { task: AgentTask|null } — the full task, as a reply and pushed on every change
  AGENT_LIST_RESULT: 'AGENT_LIST_RESULT', // { tasks: Array<{ taskId, goal, status, url, stepCount, steps, createdAt, updatedAt }> }
  PROFILE_STATE: 'PROFILE_STATE', // { profile } — as a reply, and pushed to every panel when it changes
  DATA_CLEARED: 'DATA_CLEARED', // {}
  SKILLS_STATE: 'SKILLS_STATE', // { skills } — as a reply, and pushed to every panel when they change
  SAFETY_STATE: 'SAFETY_STATE', // { safety } — as a reply, and pushed to every panel when it changes
  SAVED: 'SAVED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BUILTIN_SUMMARIZE: 'BUILTIN_SUMMARIZE', // SW asks the panel to run Chrome's on-device Summarizer (P1.7)
  ERROR: 'ERROR'
});

/** Service worker → content script (chrome.tabs.sendMessage). */
export const ToContent = Object.freeze({
  CS_EXTRACT_ARTICLE: 'CS_EXTRACT_ARTICLE',
  CS_EXTRACT_VISIBLE: 'CS_EXTRACT_VISIBLE',
  CS_GET_SELECTION: 'CS_GET_SELECTION',
  CS_PAGE_SIGNALS: 'CS_PAGE_SIGNALS',
  CS_SCAN: 'CS_SCAN',
  CS_SHOW_BADGES: 'CS_SHOW_BADGES',
  CS_HIDE_BADGES: 'CS_HIDE_BADGES',
  CS_HIGHLIGHT: 'CS_HIGHLIGHT',
  CS_EXECUTE: 'CS_EXECUTE',
  CS_YT_SEEK: 'CS_YT_SEEK',
  CS_YT_INFO: 'CS_YT_INFO'
});

/**
 * @param {string} type
 * @param {any} [payload]
 * @param {string} [requestId]
 * @returns {Message}
 */
export function makeMessage(type, payload, requestId) {
  /** @type {Message} */
  const msg = { type };
  if (payload !== undefined) msg.payload = payload;
  if (requestId !== undefined) msg.requestId = requestId;
  return msg;
}

/**
 * @param {unknown} value
 * @returns {value is Message}
 */
export function isMessage(value) {
  return typeof value === 'object' && value !== null && typeof (/** @type {any} */ (value).type) === 'string';
}
