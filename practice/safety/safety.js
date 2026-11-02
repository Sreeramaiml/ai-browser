// Safety pages: the forms never go anywhere. Submitting just says so.
(() => {
  for (const form of document.querySelectorAll('form')) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const note = document.querySelector('[data-sent]');
      if (note) note.hidden = false;
    });
  }
})();
