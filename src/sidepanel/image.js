// @ts-check
// Screenshot crop maths and encoding for the See tab (architecture §10.3).
// Crops are kept as fractions of the image, so they survive the panel being resized and map to
// the full-resolution capture however small the thumbnail is shown (EC-SCR-04, EC-SCR-07).
// The pure helpers at the top are unit tested; the canvas code at the bottom needs a browser.

import { SCREENSHOT } from '../shared/config.js';

/**
 * @typedef {{ x: number, y: number }} Point fractions of the image, 0..1
 * @typedef {{ x: number, y: number, w: number, h: number }} Rect
 */

/** @param {number} v */
export const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * A pointer position as a fraction of the shown image, clamped to it (EC-SCR-06).
 * @param {number} clientX
 * @param {number} clientY
 * @param {{ left: number, top: number, width: number, height: number }} box the image's on-screen box
 * @returns {Point}
 */
export function toFraction(clientX, clientY, box) {
  return {
    x: box.width > 0 ? clamp01((clientX - box.left) / box.width) : 0,
    y: box.height > 0 ? clamp01((clientY - box.top) / box.height) : 0
  };
}

/**
 * The rectangle between two dragged corners, in either direction.
 * @param {Point} a
 * @param {Point} b
 * @returns {Rect}
 */
export function rectFromPoints(a, b) {
  const x = clamp01(Math.min(a.x, b.x));
  const y = clamp01(Math.min(a.y, b.y));
  return { x, y, w: clamp01(Math.max(a.x, b.x)) - x, h: clamp01(Math.max(a.y, b.y)) - y };
}

/**
 * Move a rectangle by (dx, dy) without letting it leave the image.
 * @param {Rect} rect
 * @param {number} dx
 * @param {number} dy
 * @returns {Rect}
 */
export function moveRect(rect, dx, dy) {
  return {
    ...rect,
    x: Math.min(1 - rect.w, Math.max(0, rect.x + dx)),
    y: Math.min(1 - rect.h, Math.max(0, rect.y + dy))
  };
}

/**
 * A fractional crop → whole pixels of the captured image. Too small on either side counts as no
 * crop (EC-SCR-05).
 * @param {Rect|null} frac
 * @param {{ width: number, height: number }} natural the captured image's real size
 * @param {number} [minPx]
 * @returns {Rect|null} null: send the full screen
 */
export function toImageCrop(frac, natural, minPx = SCREENSHOT.minCropPx) {
  if (!frac) return null;
  const x = Math.round(clamp01(frac.x) * natural.width);
  const y = Math.round(clamp01(frac.y) * natural.height);
  const w = Math.round(clamp01(frac.x + frac.w) * natural.width) - x;
  const h = Math.round(clamp01(frac.y + frac.h) * natural.height) - y;
  if (w < minPx || h < minPx) return null;
  if (w === natural.width && h === natural.height) return null; // the whole image anyway
  return { x, y, w, h };
}

/**
 * Scale a size down (never up) so its long edge is at most maxEdge.
 * @param {number} width
 * @param {number} height
 * @param {number} maxEdge
 */
export function fitWithin(width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- Canvas (browser only) ----

/** @param {string} src */
export async function loadImage(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

/** @param {Blob} blob @returns {Promise<string>} */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(/** @type {string} */ (reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Crop and downscale on an OffscreenCanvas, then encode as JPEG.
 * @param {HTMLImageElement} img
 * @param {Rect|null} crop in image pixels, or null for the whole image
 * @param {{ maxEdge: number, quality: number }} opts
 * @returns {Promise<{ dataUrl: string, width: number, height: number, bytes: number }>}
 */
export async function encodeScreenshot(img, crop, { maxEdge, quality }) {
  const area = crop ?? { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  const size = fitWithin(area.w, area.h, maxEdge);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#ffffff'; // JPEG has no transparency
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(img, area.x, area.y, area.w, area.h, 0, 0, size.width, size.height);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return { dataUrl: await blobToDataUrl(blob), width: size.width, height: size.height, bytes: blob.size };
}

/**
 * The exact image that will be sent: 1600 px / q0.85, or 1280 px / q0.7 if that is still too big
 * (EC-SCR-11). Throws if even that is too big.
 * @param {HTMLImageElement} img
 * @param {Rect|null} crop
 */
export async function prepareScreenshot(img, crop) {
  let out = await encodeScreenshot(img, crop, { maxEdge: SCREENSHOT.maxEdge, quality: SCREENSHOT.quality });
  if (out.bytes > SCREENSHOT.maxBytes) {
    out = await encodeScreenshot(img, crop, { maxEdge: SCREENSHOT.fallbackMaxEdge, quality: SCREENSHOT.fallbackQuality });
  }
  if (out.bytes > SCREENSHOT.maxBytes) throw new Error('This screenshot is too large to send. Crop it to a smaller area.');
  return out;
}
