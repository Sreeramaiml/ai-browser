// @ts-check
// Tiny observable store (architecture §17.2): get / set / subscribe(selector, fn).

/**
 * @template S
 * @typedef {{
 *   get: () => S,
 *   set: (update: Partial<S> | ((state: S) => S)) => void,
 *   subscribe: <T>(selector: (state: S) => T, fn: (value: T, prev: T|undefined) => void, opts?: { immediate?: boolean }) => () => void
 * }} Store
 */

/**
 * @template {object} S
 * @param {S} initial
 * @returns {Store<S>}
 */
export function createStore(initial) {
  let state = initial;
  /** @type {Set<() => void>} */
  const listeners = new Set();

  return {
    get: () => state,

    set(update) {
      const next = typeof update === 'function' ? update(state) : { ...state, ...update };
      if (next === state) return;
      state = next;
      for (const listener of [...listeners]) {
        // One broken view must not stop the others from updating, or break whoever called set().
        try {
          listener();
        } catch (err) {
          console.error('[Pagewise] store subscriber failed', err);
        }
      }
    },

    subscribe(selector, fn, { immediate = true } = {}) {
      let prev = selector(state);
      const listener = () => {
        const value = selector(state);
        if (Object.is(value, prev)) return;
        const old = prev;
        prev = value;
        fn(value, old);
      };
      listeners.add(listener);
      if (immediate) fn(prev, undefined);
      return () => listeners.delete(listener);
    }
  };
}
