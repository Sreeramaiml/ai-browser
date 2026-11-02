// @ts-check
// Page reading (classic script): the user's selection (CS_GET_SELECTION), the readable article
// (CS_EXTRACT_ARTICLE, via Readability), the visible page text (CS_EXTRACT_VISIBLE), and the
// signals the safety tiers use (CS_PAGE_SIGNALS, architecture §14.2).

(() => {
  const ns = /** @type {any} */ (globalThis).__pagewise;
  const MAX_SELECTION_CHARS = 20_000; // EC-SEL-06
  const CONTEXT_CHARS = 200;
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', '']);

  /**
   * Never read a selection out of a password, OTP or card field (EC-SEL-03, EC-SEL-10). Uses the
   * shared field rules (src/content/generated/field-rules.classic.js, injected before this file).
   * @param {HTMLInputElement|HTMLTextAreaElement} el
   */
  function isProtectedField(el) {
    const rules = /** @type {any} */ (globalThis).__pagewiseShared?.fieldRules;
    if (!rules) {
      // Rules missing (shouldn't happen): fail closed on the obvious cases.
      const autocomplete = (el.getAttribute('autocomplete') ?? '').toLowerCase();
      return (el instanceof HTMLInputElement && el.type === 'password') || /password|one-time-code|cc-/.test(autocomplete);
    }
    return rules.classifyField(fieldInfo(el)) !== null;
  }

  /**
   * What the shared field rules look at.
   * @param {HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement} el
   */
  function fieldInfo(el) {
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => (id ? document.getElementById(id)?.textContent ?? '' : ''))
      .join(' ')
      .trim();
    const labelEl = el.labels?.[0];
    const label = labelledBy || el.getAttribute('aria-label') || labelEl?.innerText || labelEl?.textContent || '';
    return {
      tag: el.tagName.toLowerCase(),
      type: el instanceof HTMLSelectElement ? 'select' : el.type,
      autocomplete: (el.getAttribute('autocomplete') ?? '').toLowerCase(),
      name: el.getAttribute('name') ?? '',
      id: el.id,
      label: label.trim(),
      placeholder: el.getAttribute('placeholder') ?? '',
      inputMode: el.inputMode ?? '',
      maxLength: el instanceof HTMLSelectElement ? -1 : el.maxLength
    };
  }

  /**
   * @param {string} raw
   * @param {string} before
   * @param {string} after
   */
  function result(raw, before, after) {
    const text = raw.trim();
    if (!text) return { text: '' };
    const truncated = text.length > MAX_SELECTION_CHARS;
    return {
      text: truncated ? text.slice(0, MAX_SELECTION_CHARS) : text,
      contextBefore: before.slice(-CONTEXT_CHARS).trimStart(),
      contextAfter: after.slice(0, CONTEXT_CHARS).trimEnd(),
      truncated
    };
  }

  function readSelection() {
    // Text selected inside a form field isn't part of window.getSelection().
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      const isTextField = active instanceof HTMLTextAreaElement || TEXT_INPUT_TYPES.has(active.type) || active.type === 'password';
      if (isTextField) {
        if (isProtectedField(active)) return { text: '', protected: true };
        const { selectionStart: s, selectionEnd: e, value } = active;
        if (s !== null && e !== null && e > s) {
          return result(value.slice(s, e), value.slice(Math.max(0, s - CONTEXT_CHARS), s), value.slice(e, e + CONTEXT_CHARS));
        }
      }
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return { text: '' };
    const text = selection.toString();

    // Surrounding text from the nearest block, so the model can resolve "it", "this", etc.
    let node = selection.getRangeAt(0).commonAncestorContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (node) : node.parentElement;
    const block = el?.closest('p, li, td, th, blockquote, pre, dd, figcaption, h1, h2, h3, h4, h5, h6, article, section, div') ?? document.body;
    const full = /** @type {HTMLElement} */ (block).innerText ?? '';
    const index = full.indexOf(text);
    if (index === -1) return result(text, '', '');
    return result(text, full.slice(Math.max(0, index - CONTEXT_CHARS), index), full.slice(index + text.length, index + text.length + CONTEXT_CHARS));
  }

  ns.handlers.CS_GET_SELECTION = () => readSelection();

  // ---- Article and visible text ----

  /** An article shorter than this is treated as "Readability found nothing useful". */
  const MIN_ARTICLE_CHARS = 500;
  /** Page chrome left out of the visible-text fallback (EC-ART-01, architecture §9.2). */
  const CHROME_SELECTOR = [
    // Not 'form': some sites (e.g. ASP.NET WebForms) wrap the whole page in one.
    'nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'template', 'svg', 'iframe',
    '[role="banner"]', '[role="navigation"]', '[role="contentinfo"]', '[role="complementary"]',
    '[role="search"]', '[aria-hidden="true"]', '[hidden]'
  ].join(',');

  /** @param {string} text */
  function tidy(text) {
    return text
      .replace(/\r/g, '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Visible text under `el`, skipping page chrome. innerText already leaves out
   * display:none / visibility:hidden content (EC-INJ-10).
   * @param {Element} el
   * @returns {string}
   */
  function visibleText(el) {
    const parts = [];
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent?.trim()) parts.push(node.textContent);
        continue;
      }
      if (!(node instanceof HTMLElement) || node.matches(CHROME_SELECTOR)) continue;
      // Only recurse where chrome is nested inside; otherwise innerText handles the whole subtree.
      parts.push(node.querySelector(CHROME_SELECTOR) ? visibleText(node) : node.innerText);
    }
    return parts.join('\n');
  }

  function extractVisible() {
    const root = document.querySelector('main, [role="main"]') ?? document.body;
    return {
      source: 'visible',
      title: document.title,
      byline: null,
      text: tidy(root ? visibleText(root) : ''),
      lang: document.documentElement.lang || null,
      url: location.href
    };
  }

  function extractArticle() {
    const g = /** @type {any} */ (globalThis);
    const isReadable = typeof g.isProbablyReaderable === 'function' ? Boolean(g.isProbablyReaderable(document)) : true;
    let article = null;
    try {
      // Readability mutates the document it parses, so always give it a clone (EC-ART-14).
      article = new g.Readability(document.cloneNode(true)).parse();
    } catch {
      article = null; // malformed pages: fall back to visible text below
    }
    const text = tidy(article?.textContent ?? '');
    if (article && text.length >= MIN_ARTICLE_CHARS) {
      return {
        source: 'article',
        title: (article.title || document.title || '').trim(),
        byline: article.byline?.trim() || null,
        text,
        lang: article.lang || document.documentElement.lang || null,
        url: location.href,
        isReadable
      };
    }
    // Not an article (home page, app, search results): summarise what's visible instead (EC-ART-01/02).
    return { ...extractVisible(), isReadable: false };
  }

  ns.handlers.CS_EXTRACT_ARTICLE = () => extractArticle();
  ns.handlers.CS_EXTRACT_VISIBLE = () => extractVisible();

  // ---- Safety signals (architecture §14.2) ----

  /** Banking and OTP phrases. Only looked for where a page asks for input (EC-TIR-16). */
  const KEYWORD_RE = /\b(net\s*banking|internet\s*banking|mobile\s*banking|upi\s*pin|m-?pin|enter\s*(the\s*|your\s*)?otp|one[\s-]?time\s*password|card\s*number|cvv|debit\s*card|credit\s*card|bank\s*account\s*number)\b|नेट\s*बैंकिंग|ओटीपी|यूपीआई\s*पिन/gi;
  const UPI_FIELD_RE = /\b(upi|vpa)\b/i;
  const MAX_FRAME_HOSTS = 20;

  /** @param {Element} el */
  function isShown(el) {
    if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
    if (el.closest('[hidden], [aria-hidden="true"], template')) return false;
    if (getComputedStyle(el).visibility === 'hidden') return false;
    // `display` isn't inherited: a field inside a display:none box reports its own display.
    for (let node = /** @type {Element|null} */ (el); node; node = node.parentElement) {
      if (getComputedStyle(node).display === 'none') return false;
    }
    return true;
  }

  function pageSignals() {
    const rules = /** @type {any} */ (globalThis).__pagewiseShared?.fieldRules;
    const signals = {
      hasPasswordField: false, hasCardFields: false, hasOtpField: false, hasUpiField: false,
      /** @type {string[]} */ keywords: [], /** @type {string[]} */ frameHosts: []
    };
    /** @type {string[]} */
    const texts = [];
    const fields = /** @type {Array<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>} */ (
      [...document.querySelectorAll('input, textarea, select')]
    ).filter(isShown);
    for (const el of fields) {
      const info = fieldInfo(el);
      // No rules (shouldn't happen): a password field still counts.
      const kind = rules ? rules.classifyField(info) : (info.type === 'password' ? 'password' : null);
      if (kind === 'password') signals.hasPasswordField = true;
      else if (kind === 'otp') signals.hasOtpField = true;
      else if (kind === 'card') {
        if (UPI_FIELD_RE.test(`${info.name} ${info.id} ${info.label} ${info.placeholder}`)) signals.hasUpiField = true;
        else signals.hasCardFields = true;
      }
      texts.push(info.label, info.placeholder, info.name);
    }
    if (fields.length) {
      // Headings only matter on a page that asks for something; an article about UPI stays tier 0.
      texts.push(document.title);
      for (const h of document.querySelectorAll('h1, h2, h3, legend, label, [role="heading"]')) {
        if (isShown(h)) texts.push(/** @type {HTMLElement} */ (h).innerText || h.textContent || '');
      }
    }
    const found = new Set();
    for (const m of texts.join('\n').matchAll(KEYWORD_RE)) found.add(m[0].toLowerCase().replace(/\s+/g, ' '));
    signals.keywords = [...found].slice(0, 10);

    // A payment iframe on an ordinary page (EC-TIR-06).
    const hosts = new Set();
    for (const frame of document.querySelectorAll('iframe[src], frame[src]')) {
      try {
        const url = new URL(frame.getAttribute('src') ?? '', location.href);
        if (url.protocol === 'https:' || url.protocol === 'http:') hosts.add(url.hostname.toLowerCase());
      } catch { /* not a URL */ }
      if (hosts.size >= MAX_FRAME_HOSTS) break;
    }
    signals.frameHosts = [...hosts];
    return signals;
  }

  ns.handlers.CS_PAGE_SIGNALS = () => pageSignals();
})();
