// @ts-check
// Profile memory (architecture §13.1, P4.1): the only writer of `profile`, plus "Clear all my data".
// The profile stays in storage.local; nothing here sends it anywhere but the user's own panels.

import { PENDING_KEY } from '../shared/pending-request.js';
import { CONVERSATIONS_KEY } from '../shared/conversations.js';
import { ToPanel, ToSW, makeMessage } from '../shared/messages.js';
import { StorageError, createStorage, validateProfile } from '../shared/storage.js';
import { broadcast, on } from './router.js';

/** storage.session keys holding page text or chat history, wiped with the rest (EC-SET-14). */
export const SESSION_DATA_KEYS = Object.freeze([CONVERSATIONS_KEY, 'summaryCache', PENDING_KEY]);

/**
 * @typedef {import('../shared/storage.js').Profile} Profile
 * @typedef {{ type: string, payload: any }} Reply
 */

/**
 * @param {{
 *   storage: ReturnType<typeof createStorage>,
 *   session: { remove: (keys: string[]) => Promise<void> },
 *   stopAgent: () => Promise<unknown>
 * }} deps
 */
export function createProfileService({ storage, session, stopAgent }) {
  /** @param {unknown} err @returns {Reply} */
  function storageFailure(err) {
    if (err instanceof StorageError) return { type: ToPanel.ERROR, payload: { code: err.code, message: err.message } };
    throw err;
  }

  return {
    /** @returns {Promise<Reply>} */
    async get() {
      return { type: ToPanel.PROFILE_STATE, payload: { profile: await storage.getProfile() } };
    },

    /**
     * Save the profile form. Valid fields are saved even when others aren't; an invalid field
     * keeps its previous value (EC-PRF-06).
     * @param {{ profile?: unknown }} payload
     * @returns {Promise<Reply>}
     */
    async save(payload) {
      const { value, errors, warnings } = validateProfile(payload?.profile);
      if (errors._) return { type: ToPanel.VALIDATION_ERROR, payload: { errors, warnings } };

      const previous = await storage.getProfile();
      /** @type {Record<string, any>} */
      const next = { ...value };
      for (const field of Object.keys(errors)) {
        const [top, sub] = field.split('.');
        if (sub) {
          const old = previous.links?.[/** @type {'linkedin'|'github'|'portfolio'} */ (sub)];
          if (old) next.links = { ...next.links, [sub]: old };
        } else if (top in previous) {
          next[top] = previous[/** @type {keyof Profile} */ (top)];
        }
      }

      try {
        await storage.set('profile', next);
        // The profile's language seeds the setting once; after that the header toggle decides (EC-PRF-09).
        if (next.preferredLanguage && !previous.preferredLanguage) {
          await storage.updateSettings({ language: next.preferredLanguage });
        }
      } catch (err) {
        return storageFailure(err);
      }
      const profile = await storage.getProfile();
      return Object.keys(errors).length
        ? { type: ToPanel.VALIDATION_ERROR, payload: { errors, warnings, profile } }
        : { type: ToPanel.SAVED, payload: { profile, warnings } };
    },

    /**
     * Delete the profile, skills, agent logs, chat history and keys (EC-SET-14). A running agent
     * task is stopped first, so it can't save itself back.
     * @returns {Promise<Reply>}
     */
    async clearAll() {
      await stopAgent().catch(() => {});
      try {
        await storage.clearUserData();
      } catch (err) {
        return storageFailure(err);
      }
      await session.remove([...SESSION_DATA_KEYS]).catch(() => {});
      return { type: ToPanel.DATA_CLEARED, payload: {} };
    }
  };
}

/**
 * Wire the service into the router. Call synchronously at the worker's top level.
 * @param {{ stopAgent: () => Promise<unknown> }} deps
 */
export function initProfileService({ stopAgent }) {
  const storage = createStorage(chrome.storage.local);
  const service = createProfileService({ storage, session: chrome.storage.session, stopAgent });

  /** @param {(payload: any) => Promise<Reply>} run @returns {import('./router.js').Handler} */
  const reply = (run) => async (payload, { port }, msg) => {
    const r = await run(payload);
    port.postMessage(makeMessage(r.type, r.payload, msg.requestId));
  };

  on(ToSW.PROFILE_GET, reply(() => service.get()));
  on(ToSW.PROFILE_SAVE, reply((p) => service.save(p)));
  on(ToSW.CLEAR_ALL_DATA, reply(() => service.clearAll()));

  // Keep every open panel's form current, whichever window saved or cleared it.
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== 'local' || !('profile' in changes)) return;
    broadcast(makeMessage(ToPanel.PROFILE_STATE, { profile: await storage.getProfile() }));
  });

  return service;
}
