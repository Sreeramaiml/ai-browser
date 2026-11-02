// @ts-check
// Runs one approved agent step on the page (classic script, architecture §12.6). The service
// worker only sends CS_EXECUTE after the user approved the step, and this file still re-finds the
// element and re-checks the safety rules on a fresh look at the page before touching anything, so
// a bug or an injection upstream can't type into a password box or press a login button (§14.1).

(() => {
  const ns = /** @type {any} */ (globalThis).__pagewise;
  if (ns.executor) return;
  const rules = /** @type {any} */ (globalThis).__pagewiseShared ?? {};

  /** After acting, wait for the page to settle: no DOM changes for QUIET_MS, at most MAX_WAIT_MS. */
  const QUIET_MS = 300;
  const MAX_WAIT_MS = 1_500;
  const TYPE_ROLES = new Set(['textbox', 'searchbox']);

  /** @param {string} code @param {string} error */
  const fail = (code, error) => ({ ok: false, code, error });
  /** @param {unknown} s */
  const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

  function waitForQuiet() {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(quiet);
        clearTimeout(cap);
        observer.disconnect();
        resolve(undefined);
      };
      let quiet = setTimeout(finish, QUIET_MS);
      const cap = setTimeout(finish, MAX_WAIT_MS);
      const observer = new MutationObserver(() => {
        clearTimeout(quiet);
        quiet = setTimeout(finish, QUIET_MS);
      });
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    });
  }

  /**
   * Set a value through the prototype's setter, so frameworks that watch the value (React, Vue)
   * see the change, then tell them with input and change events (§12.6).
   * @param {HTMLInputElement|HTMLTextAreaElement} el
   * @param {string} value
   */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** @param {Element} el @param {string} value */
  function typeInto(el, value) {
    /** @type {HTMLElement} */ (el).focus({ preventScroll: true });
    if (/** @type {HTMLElement} */ (el).isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      return squash(el.textContent);
    }
    setNativeValue(/** @type {HTMLInputElement} */ (el), value);
    return /** @type {HTMLInputElement} */ (el).value;
  }

  /** @param {string|null|undefined} s */
  const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  /** A radio's visible label: aria-label, its <label>, or its value. @param {HTMLInputElement} r */
  function radioLabel(r) {
    return squash(r.getAttribute('aria-label') || r.labels?.[0]?.textContent || r.closest('label')?.textContent || r.value);
  }

  /**
   * Pick an option: by label, then by value (§12.6). Radio groups pick the matching radio.
   * @param {Element} el
   * @param {string} value
   */
  function selectOption(el, value) {
    const want = norm(value);
    if (el instanceof HTMLSelectElement) {
      const options = [...el.options];
      let i = options.findIndex((o) => norm(o.textContent) === want);
      if (i < 0) i = options.findIndex((o) => norm(o.value) === want);
      if (i < 0) return fail('BAD_OPTION', `There's no "${value}" option in that list.`);
      if (options[i].disabled) return fail('BAD_OPTION', `"${value}" can't be chosen right now.`);
      el.focus({ preventScroll: true });
      el.selectedIndex = i;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, valueAfter: squash(options[i].textContent) };
    }
    if (el instanceof HTMLInputElement && el.type === 'radio') {
      const scope = el.form ?? document;
      const group = el.name
        ? [...scope.querySelectorAll('input[type="radio"]')].filter((r) => /** @type {HTMLInputElement} */ (r).name === el.name)
        : [el];
      const pick = /** @type {HTMLInputElement[]} */ (group).find((r) => norm(radioLabel(r)) === want || norm(r.value) === want);
      if (!pick) return fail('BAD_OPTION', `There's no "${value}" choice in that group.`);
      if (pick.disabled) return fail('BAD_OPTION', `"${value}" can't be chosen right now.`);
      pick.focus({ preventScroll: true });
      pick.click();
      return { ok: true, valueAfter: radioLabel(pick) };
    }
    return fail('UNSUPPORTED', "Pagewise can't pick from this kind of list yet. Choose it yourself, then skip this step.");
  }

  /** The nearest ancestor that scrolls vertically, if any. @param {Element} el */
  function scrollBoxOf(el) {
    for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const { overflowY } = getComputedStyle(n);
      if ((overflowY === 'auto' || overflowY === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    }
    return null;
  }

  /** @param {Element|null} el @param {'up'|'down'} direction */
  function scrollPage(el, direction) {
    const top = (direction === 'up' ? -1 : 1) * 0.8 * innerHeight;
    const box = el ? scrollBoxOf(el) : null;
    (box ?? window).scrollBy({ top, behavior: smooth() });
  }

  /** @param {Element} el */
  function click(el) {
    el.scrollIntoView({ block: 'center', behavior: 'auto' });
    /** @type {HTMLElement} */ (el).focus?.({ preventScroll: true });
    if (el instanceof HTMLAnchorElement && el.target === '_blank') {
      // New-tab links are followed in this tab, and only within the site (§12.6).
      const url = new URL(el.href, location.href);
      if (url.origin !== location.origin) return fail('NEW_TAB_LINK', "That link opens another site in a new tab, so Pagewise won't follow it.");
      location.assign(url.href);
      return { ok: true };
    }
    /** @type {HTMLElement} */ (el).click();
    return { ok: true };
  }

  /**
   * @param {{
   *   snapshotId?: string, elementId?: number|null, fingerprint?: string|null,
   *   action?: { type?: string, value?: string|null, direction?: 'up'|'down'|null },
   *   confirmed?: boolean
   * }} payload confirmed: the user gave the second confirmation a consequential click needs
   */
  async function execute({ snapshotId, elementId, fingerprint, action, confirmed = false } = {}) {
    const type = action?.type;
    /** @type {Element|null} */
    let el = null;
    if (elementId != null) {
      el = ns.scanner.resolve(snapshotId, elementId) ??
        (typeof fingerprint === 'string' ? ns.scanner.findByFingerprint(fingerprint) : null);
      if (!el) return fail('STALE_TARGET', 'The page changed, so that element is gone.');
    }

    if (type === 'scroll') {
      if (action?.direction !== 'up' && action?.direction !== 'down') return fail('BAD_ACTION', 'Scroll needs a direction.');
      scrollPage(el, action.direction);
      await waitForQuiet();
      return { ok: true, effect: { navigated: false, url: location.href } };
    }
    if (type !== 'click' && type !== 'type' && type !== 'select') return fail('BAD_ACTION', 'Pagewise doesn’t know that kind of step.');
    if (!el) return fail('STALE_TARGET', 'That step needs an element on the page.');

    // Judge the element again, as the page is now.
    const d = ns.scanner.inspect(el);
    if (!d) return fail('STALE_TARGET', "That element isn't visible any more.");
    if (d.disabled) return fail('DISABLED', 'That control is switched off right now.');

    /** @type {any} */
    let done;
    if (type === 'click') {
      if (d.role === 'file') return fail('FILE_INPUT', 'Please choose the file yourself.');
      if (d.blocked) return fail('BLOCKED', "Pagewise won't click this. It would submit a form with a password, OTP or card field.");
      if (d.consequential && !confirmed) return fail('NEEDS_CONFIRMATION', 'This step needs your second confirmation first.');
      done = click(el);
    } else {
      // Fail closed if the shared rules didn't load: never type blind.
      if (!rules.fieldRules) return fail('BLOCKED', "Pagewise's safety rules didn't load on this page, so it won't type here.");
      if (d.protected) return fail('PROTECTED_FIELD', 'Pagewise never types into password, OTP or card fields.');
      const value = String(action?.value ?? '');
      if (!value) return fail('BAD_ACTION', 'There is nothing to type.');
      if (type === 'type') {
        const typable = TYPE_ROLES.has(d.role) || (d.role === 'combobox' && d.tag === 'input');
        if (!typable) return fail('WRONG_ELEMENT_KIND', "That isn't a text field.");
        const secret = rules.fieldRules.looksLikeSecretValue(value, { label: d.name, pageOtp: d.pageOtp });
        if (secret) return fail('BLOCKED', "That value looks like a card number, Aadhaar number or one-time code, so Pagewise won't type it.");
        done = { ok: true, valueAfter: typeInto(el, value) };
      } else {
        done = selectOption(el, value);
      }
    }
    if (!done.ok) return done;

    await waitForQuiet();
    /** @type {{ navigated: boolean, url: string, valueAfter?: string }} */
    const effect = { navigated: false, url: location.href };
    if (done.valueAfter !== undefined) effect.valueAfter = String(done.valueAfter).slice(0, 200);
    return { ok: true, effect };
  }

  ns.executor = { execute };
  ns.handlers.CS_EXECUTE = (payload) => execute(payload ?? {});
})();
