// Sahayak practice site helpers. Values typed into the multi-step forms are kept in
// sessionStorage, so they survive moving between steps and vanish when the tab closes.
(() => {
  const KEY = 'sahayak-practice';

  /** @returns {Record<string, Record<string, string>>} */
  function readAll() {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) || '{}');
    } catch {
      return {};
    }
  }

  window.practice = {
    /** @param {string} form @returns {Record<string, string>} */
    load(form) {
      return readAll()[form] || {};
    },
    /** @param {string} form @param {Record<string, string>} values merged into what's saved */
    save(form, values) {
      const all = readAll();
      all[form] = { ...(all[form] || {}), ...values };
      try {
        sessionStorage.setItem(KEY, JSON.stringify(all));
      } catch {
        /* storage blocked: the form still works, it just won't remember */
      }
    },
    /** @param {string} form */
    clear(form) {
      const all = readAll();
      delete all[form];
      try {
        sessionStorage.setItem(KEY, JSON.stringify(all));
      } catch {
        /* ignore */
      }
    },
    /** @param {string} name */
    param(name) {
      return new URLSearchParams(location.search).get(name);
    }
  };
})();
