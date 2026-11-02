// @ts-check
// Small text utilities shared by the service worker and tests.

/**
 * Fit text into a character budget, keeping the start (where articles put the main point) and the
 * end (conclusions). Returns whether anything was cut (EC-ART-04).
 * @param {string} text
 * @param {number} budget
 * @returns {{ text: string, truncated: boolean }}
 */
export function fitToBudget(text, budget) {
  if (text.length <= budget) return { text, truncated: false };
  const marker = '\n\n[… middle of the page omitted …]\n\n';
  const room = Math.max(0, budget - marker.length);
  const head = Math.floor(room * 0.75);
  const tail = room - head;
  return { text: text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : ''), truncated: true };
}

/**
 * Fast non-cryptographic hash (FNV-1a, 32-bit) for cache keys. Collisions only cost a cache miss.
 * @param {string} text
 * @returns {string} 8 hex chars
 */
export function hashString(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Pull a JSON object out of model output, tolerating ```json fences and stray prose around it.
 * @param {string} raw
 * @returns {{ ok: true, value: unknown } | { ok: false, error: string }}
 */
export function parseModelJson(raw) {
  let text = String(raw ?? '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced) text = fenced[1];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, error: 'The reply did not contain a JSON object.' };
  try {
    return { ok: true, value: JSON.parse(text.slice(start, end + 1)) };
  } catch (err) {
    return { ok: false, error: `The reply was not valid JSON (${err instanceof Error ? err.message : 'parse error'}).` };
  }
}
