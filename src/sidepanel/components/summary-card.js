// @ts-check
// Structured summary card: TL;DR, 5 numbered key points, next steps, chapters (videos), notes, actions.
// Everything is set with textContent — no HTML from the model or the page reaches the DOM.

import { LANGUAGES } from '../../shared/config.js';
import { otherLanguage } from '../../shared/language.js';
import { formatTimestamp } from '../../shared/youtube-url.js';
import { viaLabel } from './message-list.js';

/**
 * @typedef {import('../../background/summaries.js').SummaryResult} SummaryResult
 * @typedef {import('../../shared/schemas.js').Chapter} Chapter
 */

/** @param {SummaryResult} r @returns {Chapter[]} */
function chaptersOf(r) {
  return 'chapters' in r.summary && Array.isArray(r.summary.chapters) ? r.summary.chapters : [];
}

/**
 * Plain-text version for the clipboard.
 * @param {SummaryResult} r
 */
export function summaryToText(r) {
  const chapters = chaptersOf(r);
  return [
    r.title,
    '',
    `TL;DR: ${r.summary.tldr}`,
    '',
    'Key points:',
    ...r.summary.keyPoints.map((p, i) => `${i + 1}. ${p}`),
    '',
    'What to do next:',
    ...r.summary.nextSteps.map((s) => `- ${s}`),
    ...(chapters.length
      ? ['', 'Chapters:', ...chapters.map((c) => `${formatTimestamp(c.startSeconds)} ${c.title}${c.notes ? ` — ${c.notes}` : ''}`)]
      : []),
    '',
    r.url
  ].join('\n');
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {SummaryResult} result
 * @param {{ onRefresh: () => void, onSeek?: (seconds: number) => void, onSwitchLanguage?: () => void }} actions
 * @returns {HTMLElement}
 */
export function createSummaryCard(result, { onRefresh, onSeek, onSwitchLanguage }) {
  const card = el('article', 'summary-card');
  card.setAttribute('aria-label', result.kind === 'video' ? 'Video summary' : 'Page summary');

  const tldr = el('p', 'summary-tldr');
  tldr.append(el('strong', '', 'TL;DR: '), document.createTextNode(result.summary.tldr));

  const points = el('ol', 'summary-points');
  for (const p of result.summary.keyPoints) points.append(el('li', '', p));

  const next = el('ul', 'summary-next');
  for (const s of result.summary.nextSteps) next.append(el('li', '', s));

  card.append(
    el('h3', 'summary-title', result.title || 'This page'),
    tldr,
    el('h4', '', 'Key points'),
    points,
    el('h4', '', 'What to do next'),
    next
  );

  // Chapter notes with clickable timestamps (hidden if the model gave none we could trust, EC-YT-09).
  const chapters = chaptersOf(result);
  if (chapters.length) {
    const list = el('ol', 'summary-chapters');
    for (const c of chapters) {
      const item = el('li');
      const stamp = el('button', 'chip chip-time', formatTimestamp(c.startSeconds));
      stamp.setAttribute('type', 'button');
      stamp.setAttribute('aria-label', `Play from ${formatTimestamp(c.startSeconds)}: ${c.title}`);
      stamp.addEventListener('click', () => onSeek?.(c.startSeconds));
      const text = el('div', 'chapter-text');
      text.append(el('span', 'chapter-title', c.title));
      if (c.notes) text.append(el('span', 'chapter-notes', c.notes));
      item.append(stamp, text);
      list.append(item);
    }
    card.append(el('h4', '', 'Chapters'), list);
  }

  const notes = [];
  if (result.source === 'visible') notes.push("This doesn't look like an article, so Sahayak summarised the visible content.");
  if (result.truncated) notes.push('This page is long; Sahayak summarised its beginning and end.');
  if (result.stillLoading) notes.push('The page was still loading, so the summary may miss some content.');
  for (const n of notes) card.append(el('p', 'note', n));

  const meta = el('div', 'msg-meta');
  meta.append(el('span', 'chip', viaLabel(result)));
  const language = /** @type {keyof typeof LANGUAGES} */ (result.language in LANGUAGES ? result.language : 'en');
  meta.append(el('span', 'chip chip-muted', LANGUAGES[language]));
  if (result.cached) meta.append(el('span', 'chip chip-muted', 'Saved summary'));

  const copy = el('button', 'btn btn-link', 'Copy');
  copy.setAttribute('type', 'button');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(summaryToText(result));
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Copy failed';
    }
  });
  const refresh = el('button', 'btn btn-link', 'Summarise again');
  refresh.setAttribute('type', 'button');
  refresh.addEventListener('click', onRefresh);
  meta.append(copy, refresh);

  // ⇄ regenerates this card in the other language, without changing the saved setting (EC-LNG-04).
  if (onSwitchLanguage) {
    const target = LANGUAGES[otherLanguage(language)];
    const swap = el('button', 'btn btn-link', `⇄ ${target}`);
    swap.setAttribute('type', 'button');
    swap.setAttribute('aria-label', `Show this summary in ${target}`);
    swap.addEventListener('click', onSwitchLanguage);
    meta.append(swap);
  }
  card.append(meta);

  return card;
}
