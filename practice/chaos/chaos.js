// Chaos page: a late button, a list rebuilt every 5 s, and a button in an open shadow root.
(() => {
  // 1. Late button.
  setTimeout(() => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'I appeared late';
    b.addEventListener('click', () => {
      document.getElementById('late-result').textContent = 'The late button was clicked.';
    });
    document.getElementById('late-slot').append(b);
  }, 2000);

  // 2. List replaced wholesale every 5 s. Likes are kept in this array, not in the DOM.
  const items = [
    { title: 'Hackathon this Saturday', likes: 0 },
    { title: 'Library open till midnight during exams', likes: 0 },
    { title: 'New canteen menu', likes: 0 }
  ];
  let renders = 0;
  function renderList() {
    const list = document.getElementById('live-list');
    list.replaceChildren(...items.map((item) => {
      const li = document.createElement('li');
      li.className = 'product row';
      const title = document.createElement('span');
      title.textContent = `${item.title} · ${item.likes} like${item.likes === 1 ? '' : 's'}`;
      const like = document.createElement('button');
      like.type = 'button';
      like.className = 'secondary';
      like.textContent = 'Like';
      like.addEventListener('click', () => {
        item.likes++;
        title.textContent = `${item.title} · ${item.likes} like${item.likes === 1 ? '' : 's'}`;
      });
      li.append(title, like);
      return li;
    }));
    document.getElementById('renders').textContent = String(renders++);
  }
  renderList();
  setInterval(renderList, 5000);

  // 3. Open shadow root. Defined once, even if this script runs again.
  if (!customElements.get('shadow-card')) customElements.define('shadow-card', class extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot) return;
      const root = this.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          .card { padding: 0.75rem; border: 1px dashed currentColor; border-radius: 0.5rem; }
          button { padding: 0.5rem 1rem; font: inherit; cursor: pointer; }
        </style>
        <div class="card"><button type="button">Button inside shadow DOM</button></div>`;
      root.querySelector('button').addEventListener('click', () => {
        document.getElementById('shadow-result').textContent = 'The shadow-DOM button was clicked.';
      });
    }
  });
})();
