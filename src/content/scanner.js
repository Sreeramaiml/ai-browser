// @ts-check
// Interactive element scanner (classic script, architecture §11). Finds what can be clicked or
// typed into, numbers it in DOM order, and describes it for the action map. The DOM is never sent
// anywhere; only these descriptors are. Safety flags come from the shared rules
// (src/content/generated/*.classic.js), which are injected before this file.

(() => {
  const ns = /** @type {any} */ (globalThis).__sahayak;
  if (ns.scanner) return; // already injected: keep the existing snapshot and observer

  const SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select',
    '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]',
    '[role=menuitem]', '[role=combobox]', '[role=switch]', '[role=option]',
    '[contenteditable=""]', '[contenteditable=true]', 'summary', '[tabindex]:not([tabindex="-1"])'
  ].join(',');
  /** Actionable elements that swallow actionable children: keep the outermost (EC-SCN-03). */
  const WRAPPERS = 'a[href], button, [role=button], [role=link], [role=menuitem], [role=tab], [role=option], summary';
  const MODALS = 'dialog[open], [role=dialog][aria-modal=true], [role=alertdialog][aria-modal=true]';
  /** Hard cap on what one scan returns; the action map shows fewer (ACTION_MAP_MAX_ELEMENTS). */
  const MAX_ELEMENTS = 1000;
  const NAME_MAX = 80;
  const VALUE_MAX = 100;
  const OPTIONS_MAX = 20;
  const BUTTON_TYPES = new Set(['submit', 'button', 'reset', 'image']);
  const MASK = '••••';
  const OTP_PAGE_RE = /\b(otp|one[\s-]?time\s*(pass)?code|verification\s*code|verify\s*your\s*(phone|mobile|number|email))\b|ओटीपी/i;

  /** @param {unknown} s */
  const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  /** @param {string} s @param {number} n */
  const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  /** FNV-1a, for fingerprints. @param {string} text */
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  /** Parent across shadow-root boundaries. @param {Node} node @returns {Element|null} */
  function parentOf(node) {
    if (node.parentElement) return node.parentElement;
    const root = node.parentNode;
    return root && root.nodeType === 11 ? /** @type {ShadowRoot} */ (root).host ?? null : null;
  }

  /** @param {Element} container @param {Element} el */
  function deepContains(container, el) {
    for (let n = /** @type {Element|null} */ (el); n; n = parentOf(n)) if (n === container) return true;
    return false;
  }

  /** Candidates in DOM order, including inside open shadow roots (closed ones are unreachable, EC-SCN-15). */
  function collect(root, out) {
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(SELECTOR)) out.push(el);
      if (el.shadowRoot) collect(el.shadowRoot, out);
    }
    return out;
  }

  /**
   * Hidden by attribute or style, here or on an ancestor. Memoised per scan.
   * @param {Element|null} node
   * @param {Map<Element, boolean>} cache
   * @returns {boolean}
   */
  function isHidden(node, cache) {
    if (!node || node.nodeType !== 1) return false;
    const known = cache.get(node);
    if (known !== undefined) return known;
    let hidden = node.hasAttribute('hidden') || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true';
    if (!hidden) {
      const style = getComputedStyle(node);
      hidden = style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0';
    }
    if (!hidden) hidden = isHidden(parentOf(node), cache);
    cache.set(node, hidden);
    return hidden;
  }

  /** @param {Element} el */
  function tagOf(el) {
    return el.tagName.toLowerCase();
  }

  /** The type attribute as authored (a <button> defaults to submit). @param {Element} el */
  function typeOf(el) {
    const tag = tagOf(el);
    if (tag === 'input') return (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'button') return (el.getAttribute('type') || 'submit').toLowerCase();
    return '';
  }

  /** @param {Element} el */
  function isEditable(el) {
    const ce = el.getAttribute('contenteditable');
    return ce === '' || ce === 'true';
  }

  /** @param {Element} el */
  function isTextLike(el) {
    const tag = tagOf(el);
    if (tag === 'textarea' || isEditable(el)) return true;
    if (tag !== 'input') return false;
    const type = typeOf(el);
    return !BUTTON_TYPES.has(type) && !['checkbox', 'radio', 'file', 'range', 'color'].includes(type);
  }

  /** @param {Element} el */
  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = tagOf(el);
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox';
    if (tag === 'textarea' || isEditable(el)) return 'textbox';
    if (tag === 'input') {
      const type = typeOf(el);
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'file') return 'file';
      if (BUTTON_TYPES.has(type)) return 'button';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    return 'generic';
  }

  /** A label's own text, without the controls inside it (EC-SCN-04). @param {Element} label */
  function labelText(label) {
    const clone = /** @type {Element} */ (label.cloneNode(true));
    for (const c of clone.querySelectorAll('input, select, textarea, button')) c.remove();
    return squash(clone.textContent);
  }

  /**
   * Accessible name in the order of architecture §11.2, truncated to 80 chars.
   * @param {Element} el
   * @param {Map<string, Element>} labelsFor `<label for>` by id
   */
  function accessibleName(el, labelsFor) {
    const tag = tagOf(el);
    const type = typeOf(el);
    const root = /** @type {Document|ShadowRoot} */ (el.getRootNode());
    const byId = (id) => (typeof root.getElementById === 'function' ? root.getElementById(id) : null) ?? document.getElementById(id);

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = squash(labelledBy.split(/\s+/).map((id) => byId(id)?.textContent ?? '').join(' '));
      if (text) return cut(text, NAME_MAX);
    }
    const aria = squash(el.getAttribute('aria-label'));
    if (aria) return cut(aria, NAME_MAX);

    const isControl = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (isControl) {
      const forLabel = el.id ? labelsFor.get(el.id) : undefined;
      const text = (forLabel && labelText(forLabel)) || (el.closest('label') && labelText(/** @type {Element} */ (el.closest('label'))));
      if (text) return cut(text, NAME_MAX);
    }
    if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
      const value = squash(el.getAttribute('value'));
      if (value) return cut(value, NAME_MAX);
      if (type !== 'button') return type === 'submit' ? 'Submit' : 'Reset';
    }
    if (tag === 'input' && type === 'image') {
      const alt = squash(el.getAttribute('alt'));
      if (alt) return cut(alt, NAME_MAX);
    }
    for (const attr of ['placeholder', 'title']) {
      const v = squash(el.getAttribute(attr));
      if (v) return cut(v, NAME_MAX);
    }
    if (!isControl) {
      const alt = squash(el.querySelector('img[alt]')?.getAttribute('alt'));
      const text = squash(el.textContent);
      if (text) return cut(text, NAME_MAX);
      if (alt) return cut(alt, NAME_MAX);
    }
    return cut(squash(el.getAttribute('name') || el.id), NAME_MAX);
  }

  /** Text that says which part of the page an element belongs to. @param {Element} el */
  function nearestHeading(el) {
    const box = el.closest('fieldset, section, article, dialog, [role=dialog], form');
    const heading = box?.querySelector('legend, h1, h2, h3, h4, h5, h6');
    return heading ? cut(squash(heading.textContent), 60) : '';
  }

  /** @param {Element} form */
  function formName(form) {
    const by = form.getAttribute('aria-labelledby');
    const labelled = by ? squash(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')) : '';
    const name = labelled || squash(form.getAttribute('aria-label')) ||
      squash(form.querySelector('legend, h1, h2, h3, h4, h5, h6')?.textContent) || squash(form.getAttribute('name') || form.id);
    return cut(name, 60);
  }

  /** Buttons and links: the things the action rules judge. @param {Element} el @param {string} role */
  function isActionTarget(el, role) {
    const tag = tagOf(el);
    return tag === 'a' || tag === 'button' || tag === 'summary' || (tag === 'input' && BUTTON_TYPES.has(typeOf(el))) ||
      ['button', 'link', 'menuitem', 'tab'].includes(role);
  }

  /** @param {Element} el @returns {HTMLFormElement|null} */
  function formOf(el) {
    const own = /** @type {any} */ (el).form;
    if (own && own.nodeType === 1) return own;
    return /** @type {HTMLFormElement|null} */ (el.closest('form'));
  }

  /** @param {Element} el */
  function isDisabled(el) {
    return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' ||
      (el.closest('fieldset[disabled]') !== null && tagOf(el) !== 'legend');
  }

  /** @param {Element} el */
  function hrefOf(el) {
    const raw = el.getAttribute('href') ?? '';
    if (/^\s*javascript:/i.test(raw)) return 'javascript:…';
    try {
      const url = new URL(raw, location.href);
      return cut(url.origin === location.origin ? `${url.pathname}${url.search}${url.hash}` : `${url.origin}${url.pathname}`, VALUE_MAX);
    } catch {
      return cut(raw, VALUE_MAX);
    }
  }

  /** Single-character boxes side by side, for split OTP detection (EC-FLD-06). @param {Element} el */
  function groupSize(el) {
    const count = (box) => (box ? box.querySelectorAll('input[maxlength="1"]').length : 0);
    const here = count(el.parentElement);
    return here > 1 ? here : count(el.parentElement?.parentElement ?? null);
  }

  /**
   * @param {{
   *   getRect?: (el: Element) => { left: number, top: number, width: number, height: number, right: number, bottom: number },
   *   viewport?: () => { width: number, height: number, scrollX: number },
   *   elementFromPoint?: (x: number, y: number) => Element|null
   * }} [deps] injectable for tests: happy-dom has no layout
   */
  function createScanner(deps = {}) {
    const getRect = deps.getRect ?? ((el) => el.getBoundingClientRect());
    const viewport = deps.viewport ?? (() => ({ width: innerWidth, height: innerHeight, scrollX }));
    const elementFromPoint = deps.elementFromPoint ?? ((x, y) => document.elementFromPoint(x, y));
    const rules = /** @type {any} */ (globalThis).__sahayakShared ?? {};

    /** @type {null | { id: string, refs: Map<number, WeakRef<Element>>, fingerprints: Map<number, string>, url: string }} */
    let snapshot = null;
    let counter = 0;
    let dirty = true;

    /** Union of child boxes, for zero-size wrappers like an <a> around a block (EC-SCN-09). @param {Element} el */
    function boxOf(el) {
      const r = getRect(el);
      if (r.width > 0 || r.height > 0) return r;
      let box = null;
      for (const child of el.children) {
        const c = getRect(child);
        if (c.width === 0 && c.height === 0) continue;
        box = box
          ? { left: Math.min(box.left, c.left), top: Math.min(box.top, c.top), right: Math.max(box.right, c.right), bottom: Math.max(box.bottom, c.bottom) }
          : { left: c.left, top: c.top, right: c.right, bottom: c.bottom };
      }
      return box ? { ...box, width: box.right - box.left, height: box.bottom - box.top } : r;
    }

    /**
     * Visible, findable candidates in DOM order, after modal scoping and de-duplication.
     * @returns {{ els: Element[], boxes: Map<Element, any>, modal: Element|null }}
     */
    function candidates() {
      const cache = new Map();
      const vp = viewport();
      const focused = document.activeElement;
      let els = collect(document, []).filter((el) => !isHidden(el, cache));

      // An open modal: only its elements, so nothing behind it gets clicked (EC-SCN-07).
      const modals = [...document.querySelectorAll(MODALS)].filter((m) => !isHidden(m, cache));
      const modal = modals.at(-1) ?? null;
      if (modal) els = els.filter((el) => deepContains(modal, el));

      /** @type {Map<Element, any>} */
      const boxes = new Map();
      els = els.filter((el) => {
        const r = boxOf(el);
        // Zero-size, 1-px "sr-only" clips and things pushed off the left edge are hidden unless focused (EC-SCN-08).
        const gone = (r.width <= 1 && r.height <= 1) || r.right + vp.scrollX <= 0;
        if (gone && el !== focused) return false;
        boxes.set(el, r);
        return true;
      });

      // Disabled controls only matter inside forms (architecture §11.1, EC-SCN-13).
      els = els.filter((el) => !isDisabled(el) || formOf(el) !== null);

      const wrappers = new Set(els.filter((el) => el.matches(WRAPPERS)));
      els = els.filter((el) => {
        for (let p = parentOf(el); p; p = parentOf(p)) if (wrappers.has(p)) return false;
        return true;
      });
      return { els, boxes, modal };
    }

    /**
     * Describe the elements (pure apart from reading the DOM).
     * @param {Element[]} els
     * @param {Map<Element, any>} boxes
     */
    function describe(els, boxes) {
      const vp = viewport();
      /** @type {Map<string, Element>} */
      const labelsFor = new Map();
      for (const l of document.querySelectorAll('label[for]')) {
        const id = l.getAttribute('for');
        if (id && !labelsFor.has(id)) labelsFor.set(id, l);
      }
      const pageText = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, label, legend')]
        .map((n) => n.textContent ?? '').join(' ').slice(0, 5000);
      const pageOtp = OTP_PAGE_RE.test(pageText);

      /** @type {Map<HTMLFormElement, number>} */
      const formIds = new Map();
      const forms = [];
      const firstSubmit = new Map();
      const seen = new Map();

      const described = els.slice(0, MAX_ELEMENTS).map((el, i) => {
        const tag = tagOf(el);
        const type = typeOf(el);
        const role = roleOf(el);
        const name = accessibleName(el, labelsFor);
        const form = formOf(el);
        let formId;
        if (form) {
          formId = formIds.get(form);
          if (formId === undefined) {
            formId = formIds.size + 1;
            formIds.set(form, formId);
            forms.push({ id: formId, name: formName(form) });
          }
          if (BUTTON_TYPES.has(type) && type !== 'button' && type !== 'reset' && !firstSubmit.has(form)) firstSubmit.set(form, el);
        }

        /** @type {Record<string, any>} */
        const d = { id: i + 1, tag, role, name };
        if (tag === 'input' && type !== 'text') d.inputType = type;
        const r = boxes.get(el);
        d.inViewport = r.bottom > 0 && r.right > 0 && r.top < vp.height && r.left < vp.width;
        if (formId !== undefined) d.formId = formId;
        if (isDisabled(el)) d.disabled = true;
        if (el.hasAttribute('required') || el.getAttribute('aria-required') === 'true') d.required = true;
        const placeholder = squash(el.getAttribute('placeholder'));
        if (placeholder && placeholder !== name) d.placeholder = cut(placeholder, NAME_MAX);
        if (tag === 'a') d.href = hrefOf(el);

        // Safety: protected fields are flagged, and their values never leave the page (EC-SCN-25).
        if (isTextLike(el) || tag === 'select') {
          const maxLength = Number(el.getAttribute('maxlength'));
          d.protected = rules.fieldRules?.classifyField({
            tag, type: tag === 'input' ? type : tag, role,
            autocomplete: el.getAttribute('autocomplete') ?? '',
            name: el.getAttribute('name') ?? '', id: el.id, label: name, placeholder,
            inputMode: el.getAttribute('inputmode') ?? '',
            maxLength: Number.isFinite(maxLength) && maxLength > 0 ? maxLength : undefined,
            groupSize: maxLength === 1 ? groupSize(el) : 0,
            pageOtp
          }) ?? null;
          if (!rules.fieldRules && type === 'password') d.protected = 'password'; // rules missing: fail closed
        }

        if (tag === 'select') {
          const options = [...el.querySelectorAll('option')].map((o) => cut(squash(o.textContent), 40));
          d.options = options.length > OPTIONS_MAX ? [...options.slice(0, OPTIONS_MAX), `…(${options.length - OPTIONS_MAX} more)`] : options;
          const selected = /** @type {HTMLSelectElement} */ (el).selectedOptions?.[0] ?? el.querySelector('option[selected]') ?? el.querySelector('option');
          d.value = d.protected ? MASK : cut(squash(selected?.textContent), 40);
        } else if (type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'radio' || role === 'switch') {
          d.checked = tag === 'input' ? Boolean(/** @type {HTMLInputElement} */ (el).checked) : el.getAttribute('aria-checked') === 'true';
          if (type === 'radio') {
            // Radios are listed with their group (EC-SCN-12).
            const group = squash(el.closest('fieldset')?.querySelector('legend')?.textContent) || el.getAttribute('name') || '';
            if (group) d.group = cut(group, 40);
          }
        } else if (isTextLike(el)) {
          const raw = isEditable(el) ? squash(el.textContent) : String(/** @type {HTMLInputElement} */ (el).value ?? '');
          d.value = d.protected ? (raw ? MASK : '') : cut(raw, VALUE_MAX);
        }

        // Fingerprint for re-finding the element after a re-render (EC-SCN-16, EC-SCN-17).
        const heading = nearestHeading(el);
        const key = [tag, role, name, formId ?? 0, heading].join('|');
        const nth = seen.get(key) ?? 0;
        seen.set(key, nth + 1);
        d.fingerprint = hash(`${key}|${nth}`);
        return { el, d, form };
      });

      // Second pass: things that need the whole list.
      const protectedForms = new Set(described.filter((x) => x.form && x.d.protected).map((x) => x.form));
      const names = new Map();
      for (const { d } of described) names.set(`${d.role}|${d.name}`, (names.get(`${d.role}|${d.name}`) ?? 0) + 1);

      for (const { el, d, form } of described) {
        if (isActionTarget(el, d.role)) {
          const verdict = rules.actionRules?.classifyAction({
            tag: d.tag, role: d.role, inputType: typeOf(el) || undefined, label: d.name, href: el.getAttribute('href') ?? '',
            inForm: Boolean(form), isFormDefaultSubmit: form ? firstSubmit.get(form) === el : false,
            formHasProtectedField: form ? protectedForms.has(form) : false
          });
          if (verdict && verdict.kind !== 'normal') d.consequential = true;
          if (verdict?.kind === 'blocked') d.blocked = true;
        }
        // Same name more than once ("Edit" × 10): add the row it belongs to (EC-SCN-05).
        if ((names.get(`${d.role}|${d.name}`) ?? 0) > 1) {
          const row = el.closest('tr, li, [role=row], [role=listitem], article');
          const text = row ? squash(row.textContent).replace(d.name, '').trim() : '';
          if (text) d.context = cut(text, 40);
        }
        // Covered by something else, e.g. a cookie banner (EC-SCN-06).
        if (d.inViewport) {
          const r = boxes.get(el);
          const x = Math.min(Math.max((r.left + r.right) / 2, 0), vp.width - 1);
          const y = Math.min(Math.max((r.top + r.bottom) / 2, 0), vp.height - 1);
          const hit = elementFromPoint(x, y);
          if (hit && !deepContains(el, hit) && !deepContains(hit, el)) d.obscured = true;
        }
      }
      return { described, forms, pageOtp };
    }

    /**
     * The one element on the page now with this fingerprint, or null if there are none or several.
     * @param {string} fingerprint
     * @returns {Element|null}
     */
    function findByFingerprint(fingerprint) {
      const { els, boxes } = candidates();
      const matches = describe(els, boxes).described.filter((x) => x.d.fingerprint === fingerprint);
      return matches.length === 1 ? matches[0].el : null;
    }

    function clearMarks() {
      if (!snapshot) return;
      for (const ref of snapshot.refs.values()) ref.deref()?.removeAttribute('data-sahayak-id');
    }

    return {
      /** Scan the page, number the elements, and remember them as the current snapshot. */
      scan() {
        const { els, boxes, modal } = candidates();
        const { described, forms, pageOtp } = describe(els, boxes);
        clearMarks();
        snapshot = { id: `${Date.now().toString(36)}-${++counter}`, refs: new Map(), fingerprints: new Map(), url: location.href };
        for (const { el, d } of described) {
          snapshot.refs.set(d.id, new WeakRef(el));
          snapshot.fingerprints.set(d.id, d.fingerprint);
          el.setAttribute('data-sahayak-id', String(d.id));
        }
        dirty = false;
        const framesNotScanned = [...document.querySelectorAll('iframe')].filter((f) => !isHidden(f, new Map())).length;
        return {
          snapshotId: snapshot.id,
          url: location.href,
          title: document.title,
          elements: described.map((x) => x.d),
          forms,
          modal: Boolean(modal),
          framesNotScanned,
          pageOtp, // the page asks for an OTP somewhere (EC-FLD-07): the executor and policy treat codes as secret
          truncated: els.length > MAX_ELEMENTS,
          total: els.length
        };
      },

      /**
       * The live element for a numbered target, or null. Re-finds it by fingerprint if the page was
       * re-rendered, and never guesses between look-alikes (EC-SCN-16, EC-SCN-17).
       * @param {string} snapshotId
       * @param {number} elementId
       * @returns {Element|null}
       */
      resolve(snapshotId, elementId) {
        if (!snapshot || snapshot.id !== snapshotId) return null;
        const el = snapshot.refs.get(elementId)?.deref();
        if (el?.isConnected) return el;
        const fingerprint = snapshot.fingerprints.get(elementId);
        return fingerprint ? findByFingerprint(fingerprint) : null;
      },

      findByFingerprint,

      /**
       * A fresh descriptor for one element, judged as the page is now: protected, consequential and
       * blocked are worked out again (executor re-checks, §12.6). Null if it's no longer actionable.
       * @param {Element} el
       */
      inspect(el) {
        const { els, boxes } = candidates();
        const { described, pageOtp } = describe(els, boxes);
        const hit = described.find((x) => x.el === el);
        return hit ? { ...hit.d, pageOtp } : null;
      },

      /** The current snapshot's live elements, for badges. @returns {Array<[number, Element]>} */
      elements() {
        if (!snapshot) return [];
        const out = [];
        for (const [id, ref] of snapshot.refs) {
          const el = ref.deref();
          if (el?.isConnected) out.push([id, el]);
        }
        return out;
      },

      snapshotId: () => snapshot?.id ?? null,
      isDirty: () => dirty,
      markDirty() {
        dirty = true;
      },
      /** Remove data-sahayak-id from the page (EC-SCN-23). */
      clearMarks
    };
  }

  const scanner = createScanner();
  ns.createScanner = createScanner;
  ns.scanner = scanner;

  // Significant DOM changes make the snapshot stale, so the next observe rescans (§11.3).
  // Our own data-sahayak-id attribute and the overlay host are ignored.
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every((n) => /** @type {Element} */ (n).id === 'sahayak-overlay')) continue;
      scanner.markDirty();
      return;
    }
  }).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['disabled', 'hidden', 'style', 'class', 'aria-hidden', 'aria-disabled', 'open', 'type', 'inert']
  });

  ns.handlers.CS_SCAN = () => scanner.scan();
})();
