import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, it, expect, vi } from 'vitest';

const ID = 'pagewise-extension-id';
afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.__pagewise;
  vi.resetModules();
});

describe('messaging hardening (P4.3 step 9)', () => {
  it('content scripts answer only our own extension (EC-INJ-07)', async () => {
    let listener;
    globalThis.chrome = { runtime: { id: ID, onMessage: { addListener: (fn) => { listener = fn; } } } };
    globalThis.__pagewise = { handlers: {} };
    await import('../../src/content/bootstrap.js');
    const calls = [];
    globalThis.__pagewise.handlers.CS_TEST = (p) => { calls.push(p); return 'ok'; };

    expect(listener({ type: 'CS_TEST', payload: 1 }, { id: 'some-other-extension' }, () => {})).toBe(false);
    expect(listener({ type: 'CS_TEST', payload: 2 }, {}, () => {})).toBe(false);
    expect(calls).toEqual([]);

    const reply = await new Promise((resolve) => listener({ type: 'CS_TEST', payload: 3 }, { id: ID }, resolve));
    expect(reply).toEqual({ ok: true, result: 'ok' });
    expect(calls).toEqual([3]);
  });

  it('the service worker messages only the top frame it injected into', async () => {
    const sent = [];
    globalThis.chrome = { tabs: { sendMessage: async (...args) => { sent.push(args); return { ok: true, result: 'r' }; } } };
    const { sendToTab } = await import('../../src/background/tab-context.js');
    expect(await sendToTab(7, 'CS_SCAN', { x: 1 })).toBe('r');
    expect(sent).toEqual([[7, { type: 'CS_SCAN', payload: { x: 1 } }, { frameId: 0 }]]);
  });

  it('the service worker accepts ports only from Pagewise\'s own pages', async () => {
    let onConnect;
    globalThis.chrome = {
      runtime: {
        id: ID,
        getURL: (p) => `chrome-extension://${ID}/${p}`,
        onConnect: { addListener: (fn) => { onConnect = fn; } }
      }
    };
    const { initRouter } = await import('../../src/background/router.js');
    initRouter();
    const port = (sender) => {
      const p = { name: 'panel', sender, disconnected: false, disconnect() { this.disconnected = true; }, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } };
      onConnect(p);
      return p;
    };
    expect(port({ id: 'evil', url: `chrome-extension://evil/src/sidepanel/index.html` }).disconnected).toBe(true);
    expect(port({ id: ID, url: 'https://example.com/' }).disconnected).toBe(true); // a content script can't pose as the panel
    expect(port({ id: ID, url: `chrome-extension://${ID}/src/sidepanel/index.html` }).disconnected).toBe(false);
  });

  it('pages can\'t reach the extension: no external messaging, no window.postMessage listeners (EC-INJ-07, EC-INJ-08)', () => {
    const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
    expect(manifest.externally_connectable).toBeUndefined();
    for (const file of readdirSync('src/content').filter((f) => f.endsWith('.js'))) {
      const src = readFileSync(`src/content/${file}`, 'utf8');
      expect(src, file).not.toMatch(/addEventListener\(\s*['"]message['"]|onmessage\s*=/);
    }
    for (const file of readdirSync('src/background', { recursive: true }).filter((f) => String(f).endsWith('.js'))) {
      const src = readFileSync(`src/background/${file}`, 'utf8');
      expect(src, String(file)).not.toMatch(/runtime\.onMessage(External)?\.addListener/);
    }
  });
});

describe('the safety suite can\'t be skipped (P4.3 step 10)', () => {
  it('no test in tests/safety is skipped, focused or left as a todo', () => {
    for (const file of readdirSync('tests/safety')) {
      const src = readFileSync(`tests/safety/${file}`, 'utf8');
      expect(src, file).not.toMatch(/\b(?:it|test|describe)\s*\.\s*(?:skip|only|todo|skipIf|runIf)\b|\bx(?:it|describe|test)\s*\(/);
    }
  });

  it('npm run test:safety runs only the safety suite, for CI', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['test:safety']).toBe('vitest run tests/safety tests/redact.test.js');
  });
});
