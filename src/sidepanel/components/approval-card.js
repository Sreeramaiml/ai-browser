// @ts-check
// The agent's task card (architecture §17.1): the step awaiting approval with Approve / Skip / Stop,
// the second confirmation for consequential steps, the waiting, paused, blocked, failed and
// finished states, and the task's timeline. Everything from the page or the model is set as plain
// text (§14.7), except the final result, which is markdown sanitised by renderMarkdown.

import { AGENT_HINT_MAX_CHARS } from '../../shared/config.js';
import { renderMarkdown } from '../markdown.js';
import { downloadText, exportButtons, renderTimeline } from '../views/log-view.js';
import { viaLabel } from './message-list.js';

/**
 * @typedef {import('../../background/agent/agent-controller.js').AgentTask} AgentTask
 * @typedef {import('../../background/agent/agent-controller.js').ProposedStep} ProposedStep
 * @typedef {'approve'|'skip'|'stop'|'cancel'|'retry'|'resume'} Decision
 * @typedef {(decision: Decision, opts?: { stepId?: string, confirmConsequential?: boolean, hint?: string }) => void} OnDecision
 * @typedef {{ onDecision: OnDecision, onGoToTab: () => void }} Handlers
 */

const VERBS = { click: ['👆', 'Click'], type: ['✍', 'Type into'], select: ['☑', 'Choose in'], scroll: ['↕', 'Scroll'], done: ['✓', 'Finish'] };

const WAITING = {
  OBSERVING: 'Looking at the page…',
  THINKING: 'Working out the next step…',
  EXECUTING: 'Doing it…'
};

/** @param {string} tag @param {string} [className] @param {string} [text] */
function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** @param {string} label @param {string} className @param {() => void} onClick */
function button(label, className, onClick) {
  const b = /** @type {HTMLButtonElement} */ (h('button', `btn ${className}`, label));
  b.type = 'button';
  b.addEventListener('click', () => {
    // One click per state: the next AGENT_STATE redraws the card (the worker ignores repeats anyway).
    for (const other of b.parentElement?.querySelectorAll('button') ?? []) /** @type {HTMLButtonElement} */ (other).disabled = true;
    onClick();
  });
  return b;
}

/** `Type into [4] "College name"` (pure). @param {ProposedStep} step */
export function stepTitle(step) {
  const [icon, verb] = VERBS[step.action.type] ?? ['•', step.action.type];
  if (step.action.type === 'scroll') {
    return `${icon} ${verb} ${step.action.direction ?? 'down'}${step.element ? ` inside [${step.element.id}] "${step.element.name}"` : ''}`;
  }
  return `${icon} ${verb} [${step.action.target}] "${step.element?.name || 'unnamed'}"`;
}

/** @param {AgentTask} task @param {OnDecision} onDecision */
function header(task, onDecision) {
  const head = h('div', 'task-head');
  head.append(h('span', 'task-step', `Step ${Math.min(task.stepCount + 1, task.options.maxSteps)} of ${task.options.maxSteps}`));
  if (task.options.dryRun) head.append(h('span', 'chip chip-muted', 'Dry run'));
  if (task.status !== 'DONE' && task.status !== 'STOPPED') {
    const stop = h('button', 'btn btn-secondary task-stop', '⏹ Stop');
    stop.setAttribute('type', 'button');
    stop.addEventListener('click', () => onDecision('stop'));
    head.append(stop);
  }
  return head;
}

/** @param {ProposedStep} step */
function stepDetails(step) {
  const box = h('div', 'step');
  box.append(h('p', 'step-title', stepTitle(step)));
  if (step.resolvedValue !== null) {
    const value = h('p', 'step-value', `Value: "${step.resolvedValue}"`);
    if (step.fromProfile) value.append(h('span', 'hint', ' (from your profile)'));
    box.append(value);
  }
  box.append(h('p', 'step-reason', `Why: ${step.action.reason}`));
  if (step.model) box.append(h('span', 'chip chip-muted', viaLabel({ model: step.model, provider: step.provider })));
  return box;
}

/**
 * What a paused task needs from the user: a hint when it's stuck, the way back when it lost its tab.
 * @param {AgentTask} task
 * @param {Handlers} handlers
 */
function pausedBody(task, { onDecision, onGoToTab }) {
  const out = h('div', 'task-body');
  out.append(h('p', 'step-note', task.message ?? 'The agent is paused.'));
  const row = h('div', 'row');
  switch (task.paused?.reason) {
    case 'loop': {
      const hint = /** @type {HTMLTextAreaElement} */ (h('textarea', 'task-hint'));
      hint.rows = 2;
      hint.maxLength = AGENT_HINT_MAX_CHARS;
      hint.placeholder = 'e.g. The Next button is at the bottom of the form.';
      hint.setAttribute('aria-label', 'Hint for the agent');
      out.append(hint);
      row.append(
        button('Continue with this hint', 'btn-primary', () => onDecision('resume', { hint: hint.value })),
        button('Continue without a hint', 'btn-secondary', () => onDecision('resume'))
      );
      break;
    }
    case 'tab':
      row.append(button("Go to the task's tab", 'btn-primary', onGoToTab));
      break;
    default:
      // Safety and restart pauses can't be resumed: only Stop (in the header).
      return out;
  }
  out.append(row);
  return out;
}

/** @param {AgentTask} task @param {string|undefined} host @param {Handlers} handlers */
function body(task, host, handlers) {
  const { onDecision } = handlers;
  const step = task.pending;
  const stepId = step?.stepId;
  const row = h('div', 'row');
  const out = h('div', 'task-body');

  switch (task.status) {
    case 'OBSERVING':
    case 'THINKING':
    case 'EXECUTING':
      out.append(h('p', 'task-wait', WAITING[task.status]));
      if (task.status === 'EXECUTING' && step) out.append(stepDetails(step));
      return out;

    case 'AWAITING_APPROVAL':
      if (!step) return out;
      out.append(stepDetails(step));
      if (step.manual) {
        out.append(h('p', 'step-note', 'Please choose the file yourself, then press Continue.'));
        row.append(button('Continue', 'btn-primary', () => onDecision('approve', { stepId })));
      } else {
        if (step.consequential) out.append(h('p', 'step-note danger', '⚠ This step submits, sends or confirms something. You will be asked to confirm.'));
        row.append(button(step.consequential ? '✓ Approve…' : '✓ Approve', step.consequential ? 'btn-danger' : 'btn-primary',
          () => onDecision('approve', { stepId })));
      }
      row.append(button('↷ Skip', 'btn-secondary', () => onDecision('skip', { stepId })));
      out.append(row);
      return out;

    case 'CONFIRMING': {
      if (!step) return out;
      out.append(stepDetails(step));
      const ask = h('p', 'step-note danger');
      ask.append('This will ', h('strong', '', step.element?.name || 'press that button'), ` on ${host || 'this site'}. Are you sure?`);
      out.append(ask);
      row.append(
        button('Yes, do it', 'btn-danger', () => onDecision('approve', { stepId, confirmConsequential: true })),
        button('Cancel', 'btn-secondary', () => onDecision('cancel', { stepId }))
      );
      out.append(row);
      return out;
    }

    case 'BLOCKED':
      if (step) out.append(stepDetails(step));
      out.append(h('p', 'step-note danger', `🔒 Blocked: ${task.message ?? 'this step is not allowed.'}`));
      row.append(button('Ask for a different step', 'btn-primary', () => onDecision('retry', { stepId })));
      out.append(row);
      return out;

    case 'ERROR':
      if (step) out.append(stepDetails(step));
      out.append(h('p', 'step-note danger', task.message ?? 'Something went wrong.'));
      row.append(button('Try again', 'btn-primary', () => onDecision('retry', { stepId })));
      if (step) row.append(button('↷ Skip this step', 'btn-secondary', () => onDecision('skip', { stepId })));
      out.append(row);
      return out;

    case 'PAUSED':
      return pausedBody(task, handlers);

    case 'STOPPED':
      out.append(h('p', 'step-note', task.message ?? 'Stopped.'));
      return out;

    case 'DONE': {
      const result = h('div', 'task-result markdown');
      result.innerHTML = renderMarkdown(task.result ?? 'Done.'); // sanitised in renderMarkdown
      result.addEventListener('click', (event) => {
        const link = /** @type {HTMLElement} */ (event.target).closest?.('a[href]');
        if (!link) return;
        event.preventDefault();
        const href = link.getAttribute('href') ?? '';
        if (/^https?:\/\//i.test(href)) chrome.tabs.create({ url: href });
      });
      out.append(h('p', 'task-wait', '✓ Done'), result);
      const copy = /** @type {HTMLButtonElement} */ (h('button', 'btn btn-secondary', 'Copy'));
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(task.result ?? '');
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = 'Copy failed';
        }
      });
      const download = /** @type {HTMLButtonElement} */ (h('button', 'btn btn-secondary', 'Download .md'));
      download.type = 'button';
      download.addEventListener('click', () => downloadText(
        `sahayak-result-${new Date(task.updatedAt).toISOString().slice(0, 10)}.md`, `# ${task.goal}\n\n${task.result ?? ''}\n`, 'text/markdown'
      ));
      row.append(copy, download);
      out.append(row);
      return out;
    }

    default:
      return out;
  }
}

/**
 * @param {AgentTask} task
 * @param {Handlers} handlers
 * @returns {HTMLElement}
 */
export function createApprovalCard(task, handlers) {
  const { onDecision } = handlers;
  let host;
  try {
    host = new URL(task.url).host;
  } catch {
    host = undefined;
  }
  const card = h('section', 'task-card');
  card.setAttribute('aria-label', 'Agent task');
  if (task.pending?.consequential && (task.status === 'AWAITING_APPROVAL' || task.status === 'CONFIRMING')) card.classList.add('consequential');
  card.dataset.status = task.status;
  card.append(h('p', 'task-goal', task.goal), header(task, onDecision), body(task, host, handlers));

  if (task.log.length) {
    const log = h('details', 'task-log');
    log.append(h('summary', '', `Log (${task.log.length})`), renderTimeline(task), exportButtons(task));
    card.append(log);
  }
  return card;
}
