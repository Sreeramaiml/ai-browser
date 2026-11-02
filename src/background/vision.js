// @ts-check
// Screenshot-and-ask (architecture §10.3, P2.3): the panel sends the cropped, downscaled JPEG it
// showed the user; this checks it and streams the answer. "Try harder" re-asks on Flash.

import { SCREENSHOT, SCREENSHOT_MAX_QUESTION_CHARS } from '../shared/config.js';
import { isLanguage } from '../shared/language.js';
import { ToSW } from '../shared/messages.js';
import { DEFAULT_SCREENSHOT_QUESTION, buildVisionPrompt } from '../shared/prompts/vision.js';
import { createStorage } from '../shared/storage.js';
import { FeatureError } from './feature-error.js';
import { createDefaultGateway } from './llm/default-gateway.js';
import { createGateway } from './llm/gateway.js';
import { on } from './router.js';
import { streamInLanguage, streamingHandler } from './streaming.js';

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Split an image data URL into the provider's { mime, base64 } (pure).
 * @param {unknown} dataUrl
 * @returns {{ mime: string, base64: string } | null}
 */
export function parseImageDataUrl(dataUrl) {
  const m = typeof dataUrl === 'string' ? DATA_URL_RE.exec(dataUrl) : null;
  return m ? { mime: m[1], base64: m[2] } : null;
}

/** Decoded size of base64 data. @param {string} base64 */
export function base64Bytes(base64) {
  return Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
}

/**
 * @param {{ gateway: ReturnType<typeof createGateway>, getLanguage: () => Promise<string> }} deps
 */
export function createVision({ gateway, getLanguage }) {
  return {
    /**
     * @param {{ imageDataUrl?: string, question?: string, language?: string, escalate?: boolean }} payload
     * @param {import('./streaming.js').StreamIO} io
     */
    async ask(payload, io) {
      const image = parseImageDataUrl(payload?.imageDataUrl);
      if (!image) throw new FeatureError('IMAGE_INVALID', 'Capture the screen first, then ask your question.');
      // The panel already shrinks it; this guards against a payload that skipped that (EC-SCR-11).
      if (base64Bytes(image.base64) > SCREENSHOT.maxBytes) {
        throw new FeatureError('IMAGE_TOO_LARGE', 'That screenshot is too large to send. Crop it to a smaller area and try again.');
      }
      const typed = typeof payload.question === 'string' ? payload.question.trim().slice(0, SCREENSHOT_MAX_QUESTION_CHARS) : '';
      const question = typed || DEFAULT_SCREENSHOT_QUESTION; // EC-SCR-10
      const escalate = payload.escalate === true;
      const language = isLanguage(payload.language) ? payload.language : await getLanguage();

      io.onStart({ question, escalated: escalate });
      const { system, turns } = buildVisionPrompt({ image, question, language });
      const result = await streamInLanguage(gateway, { task: 'vision', system, turns, escalate }, language, io);
      return { text: result.text, model: result.model, provider: result.provider, stopReason: result.stopReason, escalated: escalate };
    }
  };
}

/** Wire screenshot questions into the router. Call synchronously at the worker's top level. */
export function initVision() {
  const storage = createStorage(chrome.storage.local);
  const vision = createVision({
    gateway: createDefaultGateway(),
    getLanguage: async () => (await storage.getSettings()).language
  });

  on(ToSW.ASK_SCREENSHOT, streamingHandler((payload, io) => vision.ask(payload, io)));
}
