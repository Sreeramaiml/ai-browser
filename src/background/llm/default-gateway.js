// @ts-check
// The gateway every feature uses in the service worker: keys and models from storage, the shared
// rate limiter, and the dev-only fault switch.

import { DEV_FAULT_KEY, LLM_MIN_GAP_MS } from '../../shared/config.js';
import { createStorage, resolveModels } from '../../shared/storage.js';
import { createGateway } from './gateway.js';
import { sharedLimiter } from './rate-limiter.js';

const FAULTS = new Set(['429', '500', 'timeout', 'daily']);

/** @type {Promise<boolean>|null} */
let devInstall = null;
/** Only an unpacked (developer) install honours fault injection, never a release (EC-RTL-15). */
function isDevInstall() {
  devInstall ??= chrome.management.getSelf().then((self) => self.installType === 'development', () => false);
  return devInstall;
}

/**
 * Read and clear the armed fault, so it applies to exactly one request.
 * @returns {Promise<import('./gateway.js').Fault|null>}
 */
async function takeFault() {
  if (!(await isDevInstall())) return null;
  const { [DEV_FAULT_KEY]: fault } = await chrome.storage.session.get(DEV_FAULT_KEY);
  if (fault === undefined) return null;
  await chrome.storage.session.remove(DEV_FAULT_KEY);
  return FAULTS.has(fault) ? fault : null;
}

export function createDefaultGateway() {
  const storage = createStorage(chrome.storage.local);
  return createGateway({
    getApiKey: async () => (await storage.getSecrets()).geminiKey,
    getGroqKey: async () => {
      const [settings, secrets] = await Promise.all([storage.getSettings(), storage.getSecrets()]);
      return settings.groqEnabled ? secrets.groqKey : undefined;
    },
    getModels: async () => resolveModels(await storage.getSettings()),
    getRedaction: async () => ({ contacts: (await storage.getSettings()).redactContacts }),
    limiter: sharedLimiter(LLM_MIN_GAP_MS),
    takeFault
  });
}
