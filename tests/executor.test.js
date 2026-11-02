// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

let ns;

/** happy-dom has no layout: give every element a box in the viewport. */
const layout = () => ({ left: 10, top: 10, width: 100, height: 20, right: 110, bottom: 30 });

beforeAll(async () => {
  globalThis.__pagewise = { handlers: {} };
  await import('../src/content/generated/field-rules.classic.js');
  await import('../src/content/generated/action-rules.classic.js');
  await import('../src/content/scanner.js');
  await import('../src/content/executor.js');
  ns = globalThis.__pagewise;
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

const PAGE = `
  <form id="apply">
    <label for="name">Full name</label><input id="name" name="name">
    <label for="bio">Statement</label><textarea id="bio"></textarea>
    <label for="degree">Degree</label>
    <select id="degree"><option value="">Select</option><option value="btech">B.Tech</option><option value="bsc">B.Sc</option></select>
    <fieldset><legend>Availability</legend>
      <label><input type="radio" name="avail" value="ft"> Full time</label>
      <label><input type="radio" name="avail" value="pt"> Part time</label>
    </fieldset>
    <label for="cv">Upload resume</label><input id="cv" type="file">
    <button type="submit">Submit application</button>
  </form>
  <form id="login">
    <label for="pw">Password</label><input id="pw" type="password">
    <button type="submit">Log in</button>
  </form>
  <a href="https://other.example/" target="_blank">Elsewhere</a>`;

let snap;
beforeEach(() => {
  document.body.innerHTML = PAGE;
  ns.scanner = ns.createScanner({ getRect: layout, viewport: () => ({ width: 1000, height: 800, scrollX: 0 }), elementFromPoint: () => null });
  snap = ns.scanner.scan();
});

/** The scan id of the element named `name`. */
const idOf = (name) => snap.elements.find((d) => d.name === name).id;
const exec = (name, action, extra = {}) => ns.handlers.CS_EXECUTE({
  snapshotId: snap.snapshotId, elementId: idOf(name), fingerprint: snap.elements.find((d) => d.name === name).fingerprint, action, ...extra
});

describe('executor (architecture §12.6)', () => {
  it('types with input and change events, so frameworks notice', async () => {
    const el = document.getElementById('name');
    const events = [];
    el.addEventListener('input', () => events.push('input'));
    el.addEventListener('change', () => events.push('change'));
    const r = await exec('Full name', { type: 'type', value: 'Asha Rao' });
    expect(r).toMatchObject({ ok: true, effect: { valueAfter: 'Asha Rao', navigated: false } });
    expect(el.value).toBe('Asha Rao');
    expect(events).toEqual(['input', 'change']);
    expect((await exec('Statement', { type: 'type', value: 'Hello' })).ok).toBe(true);
    expect(document.getElementById('bio').value).toBe('Hello');
  });

  it('selects by label, then by value', async () => {
    const select = document.getElementById('degree');
    expect(await exec('Degree', { type: 'select', value: ' b.tech ' })).toMatchObject({ ok: true, effect: { valueAfter: 'B.Tech' } });
    expect(select.value).toBe('btech');
    expect((await exec('Degree', { type: 'select', value: 'bsc' })).ok).toBe(true);
    expect(select.value).toBe('bsc');
    expect(await exec('Degree', { type: 'select', value: 'M.Tech' })).toMatchObject({ ok: false, code: 'BAD_OPTION' });
  });

  it('picks the matching radio in a group', async () => {
    expect((await exec('Full time', { type: 'select', value: 'Part time' })).ok).toBe(true);
    expect(document.querySelector('input[value="pt"]').checked).toBe(true);
  });

  it('never types into a password field, even if asked directly', async () => {
    expect(await exec('Password', { type: 'type', value: 'hunter2' })).toMatchObject({ ok: false, code: 'PROTECTED_FIELD' });
    expect(document.getElementById('pw').value).toBe('');
  });

  it('refuses secret-looking values in ordinary fields', async () => {
    expect(await exec('Full name', { type: 'type', value: '4111 1111 1111 1111' })).toMatchObject({ ok: false, code: 'BLOCKED' });
  });

  it('never clicks a login button, and a consequential click needs the confirmation', async () => {
    let submitted = 0;
    document.getElementById('apply').addEventListener('submit', (e) => { e.preventDefault(); submitted++; });
    document.getElementById('login').addEventListener('submit', (e) => { e.preventDefault(); submitted += 100; });
    expect(await exec('Log in', { type: 'click' }, { confirmed: true })).toMatchObject({ ok: false, code: 'BLOCKED' });
    expect(await exec('Submit application', { type: 'click' })).toMatchObject({ ok: false, code: 'NEEDS_CONFIRMATION' });
    expect(submitted).toBe(0);
    expect((await exec('Submit application', { type: 'click' }, { confirmed: true })).ok).toBe(true);
    expect(submitted).toBe(1);
  });

  it('leaves file inputs to the user and refuses other-site new-tab links', async () => {
    expect(await exec('Upload resume', { type: 'click' })).toMatchObject({ ok: false, code: 'FILE_INPUT' });
    expect(await exec('Elsewhere', { type: 'click' })).toMatchObject({ ok: false, code: 'NEW_TAB_LINK' });
  });

  it('re-finds a re-rendered element by fingerprint, and reports STALE_TARGET when it is gone', async () => {
    const name = idOf('Full name');
    const { fingerprint } = snap.elements.find((d) => d.id === name);
    document.getElementById('name').replaceWith(Object.assign(document.createElement('input'), { id: 'name' }));
    expect((await ns.handlers.CS_EXECUTE({ snapshotId: snap.snapshotId, elementId: name, fingerprint, action: { type: 'type', value: 'A' } })).ok).toBe(true);
    expect(document.getElementById('name').value).toBe('A');
    document.getElementById('name').remove();
    document.querySelector('label[for="name"]').remove();
    expect(await ns.handlers.CS_EXECUTE({ snapshotId: snap.snapshotId, elementId: name, fingerprint, action: { type: 'type', value: 'A' } }))
      .toMatchObject({ ok: false, code: 'STALE_TARGET' });
  });

  it('scrolls the page without a target, and rejects unknown steps', async () => {
    const calls = [];
    window.scrollBy = (opts) => calls.push(opts);
    expect((await ns.handlers.CS_EXECUTE({ action: { type: 'scroll', direction: 'down' } })).ok).toBe(true);
    expect(calls[0].top).toBeGreaterThan(0);
    expect(await ns.handlers.CS_EXECUTE({ action: { type: 'scroll' } })).toMatchObject({ ok: false, code: 'BAD_ACTION' });
    expect(await exec('Full name', { type: 'hover' })).toMatchObject({ ok: false, code: 'BAD_ACTION' });
  });
});
