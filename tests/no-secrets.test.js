import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Key shapes for Gemini (AIza… and the newer AQ.…), Groq (gsk_…) and Claude (sk-ant-…). See EC-SET-13 / EC-REL-01.
const KEY_PATTERNS = [/sk-ant-[A-Za-z0-9_-]{20,}/, /gsk_[A-Za-z0-9]{20,}/, /AIza[0-9A-Za-z_-]{35}/, /AQ\.[A-Za-z0-9._-]{30,}/];

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(js|mjs|json|html|css)$/.test(name)) yield p;
  }
}

describe('no API keys in shipped source', () => {
  it('src/ and manifest.json contain no key-shaped strings', () => {
    const files = [...walk(join(root, 'src')), join(root, 'manifest.json')];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const re of KEY_PATTERNS) {
        expect(re.test(text), `${relative(root, file)} matches ${re}`).toBe(false);
      }
    }
  });

  it('nothing in the repository is key-shaped either: docs, tests, site, config (P4.5)', () => {
    const skip = new Set(['node_modules', '.git', 'dist', 'coverage']);
    const hits = [];
    const visit = (dir) => {
      for (const name of readdirSync(dir)) {
        if (skip.has(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) visit(p);
        else readFileSync(p, 'latin1').split('\n').forEach((line, i) => {
          if (KEY_PATTERNS.some((re) => re.test(line))) hits.push(`${relative(root, p)}:${i + 1}`);
        });
      }
    };
    visit(root);
    expect(hits).toEqual([]);
  });
});
