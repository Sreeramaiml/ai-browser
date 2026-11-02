import { describe, it, expect } from 'vitest';
import { MENU_ITEMS, createMenuClickHandler, registerMenus } from '../src/background/context-menus.js';

describe('registerMenus', () => {
  it('removes old items before creating the parent and its 3 children (EC-CTX-12)', async () => {
    const log = [];
    await registerMenus({
      removeAll: async () => { log.push('removeAll'); },
      create: (props) => { log.push(props); }
    });
    expect(log[0]).toBe('removeAll');
    expect(log[1]).toMatchObject({ id: 'sahayak', contexts: ['selection'] });
    expect(log.slice(2).map((p) => [p.id, p.parentId])).toEqual(MENU_ITEMS.map((m) => [m.id, 'sahayak']));
    expect(MENU_ITEMS.map((m) => m.title)).toEqual(['Explain this', 'Translate', 'Draft a reply']);
  });
});

describe('menu click', () => {
  function setup() {
    const log = [];
    const handler = createMenuClickHandler({
      openPanel: (tab) => log.push(['open', tab.windowId]),
      savePending: async (req) => { log.push(['save', req]); },
      newId: () => 'id-1',
      now: () => 5000
    });
    return { handler, log };
  }
  const tab = { id: 7, windowId: 2, url: 'https://e.com/post', title: 'Post' };

  it('opens the panel synchronously, before saving the request (EC-CTX-01)', () => {
    const { handler, log } = setup();
    handler({ menuItemId: 'translate', selectionText: 'Hello', frameId: 0, pageUrl: 'https://e.com/post' }, tab);
    // No await above: both happened inside the click, open first.
    expect(log.map((e) => e[0])).toEqual(['open', 'save']);
    expect(log[0][1]).toBe(2);
    expect(log[1][1]).toEqual({
      id: 'id-1', kind: 'translate', text: 'Hello', tabId: 7, windowId: 2, frameId: 0,
      url: 'https://e.com/post', pageTitle: 'Post', scope: 'selection-only', ts: 5000
    });
  });

  it('ignores the parent item and unknown ids', () => {
    const { handler, log } = setup();
    handler({ menuItemId: 'sahayak', selectionText: 'x' }, tab);
    handler({ menuItemId: 'other', selectionText: 'x' }, tab);
    expect(log).toEqual([]);
  });

  it('keeps an empty selection (canvas apps, EC-CTX-06) so the panel can say so', () => {
    const { handler, log } = setup();
    handler({ menuItemId: 'explain' }, tab);
    expect(log[1][1].text).toBe('');
  });
});
