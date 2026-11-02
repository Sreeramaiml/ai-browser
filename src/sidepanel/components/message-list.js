// @ts-check
// Conversation-style list: user prompts and streamed assistant answers rendered as safe markdown.

import { MODEL_LABELS } from '../../shared/config.js';
import { renderMarkdown } from '../markdown.js';
import { createErrorBanner } from './error-banner.js';

const RENDER_INTERVAL_MS = 100; // EC-UI-04: re-parse at most ~10×/s while streaming

/** @param {string} model */
export function modelLabel(model) {
  return /** @type {Record<string, string>} */ (MODEL_LABELS)[model] ?? model;
}

/**
 * "via …" chip under an answer. A Groq fallback says so, on that answer only (EC-RTL-09).
 * @param {{ model: string, provider?: string }} result
 */
export function viaLabel(result) {
  return result.provider === 'groq' ? `via Groq · ${modelLabel(result.model)}` : `via ${modelLabel(result.model)}`;
}

/** @param {HTMLElement} root */
export function createMessageList(root) {
  root.classList.add('messages');
  root.setAttribute('aria-live', 'polite');

  // Links in answers open in a new tab, and only http(s) links (sanitiser already enforces this).
  root.addEventListener('click', (event) => {
    const link = /** @type {HTMLElement} */ (event.target).closest?.('a[href]');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) chrome.tabs.create({ url: href });
  });

  function scrollToEnd() {
    root.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  return {
    /** @param {string} text */
    addUser(text) {
      const el = document.createElement('div');
      el.className = 'msg user';
      el.textContent = text;
      root.append(el);
      scrollToEnd();
      return {
        el,
        /** @param {string} t */
        setText: (t) => { el.textContent = t; },
        remove: () => el.remove()
      };
    },

    /**
     * A line across the conversation, e.g. "New page — context reset".
     * @param {string} text
     * @param {{ before?: Element }} [opts] insert above this message instead of at the end
     */
    addDivider(text, { before } = {}) {
      const el = document.createElement('div');
      el.className = 'divider';
      el.setAttribute('role', 'separator');
      el.textContent = text;
      if (before?.parentElement === root) root.insertBefore(el, before);
      else root.append(el);
      return el;
    },

    /**
     * @param {{ onRetry?: () => void, onOpenSettings?: () => void, onAck?: (domain: string) => void, stopLabel?: string }} actions
     */
    addAssistant(actions) {
      const el = document.createElement('div');
      el.className = 'msg assistant streaming';
      const body = document.createElement('div');
      body.className = 'msg-body';
      const thinking = document.createElement('p');
      thinking.className = 'thinking';
      thinking.textContent = 'Thinking…';
      body.append(thinking);
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'btn btn-link';
      stop.textContent = actions.stopLabel ?? 'Stop';
      meta.append(stop);
      el.append(body, meta);
      root.append(el);
      scrollToEnd();

      let text = '';
      let timer = 0;
      const render = () => {
        timer = 0;
        body.innerHTML = renderMarkdown(text); // sanitised in renderMarkdown
      };

      function settle() {
        if (timer) {
          clearTimeout(timer);
          timer = 0;
        }
        el.classList.remove('streaming');
        stop.remove();
      }

      return {
        /** @param {() => void} fn */
        onStop(fn) {
          stop.addEventListener('click', fn);
        },

        /** @param {string} delta */
        append(delta) {
          text += delta;
          if (!timer) timer = window.setTimeout(render, RENDER_INTERVAL_MS);
        },

        /** Discard what has streamed so far (the service worker is retrying, e.g. in better Hinglish). */
        reset() {
          text = '';
          if (timer) {
            clearTimeout(timer);
            timer = 0;
          }
          body.replaceChildren(thinking);
        },

        /**
         * @param {{ text: string, model: string, provider?: string, stopReason: string|null, notFound?: boolean }} result
         *   notFound: the page didn't have the answer; shown as a neutral info bubble, not an error
         * @param {{ notes?: string[], chips?: string[] }} [extra] short remarks shown under the answer, and
         *   labels shown next to the "via …" chip (e.g. "Profile used")
         */
        finish(result, { notes = [], chips = [] } = {}) {
          settle();
          text = result.text;
          render();
          el.classList.toggle('not-found', Boolean(result.notFound));
          if (result.stopReason === 'max_tokens') notes = ['The answer was cut off because it got too long.', ...notes];
          for (const t of notes) {
            const note = document.createElement('p');
            note.className = 'note';
            note.textContent = t;
            body.append(note);
          }
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.textContent = viaLabel(result);
          const copy = document.createElement('button');
          copy.type = 'button';
          copy.className = 'btn btn-link';
          copy.textContent = 'Copy';
          copy.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(result.text);
              copy.textContent = 'Copied';
            } catch {
              copy.textContent = 'Copy failed';
            }
          });
          for (const label of chips) {
            const extra = document.createElement('span');
            extra.className = 'chip chip-muted';
            extra.textContent = label;
            meta.append(extra);
          }
          meta.append(chip, copy);
          scrollToEnd();
        },

        /** @param {{ code: string, message: string, retryable?: boolean, retryAfterMs?: number }} error */
        fail(error) {
          settle();
          if (error.code === 'SAFETY_BLOCKED' || !text) {
            // A refused answer's partial text must not be shown as if complete.
            body.replaceChildren();
          } else {
            render();
          }
          if (error.code === 'CANCELLED') {
            const note = document.createElement('p');
            note.className = 'note';
            note.textContent = text ? '(stopped)' : 'Stopped.';
            body.append(note);
            return;
          }
          body.append(createErrorBanner(error, actions));
          scrollToEnd();
        },

        /** @param {Node} node extra controls under the answer, e.g. refinement chips */
        attach(node) {
          el.append(node);
          scrollToEnd();
        },

        remove: () => el.remove()
      };
    },

    clear: () => root.replaceChildren()
  };
}
