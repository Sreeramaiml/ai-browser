import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const vendor = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor');
const read = (f) => readFileSync(join(vendor, f), 'utf8');

describe('vendored libraries', () => {
  it('Readability defines classic-script globals for content-script injection', () => {
    expect(read('Readability.js')).toMatch(/^function Readability\(/m);
    expect(read('Readability-readerable.js')).toMatch(/^function isProbablyReaderable\(/m);
  });

  it('marked is the pinned ES module build', () => {
    const src = read('marked.esm.js');
    expect(src).toContain('marked v18.1.1');
    expect(src).toMatch(/export\{[^}]*\bas marked\b/);
  });

  it('DOMPurify is the pinned ES module build', () => {
    const src = read('purify.es.js');
    expect(src).toContain('DOMPurify 3.4.17');
    expect(src).toContain('export { purify_default as default }');
  });

  it('has no dangling source-map references', () => {
    for (const f of ['Readability.js', 'Readability-readerable.js', 'marked.esm.js', 'purify.es.js']) {
      expect(read(f), f).not.toMatch(/sourceMappingURL/);
    }
  });

  it('ships a license for every library', () => {
    for (const f of ['readability-LICENSE.md', 'marked-LICENSE.md', 'dompurify-LICENSE']) {
      expect(existsSync(join(vendor, 'licenses', f)), f).toBe(true);
    }
  });
});
