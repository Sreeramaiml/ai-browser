// @ts-check
// Agent action log (architecture §12.7, P3.6): a timeline per task — step, action, reason,
// decision, outcome, model, page — and Settings → Logs, listing past tasks with Export JSON and
// Export Markdown. Everything from the page or the model is set as plain text.

import { ToPanel, ToSW } from '../../shared/messages.js';
import { MODEL_LABELS } from '../../shared/config.js';

/**
 * @typedef {import('../../background/agent/agent-controller.js').AgentTask} AgentTask
 * @typedef {import('../../background/agent/agent-controller.js').LogEntry} LogEntry
 * @typedef {{ taskId: string, goal: string, status: string, url: string, stepCount: number, steps: number,
 *   createdAt: number, updatedAt: number }} TaskSummary
 */

const DECISION_MARK = { approved: '✓', confirmed: '✓✓', 'dry-run': '◌', skipped: '↷', blocked: '⛔', stopped: '⏹' };
const STATUS_LABEL = {
  DONE: 'Done', STOPPED: 'Stopped', ERROR: 'Failed', PAUSED: 'Paused', BLOCKED: 'Blocked',
  OBSERVING: 'Running', THINKING: 'Running', AWAITING_APPROVAL: 'Waiting for you', CONFIRMING: 'Waiting for you', EXECUTING: 'Running'
};

/** @param {string} model */
const modelName = (model) => /** @type {Record<string, string>} */ (MODEL_LABELS)[model] ?? model;
/** @param {number} ts */
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
/** @param {number} ts */
const dateTime = (ts) => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** `type [4] "College name" ← "IIT Hyderabad"` (pure). @param {LogEntry} e */
export function actionText(e) {
  const a = e.action;
  /** @type {string[]} */
  const parts = [a.type];
  if (a.target !== null) parts.push(`[${a.target}]${e.targetName ? ` "${e.targetName}"` : ''}`);
  if (a.direction) parts.push(a.direction);
  if (a.value !== null) parts.push(`← "${a.value}"`);
  return parts.join(' ');
}

/** `approved · ok`, `skipped`, `blocked: reason` (pure). @param {LogEntry} e */
export function outcomeText(e) {
  const out = e.outcome === 'n/a' ? e.decision : `${e.decision} · ${e.outcome}`;
  return e.error ? `${out}: ${e.error}` : out;
}

/** @param {string} url */
function pathOf(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/** Markdown export of one task (pure). @param {AgentTask} task */
export function taskToMarkdown(task) {
  const cell = (/** @type {string} */ s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `# Pagewise task: ${task.goal.split('\n')[0]}`,
    '',
    `- Status: ${STATUS_LABEL[task.status] ?? task.status}${task.message ? ` — ${task.message}` : ''}`,
    `- Started: ${new Date(task.createdAt).toISOString()}`,
    `- Page: ${task.url}`,
    `- Steps: ${task.stepCount} of ${task.options.maxSteps}${task.options.dryRun ? ' (dry run)' : ''}`,
    '',
    '## Goal',
    '',
    task.goal,
    '',
    '## Steps',
    ''
  ];
  if (task.log.length) {
    lines.push('| # | Time | Action | Reason | Decision | Model | Page |', '|---|---|---|---|---|---|---|');
    task.log.forEach((e, i) => lines.push(
      `| ${i + 1} | ${new Date(e.ts).toISOString()} | ${cell(actionText(e))} | ${cell(e.action.reason)} | ${cell(outcomeText(e))} | ${cell(e.model ? modelName(e.model) : '')} | ${cell(pathOf(e.url))} |`
    ));
  } else {
    lines.push('No steps yet.');
  }
  if (task.notes.length) lines.push('', '## Notes', '', ...task.notes.map((n) => `- ${n}`));
  if (task.result) lines.push('', '## Result', '', task.result);
  return `${lines.join('\n')}\n`;
}

/** JSON export: the saved task as is (pure). @param {AgentTask} task */
export function taskToJson(task) {
  return `${JSON.stringify(task, null, 2)}\n`;
}

/**
 * Save text as a file from the panel.
 * @param {string} filename
 * @param {string} text
 * @param {string} type MIME type
 */
export function downloadText(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** @param {AgentTask|TaskSummary} task @param {string} ext */
const fileName = (task, ext) => `pagewise-task-${new Date(task.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`;

/** @param {AgentTask} task */
export function exportMarkdown(task) {
  downloadText(fileName(task, 'md'), taskToMarkdown(task), 'text/markdown');
}

/** @param {AgentTask} task */
export function exportJson(task) {
  downloadText(fileName(task, 'json'), taskToJson(task), 'application/json');
}

/** @param {string} tag @param {string} [className] @param {string} [text] */
function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * The step-by-step timeline of one task.
 * @param {AgentTask} task
 * @returns {HTMLElement}
 */
export function renderTimeline(task) {
  if (!task.log.length) return h('p', 'hint', 'No steps yet.');
  const list = h('ol', 'timeline');
  task.log.forEach((e, i) => {
    const item = h('li', `timeline-item decision-${e.decision}`);
    const head = h('p', 'timeline-head');
    head.append(
      h('span', 'timeline-mark', DECISION_MARK[e.decision] ?? '•'),
      h('span', 'timeline-step', `Step ${i + 1}`),
      h('span', 'timeline-action', actionText(e))
    );
    item.append(head, h('p', 'timeline-reason', e.action.reason));
    const meta = [outcomeText(e), time(e.ts)];
    if (e.model) meta.push(modelName(e.model));
    meta.push(pathOf(e.url));
    item.append(h('p', 'timeline-meta', meta.join(' · ')));
    list.append(item);
  });
  return list;
}

/** Export JSON / Export Markdown buttons for one task. @param {AgentTask} task */
export function exportButtons(task) {
  const row = h('div', 'row');
  for (const [label, run] of /** @type {const} */ ([['Export JSON', exportJson], ['Export Markdown', exportMarkdown]])) {
    const b = /** @type {HTMLButtonElement} */ (h('button', 'btn btn-secondary', label));
    b.type = 'button';
    b.addEventListener('click', () => run(task));
    row.append(b);
  }
  return row;
}

/**
 * Settings → Logs: past tasks, loaded when the section is opened.
 * @param {HTMLElement} root
 * @param {{ request: (type: string, payload?: any) => Promise<import('../../shared/messages.js').Message> }} deps
 */
export function mountLogView(root, { request }) {
  root.replaceChildren();
  const status = h('p', 'status');
  status.setAttribute('role', 'status');
  const list = h('ul', 'log-tasks');
  const detail = h('div', 'log-detail');
  const refresh = /** @type {HTMLButtonElement} */ (h('button', 'btn btn-secondary', 'Refresh'));
  refresh.type = 'button';
  const bar = h('div', 'row');
  bar.append(refresh);
  root.append(bar, status, list, detail);

  /** @param {string} taskId */
  async function open(taskId) {
    detail.replaceChildren(h('p', 'hint', 'Loading…'));
    try {
      const reply = await request(ToSW.AGENT_GET_STATE, { taskId });
      const task = reply.type === ToPanel.AGENT_STATE ? reply.payload?.task : null;
      if (!task) {
        detail.replaceChildren(h('p', 'hint', 'That task is no longer saved.'));
        return;
      }
      const goal = h('p', 'task-goal', task.goal);
      detail.replaceChildren(goal, h('p', 'hint', `${STATUS_LABEL[task.status] ?? task.status}${task.message ? ` — ${task.message}` : ''}`),
        exportButtons(task), renderTimeline(task));
    } catch (err) {
      detail.replaceChildren(h('p', 'hint', err instanceof Error ? err.message : "Couldn't load that task."));
    }
  }

  async function load() {
    status.textContent = 'Loading…';
    detail.replaceChildren();
    try {
      const reply = await request(ToSW.AGENT_LIST, {});
      /** @type {TaskSummary[]} */
      const tasks = reply.type === ToPanel.AGENT_LIST_RESULT ? reply.payload.tasks : [];
      status.textContent = tasks.length ? `${tasks.length} task${tasks.length === 1 ? '' : 's'} (the last 20 are kept).` : 'No agent tasks yet.';
      list.replaceChildren(...tasks.map((t) => {
        const li = h('li');
        const b = /** @type {HTMLButtonElement} */ (h('button', 'log-task'));
        b.type = 'button';
        b.append(h('span', 'log-task-goal', t.goal.split('\n')[0]),
          h('span', 'log-task-meta', `${STATUS_LABEL[t.status] ?? t.status} · ${t.steps} step${t.steps === 1 ? '' : 's'} · ${dateTime(t.updatedAt)}`));
        b.addEventListener('click', () => open(t.taskId));
        li.append(b);
        return li;
      }));
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : "Couldn't load the logs.";
    }
  }

  refresh.addEventListener('click', load);
  return { load };
}
