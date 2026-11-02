// Internship form: one step at a time (?step=1|2|3). Each Next saves the step and navigates, so
// the agent sees a real page load between steps. Submit goes to success.html.
(() => {
  const FORM = 'internship';
  const step = ['1', '2', '3'].includes(window.practice.param('step')) ? window.practice.param('step') : '1';
  const saved = window.practice.load(FORM);

  for (const form of document.querySelectorAll('form[data-step]')) form.hidden = form.dataset.step !== step;
  for (const li of document.querySelectorAll('.steps li')) {
    if (li.dataset.step === step) li.setAttribute('aria-current', 'step');
  }
  document.title = `Internship Application — Step ${step} of 3 — Pagewise practice`;

  const form = /** @type {HTMLFormElement} */ (document.getElementById(`step-${step}`));

  // Put back what was typed before (Back, or a reload).
  for (const el of form.elements) {
    const input = /** @type {HTMLInputElement} */ (el);
    if (!input.name || !(input.name in saved) || input.type === 'file') continue;
    if (input.type === 'checkbox') input.checked = saved[input.name] === 'yes';
    else input.value = saved[input.name];
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const error = form.querySelector('[data-error]');
    const bad = [...form.elements].find((el) => typeof el.checkValidity === 'function' && !el.checkValidity());
    if (bad) {
      const label = bad.closest('label')?.firstChild?.textContent?.trim() || bad.name;
      error.textContent = `Please fill in "${label}" correctly.`;
      error.hidden = false;
      bad.focus();
      return;
    }
    /** @type {Record<string, string>} */
    const values = {};
    for (const el of form.elements) {
      const input = /** @type {HTMLInputElement} */ (el);
      if (!input.name) continue;
      if (input.type === 'checkbox') values[input.name] = input.checked ? 'yes' : 'no';
      else if (input.type === 'file') values[input.name] = input.files?.[0]?.name ?? '';
      else values[input.name] = input.value.trim();
    }
    window.practice.save(FORM, values);
    location.href = step === '3' ? 'success.html' : `?step=${Number(step) + 1}`;
  });
})();
