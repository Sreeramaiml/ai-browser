import { describe, it, expect } from 'vitest';
import { fitWithin, formatBytes, moveRect, rectFromPoints, toFraction, toImageCrop } from '../src/sidepanel/image.js';

describe('toFraction', () => {
  const box = { left: 100, top: 50, width: 400, height: 200 };

  it('maps pointer positions to fractions of the shown image', () => {
    expect(toFraction(300, 150, box)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('clamps drags that leave the image (EC-SCR-06)', () => {
    expect(toFraction(0, 1000, box)).toEqual({ x: 0, y: 1 });
  });
});

describe('rectFromPoints / moveRect', () => {
  it('works whichever way the user drags', () => {
    expect(rectFromPoints({ x: 0.75, y: 0.5 }, { x: 0.25, y: 0.25 })).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.25 });
  });

  it('keeps a moved rectangle inside the image', () => {
    expect(moveRect({ x: 0.5, y: 0.5, w: 0.25, h: 0.25 }, 0.5, -1)).toEqual({ x: 0.75, y: 0, w: 0.25, h: 0.25 });
  });
});

describe('toImageCrop (EC-SCR-04, EC-SCR-05)', () => {
  // A Retina capture: the panel shows it at a fraction of its real size.
  const natural = { width: 2880, height: 1800 };

  it('maps a fractional crop to real image pixels', () => {
    expect(toImageCrop({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, natural)).toEqual({ x: 720, y: 900, w: 1440, h: 450 });
  });

  it('treats no crop, a tiny crop, or the whole image as the full screen', () => {
    expect(toImageCrop(null, natural)).toBeNull();
    expect(toImageCrop({ x: 0.5, y: 0.5, w: 0.004, h: 0.3 }, natural)).toBeNull(); // 12 px wide
    expect(toImageCrop({ x: 0, y: 0, w: 1, h: 1 }, natural)).toBeNull();
  });

  it('clamps a crop that runs past the edge', () => {
    expect(toImageCrop({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, { width: 1000, height: 1000 })).toEqual({ x: 900, y: 900, w: 100, h: 100 });
  });
});

describe('fitWithin', () => {
  it('downscales the long edge to the limit, keeping the shape', () => {
    expect(fitWithin(2880, 1800, 1600)).toEqual({ width: 1600, height: 1000 });
    expect(fitWithin(900, 3000, 1600)).toEqual({ width: 480, height: 1600 });
  });

  it('never upscales', () => {
    expect(fitWithin(400, 300, 1600)).toEqual({ width: 400, height: 300 });
  });
});

describe('formatBytes', () => {
  it('shows KB, or MB for big images', () => {
    expect(formatBytes(180 * 1024)).toBe('180 KB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
});
