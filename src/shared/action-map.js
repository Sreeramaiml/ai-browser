// @ts-check
// Scan result → the compact text the model sees (architecture §11.4). Raw HTML is never sent.
// Viewport and form elements are listed first, grouped by form, capped, with names quoted as data.

import { ACTION_MAP_MAX_ELEMENTS } from './config.js';

/**
 * @typedef {{
 *   id: number, tag: string, role: string, name: string, inputType?: string, value?: string, checked?: boolean,
 *   options?: string[], placeholder?: string, required?: boolean, disabled?: boolean, href?: string,
 *   inViewport: boolean, obscured?: boolean, formId?: number, group?: string, context?: string,
 *   protected?: 'password'|'otp'|'card'|null, consequential?: boolean, blocked?: boolean, fingerprint: string
 * }} ElementDescriptor
 * @typedef {{
 *   snapshotId: string, url: string, title: string, elements: ElementDescriptor[],
 *   forms: Array<{ id: number, name: string }>, modal: boolean, framesNotScanned: number, truncated: boolean, total: number, pageOtp?: boolean
 * }} ScanResult
 */

/** Quote page-controlled text so it reads as data, never as instructions (EC-SCN-24). @param {string} s */
const q = (s) => JSON.stringify(String(s ?? ''));

/** Input types worth stating; plain text and button-ish types say nothing new. */
const SHOWN_TYPES = new Set(['email', 'tel', 'number', 'url', 'search', 'date', 'time', 'datetime-local', 'month', 'week', 'password', 'range', 'color']);

/**
 * One element as one line, e.g. `[10] button "Next" ⚠consequential` (pure).
 * @param {ElementDescriptor} d
 */
export function formatElement(d) {
  const parts = [`[${d.id}]`, d.role === 'generic' ? d.tag : d.role, q(d.name)];
  if (d.context) parts.push(`(row: ${q(d.context)})`);
  if (d.group) parts.push(`group=${q(d.group)}`);
  if (d.inputType && SHOWN_TYPES.has(d.inputType)) parts.push(`type=${d.inputType}`);
  if (d.protected) {
    // Kept so the model understands the page, but flagged; its value is never shown (EC-SCN-25).
    parts.push(`🔒protected:${d.protected}`);
  } else {
    if (d.value !== undefined) parts.push(`value=${q(d.value)}`);
    if (d.checked !== undefined) parts.push(`checked=${d.checked}`);
    if (d.options) parts.push(`options=[${d.options.join(', ')}]`);
  }
  if (d.placeholder) parts.push(`placeholder=${q(d.placeholder)}`);
  if (d.href) parts.push(`href=${d.href}`);
  if (d.required) parts.push('required');
  if (d.disabled) parts.push('disabled');
  if (d.obscured) parts.push('obscured');
  if (d.blocked) parts.push('⛔blocked');
  else if (d.consequential) parts.push('⚠consequential');
  return parts.join(' ');
}

/**
 * The action map for one scan (pure).
 * @param {ScanResult} scan
 * @param {{ max?: number }} [opts]
 * @returns {string}
 */
export function buildActionMap(scan, { max = ACTION_MAP_MAX_ELEMENTS } = {}) {
  const lines = [`URL: ${scan.url}   TITLE: ${q(scan.title)}`];
  if (scan.modal) lines.push('A dialog is open: only its elements are listed.');
  const elements = scan.elements ?? [];
  if (elements.length === 0) {
    lines.push('No interactive elements found on this screen.'); // EC-SCN-01
  } else {
    // Viewport first, then form fields, then everything else; page order within each (§11.4).
    const rank = (d) => (d.inViewport ? 0 : 2) + (d.formId ? 0 : 1);
    const keep = new Set([...elements].sort((a, b) => rank(a) - rank(b) || a.id - b.id).slice(0, max).map((d) => d.id));
    const shown = elements.filter((d) => keep.has(d.id));

    const formNames = new Map((scan.forms ?? []).map((f) => [f.id, f.name]));
    for (const formId of [...new Set(shown.map((d) => d.formId).filter(Boolean))].sort((a, b) => a - b)) {
      const name = formNames.get(formId);
      lines.push(name ? `FORM f${formId} ${q(name)}` : `FORM f${formId}`);
      for (const d of shown) if (d.formId === formId) lines.push(formatElement(d));
    }
    const outside = shown.filter((d) => !d.formId);
    if (outside.length) {
      if (shown.length !== outside.length) lines.push('OUTSIDE FORMS');
      for (const d of outside) lines.push(formatElement(d));
    }

    const dropped = elements.filter((d) => !keep.has(d.id));
    const unscanned = scan.truncated ? Math.max(0, (scan.total ?? 0) - elements.length) : 0;
    const more = dropped.length + unscanned;
    if (more) {
      lines.push(dropped.every((d) => !d.inViewport)
        ? `… ${more} more elements below the viewport (scroll to reveal)`
        : `… ${more} more elements not listed`);
    }
  }
  if (scan.framesNotScanned) {
    lines.push(`${scan.framesNotScanned} embedded frame${scan.framesNotScanned > 1 ? 's' : ''} not scanned.`); // EC-SCN-14
  }
  return lines.join('\n');
}

/** Rough token count for budgeting: about 4 characters per token. @param {string} text */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
