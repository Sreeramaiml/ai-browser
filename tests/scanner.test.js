// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import { buildActionMap } from '../src/shared/action-map.js';

let createScanner;

beforeAll(async () => {
  globalThis.__sahayak = { handlers: {} };
  await import('../src/content/generated/field-rules.classic.js');
  await import('../src/content/generated/action-rules.classic.js');
  await import('../src/content/scanner.js');
  createScanner = globalThis.__sahayak.createScanner;
});

/** happy-dom has no layout: every element gets a box in the viewport unless data-rect says otherwise. */
function layout(el) {
  const spec = el.getAttribute?.('data-rect');
  if (spec) {
    const [left, top, width, height] = spec.split(',').map(Number);
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  return { left: 10, top: 10, width: 100, height: 20, right: 110, bottom: 30 };
}
const make = (extra = {}) => createScanner({
  getRect: layout, viewport: () => ({ width: 1000, height: 800, scrollX: 0 }), elementFromPoint: () => null, ...extra
});
function scan(html, extra) {
  document.body.innerHTML = html;
  return make(extra).scan();
}
const names = (r) => r.elements.map((d) => d.name);

describe('scanner (architecture §11)', () => {
  it('registers the CS_SCAN handler', () => {
    expect(typeof globalThis.__sahayak.handlers.CS_SCAN).toBe('function');
  });

  it('computes accessible names in the documented order (§11.2)', () => {
    const r = scan(`
      <label for="n">Full name</label><input id="n">
      <label>Email <input type="email"></label>
      <span id="c">College</span><input aria-labelledby="c">
      <input aria-label="Phone">
      <input placeholder="Search">
      <button>Next</button>
      <input type="submit" value="Send">
      <a href="/help"><img src="x.png" alt="Help"></a>`);
    expect(names(r)).toEqual(['Full name', 'Email', 'College', 'Phone', 'Search', 'Next', 'Send', 'Help']);
    expect(r.elements.map((d) => d.role)).toEqual(['textbox', 'textbox', 'textbox', 'textbox', 'textbox', 'button', 'button', 'link']);
  });

  it('truncates long names to 80 characters', () => {
    const r = scan(`<button>${'word '.repeat(40)}</button>`);
    expect(r.elements[0].name.length).toBe(80);
  });

  it('leaves out hidden, off-screen and hidden-input elements (EC-SCN-08)', () => {
    const r = scan(`
      <button>Shown</button>
      <button style="display:none">A</button>
      <div hidden><button>B</button></div>
      <div style="visibility:hidden"><button>C</button></div>
      <div aria-hidden="true"><a href="#">D</a></div>
      <input type="hidden" value="x">
      <button data-rect="-9999,0,50,20">Off-screen</button>
      <a href="#main" data-rect="0,0,1,1">Skip to content</a>`);
    expect(names(r)).toEqual(['Shown']);
  });

  it('keeps only the outermost of nested actionable elements (EC-SCN-03)', () => {
    const r = scan('<a href="/x"><button>Go</button></a>');
    expect(r.elements).toHaveLength(1);
    expect(r.elements[0]).toMatchObject({ tag: 'a', role: 'link', name: 'Go' });
  });

  it('numbers in DOM order, the same way every time, and marks the page', () => {
    document.body.innerHTML = '<form><input name="a" aria-label="A"><select aria-label="B"><option>x</option></select><button>Save</button></form><a href="/">Home</a>';
    const scanner = make();
    const first = scanner.scan();
    const second = scanner.scan();
    expect(first.elements.map((d) => [d.id, d.name, d.fingerprint])).toEqual(second.elements.map((d) => [d.id, d.name, d.fingerprint]));
    expect(first.snapshotId).not.toBe(second.snapshotId);
    expect(names(first)).toEqual(['A', 'B', 'Save', 'Home']);
    expect(document.querySelector('button').getAttribute('data-sahayak-id')).toBe('3');
    scanner.clearMarks(); // EC-SCN-23
    expect(document.querySelector('[data-sahayak-id]')).toBeNull();
  });

  it('groups by form and names the form', () => {
    const r = scan('<form aria-label="Education details"><input aria-label="College"></form><a href="/">Home</a>');
    expect(r.forms).toEqual([{ id: 1, name: 'Education details' }]);
    expect(r.elements[0].formId).toBe(1);
    expect(r.elements[1].formId).toBeUndefined();
  });

  it('lists the first 20 select options (EC-SCN-10)', () => {
    const options = Array.from({ length: 25 }, (_, i) => `<option>Country ${i + 1}</option>`).join('');
    const r = scan(`<select aria-label="Country">${options}</select>`);
    expect(r.elements[0].options).toHaveLength(21);
    expect(r.elements[0].options.at(-1)).toBe('…(5 more)');
    expect(r.elements[0].value).toBe('Country 1');
  });

  it('flags protected fields, masks their values, and blocks the login submit (EC-SCN-25)', () => {
    const r = scan(`
      <form>
        <label for="u">Username</label><input id="u">
        <label for="p">Password</label><input id="p" type="password" value="secret">
        <button>Sign in</button>
      </form>`);
    const [user, pass, submit] = r.elements;
    expect(user.protected).toBeNull();
    expect(pass).toMatchObject({ protected: 'password', value: '••••' });
    expect(submit).toMatchObject({ consequential: true, blocked: true });
    const map = buildActionMap(r);
    expect(map).not.toContain('secret');
    expect(map).toContain('🔒protected:password');
  });

  it('protects split OTP boxes (EC-FLD-06)', () => {
    const boxes = '<input maxlength="1" inputmode="numeric">'.repeat(6);
    const r = scan(`<div>${boxes}</div>`);
    expect(r.elements.map((d) => d.protected)).toEqual(Array(6).fill('otp'));
  });

  it('finds elements inside open shadow roots', () => {
    document.body.innerHTML = '<button>Outside</button><div id="host"></div>';
    document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button>Inside</button>';
    expect(names(make().scan())).toEqual(['Outside', 'Inside']);
  });

  it('lists only the open dialog when there is one (EC-SCN-07)', () => {
    const r = scan('<button>Behind</button><div role="dialog" aria-modal="true"><p>Sure?</p><button>OK</button></div>');
    expect(names(r)).toEqual(['OK']);
    expect(r.modal).toBe(true);
  });

  it('lists radios with their group (EC-SCN-12)', () => {
    const r = scan(`<form><fieldset><legend>Degree</legend>
      <label><input type="radio" name="deg"> B.Tech</label><label><input type="radio" name="deg"> B.Sc</label></fieldset></form>`);
    expect(r.elements.map((d) => [d.role, d.name, d.group])).toEqual([['radio', 'B.Tech', 'Degree'], ['radio', 'B.Sc', 'Degree']]);
  });

  it('tells duplicate names apart by their row (EC-SCN-05, EC-SCN-17)', () => {
    const r = scan('<table><tr><td>Asha Rao</td><td><button>Edit</button></td></tr><tr><td>Ravi K</td><td><button>Edit</button></td></tr></table>');
    expect(r.elements.map((d) => d.context)).toEqual(['Asha Rao', 'Ravi K']);
    expect(r.elements[0].fingerprint).not.toBe(r.elements[1].fingerprint);
  });

  it('keeps disabled controls only inside forms (EC-SCN-13)', () => {
    const r = scan('<form><button disabled>Save</button></form><button disabled>Outside</button>');
    expect(r.elements.map((d) => [d.name, d.disabled])).toEqual([['Save', true]]);
  });

  it('marks elements covered by something else (EC-SCN-06)', () => {
    document.body.innerHTML = '<button>Under</button><div id="cover">Cookie banner</div>';
    const r = make({ elementFromPoint: () => document.getElementById('cover') }).scan();
    expect(r.elements[0].obscured).toBe(true);
  });

  it('counts frames it cannot look into (EC-SCN-14)', () => {
    expect(scan('<iframe></iframe><button>X</button>').framesNotScanned).toBe(1);
  });

  it('re-finds a re-rendered element by fingerprint, and gives up when it is gone (EC-SCN-16)', () => {
    document.body.innerHTML = '<ul><li><button>Like</button></li></ul>';
    const scanner = make();
    const r = scanner.scan();
    document.querySelector('ul').innerHTML = '<li><button>Like</button></li>'; // React-style replacement
    expect(scanner.resolve(r.snapshotId, 1)).toBe(document.querySelector('button'));
    document.querySelector('ul').innerHTML = '';
    expect(scanner.resolve(r.snapshotId, 1)).toBeNull();
    expect(scanner.resolve('another-snapshot', 1)).toBeNull();
  });

  it('finds an element by fingerprint after a newer scan or a re-render (Show again)', () => {
    document.body.innerHTML = '<button>Upload</button><button>Next</button>';
    const scanner = make();
    const first = scanner.scan();
    const upload = first.elements[0].fingerprint;
    scanner.scan(); // the old snapshot is gone ("Show numbers", "Scan again")
    expect(scanner.resolve(first.snapshotId, 1)).toBeNull();
    expect(scanner.findByFingerprint(upload)).toBe(document.querySelector('button'));
    expect(scanner.findByFingerprint('no-such-fingerprint')).toBeNull();
    document.body.innerHTML = '<button>Upload</button><button>Next</button>';
    expect(scanner.findByFingerprint(upload)).toBe(document.querySelector('button')); // re-rendered
  });
});

