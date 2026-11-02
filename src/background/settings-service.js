// @ts-check
// Settings and API keys: the only writer of `settings` and `secrets` (architecture §5.4, §15.1).
// The panel only ever receives masked key status, never a raw key.

import { GEMINI_MODEL_KEYS } from '../shared/config.js';
import { ToPanel, ToSW, makeMessage } from '../shared/messages.js';
import {
  SECRET_FIELDS, StorageError, createStorage, resolveModels, secretsStatus, validateKeyInput, validateSettingsPatch
} from '../shared/storage.js';
import { checkGeminiKey } from './llm/key-check.js';
import { checkGroqKey } from './llm/providers/groq.js';
import { broadcast, on, onPanelConnected } from './router.js';

/**
 * @typedef {{
 *   settings: import('../shared/storage.js').Settings,
 *   secrets: Record<import('../shared/storage.js').KeyProvider, import('../shared/storage.js').SecretStatus>,
 *   readOnly: boolean
 * }} SettingsState
 * @typedef {{ type: string, payload: any }} Reply
 */

/**
 * @param {{
 *   storage: ReturnType<typeof createStorage>,
 *   checkKey: (key: string, opts: { requiredModels: string[] }) => Promise<import('./llm/key-check.js').KeyCheckResult>,
 *   checkGroq?: (key: string, opts: { model: string }) => Promise<import('./llm/key-check.js').KeyCheckResult>
 * }} deps checkKey tests a Gemini key, checkGroq a Groq key
 */
export function createSettingsService({ storage, checkKey, checkGroq = async () => ({ ok: false, code: 'PROVIDER_DOWN', message: 'Groq keys can’t be tested here.' }) }) {
  /** @returns {Promise<SettingsState>} */
  async function buildState() {
    const [settings, secrets, readOnly] = await Promise.all([
      storage.getSettings(), storage.getSecrets(), storage.isReadOnly()
    ]);
    return { settings, secrets: secretsStatus(secrets), readOnly };
  }

  /** @param {unknown} err @returns {Reply} */
  function storageFailure(err) {
    if (err instanceof StorageError) return { type: ToPanel.ERROR, payload: { code: err.code, message: err.message } };
    throw err;
  }

  return {
    buildState,

    /**
     * @param {{ settings?: unknown, secrets?: { gemini?: string|null, groq?: string|null } }} payload
     * @returns {Promise<Reply>}
     */
    async save(payload) {
      /** @type {Record<string, string>} */
      const errors = {};
      let settingsPatch = null;
      /** @type {Array<[import('../shared/storage.js').KeyProvider, string|null]>} */
      const secretUpdates = [];

      if (payload?.settings !== undefined) {
        const { value, errors: e } = validateSettingsPatch(payload.settings);
        Object.assign(errors, e);
        settingsPatch = value;
      }
      for (const provider of /** @type {const} */ (['gemini', 'groq'])) {
        const raw = payload?.secrets?.[provider];
        if (raw === undefined) continue;
        if (raw === null) {
          secretUpdates.push([provider, null]);
          continue;
        }
        const checked = validateKeyInput(provider, raw);
        if (checked.ok) secretUpdates.push([provider, checked.key]);
        else errors[`${provider}Key`] = checked.error;
      }

      // All-or-nothing: don't half-apply a save that has an invalid field.
      if (Object.keys(errors).length) return { type: ToPanel.VALIDATION_ERROR, payload: { errors } };

      // Saving a Groq key turns the backup on; removing it turns it off. An explicit choice in the
      // same save wins.
      const groqUpdate = secretUpdates.find(([provider]) => provider === 'groq');
      if (groqUpdate && !(settingsPatch && 'groqEnabled' in settingsPatch)) {
        settingsPatch = { ...(settingsPatch ?? {}), groqEnabled: groqUpdate[1] !== null };
      }

      try {
        if (settingsPatch && Object.keys(settingsPatch).length) await storage.updateSettings(settingsPatch);
        for (const [provider, key] of secretUpdates) await storage.setSecret(provider, key);
      } catch (err) {
        return storageFailure(err);
      }
      return { type: ToPanel.SAVED, payload: { state: await buildState() } };
    },

    /**
     * Test the key the user just typed, or the saved one if `key` is absent.
     * @param {{ provider?: string, key?: string }} payload
     * @returns {Promise<Reply>}
     */
    async testKey(payload) {
      const provider = payload?.provider ?? 'gemini';
      if (provider !== 'gemini' && provider !== 'groq') {
        return { type: ToPanel.KEY_TEST_RESULT, payload: { ok: false, code: 'UNSUPPORTED', message: 'Unknown key type.' } };
      }
      let key;
      if (typeof payload?.key === 'string' && payload.key.trim()) {
        const checked = validateKeyInput(provider, payload.key);
        if (!checked.ok) return { type: ToPanel.KEY_TEST_RESULT, payload: { ok: false, code: 'INVALID_INPUT', message: checked.error } };
        key = checked.key;
      } else {
        key = (await storage.getSecrets())[SECRET_FIELDS[provider]];
      }
      if (!key) {
        return { type: ToPanel.KEY_TEST_RESULT, payload: { ok: false, code: 'NO_API_KEY', message: 'Enter or save a key first.' } };
      }
      const models = resolveModels(await storage.getSettings());
      const result = provider === 'groq'
        ? await checkGroq(key, { model: models.groq })
        : await checkKey(key, { requiredModels: GEMINI_MODEL_KEYS.map((k) => models[k]) });
      return { type: ToPanel.KEY_TEST_RESULT, payload: result };
    }
  };
}

/** Wire the service into the router and storage events. Call synchronously at the worker's top level. */
export function initSettingsService() {
  const storage = createStorage(chrome.storage.local);
  const service = createSettingsService({
    storage,
    checkKey: (key, opts) => checkGeminiKey(key, opts),
    checkGroq: (key, opts) => checkGroqKey(key, opts)
  });

  chrome.runtime.onInstalled.addListener(async () => {
    try {
      const result = await storage.migrate();
      if (result.status === 'newer') console.warn('[Sahayak] stored data is from a newer version; settings are read-only');
      else if (result.status === 'migrated') console.log('[Sahayak] storage migrated', result.from, '→', result.to);
    } catch (err) {
      console.error('[Sahayak] storage migration failed', err);
    }
  });

  on(ToSW.SETTINGS_SAVE, async (payload, { port }, msg) => {
    const reply = await service.save(payload);
    port.postMessage(makeMessage(reply.type, reply.payload, msg.requestId));
  });

  on(ToSW.TEST_KEY, async (payload, { port }, msg) => {
    const reply = await service.testKey(payload);
    port.postMessage(makeMessage(reply.type, reply.payload, msg.requestId));
  });

  // Every panel gets current settings when it (re)connects…
  onPanelConnected(async ({ port }) => {
    try {
      port.postMessage(makeMessage(ToPanel.SETTINGS_STATE, await service.buildState()));
    } catch { /* port closed */ }
  });

  // …and whenever they change, from any window (EC-SET-08).
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== 'local' || !('settings' in changes || 'secrets' in changes || 'schemaVersion' in changes)) return;
    broadcast(makeMessage(ToPanel.SETTINGS_STATE, await service.buildState()));
  });

  return service;
}
