import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('manifest.json', () => {
  it('is Manifest V3 with a module service worker', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.background.type).toBe('module');
  });

  it('version matches package.json', () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it('references files that exist', () => {
    const paths = [
      manifest.background.service_worker,
      manifest.side_panel.default_path,
      manifest.options_page,
      ...Object.values(manifest.icons),
      ...Object.values(manifest.action.default_icon)
    ];
    for (const p of paths) {
      expect(existsSync(join(root, p)), `missing ${p}`).toBe(true);
    }
  });

  it('declares the permissions the architecture relies on', () => {
    for (const perm of ['sidePanel', 'storage', 'contextMenus', 'scripting', 'activeTab', 'tabs']) {
      expect(manifest.permissions).toContain(perm);
    }
    expect(manifest.host_permissions).toContain('https://generativelanguage.googleapis.com/*');
    expect(manifest.host_permissions).not.toContain('https://api.anthropic.com/*');
  });

  it('does not run in incognito (edge-case D1)', () => {
    expect(manifest.incognito).toBe('not_allowed');
  });

  it('binds Alt+Shift+X to the agent kill switch (§12.7)', async () => {
    const { STOP_AGENT_COMMAND } = await import('../src/background/commands.js');
    expect(manifest.commands[STOP_AGENT_COMMAND].suggested_key.default).toBe('Alt+Shift+X');
  });

  it('declares no static content scripts (scripts are injected on demand)', () => {
    expect(manifest.content_scripts).toBeUndefined();
  });
});
