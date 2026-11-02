// @ts-check
// Context-menu → side panel handoff through storage.session (architecture §6.3). The panel may be
// closed when the menu is clicked, so the service worker leaves the request here and the panel
// picks it up on boot or when it changes. The area is injected so everything here is unit testable.

export const PENDING_KEY = 'pendingRequest';
/** An older request means the panel never opened for it; drop it (EC-CTX-04). */
export const PENDING_MAX_AGE_MS = 2 * 60_000;

/**
 * @typedef {'explain'|'translate'|'draft'} QuickActionKind
 * @typedef {{
 *   id: string, kind: QuickActionKind, text: string, tabId: number|null, windowId: number|null, frameId: number,
 *   url: string, pageTitle: string, scope: 'selection-only', ts: number
 * }} PendingRequest
 * @typedef {{
 *   get: (key: string) => Promise<Record<string, any>>,
 *   remove: (key: string) => Promise<void>
 * }} PendingArea
 */

export const QUICK_ACTION_KINDS = /** @type {const} */ (['explain', 'translate', 'draft']);

/**
 * Build the request from a context-menu click (pure).
 * @param {{
 *   kind: QuickActionKind,
 *   info: { selectionText?: string, frameId?: number, pageUrl?: string },
 *   tab?: { id?: number, windowId?: number, url?: string, title?: string },
 *   id: string,
 *   now: number
 * }} input
 * @returns {PendingRequest}
 */
export function makePendingRequest({ kind, info, tab, id, now }) {
  return {
    id,
    kind,
    text: info.selectionText ?? '',
    tabId: tab?.id ?? null,
    windowId: tab?.windowId ?? null,
    frameId: info.frameId ?? 0,
    url: info.pageUrl ?? tab?.url ?? '',
    pageTitle: tab?.title ?? '',
    // Quick actions only ever send the selection (plus a little surrounding text), never the page.
    // P4.3 relies on this for the tier-2 acknowledgment.
    scope: 'selection-only',
    ts: now
  };
}

/**
 * What a panel should do with a stored request (pure).
 * @param {unknown} req
 * @param {{ windowId: number, now: number, seen: Set<string> }} ctx
 * @returns {'run'|'drop'|'skip'} skip: it's for another window's panel, so leave it there (EC-X-11)
 */
export function classifyPending(req, { windowId, now, seen }) {
  const r = /** @type {Partial<PendingRequest>|null} */ (typeof req === 'object' ? req : null);
  if (!r || typeof r.id !== 'string' || !QUICK_ACTION_KINDS.includes(/** @type {any} */ (r.kind)) || typeof r.ts !== 'number') {
    return 'drop';
  }
  if (now - r.ts > PENDING_MAX_AGE_MS || r.ts - now > PENDING_MAX_AGE_MS) return 'drop';
  if (typeof r.windowId === 'number' && r.windowId !== windowId) return 'skip';
  if (seen.has(r.id)) return 'drop'; // the same request seen at boot and again via onChanged (EC-CTX-02)
  return 'run';
}

/**
 * Panel side: call check() on boot and whenever pendingRequest changes.
 * @param {{ area: PendingArea, windowId: number, onRequest: (req: PendingRequest) => void, now?: () => number }} deps
 */
export function createPendingWatcher({ area, windowId, onRequest, now = Date.now }) {
  /** Each id runs at most once in this panel (EC-CTX-03). */
  const seen = new Set();

  /** Remove the request only if it's still this one, so a newer click isn't lost. */
  async function removeIf(id) {
    const { [PENDING_KEY]: current } = await area.get(PENDING_KEY);
    if (!current || current.id === id) await area.remove(PENDING_KEY);
  }

  return {
    async check() {
      const { [PENDING_KEY]: req } = await area.get(PENDING_KEY);
      if (req === undefined) return;
      const action = classifyPending(req, { windowId, now: now(), seen });
      if (action === 'skip') return;
      if (action === 'run') {
        seen.add(req.id); // before any await, so a concurrent check can't run it too
        onRequest(req);
      }
      await removeIf(req?.id);
    }
  };
}
