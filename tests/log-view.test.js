// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { actionText, outcomeText, renderTimeline, taskToJson, taskToMarkdown } from '../src/sidepanel/views/log-view.js';
import { STOP_AGENT_COMMAND, initCommands } from '../src/background/commands.js';

const entry = (over = {}) => ({
  ts: Date.UTC(2026, 10, 2, 10, 30), stepId: 'step-1', url: 'http://localhost:3000/internship/', targetName: 'College name',
  decision: 'approved', outcome: 'ok', model: 'gemini-3.5-flash-lite',
  action: { type: 'type', target: 4, value: 'IIT Hyderabad', direction: null, reason: 'Fills the college field.', note: null, result: null },
  ...over
});

const TASK = {
  taskId: 't1', goal: 'Fill the application | quickly', tabId: 7, windowId: 1, origin: 'http://localhost:3000',
  url: 'http://localhost:3000/internship/', status: 'DONE', options: { maxSteps: 15, dryRun: false, useProfile: false },
  stepCount: 3, cycle: 4, pending: null, notes: ['Robotics — r@x.in'], result: '| Club | Email |\n|---|---|', message: null,
  createdAt: Date.UTC(2026, 10, 2, 10, 29), updatedAt: Date.UTC(2026, 10, 2, 10, 32),
  log: [
    entry(),
    entry({ stepId: 'step-2', decision: 'skipped', outcome: 'n/a', action: { ...entry().action, type: 'click', target: 10, value: null, reason: 'Goes to step 3.' }, targetName: 'Next' }),
    entry({ stepId: 'step-3', decision: 'blocked', outcome: 'n/a', error: 'Pagewise never types into password fields.', targetName: 'Password' })
  ]
};

describe('log text (P3.6)', () => {
  it('describes the action and what the user decided', () => {
    expect(actionText(entry())).toBe('type [4] "College name" ← "IIT Hyderabad"');
    expect(actionText(entry({ action: { ...entry().action, type: 'scroll', target: null, value: null, direction: 'down' } }))).toBe('scroll down');
    expect(outcomeText(entry())).toBe('approved · ok');
    expect(outcomeText(TASK.log[1])).toBe('skipped');
    expect(outcomeText(TASK.log[2])).toBe('blocked: Pagewise never types into password fields.');
  });
});

describe('taskToMarkdown', () => {
  const md = taskToMarkdown(TASK);

  it('has every step with its reason, decision, model and page', () => {
    expect(md).toContain('# Pagewise task: Fill the application | quickly');
    expect(md).toContain('| 1 | 2026-11-02T10:30:00.000Z | type [4] "College name" ← "IIT Hyderabad" | Fills the college field. | approved · ok | Gemini 3.5 Flash-Lite | localhost:3000/internship/ |');
    expect(md).toContain('| 2 |');
    expect(md).toMatch(/\| 3 \| .* \| blocked: Pagewise never types into password fields\. \|/);
  });

  it('escapes pipes inside cells, and adds notes and the result', () => {
    const withPipe = taskToMarkdown({ ...TASK, log: [entry({ action: { ...entry().action, reason: 'a | b' } })] });
    expect(withPipe).toContain('a \\| b');
    expect(md).toContain('## Notes\n\n- Robotics — r@x.in');
    expect(md).toContain('## Result\n\n| Club | Email |');
  });

  it('says so when there are no steps', () => {
    expect(taskToMarkdown({ ...TASK, log: [] })).toContain('No steps yet.');
  });
});

describe('taskToJson', () => {
  it('round-trips the saved task', () => {
    expect(JSON.parse(taskToJson(TASK))).toEqual(TASK);
  });
});

describe('renderTimeline', () => {
  it('shows one item per step, as plain text', () => {
    const evil = { ...TASK, log: [entry({ action: { ...entry().action, reason: '<img src=x onerror=alert(1)>' } })] };
    const list = renderTimeline(evil);
    expect(list.querySelectorAll('li')).toHaveLength(1);
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(renderTimeline(TASK).querySelectorAll('li.decision-blocked')).toHaveLength(1);
    expect(renderTimeline({ ...TASK, log: [] }).textContent).toBe('No steps yet.');
  });
});

describe('initCommands', () => {
  it('Alt+Shift+X stops the agent; other commands are ignored', () => {
    let listener;
    globalThis.chrome = { commands: { onCommand: { addListener: (fn) => { listener = fn; } } } };
    const stopAgent = vi.fn(async () => {});
    initCommands({ stopAgent });
    listener('something-else');
    expect(stopAgent).not.toHaveBeenCalled();
    listener(STOP_AGENT_COMMAND);
    expect(stopAgent).toHaveBeenCalledOnce();
    delete globalThis.chrome;
  });
});
