import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  INCLUDE, PackageError, buildPackage, changelogSection, checkVersions, crc32, createZip, findSecrets, missingFiles,
  readZip, unexpectedPaths
} from '../scripts/package.mjs';

/** A throwaway copy of what the packager reads, to break on purpose. */
const temps = [];
function copyRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'pagewise-pkg-'));
  temps.push(dir);
  for (const item of [...INCLUDE, 'package.json', 'scripts']) cpSync(item, join(dir, item), { recursive: true });
  return dir;
}
afterEach(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const fail = (fn) => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected it to fail');
};

describe('release ZIP (architecture §20.2)', () => {
  it('packages the repo: only manifest.json, src/, vendor/ and assets/ (EC-REL-04)', () => {
    const { entries, zip, label } = buildPackage();
    const names = entries.map((e) => e.name);
    expect(label).toBe(`v${JSON.parse(readFileSync('manifest.json', 'utf8')).version}`);
    expect(new Set(names.map((n) => n.split('/')[0]))).toEqual(new Set(['manifest.json', 'src', 'vendor', 'assets']));
    expect(names).toContain('src/content/generated/field-rules.classic.js'); // EC-REL-05
    expect(names).toContain('vendor/licenses/dompurify-LICENSE');
    expect(names.some((n) => /\.DS_Store|\.gitkeep|^tests\/|^practice\/|node_modules/.test(n))).toBe(false);
    expect(readZip(zip).map((e) => e.name)).toEqual(names);
  });

  it('is reproducible: the same sources give the same bytes', () => {
    expect(buildPackage().zip.equals(buildPackage().zip)).toBe(true);
  });

  it('round-trips every file exactly', () => {
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello') },
      { name: 'dir/ü.json', data: Buffer.from('{"x":1}') },
      { name: 'empty', data: Buffer.alloc(0) },
      { name: 'bin.png', data: Buffer.from([0, 255, 1, 254, 0x50, 0x4b, 0x05, 0x06]) }
    ];
    const back = readZip(createZip(entries));
    expect(back.map((e) => [e.name, e.data.toString('hex')])).toEqual(entries.map((e) => [e.name, e.data.toString('hex')]));
  });

  it('crc32 matches the standard check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('refuses to ship a key-shaped string, saying where it is', () => {
    const dir = copyRepo();
    writeFileSync(join(dir, 'src/shared/oops.js'), `// test\nexport const KEY = '${'AIza' + 'Q'.repeat(35)}';\n`);
    const err = fail(() => buildPackage({ root: dir }));
    expect(err).toBeInstanceOf(PackageError);
    expect(err.message).toMatch(/shaped like an API key[\s\S]*src\/shared\/oops\.js:2/);
  });

  it('finds Gemini, Groq and Claude key shapes, and nothing in ordinary text', () => {
    const e = (text) => [{ name: 'f.js', data: Buffer.from(text) }];
    expect(findSecrets(e(`a\nconst k = "${'gsk_' + 'z'.repeat(24)}";`))).toEqual(['f.js:2']);
    expect(findSecrets(e(`x ${'sk-ant-' + 'y'.repeat(24)}`))).toEqual(['f.js:1']);
    expect(findSecrets(e(`x AQ.${'a'.repeat(40)}`))).toEqual(['f.js:1']);
    expect(findSecrets(e("const GEMINI_KEY_RE = /^(?:AIza[0-9A-Za-z_-]{35})$/; // 'AIza' + 'x'.repeat(35)"))).toEqual([]);
  });

  it('refuses out-of-date generated safety rules (EC-REL-05)', () => {
    const dir = copyRepo();
    writeFileSync(join(dir, 'src/content/generated/field-rules.classic.js'), '// stale\n');
    expect(fail(() => buildPackage({ root: dir })).message).toMatch(/generated safety rules are out of date/);
  });

  it('leaves out junk and never ships tests or practice files', () => {
    const dir = copyRepo();
    writeFileSync(join(dir, 'src/.DS_Store'), 'x');
    writeFileSync(join(dir, 'vendor/marked.esm.js.map'), '{}');
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'tests/x.test.js'), '');
    const names = buildPackage({ root: dir }).entries.map((e) => e.name);
    expect(names.filter((n) => /\.DS_Store|\.map$|^tests\//.test(n))).toEqual([]);
  });

  it('refuses a package missing a file the extension loads', () => {
    const dir = copyRepo();
    rmSync(join(dir, 'src/content/youtube.js'));
    expect(fail(() => buildPackage({ root: dir })).message).toMatch(/src\/content\/youtube\.js \(needed by tab-context\.js CONTENT_FILES\)/);
  });

  it('finds missing manifest files, page scripts and module imports', () => {
    const entries = [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify({ background: { service_worker: 'src/sw.js' }, icons: { 16: 'assets/16.png' } })) },
      { name: 'src/sw.js', data: Buffer.from("import { a } from './lib/a.js';\nconst b = await import('../x/b.js');") },
      { name: 'src/page.html', data: Buffer.from('<script type="module" src="app.js"></script><link rel="stylesheet" href="https://fonts.example/x.css">') }
    ];
    const missing = missingFiles(entries).join('\n');
    expect(missing).toContain('assets/16.png (needed by manifest.json)');
    expect(missing).toContain('src/lib/a.js (needed by src/sw.js)');
    expect(missing).toContain('x/b.js (needed by src/sw.js)');
    expect(missing).toContain('src/app.js (needed by src/page.html)');
    expect(missing).not.toContain('fonts.example');
  });

  it('flags any unexpected path in the ZIP (EC-REL-04)', () => {
    expect(unexpectedPaths(['manifest.json', 'src/a.js', 'vendor/x.js', 'assets/icons/16.png'])).toEqual([]);
    expect(unexpectedPaths(['tests/a.test.js', 'practice/index.html', 'node_modules/x/y.js', 'src/.DS_Store', 'docs/a.md', '.git/HEAD', 'src/../x', 'README.md']))
      .toHaveLength(8);
  });
});

describe('versions (EC-REL-03)', () => {
  it('accepts matching versions, with or without a tag', () => {
    expect(() => checkVersions({ manifest: '1.0.0', pkg: '1.0.0' })).not.toThrow();
    expect(() => checkVersions({ manifest: '1.0.0', pkg: '1.0.0', tag: 'v1.0.0' })).not.toThrow();
    expect(() => checkVersions({ manifest: '0.9.0', pkg: '0.9.0', tag: 'v0.9.0-rc1' })).not.toThrow();
  });

  it('explains every mismatch at once', () => {
    const err = fail(() => checkVersions({ manifest: '1.0.0', pkg: '1.0.1', tag: 'v1.1.0' }));
    expect(err.message).toMatch(/manifest.json says 1.0.0 but package.json says 1.0.1/);
    expect(err.message).toMatch(/Tag v1.1.0 is for version 1.1.0, but manifest.json says 1.0.0/);
  });

  it('refuses versions Chrome can\'t load and malformed tags', () => {
    expect(fail(() => checkVersions({ manifest: '1.0.0-beta', pkg: '1.0.0-beta' })).message).toMatch(/isn't a Chrome version/);
    expect(fail(() => checkVersions({ manifest: '1.0.0', pkg: '1.0.0', tag: 'release-1' })).message).toMatch(/v1.2.3/);
  });
});

describe('release notes from CHANGELOG.md', () => {
  const log = '# Changelog\n\nIntro\n\n## [Unreleased]\n\n- next\n\n## [1.0.0] - 2026-11-28\n\n### Added\n\n- all of it\n\n## [0.9.0] - 2026-11-20\n\n- rc\n';
  it('picks the version\'s section, then the base version, then Unreleased', () => {
    expect(changelogSection(log, 'v1.0.0')).toBe('### Added\n\n- all of it');
    expect(changelogSection(log, 'v0.9.0-rc1')).toBe('- rc');
    expect(changelogSection(log, 'v2.0.0')).toBe('- next');
  });

  it('fails when there is nothing to say', () => {
    expect(fail(() => changelogSection('# Changelog\n', 'v1.0.0'))).toBeInstanceOf(PackageError);
  });

  it('the real CHANGELOG.md gives notes for the next release', () => {
    expect(changelogSection(readFileSync('CHANGELOG.md', 'utf8'), 'v1.0.0')).toMatch(/### Added/);
  });
});

describe('GitHub workflows (architecture §20.3)', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const release = readFileSync('.github/workflows/release.yml', 'utf8');
  const pages = readFileSync('.github/workflows/pages.yml', 'utf8');

  it('CI: npm ci, sync check, tests, the safety suite, gitleaks over the whole history, ZIP dry run', () => {
    for (const step of ['npm ci', 'npm run sync -- --check', 'npm test', 'npm run test:safety', 'gitleaks/gitleaks-action', 'fetch-depth: 0', 'node scripts/package.mjs --check']) {
      expect(ci, step).toContain(step);
    }
  });

  it('Release: only on v* tags, tests before packaging, ZIP and changelog attached (EC-REL-07)', () => {
    expect(release).toMatch(/tags: \['v\*'\]/);
    const order = ['npm test', 'npm run test:safety', 'package.mjs --tag', 'package.mjs --notes', 'gh release create'].map((s) => release.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(release).toContain('dist/pagewise-${GITHUB_REF_NAME}.zip');
    expect(release).toContain('--prerelease');
  });

  it('Pages: site/ at the root and practice/ under /practice/ (EC-REL-08)', () => {
    expect(pages).toContain('cp -R site/. _site/');
    expect(pages).toContain('cp -R practice/. _site/practice/');
    expect(pages).toContain('actions/deploy-pages');
  });
});
