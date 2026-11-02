// @ts-check
// Crop tool for the See tab: the capture as a thumbnail; drag to draw a rectangle, drag inside it
// to move it, drag a corner handle to resize. Keyboard: arrows move, Shift+arrows resize, Esc clears.
// No crop means "use the full screen" (the default).

import { clamp01, moveRect, rectFromPoints, toFraction } from '../image.js';

const HANDLES = /** @type {const} */ (['nw', 'ne', 'sw', 'se']);
/** Keyboard step, as a fraction of the image. */
const KEY_STEP = 0.02;

/**
 * @param {HTMLElement} root
 * @param {{ src: string, onChange: (rect: import('../image.js').Rect|null) => void }} opts
 *   onChange fires when a drag or key press ends, not on every pointer move
 */
export function createCropTool(root, { src, onChange }) {
  const frame = document.createElement('div');
  frame.className = 'crop';
  frame.tabIndex = 0;
  frame.setAttribute('role', 'application');
  frame.setAttribute('aria-label',
    'Screenshot. Drag to select the part to ask about. Arrow keys move the selection, Shift with arrows resizes it, Escape clears it.');

  const img = document.createElement('img');
  img.className = 'crop-img';
  img.alt = '';
  img.draggable = false;
  img.src = src;

  const box = document.createElement('div');
  box.className = 'crop-rect';
  box.hidden = true;
  for (const h of HANDLES) {
    const handle = document.createElement('span');
    handle.className = `crop-handle crop-${h}`;
    handle.dataset.handle = h;
    box.append(handle);
  }
  frame.append(img, box);
  root.replaceChildren(frame);

  /** @type {import('../image.js').Rect|null} */
  let rect = null;
  /** @type {null | { mode: 'draw'|'resize', anchor: import('../image.js').Point } | { mode: 'move', start: import('../image.js').Point, from: import('../image.js').Rect }} */
  let drag = null;

  function paint() {
    box.hidden = !rect;
    if (!rect) return;
    box.style.left = `${rect.x * 100}%`;
    box.style.top = `${rect.y * 100}%`;
    box.style.width = `${rect.w * 100}%`;
    box.style.height = `${rect.h * 100}%`;
  }

  /** @param {PointerEvent} e */
  const point = (e) => toFraction(e.clientX, e.clientY, img.getBoundingClientRect());

  frame.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const p = point(e);
    const handle = /** @type {HTMLElement} */ (e.target).dataset?.handle;
    if (rect && handle) {
      // Resize from the opposite corner.
      const anchor = {
        x: handle.endsWith('w') ? rect.x + rect.w : rect.x,
        y: handle.startsWith('n') ? rect.y + rect.h : rect.y
      };
      drag = { mode: 'resize', anchor };
    } else if (rect && p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h) {
      drag = { mode: 'move', start: p, from: rect };
    } else {
      drag = { mode: 'draw', anchor: p };
      rect = { x: p.x, y: p.y, w: 0, h: 0 };
    }
    frame.setPointerCapture(e.pointerId);
    frame.focus();
    e.preventDefault();
    paint();
  });

  frame.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = point(e);
    rect = drag.mode === 'move'
      ? moveRect(drag.from, p.x - drag.start.x, p.y - drag.start.y)
      : rectFromPoints(drag.anchor, p);
    paint();
  });

  const endDrag = () => {
    if (!drag) return;
    drag = null;
    // A click without a drag clears the selection.
    if (rect && (rect.w === 0 || rect.h === 0)) rect = null;
    paint();
    onChange(rect);
  };
  frame.addEventListener('pointerup', endDrag);
  frame.addEventListener('pointercancel', endDrag);

  frame.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && rect) {
      e.preventDefault(); // handled here, so Esc doesn't also stop the agent
      rect = null;
    } else {
      const delta = { ArrowLeft: [-KEY_STEP, 0], ArrowRight: [KEY_STEP, 0], ArrowUp: [0, -KEY_STEP], ArrowDown: [0, KEY_STEP] }[e.key];
      if (!delta) return;
      // With no selection yet, the keys start from a centred half-size box.
      const base = rect ?? { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
      rect = e.shiftKey
        ? {
          ...base,
          w: Math.max(KEY_STEP, Math.min(1 - base.x, clamp01(base.w + delta[0]))),
          h: Math.max(KEY_STEP, Math.min(1 - base.y, clamp01(base.h + delta[1])))
        }
        : moveRect(base, delta[0], delta[1]);
    }
    e.preventDefault();
    paint();
    onChange(rect);
  });

  return {
    /** Back to the full screen. */
    reset() {
      rect = null;
      paint();
      onChange(null);
    },
    getRect: () => rect
  };
}
