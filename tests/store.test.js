import { describe, it, expect } from 'vitest';
import { createStore } from '../src/sidepanel/store.js';

describe('createStore', () => {
  it('merges partial updates at the top level', () => {
    const store = createStore({ a: 1, b: { c: 2 } });
    store.set({ a: 5 });
    expect(store.get()).toEqual({ a: 5, b: { c: 2 } });
  });

  it('accepts updater functions', () => {
    const store = createStore({ n: 1 });
    store.set((s) => ({ ...s, n: s.n + 1 }));
    expect(store.get().n).toBe(2);
  });

  it('calls subscribers immediately by default, then only when the selected value changes', () => {
    const store = createStore({ view: 'read', other: 0 });
    const seen = [];
    store.subscribe((s) => s.view, (v, prev) => seen.push([v, prev]));
    store.set({ other: 1 });
    store.set({ view: 'chat' });
    store.set({ view: 'chat' });
    expect(seen).toEqual([['read', undefined], ['chat', 'read']]);
  });

  it('skips the immediate call when asked', () => {
    const store = createStore({ x: 1 });
    const seen = [];
    store.subscribe((s) => s.x, (v) => seen.push(v), { immediate: false });
    store.set({ x: 2 });
    expect(seen).toEqual([2]);
  });

  it('stops notifying after unsubscribe', () => {
    const store = createStore({ x: 1 });
    const seen = [];
    const off = store.subscribe((s) => s.x, (v) => seen.push(v), { immediate: false });
    off();
    store.set({ x: 2 });
    expect(seen).toEqual([]);
  });

  it('ignores updaters that return the same state object', () => {
    const store = createStore({ x: 1 });
    const seen = [];
    store.subscribe((s) => s, () => seen.push(1), { immediate: false });
    store.set((s) => s);
    expect(seen).toHaveLength(0);
  });

  it('keeps notifying other subscribers when one throws, and set() does not throw', () => {
    const store = createStore({ x: 1 });
    const seen = [];
    const originalError = console.error;
    console.error = () => {};
    try {
      store.subscribe((s) => s.x, () => { throw new Error('broken view'); }, { immediate: false });
      store.subscribe((s) => s.x, (v) => seen.push(v), { immediate: false });
      store.set({ x: 2 });
    } finally {
      console.error = originalError;
    }
    expect(seen).toEqual([2]);
  });

  it('lets a subscriber unsubscribe another during notification without skipping it', () => {
    const store = createStore({ x: 1 });
    const seen = [];
    let offB = () => {};
    store.subscribe((s) => s.x, () => { seen.push('a'); offB(); }, { immediate: false });
    offB = store.subscribe((s) => s.x, () => seen.push('b'), { immediate: false });
    store.set({ x: 2 });
    store.set({ x: 3 });
    expect(seen).toEqual(['a', 'b', 'a']);
  });
});
