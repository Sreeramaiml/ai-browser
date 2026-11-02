// @ts-check
// Model output → safe HTML. Model text can echo injected page content, so it is always sanitised
// (architecture §14.7, EC-UI-01) and images are dropped (EC-UI-03: they could be tracking pixels).

import { marked } from '../../vendor/marked.esm.js';
import DOMPurify from '../../vendor/purify.es.js';

/** @param {string} s */
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Links the panel will show. Same rule as DOMPurify's below, applied first (defence in depth, EC-INJ-04). */
const SAFE_HREF_RE = /^(?:https?:|mailto:)/i;

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    // Raw HTML in the model's markdown is shown as text, never interpreted.
    html: ({ text }) => escapeHtml(text),
    // Images become their alt text.
    image: ({ text }) => escapeHtml(text ?? ''),
    // javascript:, data: and other schemes become plain text. Safe links open in a new tab without
    // access to the panel (the DOMPurify hook below enforces the same in case this is ever bypassed).
    link(token) {
      const href = String(token.href ?? '').trim();
      if (!SAFE_HREF_RE.test(href)) return escapeHtml(token.text ?? '');
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer">${this.parser.parseInline(token.tokens)}</a>`;
    }
  }
});

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'strong', 'em', 'b', 'i', 'del', 'code', 'pre', 'blockquote', 'hr',
    'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'th', 'td'
  ],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel'], // target and rel come only from our link renderer
  ALLOWED_URI_REGEXP: SAFE_HREF_RE
};

/** DOMPurify needs a real DOM. If it can't run, fail closed: show plain escaped text. */
const purifyReady = DOMPurify.isSupported === true;

if (purifyReady) {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/**
 * @param {string} text markdown from the model
 * @returns {string} sanitised HTML
 */
export function renderMarkdown(text) {
  if (!purifyReady) return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
  const html = /** @type {string} */ (marked.parse(text, { async: false }));
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}
