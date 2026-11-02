import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const read = (p) => readFileSync(p, 'utf8');
const readme = read('README.md');
const site = read('site/index.html');
const css = read('site/styles.css');
const shotList = read('docs/screenshots/README.md');
const testPlan = read('docs/test-plan.md');
const pages = read('.github/workflows/pages.yml');

describe('README (P4.5)', () => {
  it('has every section the plan asks for', () => {
    for (const heading of [
      'Features', 'Install', 'Get a free API key', 'First run', 'Privacy and safety', 'Permissions explained',
      'Practice site', 'Limitations', 'Development', 'Contributing', 'License'
    ]) expect(readme, heading).toMatch(new RegExp(`^## ${heading}$`, 'm'));
    expect(readme).toContain('docs/demo.gif');
  });

  it('explains every permission the manifest asks for', () => {
    const manifest = JSON.parse(read('manifest.json'));
    for (const p of manifest.permissions) expect(readme, p).toContain(`\`${p}\``);
    expect(readme).toContain('`<all_urls>`');
    expect(readme).toContain('generativelanguage.googleapis.com');
    expect(readme).toContain('api.groq.com');
  });

  it('links releases relative to the repository, so it works wherever it\'s hosted', () => {
    expect(readme).toContain('](../../releases/latest)');
  });

  it('every in-repo link points at a file that exists', () => {
    const links = [...readme.matchAll(/\]\((?!https?:|#|\.\.\/\.\.\/)([^)\s]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(5);
    for (const link of links) {
      if (/^docs\/(screenshots\/.+\.png|demo\.gif)$/.test(link)) continue; // captured by hand, see the shot list
      expect(() => readFileSync(link), link).not.toThrow();
    }
  });
});

describe('screenshots', () => {
  it('every image the README or the landing page uses is in the capture guide', () => {
    const used = new Set([
      ...[...readme.matchAll(/docs\/screenshots\/([\w-]+\.png)/g)].map((m) => m[1]),
      ...[...site.matchAll(/screenshots\/([\w-]+\.png)/g)].map((m) => m[1])
    ]);
    expect(used.size).toBeGreaterThanOrEqual(8);
    for (const file of used) expect(shotList, file).toContain(`\`${file}\``);
  });

  it('the capture guide covers the plan\'s list and the practice profile (EC-REL-09)', () => {
    for (const file of ['read-summary-en.png', 'read-summary-hinglish.png', 'chat-not-found.png', 'context-menu-draft.png', 'see-crop.png',
      'agent-badges.png', 'agent-confirm.png', 'agent-log.png', 'safety-blocked.png', 'skills-list.png']) {
      expect(shotList, file).toContain(`\`${file}\``);
    }
    expect(shotList).toContain('Asha Rao');
    expect(shotList).toMatch(/Never show real personal data/);
  });

  it('the Pages site publishes them next to the landing page', () => {
    expect(pages).toContain('cp docs/screenshots/*.png _site/screenshots/');
    expect(pages).toContain('cp docs/demo.gif _site/screenshots/');
  });
});

describe('landing page (architecture §20.4)', () => {
  it('has the hero, Read · See · Act, screenshots, the safety promise, install steps and the practice site', () => {
    expect(site).toMatch(/<h1>[^<]+<\/h1>/);
    expect(site).toContain('Read · See · Act');
    expect(site).toContain('data-gallery');
    expect(site).toContain('The safety promise');
    expect((site.match(/<ol class="steps">([\s\S]*?)<\/ol>/)?.[1].match(/<li>/g) ?? []).length).toBe(4);
    expect(site).toContain('href="practice/"');
    expect(site).toMatch(/data-gh="releases\/latest"[^>]*>Download latest release</);
  });

  it('makes no third-party requests: no trackers, fonts, CDNs or external scripts', () => {
    const external = [...site.matchAll(/<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)="(https?:)?\/\//gi)];
    expect(external).toEqual([]);
    expect(css).not.toMatch(/@import|url\(\s*['"]?https?:/);
    expect(site).not.toMatch(/googletagmanager|google-analytics|gtag\(|plausible|segment|hotjar|facebook\.net/i);
  });

  it('is responsive: viewport meta, a 16 px phone gutter, and nothing wider than the screen', () => {
    expect(site).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(css).toContain('--gutter: 16px;');
    expect(css).toMatch(/img \{ max-width: 100%;/);
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });

  it('links to this repository, and works it out from the github.io address in a fork', () => {
    expect(site).toContain('<meta name="pagewise-repo" content="Sreeramaiml/ai-browser">');
    expect(site).toContain("location.hostname.endsWith('.github.io')");
  });

  it('links the privacy policy', () => {
    expect(site).toContain('href="privacy.html"');
  });
});

describe('manual test plan (docs/test-plan.md)', () => {
  it('has every safety scenario S1–S12 and every Definition-of-Done step 0–12', () => {
    for (let i = 1; i <= 12; i++) expect(testPlan, `S${i}`).toMatch(new RegExp(`^\\| S${i} \\|`, 'm'));
    for (let i = 0; i <= 12; i++) expect(testPlan, `DoD ${i}`).toMatch(new RegExp(`^\\| ${i} \\|`, 'm'));
  });

  it('includes the weekly checkpoints and the three errands', () => {
    for (const text of ['Read (Week 1)', 'Understand (Week 2)', 'Act (Week 3)', 'A. Internship', 'B. Shop', 'C. Directory', 'Release (P4.4)']) {
      expect(testPlan, text).toContain(text);
    }
  });
});
