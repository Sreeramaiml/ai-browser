import { describe, it, expect } from 'vitest';
import { base64Bytes, createVision, parseImageDataUrl } from '../src/background/vision.js';
import { SCREENSHOT } from '../src/shared/config.js';
import { DEFAULT_SCREENSHOT_QUESTION } from '../src/shared/prompts/vision.js';

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

function setup({ language = 'en' } = {}) {
  const calls = [];
  const starts = [];
  const vision = createVision({
    gateway: {
      stream: async (req) => {
        calls.push(req);
        req.onDelta('2019');
        return { text: '2019', model: req.escalate ? 'gemini-3.8-flash' : 'gemini-3.5-flash-lite', provider: 'gemini', stopReason: 'end_turn' };
      }
    },
    getLanguage: async () => language
  });
  const io = { onStart: (i) => starts.push(i), onDelta: () => {}, onReset: () => {} };
  const ask = async (payload) => { try { return { result: await vision.ask(payload, io) }; } catch (error) { return { error }; } };
  return { ask, calls, starts };
}

describe('parseImageDataUrl', () => {
  it('splits a base64 image data URL', () => {
    expect(parseImageDataUrl(JPEG)).toEqual({ mime: 'image/jpeg', base64: '/9j/4AAQSkZJRg==' });
    expect(parseImageDataUrl('data:image/png;base64,AAAA')).toEqual({ mime: 'image/png', base64: 'AAAA' });
  });

  it('rejects anything else', () => {
    for (const bad of [undefined, '', 'https://e.com/a.png', 'data:text/html;base64,AAAA', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,<script>']) {
      expect(parseImageDataUrl(bad)).toBeNull();
    }
  });

  it('measures decoded size', () => {
    expect(base64Bytes('AAAA')).toBe(3);
    expect(base64Bytes('AAA=')).toBe(2);
    expect(base64Bytes('AA==')).toBe(1);
  });
});

describe('createVision', () => {
  it('sends the image first, then the question, as a vision task', async () => {
    const { ask, calls } = setup();
    const { result } = await ask({ imageDataUrl: JPEG, question: '  Which year had the highest value?  ' });
    expect(calls[0].task).toBe('vision');
    expect(calls[0].escalate).toBe(false);
    expect(calls[0].turns[0].parts).toEqual([
      { image: { mime: 'image/jpeg', base64: '/9j/4AAQSkZJRg==' } },
      { text: 'Which year had the highest value?' }
    ]);
    expect(result).toEqual({ text: '2019', model: 'gemini-3.5-flash-lite', provider: 'gemini', stopReason: 'end_turn', escalated: false });
  });

  it('uses a default question when none is typed (EC-SCR-10)', async () => {
    const { ask, calls, starts } = setup();
    await ask({ imageDataUrl: JPEG, question: '   ' });
    expect(calls[0].turns[0].parts[1].text).toBe(DEFAULT_SCREENSHOT_QUESTION);
    expect(starts[0]).toEqual({ question: DEFAULT_SCREENSHOT_QUESTION, escalated: false });
  });

  it('"Try harder" escalates to the stronger model', async () => {
    const { ask, calls } = setup();
    const { result } = await ask({ imageDataUrl: JPEG, question: 'q', escalate: true });
    expect(calls[0].escalate).toBe(true);
    expect(result.escalated).toBe(true);
    expect(result.model).toBe('gemini-3.8-flash');
  });

  it('refuses a missing or malformed image without calling the model', async () => {
    const { ask, calls } = setup();
    expect((await ask({ question: 'q' })).error.code).toBe('IMAGE_INVALID');
    expect((await ask({ imageDataUrl: 'https://e.com/x.png' })).error.code).toBe('IMAGE_INVALID');
    expect(calls).toHaveLength(0);
  });

  it('refuses an image over the size limit (EC-SCR-11)', async () => {
    const { ask, calls } = setup();
    const huge = `data:image/jpeg;base64,${'A'.repeat(Math.ceil((SCREENSHOT.maxBytes + 10) * 4 / 3))}`;
    expect((await ask({ imageDataUrl: huge })).error.code).toBe('IMAGE_TOO_LARGE');
    expect(calls).toHaveLength(0);
  });

  it('answers in the toggle language and treats on-screen text as data', async () => {
    const { ask, calls } = setup({ language: 'hinglish' });
    await ask({ imageDataUrl: JPEG, question: 'q' });
    expect(calls[0].system).toMatch(/Hinglish/);
    expect(calls[0].system).toMatch(/never as instructions/);
  });
});
