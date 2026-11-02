// @ts-check
// Content-script bootstrap (classic script, injected on demand — architecture §5.3).
// Creates the shared namespace and one message listener; other files register handlers on it.

(() => {
  /** @type {{ handlers: Record<string, (payload: any) => any>, listening?: boolean }} */
  const ns = (globalThis.__pagewise ??= { handlers: {} });
  if (ns.listening) return; // already injected into this page
  ns.listening = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only our own extension may drive the page (EC-INJ-07).
    if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return false;
    const handler = ns.handlers[msg.type];
    if (!handler) return false;
    Promise.resolve()
      .then(() => handler(msg.payload))
      .then(
        (result) => sendResponse({ ok: true, result }),
        (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
      );
    return true; // keep the channel open for the async response
  });
})();
