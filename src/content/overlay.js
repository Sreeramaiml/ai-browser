// @ts-check
// Number badges and highlight rings on the page (classic script, architecture §11.5).
// Everything lives in one closed shadow root on a fixed, click-through host, so page CSS can't
// restyle it and it can't intercept the user's clicks (EC-SCN-21).

(() => {
  const ns = /** @type {any} */ (globalThis).__sahayak;
  if (ns.overlay) return;

  const HOST_ID = 'sahayak-overlay';
  /** Badges switch themselves off if nobody touches them for this long (§11.5). */
  const IDLE_MS = 10 * 60_000;
  const STYLES = new Set(['find', 'pending', 'dry-run', 'blocked']);

  const CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; }
    .badge {
      position: absolute; transform: translate(-6px, -6px);
      padding: 1px 5px; border: 1px solid #fff; border-radius: 999px;
      background: #4f46e5; color: #fff; box-shadow: 0 1px 3px rgb(0 0 0 / 0.35);
      font: 600 11px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; white-space: nowrap;
    }
    .badge.consequential { background: #b45309; }
    .badge.protected { background: #52525b; }
    .ring { position: absolute; border-radius: 6px; box-sizing: border-box; }
    .ring.find { border: 3px solid #2563eb; animation: pulse 1.2s ease-in-out infinite; }
    .ring.pending { border: 3px solid #f59e0b; }
    .ring.dry-run { border: 3px dashed #7c3aed; }
    .ring.blocked { border: 3px solid #dc2626; }
    .ring.blocked::after {
      content: "🔒"; position: absolute; top: -12px; right: -12px; font-size: 14px;
      background: #dc2626; border-radius: 999px; padding: 2px 4px;
    }
    @keyframes pulse { 50% { box-shadow: 0 0 0 6px rgb(37 99 235 / 0.25); } }
    @media (prefers-reduced-motion: reduce) { .ring.find { animation: none; } }
  `;

  /** @type {HTMLDivElement|null} */
  let host = null;
  /** @type {HTMLDivElement|null} */
  let layer = null;
  let showing = false;
  /** @type {{ el: Element, style: string } | null} */
  let highlight = null;
  let frame = 0;
  let idleTimer = 0;
  let listening = false;

  function ensureHost() {
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.setAttribute('style', 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;');
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = CSS;
      layer = document.createElement('div');
      layer.className = 'layer';
      shadow.append(style, layer);
    }
    // On <html>, not <body>, so frameworks that rebuild the body don't take it with them (EC-SCN-22).
    if (!host.isConnected) document.documentElement.append(host);
  }

  /** @param {DOMRect} r */
  const offScreen = (r) => (r.width === 0 && r.height === 0) || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth;
  /** @param {DOMRect} r */
  const fullyInView = (r) => r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;

  function render() {
    frame = 0;
    if (!layer) return;
    const nodes = [];
    if (showing) {
      const kinds = ns.overlay.kinds;
      for (const [id, el] of ns.scanner.elements()) {
        const r = el.getBoundingClientRect();
        if (offScreen(r)) continue;
        const badge = document.createElement('div');
        const kind = kinds.get(id);
        badge.className = kind ? `badge ${kind}` : 'badge';
        badge.textContent = kind === 'protected' ? `🔒${id}` : String(id);
        badge.style.left = `${Math.max(0, r.left)}px`;
        badge.style.top = `${Math.max(0, r.top)}px`;
        nodes.push(badge);
      }
    }
    if (highlight?.el.isConnected) {
      const r = highlight.el.getBoundingClientRect();
      const ring = document.createElement('div');
      ring.className = `ring ${highlight.style}`;
      ring.style.left = `${r.left - 4}px`;
      ring.style.top = `${r.top - 4}px`;
      ring.style.width = `${r.width + 8}px`;
      ring.style.height = `${r.height + 8}px`;
      nodes.push(ring);
    }
    layer.replaceChildren(...nodes);
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  /** Re-attach the host if the page removes it while we're showing something (EC-SCN-22). */
  const keeper = new MutationObserver(() => {
    if ((showing || highlight) && host && !host.isConnected) document.documentElement.append(host);
  });

  function listen(on) {
    if (on === listening) return;
    listening = on;
    const method = on ? 'addEventListener' : 'removeEventListener';
    // Capture on document catches inner scroll containers too (EC-SCN-19).
    document[method]('scroll', schedule, { capture: true, passive: true });
    window[method]('resize', schedule, { passive: true });
    if (on) keeper.observe(document.documentElement, { childList: true });
    else keeper.disconnect();
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(hide, IDLE_MS);
  }

  function hide() {
    showing = false;
    highlight = null;
    listen(false);
    clearTimeout(idleTimer);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    host?.remove();
    ns.scanner.clearMarks(); // EC-SCN-23
    return { ok: true };
  }

  ns.overlay = {
    /** Badge colour per element id: 'protected' | 'consequential'. */
    kinds: new Map(),

    /** Number every element of the current snapshot, scanning first if there is none or it's stale. */
    show() {
      if (!ns.scanner.snapshotId() || ns.scanner.isDirty()) {
        const result = ns.scanner.scan();
        ns.overlay.setKinds(result.elements);
      }
      showing = true;
      ensureHost();
      listen(true);
      schedule();
      resetIdle();
      return { ok: true, count: ns.scanner.elements().length };
    },

    /** @param {Array<{ id: number, protected?: string|null, consequential?: boolean }>} elements */
    setKinds(elements) {
      ns.overlay.kinds = new Map(elements
        .filter((d) => d.protected || d.consequential)
        .map((d) => [d.id, d.protected ? 'protected' : 'consequential']));
      if (showing) schedule();
    },

    hide,

    /**
     * Ring one element: find (blue, pulsing), pending (amber), dry-run (dashed purple), blocked (red, lock).
     * @param {{ snapshotId: string, elementId: number, fingerprint?: string, style?: string|null }} payload
     *   style null clears it; fingerprint re-finds the element after a newer scan ("Show again")
     */
    highlight({ snapshotId, elementId, fingerprint, style }) {
      if (!style) {
        highlight = null;
        if (!showing) listen(false);
        schedule();
        return { ok: true };
      }
      if (!STYLES.has(style)) return { ok: false, reason: 'BAD_STYLE' };
      const el = ns.scanner.resolve(snapshotId, elementId) ??
        (typeof fingerprint === 'string' ? ns.scanner.findByFingerprint(fingerprint) : null);
      if (!el) return { ok: false, reason: 'STALE_TARGET' };
      highlight = { el, style };
      if (!fullyInView(el.getBoundingClientRect())) {
        const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
      }
      ensureHost();
      listen(true);
      schedule();
      resetIdle();
      return { ok: true };
    }
  };

  ns.handlers.CS_SHOW_BADGES = () => ns.overlay.show();
  ns.handlers.CS_HIDE_BADGES = () => ns.overlay.hide();
  ns.handlers.CS_HIGHLIGHT = (payload) => ns.overlay.highlight(payload ?? {});

  // Every fresh scan refreshes badge colours.
  const scan = ns.handlers.CS_SCAN;
  ns.handlers.CS_SCAN = () => {
    const result = scan();
    ns.overlay.setKinds(result.elements);
    if (showing) schedule();
    return result;
  };
})();
