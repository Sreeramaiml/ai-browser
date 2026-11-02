// @ts-check
// See tab (P2.3): capture the visible tab, optionally crop to a region, check the exact image that
// will be sent, then ask about it. The image only ever lives in this panel's memory (EC-SCR-14).

import { SCREENSHOT_MAX_QUESTION_CHARS } from '../../shared/config.js';
import { ToPanel, ToSW, makeMessage } from '../../shared/messages.js';
import { DEFAULT_SCREENSHOT_QUESTION } from '../../shared/prompts/vision.js';
import { createCropTool } from '../components/crop-tool.js';
import { createErrorBanner } from '../components/error-banner.js';
import { createMessageList } from '../components/message-list.js';
import { formatBytes, loadImage, prepareScreenshot, toImageCrop } from '../image.js';

const TEMPLATE = /* html */ `
  <div class="see">
    <div class="see-actions">
      <button type="button" class="btn btn-primary" data-ref="capture"
              title="Protected (DRM) videos show as black in captures.">Capture screen</button>
      <p class="hint">Captures what's visible in this tab. Then drag on the picture to focus on one part.</p>
    </div>
    <div data-ref="notice"></div>

    <div class="see-stage" data-ref="stage" hidden>
      <p class="note" data-ref="captured"></p>
      <div data-ref="crop"></div>
      <div class="row see-crop-bar">
        <button type="button" class="btn btn-secondary" data-ref="full">Use full screen</button>
        <span class="hint" data-ref="cropHint" aria-live="polite"></span>
      </div>

      <figure class="see-preview">
        <figcaption>What will be sent <span class="hint" data-ref="previewInfo"></span></figcaption>
        <img data-ref="preview" alt="The image that will be sent" />
      </figure>

      <form class="see-ask" data-ref="form">
        <textarea data-ref="input" rows="2" maxlength="${SCREENSHOT_MAX_QUESTION_CHARS}"
                  placeholder="Ask about it, e.g. “Which year had the highest value?”"
                  aria-label="Question about the screenshot"></textarea>
        <div class="composer-bar">
          <button type="submit" class="btn btn-primary" data-ref="ask">Ask</button>
        </div>
      </form>
    </div>

    <div data-ref="messages"></div>
  </div>
`;

/** Keep clicks on Capture at least this far apart; Chrome allows about 2 captures a second. */
const CAPTURE_COOLDOWN_MS = 600;
/** Wait for the crop to settle before re-encoding the preview. */
const PREVIEW_DELAY_MS = 150;

/**
 * @param {HTMLElement} root
 * @param {{
 *   store: import('../store.js').Store<{ activeTab: import('../../background/tab-context.js').ActiveTabInfo|null }>,
 *   client: Awaited<ReturnType<typeof import('../client.js').startClient>>,
 *   openSettings: () => void
 * }} deps
 */
export function mountSeeView(root, { store, client, openSettings }) {
  root.innerHTML = TEMPLATE;
  /** @param {string} name @returns {any} */
  const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
  const captureBtn = /** @type {HTMLButtonElement} */ (ref('capture'));
  const askBtn = /** @type {HTMLButtonElement} */ (ref('ask'));
  const input = /** @type {HTMLTextAreaElement} */ (ref('input'));
  const preview = /** @type {HTMLImageElement} */ (ref('preview'));
  const notice = /** @type {HTMLElement} */ (ref('notice'));
  const list = createMessageList(ref('messages'));

  let capturing = false;
  let coolUntil = 0;
  let asking = false;
  /** The decoded capture. Replaced (and the old one dropped) on every new capture. */
  let image = /** @type {HTMLImageElement|null} */ (null);
  /** @type {ReturnType<typeof createCropTool>|null} */
  let cropTool = null;
  /** The encoded image the preview shows; exactly what Ask sends (EC-SCR-09). */
  let prepared = /** @type {{ dataUrl: string, width: number, height: number, bytes: number }|null} */ (null);
  let previewToken = 0;
  let previewTimer = 0;

  function render() {
    const noTab = store.get().activeTab?.tabId == null;
    captureBtn.disabled = capturing || noTab;
    captureBtn.textContent = capturing ? 'Capturing…' : image ? 'Capture again' : 'Capture screen';
    askBtn.disabled = asking || !prepared;
  }
  store.subscribe((s) => s.activeTab?.tabId, render);

  // ---- Preview ----

  async function updatePreview() {
    const token = ++previewToken;
    prepared = null;
    render();
    if (!image) return;
    const frac = cropTool?.getRect() ?? null;
    const crop = toImageCrop(frac, { width: image.naturalWidth, height: image.naturalHeight });
    ref('cropHint').textContent = frac && !crop
      ? 'That area is too small, so the full screen will be sent.' // EC-SCR-05
      : crop ? 'Sending the selected area.' : 'Sending the full screen. Drag on the picture to pick a part.';
    ref('previewInfo').textContent = 'Preparing…';
    try {
      const out = await prepareScreenshot(image, crop);
      if (token !== previewToken) return;
      prepared = out;
      preview.src = out.dataUrl;
      ref('previewInfo').textContent = `${out.width}×${out.height} · ${formatBytes(out.bytes)}`;
    } catch (err) {
      if (token !== previewToken) return;
      preview.removeAttribute('src');
      ref('previewInfo').textContent = err instanceof Error ? err.message : "Couldn't prepare the image.";
    }
    render();
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(updatePreview, PREVIEW_DELAY_MS);
  }

  ref('full').addEventListener('click', () => cropTool?.reset());

  // ---- Capture ----

  async function capture() {
    if (capturing || Date.now() < coolUntil) return;
    capturing = true;
    notice.replaceChildren();
    render();
    try {
      const reply = await client.request(ToSW.CAPTURE_SCREEN, {});
      if (reply.type !== ToPanel.CAPTURE_RESULT) {
        notice.replaceChildren(createErrorBanner(
          reply.payload ?? { code: 'CAPTURE_FAILED', message: "Couldn't capture the screen. Please try again." }, {}
        ));
        return;
      }
      const shot = reply.payload;
      image = await loadImage(shot.dataUrl);
      // Say which tab was captured: the user may have switched tabs since the header updated (EC-SCR-03).
      ref('captured').textContent = `Captured: ${shot.title}`;
      cropTool = createCropTool(ref('crop'), { src: shot.dataUrl, onChange: schedulePreview });
      ref('stage').hidden = false;
      await updatePreview();
      input.focus();
    } catch (err) {
      notice.replaceChildren(createErrorBanner(
        { code: 'CAPTURE_FAILED', message: err instanceof Error ? err.message : "Couldn't capture the screen.", retryable: false }, {}
      ));
    } finally {
      capturing = false;
      coolUntil = Date.now() + CAPTURE_COOLDOWN_MS;
      render();
    }
  }
  captureBtn.addEventListener('click', capture);

  // ---- Ask ----

  /**
   * @param {string} typed what the user asked ('' → the default question)
   * @param {{ imageDataUrl: string, escalate?: boolean }} opts the image is fixed per question, so
   *   "Try harder" re-asks about the same pixels even after a new capture
   */
  async function ask(typed, { imageDataUrl, escalate = false }) {
    if (asking) return;
    asking = true;
    render();
    const question = typed.trim().slice(0, SCREENSHOT_MAX_QUESTION_CHARS);
    const shown = question || DEFAULT_SCREENSHOT_QUESTION; // EC-SCR-10

    const user = list.addUser(escalate ? `Try harder: ${shown}` : shown);
    const thumb = document.createElement('img');
    thumb.className = 'msg-thumb';
    thumb.alt = 'Screenshot sent with this question';
    thumb.src = imageDataUrl;
    user.el.prepend(thumb);

    const reply = list.addAssistant({
      onRetry: () => {
        user.remove();
        reply.remove();
        ask(question, { imageDataUrl, escalate });
      },
      onOpenSettings: openSettings,
      stopLabel: 'Stop generating'
    });

    const { requestId, done } = client.stream(ToSW.ASK_SCREENSHOT, { imageDataUrl, question, escalate }, {
      onProgress(msg) {
        if (msg.type === ToPanel.CHAT_DELTA) reply.append(msg.payload.text);
        else if (msg.type === ToPanel.CHAT_RESET) reply.reset();
      }
    });
    reply.onStop(() => client.send(makeMessage(ToSW.CANCEL, { requestId })));

    try {
      const msg = await done;
      if (msg.type === ToPanel.CHAT_DONE) {
        reply.finish(msg.payload);
        if (!msg.payload.escalated) {
          // Re-ask on the stronger model (architecture §8.2, escalation trigger 4).
          const row = document.createElement('div');
          row.className = 'quick-followups';
          const harder = document.createElement('button');
          harder.type = 'button';
          harder.className = 'chip chip-btn';
          harder.textContent = 'Try harder';
          harder.title = 'Ask again with a stronger model. Uses more of your free quota.';
          harder.addEventListener('click', () => ask(question, { imageDataUrl, escalate: true }));
          row.append(harder);
          reply.attach(row);
        }
      } else {
        reply.fail(msg.payload ?? { code: 'INTERNAL', message: 'Something went wrong. Please try again.', retryable: true });
      }
    } catch (err) {
      reply.fail({ code: 'INTERRUPTED', message: err instanceof Error ? err.message : 'Connection interrupted.', retryable: true });
    } finally {
      asking = false;
      render();
    }
  }

  function submit() {
    if (!prepared || asking) return;
    ask(input.value, { imageDataUrl: prepared.dataUrl });
    input.value = '';
  }

  ref('form').addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });

  render();
}
