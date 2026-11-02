import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { SOURCES, toClassic } from '../../scripts/sync-classic.mjs';
import * as fieldRules from '../../src/shared/safety/field-rules.js';
import * as actionRules from '../../src/shared/safety/action-rules.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const MODULES = { fieldRules, actionRules };

describe('classic copies of the safety rules (architecture §14.6)', () => {
  for (const { from, to, ns } of SOURCES) {
    it(`${to} is up to date with ${from}`, () => {
      expect(read(to)).toBe(toClassic(read(from), ns, from));
    });

    it(`${to} exposes the same functions on __pagewiseShared.${ns}, and survives being injected twice`, () => {
      const sandbox = { globalThis: undefined };
      sandbox.globalThis = sandbox;
      runInNewContext(read(to), sandbox);
      runInNewContext(read(to), sandbox); // re-injection must not throw "already declared"
      const exposed = sandbox.__pagewiseShared[ns];
      expect(Object.keys(exposed).sort()).toEqual(Object.keys(MODULES[ns]).sort());
    });
  }

  it('the classic copy behaves like the module', () => {
    const sandbox = {};
    sandbox.globalThis = sandbox;
    runInNewContext(read('src/content/generated/field-rules.classic.js'), sandbox);
    const classic = sandbox.__pagewiseShared.fieldRules;
    for (const f of [{ type: 'password' }, { label: 'Enter OTP' }, { label: 'PIN code' }, { autocomplete: 'cc-number' }]) {
      expect(classic.classifyField(f)).toBe(fieldRules.classifyField(f));
    }
  });

  it('rejects a source that breaks the format', () => {
    expect(() => toClassic('const a = 1;\nexport default a;\n', 'x', 'bad.js')).toThrow();
    expect(() => toClassic("import x from 'y';\nexport { x };\n", 'x', 'bad.js')).toThrow();
  });
});
