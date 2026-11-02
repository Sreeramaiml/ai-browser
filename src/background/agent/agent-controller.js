// @ts-check
// The agent loop (architecture §12, P3.5): observe → propose (strict JSON) → approve / skip / stop →
// execute → repeat, one step at a time and never without the user's approval.
//
// `transition(task, event)` is a pure state machine that returns the next task and the effects to
// run (scan, call the model, highlight, execute). The runner below loads the task, transitions,
// SAVES, and only then performs the effects, feeding their results back in as events. If the
// worker sleeps at any point, the saved task is all it needs to carry on.

import { AGENT_GOAL_MAX_CHARS, AGENT_HINT_MAX_CHARS } from '../../shared/config.js';
import { ToContent, ToPanel, ToSW, makeMessage } from '../../shared/messages.js';
import { checkAction, checkAgentAllowed } from '../../shared/safety/policy.js';
import {
  AgentActionSchema, profileRefs, resolveProfileRefs, validateAgentAction
} from '../../shared/schemas.js';
import { clampMaxSteps, createStorage } from '../../shared/storage.js';
import { FeatureError } from '../feature-error.js';
import { LlmError } from '../llm/errors.js';
import { createDefaultGateway } from '../llm/default-gateway.js';
import { chromePageGuard } from '../page-guard.js';
import { chromePageScan } from '../page-scan.js';
import { on, sendToWindow } from '../router.js';
import { ensureInjected, sendToTab } from '../tab-context.js';
import { AGENT_PAGE_TEXT_CHARS, buildAgentPrompt, profileKeys } from './agent-prompt.js';
import { createAgentStore } from './agent-store.js';

/** Notes the model may keep across pages (architecture §12.2). */
export const AGENT_NOTES_MAX = 50;
/** The same step proposed this many times in a row on the same page pauses the task (§12.7). */
export const AGENT_LOOP_REPEATS = 3;
/** A model call this old is treated as hung: abort it and retry once (P3.6). */
export const AGENT_STUCK_MS = 60_000;
export const LOOP_MESSAGE = 'I seem to be stuck — want to give me a hint?';
export const TAB_PAUSE_MESSAGE = 'Agent paused — return to the original tab to continue.';

/**
 * @typedef {import('../../shared/action-map.js').ElementDescriptor} ElementDescriptor
 * @typedef {import('../../shared/schemas.js').AgentAction} AgentAction
 * @typedef {'OBSERVING'|'THINKING'|'AWAITING_APPROVAL'|'CONFIRMING'|'EXECUTING'|'PAUSED'|'BLOCKED'|'DONE'|'STOPPED'|'ERROR'} AgentStatus
 * @typedef {{
 *   snapshotId: string, url: string, action: AgentAction, element: ElementDescriptor|null,
 *   resolvedValue: string|null, fromProfile: boolean, model: string, provider: string,
 *   pageOtp: boolean, pageCard: boolean
 * }} Proposal what the model proposed, as checked against the scan it saw
 * @typedef {Proposal & {
 *   stepId: string, consequential: boolean, manual: boolean, decision?: 'approved'|'confirmed'
 * }} ProposedStep manual: a file input the user fills by hand ("Continue" instead of running it)
 * @typedef {{
 *   ts: number, stepId: string, url: string, action: AgentAction, targetName: string|null,
 *   decision: 'approved'|'skipped'|'stopped'|'blocked'|'confirmed'|'dry-run',
 *   outcome: 'ok'|'failed'|'stale'|'manual'|'n/a', error?: string, model?: string
 * }} LogEntry
 * @typedef {{
 *   taskId: string, goal: string, tabId: number, windowId: number, origin: string, url: string,
 *   status: AgentStatus, options: { maxSteps: number, dryRun: boolean, useProfile: boolean },
 *   stepCount: number, cycle: number, pending: ProposedStep|null, notes: string[], result: string|null,
 *   message: string|null, log: LogEntry[], createdAt: number, updatedAt: number,
 *   paused?: { reason: PauseReason, from: AgentStatus }|null, repeats?: string[], recoveries?: number
 * }} AgentTask stepCount: executed + skipped steps; cycle: bumped on every observe, so a late reply
 *   from an earlier observe or model call can't be applied; message: why it's paused, blocked, stopped or failed;
 *   repeats: keys of the last proposals, for loop detection; recoveries: restarts of a stuck step since the last proposal
 * @typedef {'tab'|'safety'|'loop'|'restart'} PauseReason
 * @typedef {{
 *   snapshotId: string, url: string, title: string, elements: ElementDescriptor[], map: string,
 *   pageText: string, pageOtp: boolean, pageCard: boolean
 * }} Observation
 * @typedef {{ snapshotId: string, elementId: number, fingerprint?: string }} RingTarget
 * @typedef {{ type: 'OBSERVE', cycle: number, afterAction: boolean }
 *   | { type: 'CALL_LLM', cycle: number, observation: Observation }
 *   | { type: 'HIGHLIGHT', target: RingTarget|null, style: 'pending'|'dry-run'|'blocked'|null }
 *   | { type: 'EXECUTE', step: ProposedStep }
 *   | { type: 'ABORT_LLM' }} Effect
 * @typedef {{ ok: boolean, code?: string, error?: string, effect?: { navigated?: boolean, valueAfter?: string } }} ExecResult
 * @typedef {{ type: 'OBSERVED', cycle: number, observation: Observation, allowed: { allowed: boolean, reason: string|null } }
 *   | { type: 'OBSERVE_FAILED', cycle: number, error: { code: string, message: string } }
 *   | { type: 'THOUGHT', cycle: number, proposal: Proposal }
 *   | { type: 'THINK_FAILED', cycle: number, error: { code: string, message: string } }
 *   | { type: 'DECISION', stepId?: string, decision: 'approve'|'skip'|'stop'|'cancel'|'retry'|'resume',
 *       confirmConsequential?: boolean, hint?: string }
 *   | { type: 'EXECUTED', stepId: string, result: ExecResult }
 *   | { type: 'STOP', reason?: string }
 *   | { type: 'PAUSE', reason: PauseReason, message: string }
 *   | { type: 'RECOVER' }} AgentEvent
 */

const FINISHED = new Set(['DONE', 'STOPPED']);
/** Statuses where the agent is on the move, so switching tabs pauses it (§12.8). */
const MOVING = new Set(['OBSERVING', 'THINKING', 'AWAITING_APPROVAL', 'CONFIRMING', 'EXECUTING']);

/**
 * Two proposals are "the same step" when they do the same thing to the same element with the same
 * value on the same page. The page is part of it, so pressing "Next" on page 1, 2 and 3 of a list
 * isn't a loop (pure).
 * @param {Proposal} p
 */
export function stepKey(p) {
  const a = p.action;
  return [a.type, p.element?.fingerprint ?? a.target ?? '', a.value ?? '', a.direction ?? '', p.url].join('|');
}

/**
 * May this step run, and does it need a second confirmation? `checkAction` (§14.4–14.5) plus the
 * scanner's own verdict on the element, failing closed if either objects (pure).
 * @param {Pick<Proposal, 'action'|'element'|'resolvedValue'|'fromProfile'|'pageOtp'|'pageCard'>} p
 * @returns {import('../../shared/safety/policy.js').ActionVerdict}
 */
export function judgeStep({ action, element, resolvedValue, fromProfile, pageOtp, pageCard }) {
  // Only what the rules read: the descriptor's `id` is its scan number, not the HTML id attribute.
  /** @type {import('../../shared/safety/policy.js').TargetInfo|null} */
  const target = element && {
    tag: element.tag,
    role: element.role,
    type: element.inputType ?? (element.tag === 'input' ? 'text' : element.tag),
    inputType: element.inputType,
    label: element.name,
    placeholder: element.placeholder,
    href: element.href,
    inForm: Boolean(element.formId),
    protected: element.protected ?? null
  };
  const verdict = checkAction({ type: action.type, value: resolvedValue ?? action.value ?? '' }, target, { pageOtp, pageCard, fromProfile });
  if (!verdict.allowed) return verdict;
  if (element?.blocked) {
    return { allowed: false, reason: "Pagewise won't click this. It would submit a form with a password, OTP or card field.", requiresConfirm: false };
  }
  if (action.type === 'click' && element?.consequential) {
    return { allowed: true, reason: verdict.reason ?? 'It submits, sends, pays or deletes something.', requiresConfirm: true };
  }
  return verdict;
}

/**
 * A new task, about to look at the page for the first time (pure).
 * @param {{ taskId: string, goal: string, tabId: number, windowId: number, url: string,
 *   options: AgentTask['options'], now: number }} p
 * @returns {{ task: AgentTask, effects: Effect[] }}
 */
export function startTask({ taskId, goal, tabId, windowId, url, options, now }) {
  /** @type {AgentTask} */
  const task = {
    taskId, goal, tabId, windowId, url, origin: originOf(url),
    status: 'OBSERVING', options, stepCount: 0, cycle: 1, pending: null, notes: [], result: null,
    message: null, log: [], createdAt: now, updatedAt: now, paused: null, repeats: [], recoveries: 0
  };
  return { task, effects: [{ type: 'OBSERVE', cycle: 1, afterAction: false }] };
}

/** @param {string} url */
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * @param {ProposedStep} step
 * @param {LogEntry['decision']} decision
 * @param {LogEntry['outcome']} outcome
 * @param {number} now
 * @param {string} [error]
 * @returns {LogEntry}
 */
function logEntry(step, decision, outcome, now, error) {
  /** @type {LogEntry} */
  const e = {
    ts: now, stepId: step.stepId, url: step.url, action: step.action,
    targetName: step.element?.name ?? null, decision, outcome, model: step.model
  };
  if (error) e.error = error;
  return e;
}

/** @param {ProposedStep|Proposal} step @returns {RingTarget|null} */
const ringOf = (step) => (step.element
  ? { snapshotId: step.snapshotId, elementId: step.element.id, fingerprint: step.element.fingerprint }
  : null);

/**
 * The agent's state machine (architecture §12.1). Pure: no Chrome, no clock, no I/O. Returns the
 * same task object, with no effects, for an event that doesn't apply (a stale stepId, a late
 * model reply after Stop, a second click on Approve…).
 * @param {AgentTask} task
 * @param {AgentEvent} event
 * @param {number} now
 * @returns {{ task: AgentTask, effects: Effect[] }}
 */
export function transition(task, event, now) {
  const ignore = { task, effects: /** @type {Effect[]} */ ([]) };
  if (FINISHED.has(task.status)) return ignore;
  /** @param {Partial<AgentTask>} patch */
  const next = (patch) => ({ ...task, ...patch, updatedAt: now });

  /**
   * Look at the page again, unless the step budget is spent (§12.7).
   * @param {Partial<AgentTask>} patch
   * @param {{ afterAction?: boolean, keepRing?: boolean }} [opts] keepRing: leave a dry-run ring up
   */
  const observeAgain = (patch, { afterAction = false, keepRing = false } = {}) => {
    const t = next({ ...patch, pending: null, message: null, paused: null });
    if (t.stepCount >= t.options.maxSteps) {
      return {
        task: { ...t, status: /** @type {AgentStatus} */ ('STOPPED'), message: `Stopped at the step limit (${t.options.maxSteps} steps).` },
        effects: /** @type {Effect[]} */ ([{ type: 'HIGHLIGHT', target: null, style: null }])
      };
    }
    const cycle = task.cycle + 1;
    /** @type {Effect[]} */
    const effects = keepRing ? [] : [{ type: 'HIGHLIGHT', target: null, style: null }];
    effects.push({ type: 'OBSERVE', cycle, afterAction });
    return { task: { ...t, status: /** @type {AgentStatus} */ ('OBSERVING'), cycle }, effects };
  };

  const pending = task.pending;

  /** Run the approved step, or only ring it in a dry run (§12.7). @param {'approved'|'confirmed'} decision */
  const run = (decision) => {
    if (!pending) return ignore;
    const verdict = judgeStep(pending); // defence in depth: checked again on approve (§14.1)
    if (!verdict.allowed) {
      return {
        task: next({ status: 'BLOCKED', message: verdict.reason, log: [...task.log, logEntry(pending, 'blocked', 'n/a', now, verdict.reason ?? undefined)] }),
        effects: /** @type {Effect[]} */ ([{ type: 'HIGHLIGHT', target: ringOf(pending), style: 'blocked' }])
      };
    }
    if (task.options.dryRun) {
      const ring = ringOf(pending);
      const moved = observeAgain({ stepCount: task.stepCount + 1, log: [...task.log, logEntry(pending, 'dry-run', 'n/a', now)] }, { keepRing: true });
      return { task: moved.task, effects: [...(ring ? [/** @type {Effect} */ ({ type: 'HIGHLIGHT', target: ring, style: 'dry-run' })] : []), ...moved.effects] };
    }
    const step = { ...pending, decision };
    return { task: next({ status: 'EXECUTING', pending: step, message: null }), effects: /** @type {Effect[]} */ ([{ type: 'EXECUTE', step }]) };
  };

  switch (event.type) {
    case 'STOP':
      return {
        task: next({
          status: 'STOPPED',
          pending: null,
          paused: null,
          message: event.reason ?? 'Stopped by you.',
          log: pending && task.status !== 'BLOCKED' ? [...task.log, logEntry(pending, 'stopped', 'n/a', now)] : task.log
        }),
        effects: [{ type: 'ABORT_LLM' }, { type: 'HIGHLIGHT', target: null, style: null }]
      };

    case 'OBSERVED':
      if (task.status !== 'OBSERVING' || event.cycle !== task.cycle) return ignore;
      if (!event.allowed.allowed) {
        // Navigated off the allow-list (§12.8): stop acting here, and say why.
        return {
          task: next({
            status: 'PAUSED', url: event.observation.url, paused: { reason: 'safety', from: 'OBSERVING' },
            message: `Agent paused for safety. ${event.allowed.reason ?? ''}`.trim()
          }),
          effects: [{ type: 'HIGHLIGHT', target: null, style: null }]
        };
      }
      return {
        task: next({ status: 'THINKING', url: event.observation.url }),
        effects: [{ type: 'CALL_LLM', cycle: task.cycle, observation: event.observation }]
      };

    case 'OBSERVE_FAILED':
      if (task.status !== 'OBSERVING' || event.cycle !== task.cycle) return ignore;
      if (event.error.code === 'TAB_GONE') return { task: next({ status: 'STOPPED', message: "Stopped: the task's tab was closed." }), effects: [] };
      return { task: next({ status: 'ERROR', message: event.error.message }), effects: [] };

    case 'THINK_FAILED':
      if (task.status !== 'THINKING' || event.cycle !== task.cycle) return ignore;
      return { task: next({ status: 'ERROR', message: event.error.message }), effects: [] };

    case 'THOUGHT': {
      if (task.status !== 'THINKING' || event.cycle !== task.cycle) return ignore;
      const p = event.proposal;
      const note = p.action.note;
      const notes = note && !task.notes.includes(note) ? [...task.notes, note].slice(-AGENT_NOTES_MAX) : task.notes;

      if (p.action.type === 'done') {
        return {
          task: next({ status: 'DONE', notes, result: p.action.result ?? p.action.reason, message: null, recoveries: 0 }),
          effects: [{ type: 'HIGHLIGHT', target: null, style: null }]
        };
      }
      // Loop detection (§12.7): the same step proposed 3 times in a row pauses for a hint.
      const key = stepKey(p);
      const repeats = [...(task.repeats ?? []), key].slice(-AGENT_LOOP_REPEATS);
      if (repeats.length === AGENT_LOOP_REPEATS && repeats.every((k) => k === key)) {
        return {
          task: next({ status: 'PAUSED', notes, pending: null, repeats: [], recoveries: 0, paused: { reason: 'loop', from: 'THINKING' }, message: LOOP_MESSAGE }),
          effects: [{ type: 'HIGHLIGHT', target: null, style: null }]
        };
      }
      const verdict = judgeStep(p);
      /** @type {ProposedStep} */
      const step = {
        ...p, stepId: `step-${task.cycle}`, consequential: verdict.requiresConfirm,
        // Pages can't set a file input's value, so the user picks the file (§12.3).
        manual: p.action.type === 'click' && p.element?.role === 'file'
      };
      const ring = ringOf(step);
      if (!verdict.allowed) {
        return {
          task: next({ status: 'BLOCKED', notes, repeats, recoveries: 0, pending: step, message: verdict.reason, log: [...task.log, logEntry(step, 'blocked', 'n/a', now, verdict.reason ?? undefined)] }),
          effects: [{ type: 'HIGHLIGHT', target: ring, style: 'blocked' }]
        };
      }
      return {
        task: next({ status: 'AWAITING_APPROVAL', notes, repeats, recoveries: 0, pending: step, message: null }),
        effects: [{ type: 'HIGHLIGHT', target: ring, style: ring ? 'pending' : null }]
      };
    }

    case 'DECISION': {
      if (event.decision === 'stop') return transition(task, { type: 'STOP' }, now);
      if (event.decision === 'resume') {
        // A restart's tab is gone, and a step still running must report back first.
        if (task.status !== 'PAUSED' || task.paused?.reason === 'restart' || pending) return ignore;
        const hint = typeof event.hint === 'string' ? event.hint.trim().slice(0, AGENT_HINT_MAX_CHARS) : '';
        // The hint becomes part of the goal, so the model sees it on every later step (§12.7).
        return observeAgain({ goal: hint ? `${task.goal}\nHint from the user: ${hint}` : task.goal, repeats: [] });
      }
      // A failed model call or page read has no step to match: Try again just looks again.
      if (task.status === 'ERROR' && !pending && event.decision === 'retry') return observeAgain({ recoveries: 0 });
      // Idempotency: a decision for any step but the pending one is ignored (§12.4).
      if (!pending || event.stepId !== pending.stepId) return ignore;

      switch (task.status) {
        case 'AWAITING_APPROVAL':
          if (event.decision === 'skip') {
            return observeAgain({ stepCount: task.stepCount + 1, log: [...task.log, logEntry(pending, 'skipped', 'n/a', now)] });
          }
          if (event.decision !== 'approve') return ignore;
          if (pending.manual) {
            return observeAgain({ stepCount: task.stepCount + 1, log: [...task.log, logEntry(pending, 'approved', 'manual', now)] }, { afterAction: true });
          }
          // Consequential steps always take a second, separate confirmation, even if this
          // request already claims one (§14.5).
          if (pending.consequential) return { task: next({ status: 'CONFIRMING' }), effects: [] };
          return run('approved');

        case 'CONFIRMING':
          if (event.decision === 'cancel') return { task: next({ status: 'AWAITING_APPROVAL' }), effects: [] };
          if (event.decision === 'skip') {
            return observeAgain({ stepCount: task.stepCount + 1, log: [...task.log, logEntry(pending, 'skipped', 'n/a', now)] });
          }
          if (event.decision === 'approve' && event.confirmConsequential === true) return run('confirmed');
          return ignore;

        case 'BLOCKED':
          // "Ask for a different step": the history tells the model it was blocked.
          return event.decision === 'retry' || event.decision === 'skip' ? observeAgain({}) : ignore;

        case 'ERROR':
          if (event.decision === 'retry') return observeAgain({ recoveries: 0 });
          if (event.decision === 'skip') {
            return observeAgain({ stepCount: task.stepCount + 1, log: [...task.log, logEntry(pending, 'skipped', 'n/a', now)] });
          }
          return ignore;

        default:
          return ignore;
      }
    }

    case 'EXECUTED': {
      if (!pending || event.stepId !== pending.stepId) return ignore;
      const r = event.result;
      const decision = pending.decision ?? 'approved';
      if (task.status === 'PAUSED' && task.paused?.from === 'EXECUTING') {
        // Paused mid-step (tab switch): record what happened, and stay paused.
        const outcome = r.ok ? 'ok' : r.code === 'STALE_TARGET' ? 'stale' : 'failed';
        return {
          task: next({
            pending: null, paused: { ...task.paused, from: 'OBSERVING' },
            stepCount: task.stepCount + (r.ok ? 1 : 0), log: [...task.log, logEntry(pending, decision, outcome, now, r.ok ? undefined : r.error)]
          }),
          effects: []
        };
      }
      if (task.status !== 'EXECUTING') return ignore;
      if (r.ok) {
        return observeAgain({ stepCount: task.stepCount + 1, log: [...task.log, logEntry(pending, decision, 'ok', now)] }, { afterAction: true });
      }
      if (r.code === 'STALE_TARGET') {
        // The page changed under the step: look again, without counting a step (§11.3).
        return observeAgain({ log: [...task.log, logEntry(pending, decision, 'stale', now)] });
      }
      const why = r.error || "The page didn't accept that step.";
      return {
        task: next({ status: 'ERROR', message: `That step didn't work: ${why}`, log: [...task.log, logEntry(pending, decision, 'failed', now, why)] }),
        effects: []
      };
    }

    case 'PAUSE': {
      if (task.status === 'PAUSED') {
        // Leaving the allow-list or a Chrome restart outranks a tab or loop pause: switching back
        // to the tab mustn't resume it.
        if ((event.reason !== 'safety' && event.reason !== 'restart') || task.paused?.reason === event.reason) return ignore;
        if (task.paused?.reason === 'restart') return ignore;
        return { task: next({ paused: { reason: event.reason, from: task.paused?.from ?? 'OBSERVING' }, message: event.message }), effects: [] };
      }
      if (event.reason === 'tab' && !MOVING.has(task.status)) return ignore; // already waiting on the user
      /** @type {Effect[]} */
      const effects = [{ type: 'HIGHLIGHT', target: null, style: null }];
      if (task.status === 'THINKING') effects.unshift({ type: 'ABORT_LLM' }); // don't pay for an answer nobody uses
      return {
        task: next({
          status: 'PAUSED', paused: { reason: event.reason, from: task.status }, message: event.message,
          // A running step keeps its record so its result can still be logged.
          pending: task.status === 'EXECUTING' ? pending : null
        }),
        effects
      };
    }

    case 'RECOVER': {
      // The worker slept or the call hung mid-step (P3.6).
      if (task.status === 'PAUSED' && task.paused?.from === 'EXECUTING' && pending) {
        const why = 'Pagewise restarted during this step, so it may or may not have run.';
        return {
          task: next({
            pending: null, paused: { ...task.paused, from: 'OBSERVING' },
            log: [...task.log, logEntry(pending, pending.decision ?? 'approved', 'failed', now, why)]
          }),
          effects: []
        };
      }
      if (task.status === 'EXECUTING' && pending) {
        // Never run a step twice: we can't tell whether it ran, so ask.
        const why = 'Pagewise restarted during this step, so it may or may not have run.';
        return {
          task: next({
            status: 'ERROR', message: `${why} Check the page, then press Try again or Skip.`,
            log: [...task.log, logEntry(pending, pending.decision ?? 'approved', 'failed', now, why)]
          }),
          effects: []
        };
      }
      if (task.status !== 'OBSERVING' && task.status !== 'THINKING') return ignore;
      if ((task.recoveries ?? 0) >= 1) {
        return { task: next({ status: 'ERROR', message: 'Pagewise lost track of this step twice. Press Try again to look at the page again.' }), effects: [] };
      }
      return observeAgain({ recoveries: (task.recoveries ?? 0) + 1 });
    }

    default:
      return ignore;
  }
}

/**
 * The thin runner: load → transition → save → perform effects → feed results back as events.
 * Transitions run one at a time; effects run outside that lock, so Stop is never stuck behind a
 * slow model call.
 * @param {{
 *   store: ReturnType<typeof createAgentStore>,
 *   observe: (task: AgentTask, opts: { afterAction: boolean }) => Promise<Observation>,
 *   checkAllowed: (url: string, tabId?: number) => Promise<{ allowed: boolean, reason: string|null, tier?: boolean }>,
 *   think: (task: AgentTask, observation: Observation, signal: AbortSignal) => Promise<Proposal>,
 *   execute: (task: AgentTask, step: ProposedStep) => Promise<ExecResult>,
 *   highlight: (task: AgentTask, target: RingTarget|null, style: string|null) => Promise<unknown>,
 *   notify: (task: AgentTask) => void,
 *   getTabUrl: (tabId: number) => Promise<string>,
 *   getDefaults: () => Promise<{ maxSteps: number, dryRun: boolean }>,
 *   hasProfile?: () => Promise<boolean>,
 *   now?: () => number,
 *   newId?: () => string
 * }} deps
 */
export function createAgentRunner({
  store, observe, checkAllowed, think, execute, highlight, notify, getTabUrl, getDefaults,
  hasProfile = async () => true, now = Date.now, newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}) {
  let queue = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
  /** taskId → controller for the model call in flight. Lost on sleep, which also ends the call. */
  const calls = new Map();
  /** @type {Set<Promise<void>>} */
  const inFlight = new Set();
  /**
   * taskId → observe, model or execute effects this worker is running for it. A task that is
   * OBSERVING, THINKING or EXECUTING with none here was left behind by a worker that went away.
   * @type {Map<string, number>}
   */
  const busy = new Map();
  const WORK = new Set(['OBSERVE', 'CALL_LLM', 'EXECUTE']);
  /** @param {string} id @param {number} delta */
  const markBusy = (id, delta) => {
    const n = (busy.get(id) ?? 0) + delta;
    if (n > 0) busy.set(id, n);
    else busy.delete(id);
  };

  /** @param {unknown} err @returns {{ code: string, message: string }} */
  const toError = (err) => (err instanceof LlmError || err instanceof FeatureError
    ? { code: err.code, message: err.message }
    : { code: 'INTERNAL', message: 'Something went wrong. Please try again.' });

  /**
   * Apply one event to a saved task, save, notify, then start its effects.
   * @param {string} taskId
   * @param {AgentEvent} event
   * @param {(task: AgentTask) => boolean} [when] checked under the lock: skip the event unless true
   * @returns {Promise<AgentTask|null>}
   */
  async function dispatch(taskId, event, when) {
    const out = await serial(async () => {
      const task = await store.get(taskId);
      if (!task) return null;
      if (when && !when(task)) return { task, effects: [] };
      const { task: nextTask, effects } = transition(task, event, now());
      if (nextTask !== task) {
        await store.save(nextTask); // saved before anything else happens (§12.4)
        notify(nextTask);
      }
      // Counted while still under the lock, so a concurrent stuck check can't miss them.
      for (const e of effects) if (WORK.has(e.type)) markBusy(taskId, 1);
      return { task: nextTask, effects };
    });
    if (!out) return null;
    for (const effect of out.effects) track(perform(out.task, effect));
    return out.task;
  }

  /**
   * Was this task left mid-step by a worker that went to sleep, or is its model call hung? Then
   * look again (once), or ask the user if a step may have run (P3.6). Runs under the lock.
   * @param {AgentTask} task
   */
  function isStuck(task) {
    if (task.status === 'PAUSED') return task.paused?.from === 'EXECUTING' && Boolean(task.pending) && !busy.has(task.taskId);
    if (task.status !== 'OBSERVING' && task.status !== 'THINKING' && task.status !== 'EXECUTING') return false;
    if (!busy.has(task.taskId)) return true;
    if (task.status === 'THINKING' && now() - task.updatedAt > AGENT_STUCK_MS) {
      calls.get(task.taskId)?.abort();
      return true;
    }
    return false;
  }

  /** @param {Promise<void>} p */
  function track(p) {
    inFlight.add(p);
    p.finally(() => inFlight.delete(p));
  }

  /** @param {AgentTask} task @param {Effect} effect @returns {Promise<void>} */
  async function perform(task, effect) {
    try {
      await performOne(task, effect);
    } finally {
      if (WORK.has(effect.type)) markBusy(task.taskId, -1);
    }
  }

  /** @param {AgentTask} task @param {Effect} effect @returns {Promise<void>} */
  async function performOne(task, effect) {
    const id = task.taskId;
    switch (effect.type) {
      case 'OBSERVE': {
        /** @type {AgentEvent} */
        let event;
        try {
          const observation = await observe(task, { afterAction: effect.afterAction });
          // The page as it is now: a "Pay now" box that opened since the last step pauses the task (EC-TIR-07).
          event = { type: 'OBSERVED', cycle: effect.cycle, observation, allowed: await checkAllowed(observation.url, task.tabId) };
        } catch (err) {
          event = { type: 'OBSERVE_FAILED', cycle: effect.cycle, error: toError(err) };
        }
        await dispatch(id, event);
        return;
      }
      case 'CALL_LLM': {
        const controller = new AbortController();
        calls.set(id, controller);
        /** @type {AgentEvent|null} */
        let event = null;
        try {
          event = { type: 'THOUGHT', cycle: effect.cycle, proposal: await think(task, effect.observation, controller.signal) };
        } catch (err) {
          if (!controller.signal.aborted) event = { type: 'THINK_FAILED', cycle: effect.cycle, error: toError(err) };
        } finally {
          if (calls.get(id) === controller) calls.delete(id);
        }
        if (event) await dispatch(id, event);
        return;
      }
      case 'EXECUTE': {
        // The only path to CS_EXECUTE, and only ever after an approval (P3.5 verify step).
        console.info('[Pagewise] CS_EXECUTE', { taskId: id, stepId: effect.step.stepId, action: effect.step.action.type });
        /** @type {ExecResult} */
        let result;
        try {
          result = await execute(task, effect.step);
        } catch {
          result = { ok: false, code: 'FAILED', error: "Couldn't reach the page." };
        }
        await dispatch(id, { type: 'EXECUTED', stepId: effect.step.stepId, result });
        return;
      }
      case 'HIGHLIGHT':
        await highlight(task, effect.target, effect.style).catch(() => {});
        return;
      case 'ABORT_LLM':
        calls.get(id)?.abort();
        calls.delete(id);
        return;
      default:
        return;
    }
  }

  /**
   * The task (the active one if no id), recovering it first if it was left mid-step.
   * @param {{ taskId?: string }} [payload]
   */
  async function getState(payload) {
    const task = payload?.taskId ? await store.get(payload.taskId) : await store.getActive();
    if (!task) return null;
    return (await dispatch(task.taskId, { type: 'RECOVER' }, isStuck)) ?? task;
  }

  /**
   * The kill switch (§12.7): abort any model call at once, before anything is awaited, then save
   * STOPPED. Used by the Stop button, Esc in the panel and Alt+Shift+X.
   * @param {string} reason
   * @param {string} [taskId] defaults to the active task
   */
  async function stop(reason, taskId) {
    for (const [id, controller] of calls) if (!taskId || id === taskId) controller.abort();
    const id = taskId ?? (await store.getActiveId());
    if (!id) return null;
    return dispatch(id, { type: 'STOP', reason });
  }

  /**
   * Pause the active task, if `applies` says this event concerns it.
   * @param {PauseReason} reason
   * @param {string} message
   * @param {(task: AgentTask) => boolean} applies
   */
  async function pauseActive(reason, message, applies) {
    const id = await store.getActiveId();
    if (!id) return null;
    return dispatch(id, { type: 'PAUSE', reason, message }, applies);
  }

  return {
    dispatch,
    getState,

    /**
     * @param {{ tabId?: number, goal?: string, options?: { maxSteps?: number, dryRun?: boolean, useProfile?: boolean } }} payload
     * @param {{ windowId: number }} ctx
     */
    async start(payload, { windowId }) {
      const goal = typeof payload?.goal === 'string' ? payload.goal.trim().slice(0, AGENT_GOAL_MAX_CHARS) : '';
      if (!goal) throw new FeatureError('EMPTY_QUESTION', 'Tell Pagewise what to do, e.g. "Fill this form with my name and email, and stop before submitting."');
      if (typeof payload.tabId !== 'number') throw new FeatureError('PAGE_RESTRICTED', 'Open a web page first.');
      const url = await getTabUrl(payload.tabId);
      const allowed = await checkAllowed(url, payload.tabId);
      if (!allowed.allowed) {
        // A page tier explains itself; the allow-list gets its own message (EC-TIR-11: tier 3 beats owned).
        if (allowed.tier) throw new FeatureError('PAGE_BLOCKED', allowed.reason ?? 'The agent can’t run on this page.');
        const detail = url.startsWith('file:') && allowed.reason ? ` ${allowed.reason}` : '';
        throw new FeatureError('PAGE_BLOCKED', `Agent tasks only run on the practice site or sites you own.${detail}`);
      }
      // Nothing to fill in from: say so now rather than let the model guess (EC-PRF-01).
      if (payload.options?.useProfile === true && !(await hasProfile())) {
        throw new FeatureError('PROFILE_EMPTY', 'Your profile is empty. Add your details in Settings → Profile, or turn off "Use my profile".');
      }

      // At most one active task (§7.1): a new one stops the old one first.
      const active = await store.getActiveId();
      if (active) await dispatch(active, { type: 'STOP', reason: 'Stopped: you started a new task.' });

      const defaults = await getDefaults();
      const o = payload.options ?? {};
      const { task, effects } = startTask({
        taskId: newId(), goal, tabId: payload.tabId, windowId, url, now: now(),
        options: {
          maxSteps: clampMaxSteps(o.maxSteps ?? defaults.maxSteps),
          dryRun: typeof o.dryRun === 'boolean' ? o.dryRun : defaults.dryRun,
          useProfile: o.useProfile === true
        }
      });
      await serial(async () => {
        await store.save(task);
        for (const e of effects) if (WORK.has(e.type)) markBusy(task.taskId, 1);
      });
      notify(task);
      for (const effect of effects) track(perform(task, effect));
      return task;
    },

    /**
     * @param {{ taskId?: string, stepId?: string, decision?: string, confirmConsequential?: boolean, hint?: string }} payload
     */
    async decide(payload) {
      const decision = /** @type {any} */ (payload?.decision);
      if (decision === 'stop') return stop('Stopped by you.', payload.taskId);
      if (!['approve', 'skip', 'cancel', 'retry', 'resume'].includes(decision)) return getState(payload);
      const taskId = payload.taskId ?? (await store.getActiveId());
      if (!taskId) return null;
      return dispatch(taskId, {
        type: 'DECISION', stepId: payload.stepId, decision, confirmConsequential: payload.confirmConsequential === true,
        hint: typeof payload.hint === 'string' ? payload.hint : undefined
      });
    },

    stop,

    /** A tab became active in some window: leaving the task's tab pauses it, coming back resumes. */
    async onTabActivated(/** @type {number} */ tabId, /** @type {number} */ windowId) {
      const id = await store.getActiveId();
      if (!id) return null;
      const task = await store.get(id);
      if (!task || task.windowId !== windowId) return task;
      if (tabId === task.tabId) {
        return dispatch(id, { type: 'DECISION', decision: 'resume' }, (t) => t.status === 'PAUSED' && t.paused?.reason === 'tab');
      }
      return pauseActive('tab', TAB_PAUSE_MESSAGE, (t) => t.tabId !== tabId && t.windowId === windowId);
    },

    /** The task's tab navigated: off the allow-list, the agent pauses and can't resume there (§12.8). */
    async onTabUrl(/** @type {number} */ tabId, /** @type {string} */ url) {
      const verdict = await checkAllowed(url);
      if (verdict.allowed) return null;
      return pauseActive('safety', `Agent paused for safety. ${verdict.reason ?? ''}`.trim(), (t) => t.tabId === tabId);
    },

    /** @param {number} tabId */
    async onTabRemoved(tabId) {
      const id = await store.getActiveId();
      const task = await store.get(id);
      return task?.tabId === tabId ? stop("Stopped: the task's tab was closed.", task.taskId) : null;
    },

    /** Chrome restarted: tab ids don't survive that, so a running task can't carry on (P3.6). */
    async onBrowserStartup() {
      return pauseActive('restart', 'Chrome restarted, so this task was paused. Its tab is gone: start the task again.', () => true);
    },

    /** Past and current tasks, newest first, without their logs (Settings → Logs). */
    async list() {
      return (await store.list()).map((t) => ({
        taskId: t.taskId, goal: t.goal, status: t.status, url: t.url, stepCount: t.stepCount,
        steps: t.log.length, createdAt: t.createdAt, updatedAt: t.updatedAt
      }));
    },

    /** Resolves once every effect started so far (and the ones they lead to) has finished. For tests. */
    async idle() {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
      await queue;
    }
  };
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The page unloaded before replying: what a click that navigates looks like from here. @param {unknown} err */
const isChannelClosed = (err) => err instanceof Error && /message (port|channel) closed|receiving end does not exist/i.test(err.message);

/** Wire the agent into the router. Call synchronously at the worker's top level. */
export function initAgent() {
  const storage = createStorage(chrome.storage.local);
  const guard = chromePageGuard();
  const store = createAgentStore(storage);
  const gateway = createDefaultGateway();
  const pageScan = chromePageScan();

  const runner = createAgentRunner({
    store,
    getTabUrl: async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      return tab.url ?? tab.pendingUrl ?? '';
    },
    // The allow-list (§14.3), then the page tier (§14.2). Without a tab (a navigation that's still
    // loading) only the address is judged; the next observe looks at the page itself.
    async checkAllowed(url, tabId) {
      const listed = checkAgentAllowed(url, { ownedDomains: (await storage.get('safety')).ownedDomains });
      if (!listed.allowed) return listed;
      try {
        if (tabId === undefined) await guard.assertUrl(url, 'agent');
        else await guard.assert(tabId, 'agent');
      } catch (err) {
        if (err instanceof FeatureError) return { allowed: false, reason: err.message, tier: true };
        throw err;
      }
      return { allowed: true, reason: null };
    },
    getDefaults: async () => {
      const { agent } = await storage.getSettings();
      return { maxSteps: agent.maxSteps, dryRun: agent.dryRunDefault };
    },
    hasProfile: async () => profileKeys(await storage.getProfile()).length > 0,

    async observe(task, { afterAction }) {
      // Give a click's navigation a moment to start, so we wait for the new page, not the old one (§12.6).
      if (afterAction) await sleep(400);
      const tab = await chrome.tabs.get(task.tabId).catch(() => null);
      if (!tab) throw new FeatureError('TAB_GONE', 'The tab was closed.');
      const { result, map } = await pageScan.observe(task.tabId); // waits for load, re-injects after navigation
      const visible = await sendToTab(task.tabId, ToContent.CS_EXTRACT_VISIBLE).catch(() => ({ text: '' }));
      return {
        snapshotId: result.snapshotId, url: result.url, title: result.title, elements: result.elements, map,
        pageText: String(visible?.text ?? '').slice(0, AGENT_PAGE_TEXT_CHARS),
        pageOtp: Boolean(result.pageOtp),
        pageCard: result.elements.some((d) => d.protected === 'card')
      };
    },

    async think(task, obs, signal) {
      const [profile, settings] = await Promise.all([storage.getProfile(), storage.getSettings()]);
      const { system, turns } = buildAgentPrompt({ task, map: obs.map, pageText: obs.pageText, profile, language: settings.language });
      const reply = await gateway.json({
        task: 'agent', system, turns, schema: AgentActionSchema, signal,
        validate: (/** @type {unknown} */ v) => validateAgentAction(v, { elements: obs.elements, profile, useProfile: task.options.useProfile })
      });
      const action = reply.value;
      return {
        snapshotId: obs.snapshotId, url: obs.url, action,
        element: action.target === null ? null : obs.elements.find((d) => d.id === action.target) ?? null,
        resolvedValue: action.value === null ? null : resolveProfileRefs(action.value, profile),
        fromProfile: action.value !== null && profileRefs(action.value).length > 0,
        model: reply.model, provider: reply.provider, pageOtp: obs.pageOtp, pageCard: obs.pageCard
      };
    },

    async execute(task, step) {
      await ensureInjected(task.tabId, [ToContent.CS_EXECUTE]);
      try {
        return await sendToTab(task.tabId, ToContent.CS_EXECUTE, {
          snapshotId: step.snapshotId,
          elementId: step.element?.id ?? null,
          fingerprint: step.element?.fingerprint ?? null,
          action: { type: step.action.type, value: step.resolvedValue, direction: step.action.direction },
          confirmed: step.consequential && step.decision === 'confirmed'
        });
      } catch (err) {
        if (step.action.type === 'click' && isChannelClosed(err)) return { ok: true, effect: { navigated: true } };
        throw err;
      }
    },

    highlight: (task, target, style) => pageScan.highlight(task.windowId, task.tabId, target && style
      ? { ...target, style: /** @type {any} */ (style) }
      : null),

    notify: (task) => sendToWindow(task.windowId, makeMessage(ToPanel.AGENT_STATE, { task }))
  });

  /**
   * @param {(payload: any, windowId: number) => Promise<AgentTask|null>} run
   * @returns {import('../router.js').Handler}
   */
  const reply = (run) => async (payload, { port, windowId }, msg) => {
    try {
      port.postMessage(makeMessage(ToPanel.AGENT_STATE, { task: await run(payload, windowId) }, msg.requestId));
    } catch (err) {
      if (!(err instanceof FeatureError)) throw err; // router turns this into a generic INTERNAL error
      port.postMessage(makeMessage(ToPanel.ERROR, err.toPayload(), msg.requestId));
    }
  };

  on(ToSW.AGENT_START, reply((p, windowId) => runner.start(p, { windowId })));
  on(ToSW.AGENT_DECISION, reply((p) => runner.decide(p)));
  on(ToSW.AGENT_GET_STATE, reply((p) => runner.getState(p)));
  on(ToSW.AGENT_LIST, async (payload, { port }, msg) => {
    port.postMessage(makeMessage(ToPanel.AGENT_LIST_RESULT, { tasks: await runner.list() }, msg.requestId));
  });

  // Tab binding (§12.8). Errors here only mean the task or tab is already gone.
  chrome.tabs.onActivated.addListener(({ tabId, windowId }) => { runner.onTabActivated(tabId, windowId).catch(() => {}); });
  chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.url) runner.onTabUrl(tabId, info.url).catch(() => {}); });
  chrome.tabs.onRemoved.addListener((tabId) => { runner.onTabRemoved(tabId).catch(() => {}); });
  chrome.runtime.onStartup.addListener(() => { runner.onBrowserStartup().catch(() => {}); });

  return runner;
}
