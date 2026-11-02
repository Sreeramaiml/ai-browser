// Gadget Shop: filter, sort and page through a fixed product list. The current search lives in
// the URL (?q=&cat=&price=&sort=&page=), so a reload shows the same results.
(() => {
  const PAGE_SIZE = 9;

  /** Fictional products. Prices in rupees, ratings out of 5. */
  const PRODUCTS = [
    { name: 'Sonora Air Wireless Headphones', category: 'headphones', price: 2499, rating: 4.3, tags: 'wireless bluetooth over-ear' },
    { name: 'Pulse Bass Wireless Headphones', category: 'headphones', price: 1799, rating: 4.1, tags: 'wireless bluetooth on-ear' },
    { name: 'Nimbus ANC Wireless Headphones', category: 'headphones', price: 5999, rating: 4.6, tags: 'wireless noise cancelling over-ear' },
    { name: 'Echo Lite Wired Headphones', category: 'headphones', price: 899, rating: 3.9, tags: 'wired on-ear' },
    { name: 'Vayu Sport Wireless Earbuds', category: 'headphones', price: 1299, rating: 4.0, tags: 'wireless headphones earbuds sport' },
    { name: 'Raga Studio Wired Headphones', category: 'headphones', price: 3499, rating: 4.4, tags: 'wired studio over-ear' },
    { name: 'Tarang Wireless Headphones', category: 'headphones', price: 2999, rating: 4.2, tags: 'wireless bluetooth over-ear' },
    { name: 'Megh Wireless Neckband', category: 'headphones', price: 999, rating: 3.8, tags: 'wireless headphones neckband' },
    { name: 'Sonora Pro Wireless Headphones', category: 'headphones', price: 3299, rating: 4.5, tags: 'wireless bluetooth over-ear' },
    { name: 'Dhun Kids Wireless Headphones', category: 'headphones', price: 1499, rating: 4.0, tags: 'wireless kids on-ear' },
    { name: 'Bolt Mini Bluetooth Speaker', category: 'speakers', price: 1199, rating: 4.1, tags: 'wireless portable' },
    { name: 'Bolt Max Party Speaker', category: 'speakers', price: 6499, rating: 4.4, tags: 'wireless party' },
    { name: 'Sur Pocket Speaker', category: 'speakers', price: 799, rating: 3.7, tags: 'wireless portable' },
    { name: 'Sur Home Smart Speaker', category: 'speakers', price: 3999, rating: 4.2, tags: 'wireless smart voice' },
    { name: 'Lehar Waterproof Speaker', category: 'speakers', price: 2199, rating: 4.3, tags: 'wireless waterproof portable' },
    { name: 'Gaana Soundbar 120W', category: 'speakers', price: 7999, rating: 4.5, tags: 'tv soundbar' },
    { name: 'Chhota 20W Fast Charger', category: 'chargers', price: 599, rating: 4.0, tags: 'usb-c wall' },
    { name: 'Shakti 65W GaN Charger', category: 'chargers', price: 2499, rating: 4.6, tags: 'usb-c laptop wall' },
    { name: 'Chakra Wireless Charging Pad', category: 'chargers', price: 1299, rating: 3.9, tags: 'wireless qi' },
    { name: 'Raah Dual Car Charger', category: 'chargers', price: 449, rating: 3.8, tags: 'car usb' },
    { name: 'Urja 10000 mAh Power Bank', category: 'chargers', price: 1499, rating: 4.2, tags: 'battery portable' },
    { name: 'Urja 20000 mAh Power Bank', category: 'chargers', price: 2299, rating: 4.3, tags: 'battery portable' },
    { name: 'Samay Fit Band', category: 'smartwatches', price: 1999, rating: 3.9, tags: 'fitness band' },
    { name: 'Samay Watch 2', category: 'smartwatches', price: 4499, rating: 4.2, tags: 'smartwatch calling' },
    { name: 'Kaal Sport Watch', category: 'smartwatches', price: 2999, rating: 4.1, tags: 'smartwatch gps sport' },
    { name: 'Kaal Pro Watch', category: 'smartwatches', price: 8999, rating: 4.6, tags: 'smartwatch amoled' },
    { name: 'Pal Kids Watch', category: 'smartwatches', price: 1799, rating: 4.0, tags: 'smartwatch kids gps' }
  ];

  const $ = (id) => document.getElementById(id);
  const rupees = (n) => `₹${n.toLocaleString('en-IN')}`;

  function readState() {
    const p = new URLSearchParams(location.search);
    return {
      q: p.get('q') ?? '',
      cats: (p.get('cat') ?? '').split(',').filter(Boolean),
      price: p.get('price') ?? '',
      sort: p.get('sort') ?? 'relevance',
      page: Math.max(1, Number(p.get('page')) || 1)
    };
  }

  function writeState(s) {
    const p = new URLSearchParams();
    if (s.q) p.set('q', s.q);
    if (s.cats.length) p.set('cat', s.cats.join(','));
    if (s.price) p.set('price', s.price);
    if (s.sort !== 'relevance') p.set('sort', s.sort);
    if (s.page > 1) p.set('page', String(s.page));
    const qs = p.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  }

  /** Every word of the search must appear in the name or tags. */
  function matches(product, s) {
    const hay = `${product.name} ${product.tags}`.toLowerCase();
    const words = s.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.every((w) => hay.includes(w))) return false;
    if (s.cats.length && !s.cats.includes(product.category)) return false;
    if (s.price) {
      const [lo, hi] = s.price.split('-').map((v) => (v === '' ? null : Number(v)));
      if (lo !== null && product.price < lo) return false;
      if (hi !== null && product.price > hi) return false;
    }
    return true;
  }

  const SORTS = {
    relevance: () => 0,
    'price-asc': (a, b) => a.price - b.price,
    'price-desc': (a, b) => b.price - a.price,
    rating: (a, b) => b.rating - a.rating
  };

  let state = readState();

  function syncControls() {
    $('q').value = state.q;
    for (const box of document.querySelectorAll('input[name="category"]')) box.checked = state.cats.includes(box.value);
    $('price').value = state.price;
    $('sort').value = SORTS[state.sort] ? state.sort : 'relevance';
  }

  function render() {
    const found = PRODUCTS.filter((p) => matches(p, state)).sort(SORTS[state.sort] ?? SORTS.relevance);
    const pages = Math.max(1, Math.ceil(found.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages);
    const start = (state.page - 1) * PAGE_SIZE;
    const shown = found.slice(start, start + PAGE_SIZE);

    $('status').textContent = found.length
      ? `Showing ${start + 1}–${start + shown.length} of ${found.length} products`
      : 'No products match. Try fewer words or clear the filters.';
    $('results').replaceChildren(...shown.map((p) => {
      const li = document.createElement('li');
      li.className = 'product';
      const h3 = document.createElement('h3');
      h3.textContent = p.name;
      const meta = document.createElement('p');
      meta.style.margin = '0';
      meta.innerHTML = `<span class="price"></span> · ★ <span class="rating"></span> · <span class="cat"></span>`;
      meta.querySelector('.price').textContent = rupees(p.price);
      meta.querySelector('.rating').textContent = p.rating.toFixed(1);
      meta.querySelector('.cat').textContent = p.category;
      li.append(h3, meta);
      return li;
    }));
    $('page-info').textContent = `Page ${state.page} of ${pages}`;
    $('prev').disabled = state.page <= 1;
    $('next').disabled = state.page >= pages;
    writeState(state);
  }

  /** Any change to the search or filters starts again at page 1. */
  function update(patch) {
    state = { ...state, ...patch, page: patch.page ?? 1 };
    render();
  }

  $('search').addEventListener('click', () => update({ q: $('q').value.trim() }));
  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') update({ q: $('q').value.trim() });
  });
  for (const box of document.querySelectorAll('input[name="category"]')) {
    box.addEventListener('change', () => update({
      cats: [...document.querySelectorAll('input[name="category"]:checked')].map((b) => b.value)
    }));
  }
  $('price').addEventListener('change', () => update({ price: $('price').value }));
  $('sort').addEventListener('change', () => update({ sort: $('sort').value }));
  $('clear').addEventListener('click', () => {
    state = { q: '', cats: [], price: '', sort: 'relevance', page: 1 };
    syncControls();
    render();
  });
  $('prev').addEventListener('click', () => update({ page: state.page - 1 }));
  $('next').addEventListener('click', () => update({ page: state.page + 1 }));

  syncControls();
  render();
})();
