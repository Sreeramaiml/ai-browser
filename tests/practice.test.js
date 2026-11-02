// @vitest-environment happy-dom
// The practice site (P2.5, P3.1, architecture §18): every page loads, its script runs, and the real
// scanner numbers what the agent will need, with the safety flags in the right places.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'practice');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

let createScanner;
beforeAll(async () => {
  globalThis.__sahayak = { handlers: {} };
  await import('../src/content/generated/field-rules.classic.js');
  await import('../src/content/generated/action-rules.classic.js');
  await import('../src/content/scanner.js');
  createScanner = globalThis.__sahayak.createScanner;
});
afterEach(() => vi.useRealTimers());

/** Every element gets a box in the viewport, except the 1×1 visually-hidden pattern. */
const layout = (el) => (el.classList?.contains('visually-hidden')
  ? { left: 0, top: 0, width: 1, height: 1, right: 1, bottom: 1 }
  : { left: 10, top: 10, width: 100, height: 20, right: 110, bottom: 30 });
const scan = () => createScanner({ getRect: layout, viewport: () => ({ width: 1000, height: 800, scrollX: 0 }), elementFromPoint: () => null }).scan();
const byName = (r, name) => r.elements.find((d) => d.name === name);

/**
 * Load a practice page at a URL and run its scripts (local ones by file, inline ones as written).
 * @param {string} path page file under practice/
 * @param {string} [query]
 */
function load(path, query = '') {
  window.happyDOM.setURL(`http://localhost:3000/${path.replace(/index\.html$/, '')}${query}`);
  const html = read(path).replace(/<link [^>]*>/g, ''); // happy-dom doesn't load stylesheets
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const scripts = [...doc.querySelectorAll('script')];
  for (const s of scripts) s.remove();
  document.title = doc.title;
  document.body.innerHTML = doc.body.innerHTML;
  const dir = dirname(path);
  for (const s of scripts) {
    const src = s.getAttribute('src');
    const code = src ? read(join(dir, src)) : s.textContent;
    new Function(code)(); // eslint-disable-line no-new-func
  }
}

/** Every .html file in practice/. */
function pages(dir = '') {
  return readdirSync(join(ROOT, dir)).flatMap((f) => {
    const rel = dir ? `${dir}/${f}` : f;
    if (statSync(join(ROOT, rel)).isDirectory()) return pages(rel);
    return f.endsWith('.html') ? [rel] : [];
  });
}

describe('practice site', () => {
  it('every page is marked as a practice page and links the shared stylesheet', () => {
    const all = pages();
    expect(all.length).toBeGreaterThanOrEqual(11);
    for (const p of all) {
      expect(read(p), p).toContain('<meta name="sahayak-practice" content="1">');
      expect(read(p), p).toMatch(/assets\/practice\.css/);
    }
  });

  it('the landing page links every task', () => {
    load('index.html');
    const links = [...document.querySelectorAll('.tasks a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['internship/', 'shop/', 'directory/', 'safety/', 'chaos/']);
  });
});

describe('internship', () => {
  it.each([
    ['1', ['Full name', 'Email', 'Phone number', 'Next']],
    ['2', ['College name', 'Degree', 'Graduation year', 'I am currently enrolled', 'Back', 'Next']],
    ['3', ['Why do you want this internship?', 'Upload resume (PDF)', 'Back', 'Submit application']]
  ])('step %s shows only its own fields, all numbered', (step, names) => {
    load('internship/index.html', `?step=${step}`);
    const r = scan();
    const formNames = r.elements.filter((d) => d.formId).map((d) => d.name);
    expect(formNames).toEqual(names);
    expect(document.title).toContain(`Step ${step} of 3`);
  });

  it('has the field kinds the agent needs, and Submit needs a second confirmation', () => {
    load('internship/index.html', '?step=2');
    let r = scan();
    expect(byName(r, 'Degree')).toMatchObject({ role: 'combobox', options: ['Select', 'B.Tech', 'B.Sc', 'BCA', 'MCA', 'Other'] });
    expect(byName(r, 'Graduation year')).toMatchObject({ role: 'textbox', inputType: 'number' });
    expect(byName(r, 'I am currently enrolled').role).toBe('checkbox');
    load('internship/index.html', '?step=3');
    r = scan();
    expect(byName(r, 'Upload resume (PDF)').role).toBe('file');
    expect(byName(r, 'Submit application')).toMatchObject({ consequential: true });
    expect(byName(r, 'Submit application').blocked).toBeUndefined();
  });

  it('numbers the same way on every scan (§11.3)', () => {
    load('internship/index.html', '?step=1');
    const a = scan().elements.map((d) => [d.id, d.fingerprint]);
    const b = scan().elements.map((d) => [d.id, d.fingerprint]);
    expect(b).toEqual(a);
  });

  it('puts back what was typed on an earlier visit', () => {
    sessionStorage.clear();
    load('internship/index.html', '?step=2');
    window.practice.save('internship', { college: 'IIT Hyderabad', degree: 'B.Tech', enrolled: 'yes' });
    load('internship/index.html', '?step=2');
    expect(document.querySelector('[name="college"]').value).toBe('IIT Hyderabad');
    expect(document.querySelector('[name="degree"]').value).toBe('B.Tech');
    expect(document.querySelector('[name="enrolled"]').checked).toBe(true);
  });

  it('refuses to move on with a required field empty', () => {
    load('internship/index.html', '?step=1');
    const form = document.getElementById('step-1');
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(form.querySelector('[data-error]').hidden).toBe(false);
    expect(form.querySelector('[data-error]').textContent).toBe('Please fill in "Full name" correctly.');
  });

  it('the success page echoes the submitted values as text', () => {
    sessionStorage.clear();
    load('internship/success.html');
    window.practice.save('internship', { fullName: 'Asha Rao', email: 'asha@example.com', degree: 'B.Tech', statement: '<b>hi</b>' });
    load('internship/success.html');
    const value = (k) => document.querySelector(`[data-field="${k}"]`).textContent;
    expect(value('fullName')).toBe('Asha Rao');
    expect(value('degree')).toBe('B.Tech');
    expect(value('phone')).toBe('—');
    expect(value('statement')).toBe('<b>hi</b>');
    expect(document.querySelector('dd b')).toBeNull();
  });
});

describe('shop', () => {
  const titles = () => [...document.querySelectorAll('#results h3')].map((h) => h.textContent);

  it('numbers the search, filters, sort and paging, and none of them needs a second confirmation', () => {
    load('shop/index.html');
    const r = scan();
    for (const name of ['Search products', 'Search', 'Headphones', 'Speakers', 'Chargers', 'Smartwatches', 'Price range', 'Sort by', 'Clear filters', 'Next page']) {
      expect(byName(r, name), name).toBeDefined();
    }
    expect(r.elements.filter((d) => d.consequential)).toEqual([]);
    expect(byName(r, 'Price range').options).toEqual(['Any price', 'Under ₹1,000', 'Under ₹3,000', 'Under ₹5,000', '₹5,000 and above']);
  });

  it('shows 3 pages of 9 results from the product list', () => {
    load('shop/index.html');
    expect(titles()).toHaveLength(9);
    expect(document.getElementById('status').textContent).toBe('Showing 1–9 of 27 products');
    expect(document.getElementById('page-info').textContent).toBe('Page 1 of 3');
    document.getElementById('next').click();
    document.getElementById('next').click();
    expect(document.getElementById('page-info').textContent).toBe('Page 3 of 3');
    expect(document.getElementById('next').disabled).toBe(true);
  });

  it('errand B: wireless headphones under ₹3,000, cheapest first', () => {
    load('shop/index.html');
    document.getElementById('q').value = 'wireless headphones';
    document.getElementById('search').click();
    const box = document.querySelector('input[value="headphones"]');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    for (const [id, value] of [['price', '0-2999'], ['sort', 'price-asc']]) {
      document.getElementById(id).value = value;
      document.getElementById(id).dispatchEvent(new Event('change'));
    }
    expect(titles()).toEqual([
      'Megh Wireless Neckband', 'Vayu Sport Wireless Earbuds', 'Dhun Kids Wireless Headphones',
      'Pulse Bass Wireless Headphones', 'Sonora Air Wireless Headphones', 'Tarang Wireless Headphones'
    ]);
    expect(location.search).toBe('?q=wireless+headphones&cat=headphones&price=0-2999&sort=price-asc');
  });

  it('keeps the search in the URL, so a reload shows the same results', () => {
    load('shop/index.html', '?q=power+bank&sort=price-desc');
    expect(document.getElementById('q').value).toBe('power bank');
    expect(titles()).toEqual(['Urja 20000 mAh Power Bank', 'Urja 10000 mAh Power Bank']);
  });
});

describe('directory', () => {
  it.each([
    ['1', 'Robotics Club', ['Next']],
    ['2', 'Literary Society', ['Previous', 'Next']],
    ['3', 'Quiz Club', ['Previous']]
  ])('page %s lists 5 clubs and the right page links', (page, first, links) => {
    load('directory/index.html', `?page=${page}`);
    const rows = [...document.querySelectorAll('#clubs tr')];
    expect(rows).toHaveLength(5);
    expect(rows[0].cells[0].textContent).toBe(first);
    expect(rows[0].cells[2].textContent).toMatch(/@clubs\.college\.example$/);
    expect([...document.querySelectorAll('.pager a')].map((a) => a.textContent)).toEqual(links);
    expect(byName(scan(), 'Next')?.href ?? null).toBe(page === '3' ? null : `/directory/?page=${Number(page) + 1}`);
  });
});

describe('safety pages: fields are 🔒 and their buttons ⛔', () => {
  it.each([
    ['login.html', [['Password', 'password']], 'Log in'],
    ['otp.html', [['One-time code', 'otp']], 'Verify'],
    ['card.html', [['Name on card', 'card'], ['Card number', 'card'], ['Expiry (MM/YY)', 'card'], ['CVV', 'card']], 'Pay now'],
    ['upi.html', [['UPI ID', 'card']], 'Verify and pay']
  ])('%s', (file, fields, button) => {
    load(`safety/${file}`);
    const r = scan();
    for (const [name, kind] of fields) expect(byName(r, name)?.protected, name).toBe(kind);
    expect(byName(r, button)).toMatchObject({ consequential: true, blocked: true });
  });

  it('the unlabelled 6-digit box on the OTP screen is protected too (EC-FLD-07)', () => {
    load('safety/otp.html');
    const r = scan();
    const boxes = r.elements.filter((d) => d.role === 'textbox');
    expect(boxes).toHaveLength(2);
    expect(boxes.map((d) => d.protected)).toEqual(['otp', 'otp']);
    expect(r.pageOtp).toBe(true);
  });

  it('submitting goes nowhere and says so', () => {
    load('safety/login.html');
    document.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(document.querySelector('[data-sent]').hidden).toBe(false);
  });
});

describe('chaos page', () => {
  it('the late button appears after 2 s; the shadow-DOM button is found; the hidden field is not', () => {
    vi.useFakeTimers();
    load('chaos/index.html');
    let r = scan();
    expect(byName(r, 'I appeared late')).toBeUndefined();
    expect(byName(r, 'Button inside shadow DOM')).toBeDefined();
    expect(byName(r, 'Your name')).toBeDefined();
    expect(byName(r, 'Leave this field empty')).toBeUndefined();
    vi.advanceTimersByTime(2000);
    r = scan();
    expect(byName(r, 'I appeared late')).toBeDefined();
  });

  it('the list is rebuilt every 5 s, and the scanner re-finds a Like button by fingerprint', () => {
    vi.useFakeTimers();
    load('chaos/index.html');
    const scanner = createScanner({ getRect: layout, viewport: () => ({ width: 1000, height: 800, scrollX: 0 }), elementFromPoint: () => null });
    const r = scanner.scan();
    const like = r.elements.find((d) => d.name === 'Like' && d.context?.startsWith('Hackathon'));
    const before = scanner.resolve(r.snapshotId, like.id);
    vi.advanceTimersByTime(5000);
    expect(document.getElementById('renders').textContent).toBe('1');
    expect(before.isConnected).toBe(false);
    const after = scanner.resolve(r.snapshotId, like.id);
    expect(after.isConnected).toBe(true);
    after.click();
    expect(document.querySelector('#live-list li span').textContent).toBe('Hackathon this Saturday · 1 like');
  });
});
