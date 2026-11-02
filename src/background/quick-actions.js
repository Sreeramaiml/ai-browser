// @ts-check
// Quick actions on selected text: Explain this (P1.3), Translate and Draft a reply (P2.2).
// The text comes from the context menu, or from the page's selection (Read tab → Explain).

import { TONES, TRANSLATE_TARGETS } from '../shared/config.js';
import { ToSW } from '../shared/messages.js';
import { isAlreadyInTargetScript, isLanguage } from '../shared/language.js';
import { MEDIUMS, buildDraftPrompt, inferMedium } from '../shared/prompts/draft.js';
import { buildExplainPrompt } from '../shared/prompts/explain.js';
import { buildTranslatePrompt } from '../shared/prompts/translate.js';
import { createStorage } from '../shared/storage.js';
import { FeatureError } from './feature-error.js';
import { createDefaultGateway } from './llm/default-gateway.js';
import { createGateway } from './llm/gateway.js';
import { on } from './router.js';
import { streamInLanguage, streamingHandler } from './streaming.js';
import { chromePageGuard } from './page-guard.js';
import { readSelection } from './tab-context.js';

export { FeatureError };

/**
 * @typedef {{ text: string, contextBefore?: string, contextAfter?: string, truncated?: boolean,
 *   protected?: boolean, pageTitle?: string, url?: string }} Selection
 * @typedef {{ translateTarget: string, tone: string, name: string|null, profileTone?: string|null }} Preferences
 *   name and profileTone come from the profile, and are used only for drafts (architecture §13.1)
 * @typedef {{
 *   kind: string, tabId?: number, frameId?: number, text?: string, url?: string, pageTitle?: string,
 *   language?: string, targetLang?: string, medium?: string, tone?: string,
 *   refine?: 'shorter'|'formal', previousDraft?: string
 * }} QuickActionPayload
 */

const MAX_SELECTION_CHARS = 20_000; // EC-SEL-06
const MAX_DRAFT_CHARS = 8_000;
/** How long to wait for the page's own copy of a right-clicked selection before using Chrome's. */
const PAGE_SELECTION_TIMEOUT_MS = 2_000;

/** @param {string} s */
const squash = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Where a draft will be posted: the panel's choice, or a guess from the page and the text.
 * @param {{ medium?: string }} payload
 * @param {{ url?: string, text: string }} selection
 * @returns {keyof typeof MEDIUMS}
 */
function draftMedium(payload, selection) {
  return typeof payload.medium === 'string' && Object.hasOwn(MEDIUMS, payload.medium)
    ? /** @type {keyof typeof MEDIUMS} */ (payload.medium)
    : inferMedium(selection.url, selection.text);
}
/** @param {unknown} v */
const str = (v) => (typeof v === 'string' ? v : undefined);

/**
 * @param {{
 *   gateway: ReturnType<typeof createGateway>,
 *   getSelection: (tabId: number) => Promise<Selection>,
 *   getLanguage: () => Promise<string>,
 *   getPreferences?: () => Promise<Preferences>,
 *   checkPage?: (tabId: number) => Promise<{ scope: 'page'|'selection-only' }>
 * }} deps checkPage: the page-tier check for selection actions (§14.2); throws PAGE_BLOCKED, or
 *   NEEDS_ACK on a private page the user hasn't acknowledged yet
 */
export function createQuickActions({
  gateway, getSelection, getLanguage,
  getPreferences = async () => ({ translateTarget: 'hi', tone: 'polite', name: null }),
  checkPage = async () => ({ scope: 'page' })
}) {
  /**
   * @param {QuickActionPayload} payload
   * @returns {Promise<Selection>}
   */
  async function resolveSelection(payload) {
    if (typeof payload.text === 'string') {
      const raw = payload.text.trim();
      /** @type {Selection} */
      let selection = {
        text: raw.slice(0, MAX_SELECTION_CHARS), truncated: raw.length > MAX_SELECTION_CHARS,
        url: str(payload.url), pageTitle: str(payload.pageTitle)
      };
      // From the context menu: Chrome's selectionText loses line breaks and may be cut short (EC-CTX-05).
      // If the page's own selection is the same text, use it instead; it also brings the surrounding
      // context. Only the top frame is reachable (EC-SEL-04).
      if (raw && typeof payload.tabId === 'number' && (payload.frameId ?? 0) === 0) {
        let timer;
        const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), PAGE_SELECTION_TIMEOUT_MS); });
        const page = await Promise.race([getSelection(payload.tabId).catch(() => null), timeout]);
        clearTimeout(timer);
        if (page?.protected) throw new FeatureError('PROTECTED_FIELD', 'Pagewise never reads password, OTP or card fields.');
        if (page?.text && squash(page.text).includes(squash(raw))) {
          selection = { ...page, url: page.url ?? selection.url, pageTitle: page.pageTitle ?? selection.pageTitle };
        }
      }
      return selection;
    }
    if (typeof payload.tabId === 'number') return getSelection(payload.tabId);
    throw new FeatureError('NO_SELECTION', 'Select some text on the page first.');
  }

  return {
    /**
     * @param {QuickActionPayload} payload
     * @param {import('./streaming.js').StreamIO} io
     */
    async run(payload, io) {
      const kind = payload?.kind;
      if (kind !== 'explain' && kind !== 'translate' && kind !== 'draft') {
        throw new FeatureError('UNKNOWN_ACTION', 'That action isn’t available yet.');
      }

      // Before anything is read from the page: is it banking, private, or blocked? (§14.2)
      const access = typeof payload.tabId === 'number' ? await checkPage(payload.tabId) : { scope: 'page' };
      const found = await resolveSelection(payload);
      if (found.protected) throw new FeatureError('PROTECTED_FIELD', 'Pagewise never reads password, OTP or card fields.');
      if (!found.text) throw new FeatureError('NO_SELECTION', 'Select some text on the page first.');
      // On a private page only the selected words go out: no surrounding text, title or address (EC-TIR-09).
      const privatePage = access.scope === 'selection-only';
      const medium = kind === 'draft' ? draftMedium(payload, found) : undefined;
      /** @type {Selection} */
      const selection = privatePage ? { text: found.text, truncated: found.truncated } : found;

      const start = {
        kind,
        excerpt: selection.text.length > 140 ? `${selection.text.slice(0, 140)}…` : selection.text,
        // What the panel sends back for Re-translate, Shorter, etc. Never more than the selection.
        source: { text: selection.text, url: selection.url ?? '', pageTitle: selection.pageTitle ?? '' },
        scope: 'selection-only',
        privatePage
      };
      const language = isLanguage(payload.language) ? payload.language : await getLanguage();
      const { signal, onDelta } = io;

      if (kind === 'explain') {
        io.onStart(start);
        const { system, turns } = buildExplainPrompt({ ...selection, language });
        return streamInLanguage(gateway, { task: 'explain', system, turns }, language, io);
      }

      const prefs = await getPreferences();

      if (kind === 'translate') {
        // A target picked in the panel is always honoured; the saved default is checked first (EC-CTX-10).
        const explicit = typeof payload.targetLang === 'string' && Object.hasOwn(TRANSLATE_TARGETS, payload.targetLang);
        const targetLang = explicit
          ? payload.targetLang
          : Object.hasOwn(TRANSLATE_TARGETS, prefs.translateTarget) ? prefs.translateTarget : 'hi';
        if (!explicit && isAlreadyInTargetScript(selection.text, targetLang)) {
          throw new FeatureError('ALREADY_IN_TARGET', `This text already looks like ${TRANSLATE_TARGETS[targetLang]}.`, {
            suggestTarget: 'en', source: start.source
          });
        }
        io.onStart({ ...start, targetLang });
        const { system, turns } = buildTranslatePrompt({ ...selection, targetLang });
        return gateway.stream({ task: 'translate', system, turns, signal, onDelta, onReset: io.onReset });
      }

      // Draft a reply. The medium was worked out from the page's address before it was dropped.
      /** @param {unknown} t */
      const toneOf = (t) => (typeof t === 'string' && Object.hasOwn(TONES, t) ? /** @type {keyof typeof TONES} */ (t) : null);
      // A tone picked in the panel wins, then the profile's, then the Settings default.
      const profileTone = toneOf(payload.tone) ? null : toneOf(prefs.profileTone);
      const tone = toneOf(payload.tone) ?? profileTone ?? toneOf(prefs.tone) ?? 'polite';
      const refine = payload.refine === 'shorter' || payload.refine === 'formal' ? payload.refine : undefined;
      const previousDraft = typeof payload.previousDraft === 'string' ? payload.previousDraft.slice(0, MAX_DRAFT_CHARS) : undefined;
      // The only place profile values reach the model; the panel shows a "Profile used" chip.
      const profileUsed = (medium === 'email' && Boolean(prefs.name)) || profileTone !== null;
      io.onStart({ ...start, medium, tone, refine, profileUsed });
      const { system, turns } = buildDraftPrompt({
        ...selection, medium: /** @type {keyof typeof MEDIUMS} */ (medium), tone, name: prefs.name, language, refine, previousDraft
      });
      return streamInLanguage(gateway, { task: 'draft', system, turns }, language, io);
    }
  };
}

/** Wire quick actions into the router. Call synchronously at the worker's top level. */
export function initQuickActions() {
  const storage = createStorage(chrome.storage.local);
  const guard = chromePageGuard();
  const gateway = createDefaultGateway();

  const actions = createQuickActions({
    gateway,
    getLanguage: async () => (await storage.getSettings()).language,
    async getPreferences() {
      const [settings, profile] = await Promise.all([storage.getSettings(), storage.getProfile()]);
      const name = (profile.name ?? '').slice(0, 80);
      return { translateTarget: settings.translateTarget, tone: settings.tone, name: name || null, profileTone: profile.preferredTone ?? null };
    },
    getSelection: readSelection,
    checkPage: (tabId) => guard.assert(tabId, 'selection')
  });

  on(ToSW.QUICK_ACTION, streamingHandler(async (payload, io) => {
    const { text, model, provider, stopReason } = await actions.run(payload, io);
    return { text, model, provider, stopReason };
  }));
}
