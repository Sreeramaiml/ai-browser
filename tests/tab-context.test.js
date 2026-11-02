import { describe, it, expect } from 'vitest';
import { describePageAccess, sanitizeFavIcon, toActiveTabInfo } from '../src/background/tab-context.js';

describe('describePageAccess', () => {
  const cases = [
    // [url, expected reason or null when readable, opts]
    ['https://en.wikipedia.org/wiki/India', null],
    ['http://localhost:3000/internship/', null],
    ['chrome://settings', 'browser'],
    ['chrome://newtab/', 'browser'],
    ['chrome-extension://abc/page.html', 'browser'],
    ['edge://settings', 'browser'],
    ['about:blank', 'browser'],
    ['view-source:https://example.com', 'browser'],
    ['devtools://devtools/bundled/inspector.html', 'browser'],
    ['data:text/html,hi', 'browser'],
    ['https://chromewebstore.google.com/detail/xyz', 'webstore'],
    ['https://chrome.google.com/webstore/detail/xyz', 'webstore'],
    ['https://chrome.google.com/other', null],
    ['https://CHROMEWEBSTORE.GOOGLE.COM./', 'webstore'],
    ['file:///Users/me/notes.html', 'file'],
    ['https://example.com/report.PDF', 'pdf'],
    ['https://example.com/pdf-guide', null],
    ['', 'none'],
    [undefined, 'none'],
    ['not a url', 'none'],
    ['ftp://example.com/file', 'browser']
  ];

  for (const [url, reason] of cases) {
    it(`${String(url) || '(empty)'} → ${reason ?? 'readable'}`, () => {
      const access = describePageAccess(url);
      if (reason === null) {
        expect(access).toEqual({ restricted: false });
      } else {
        expect(access).toEqual({ restricted: true, reason });
      }
    });
  }

  it('allows file URLs when file access is granted (EC-PNL-03)', () => {
    expect(describePageAccess('file:///tmp/a.html', { fileAccessAllowed: true })).toEqual({ restricted: false });
  });
});

describe('sanitizeFavIcon (EC-PNL-14)', () => {
  it('keeps http(s) icons', () => {
    expect(sanitizeFavIcon('https://example.com/favicon.ico')).toBe('https://example.com/favicon.ico');
  });

  it('keeps small data:image icons and drops huge ones', () => {
    expect(sanitizeFavIcon('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(sanitizeFavIcon('data:image/png;base64,' + 'A'.repeat(10_000))).toBeNull();
  });

  it('drops non-image data URLs and other schemes', () => {
    expect(sanitizeFavIcon('data:text/html,<script>')).toBeNull();
    expect(sanitizeFavIcon('javascript:alert(1)')).toBeNull();
    expect(sanitizeFavIcon('chrome://favicon/x')).toBeNull();
    expect(sanitizeFavIcon(undefined)).toBeNull();
  });
});

describe('toActiveTabInfo', () => {
  it('describes a normal tab', () => {
    const info = toActiveTabInfo(
      { id: 3, windowId: 9, url: 'https://example.com/', title: 'Example', favIconUrl: 'https://example.com/f.ico', status: 'complete' },
      9
    );
    expect(info).toEqual({
      tabId: 3,
      windowId: 9,
      url: 'https://example.com/',
      title: 'Example',
      favIconUrl: 'https://example.com/f.ico',
      status: 'complete',
      access: { restricted: false }
    });
  });

  it('uses pendingUrl while a tab is still loading and falls back to the URL as the title', () => {
    const info = toActiveTabInfo({ id: 1, windowId: 2, pendingUrl: 'https://news.example/a', status: 'loading' }, 2);
    expect(info.url).toBe('https://news.example/a');
    expect(info.title).toBe('https://news.example/a');
    expect(info.status).toBe('loading');
  });

  it('returns the "no page" state when there is no tab (EC-PNL-10)', () => {
    const info = toActiveTabInfo(undefined, 4);
    expect(info.tabId).toBeNull();
    expect(info.windowId).toBe(4);
    expect(info.access).toEqual({ restricted: true, reason: 'none' });
  });
});
