// @ts-check
// Agent tab. P3.5: give Sahayak a task and approve, skip or stop each step it proposes.
// P3.6: step limit and dry run options, Esc stops the task, and the task's timeline.
// P4.1: "Use my profile" lets the agent fill fields with {{profile.*}} values.
// P3.4: "Find it for me" points at the one element that answers a question, without acting.
// P3.3: number the page's buttons and fields ("Show numbers") and show the action map the agent
// sees, for checking the scanner.

import { AGENT_GOAL_MAX_CHARS, AGENT_HARD_MAX_STEPS, FIND_MAX_QUERY_CHARS } from '../../shared/config.js';
import { ToPanel, ToSW } from '../../shared/messages.js';
import { createApprovalCard } from '../components/approval-card.js';
import { createErrorBanner } from '../components/error-banner.js';
import { viaLabel } from '../components/message-list.js';

const TEMPLATE = /* html */ `
  <div class="agent">
    <div class="agent-intro">
      <h2>Agent</h2>
      <p class="hint">Give Sahayak a task. It proposes one step at a time, and nothing happens on the page until
        you approve it. Tasks run on the practice site and on sites you've added as your own.</p>
    </div>

    <section class="task" aria-labelledby="task-heading">
      <h3 id="task-heading">Do a task</h3>
      <form class="task-form" data-ref="taskForm">
        <textarea data-ref="goal" rows="3" maxlength="${AGENT_GOAL_MAX_CHARS}" aria-label="What should Sahayak do on this page?"
                  placeholder="e.g. Fill this form from my profile, and stop before submitting."></textarea>
        <div class="row task-form-bar">
          <label class="check" title="Sahayak sees only your profile's field names. You see each value on the step before approving it.">
            <input type="checkbox" data-ref="useProfile" /> Use my profile</label>
          <label class="check"><input type="checkbox" data-ref="dryRun" /> Dry run (only highlight each step)</label>
          <label class="check">Max steps
            <input type="number" class="steps-input" data-ref="maxSteps" min="1" max="${AGENT_HARD_MAX_STEPS}" step="1" inputmode="numeric" />
          </label>
          <button type="submit" class="btn btn-primary" data-ref="startBtn">Start</button>
        </div>
        <p class="hint">Stop any time with ⏹ Stop, Esc, or Alt+Shift+X.</p>
      </form>
      <div data-ref="taskNotice"></div>
      <div data-ref="taskOut"></div>
    </section>

    <section class="find" aria-labelledby="find-heading">
      <h3 id="find-heading">Find it for me</h3>
      <p class="hint">Sahayak points at it on the page. It won't click or type anything.</p>
      <form class="find-form" data-ref="findForm">
        <input type="text" data-ref="findInput" maxlength="${FIND_MAX_QUERY_CHARS}" autocomplete="off"
               placeholder="e.g. Where do I upload my resume?" aria-label="What are you looking for on this page?" />
        <button type="submit" class="btn btn-primary" data-ref="findBtn">Find</button>
      </form>
      <div data-ref="findOut" aria-live="polite"></div>
    </section>

    <h3>How Sahayak reads this page</h3>
    <p class="hint">Every button and field gets a number, and 🔒 marks fields it will never type into.</p>
    <div class="row">
      <button type="button" class="btn btn-secondary" data-ref="badges" aria-pressed="false">Show numbers</button>
      <button type="button" class="btn btn-secondary" data-ref="scan">Scan again</button>
    </div>
    <p class="hint" data-ref="summary" aria-live="polite"></p>
    <div data-ref="notice"></div>
    <details class="action-map" data-ref="details" hidden>
      <summary>Action map (what the AI will see)</summary>
      <pre data-ref="map"></pre>
    </details>
  </div>
`;

/**
 * @param {HTMLElement} root
 * @param {{
 *   store: import('../store.js').Store<{
 *     activeTab: import('../../background/tab-context.js').ActiveTabInfo|null,
 *     connection: import('../connection.js').ConnectionStatus,
 *     settingsState: import('../../background/settings-service.js').SettingsState|null
 *   }>,
 *   client: Awaited<ReturnType<typeof import('../client.js').startClient>>,
 *   openSettings: () => void
 * }} deps
 */
export function mountAgentView(root, { store, client, openSettings }) {
  root.innerHTML = TEMPLATE;
  /** @param {string} name @returns {any} */
  const ref = (name) => root.querySelector(`[data-ref="${name}"]`);
  const badgesBtn = /** @type {HTMLButtonElement} */ (ref('badges'));
  const scanBtn = /** @type {HTMLButtonElement} */ (ref('scan'));
  const findBtn = /** @type {HTMLButtonElement} */ (ref('findBtn'));
  const findInput = /** @type {HTMLInputElement} */ (ref('findInput'));
  const findOut = /** @type {HTMLElement} */ (ref('findOut'));
  const startBtn = /** @type {HTMLButtonElement} */ (ref('startBtn'));
  const goalInput = /** @type {HTMLTextAreaElement} */ (ref('goal'));
  const dryRunBox = /** @type {HTMLInputElement} */ (ref('dryRun'));
  const useProfileBox = /** @type {HTMLInputElement} */ (ref('useProfile'));
  const maxStepsInput = /** @type {HTMLInputElement} */ (ref('maxSteps'));
  const taskOut = /** @type {HTMLElement} */ (ref('taskOut'));
  const taskNotice = /** @type {HTMLElement} */ (ref('taskNotice'));

  let badgesOn = false;
  let busy = false;
  let finding = false;
  let starting = false;
  /** @type {import('../../background/agent/agent-controller.js').AgentTask|null} */
  let task = null;
  let dryRunTouched = false;
  let maxStepsTouched = false;
  /** Bumped per request so a slow reply for an old page can't overwrite a newer one. */
  let token = 0;
  let findToken = 0;

  function render() {
    const tab = store.get().activeTab;
    const usable = tab?.tabId != null && !tab.access.restricted;
    badgesBtn.disabled = busy || !usable;
    scanBtn.disabled = busy || !usable;
    findBtn.disabled = finding || !usable;
    findBtn.textContent = finding ? 'Finding…' : 'Find';
    const running = task !== null && task.status !== 'DONE' && task.status !== 'STOPPED';
    ref('taskForm').hidden = running;
    startBtn.disabled = starting || !usable;
    startBtn.textContent = starting ? 'Starting…' : 'Start';
    badgesBtn.setAttribute('aria-pressed', String(badgesOn));
    badgesBtn.textContent = badgesOn ? 'Hide numbers' : 'Show numbers';
  }

  /** @param {any} result */
  function showResult(result) {
    const parts = [`${result.count} element${result.count === 1 ? '' : 's'}`];
    if (result.protectedCount) parts.push(`${result.protectedCount} protected 🔒`);
    parts.push(`map ≈ ${result.tokens.toLocaleString()} tokens`);
    if (result.truncated) parts.push('capped');
    ref('summary').textContent = parts.join(' · ');
    ref('map').textContent = result.map; // plain text: names come from the page (EC-SCN-24)
    ref('details').hidden = false;
  }

  /** Scan the active tab, numbering it if badges are on. */
  async function scan() {
    const tabId = store.get().activeTab?.tabId;
    if (tabId == null) return;
    const mine = ++token;
    busy = true;
    ref('notice').replaceChildren();
    render();
    try {
      const reply = await client.request(ToSW.SCAN_PAGE, { tabId, badges: badgesOn });
      if (mine !== token) return;
      if (reply.type === ToPanel.SCAN_RESULT) {
        showResult(reply.payload);
      } else {
        badgesOn = false;
        ref('notice').replaceChildren(createErrorBanner(reply.payload ?? { code: 'INTERNAL', message: "Couldn't read this page." }, {}));
      }
    } catch (err) {
      if (mine !== token) return;
      ref('notice').replaceChildren(createErrorBanner({ code: 'INTERNAL', message: err instanceof Error ? err.message : "Couldn't read this page." }, {}));
    } finally {
      if (mine === token) {
        busy = false;
        render();
      }
    }
  }

  // ---- Agent task (P3.5) ----

  /** @param {import('../../background/agent/agent-controller.js').AgentTask|null} next */
  function showTask(next) {
    // Keep the newest copy: a pushed update and a reply can arrive in either order.
    if (next && task && next.taskId === task.taskId && next.updatedAt < task.updatedAt) return;
    task = next;
    taskOut.replaceChildren(...(task ? [createApprovalCard(task, { onDecision: decide, onGoToTab: goToTaskTab })] : []));
    render();
  }

  /** @param {import('../../shared/messages.js').Message} reply */
  function handleTaskReply(reply) {
    if (reply.type === ToPanel.AGENT_STATE) {
      taskNotice.replaceChildren();
      if (reply.payload?.task) showTask(reply.payload.task);
      return;
    }
    taskNotice.replaceChildren(createErrorBanner(
      reply.payload ?? { code: 'INTERNAL', message: 'Something went wrong. Please try again.' }, { onOpenSettings: openSettings }
    ));
  }

  /** Switch back to the tab the task runs in; coming back resumes it (§12.8). */
  function goToTaskTab() {
    if (task) chrome.tabs.update(task.tabId, { active: true }).catch(() => {});
  }

  /** @type {import('../components/approval-card.js').OnDecision} */
  function decide(decision, opts = {}) {
    if (!task) return;
    client.request(ToSW.AGENT_DECISION, { taskId: task.taskId, decision, ...opts })
      .then(handleTaskReply)
      .catch((err) => taskNotice.replaceChildren(createErrorBanner(
        { code: 'INTERRUPTED', message: err instanceof Error ? err.message : 'Connection interrupted.' }, {}
      )));
  }

  ref('taskForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const tabId = store.get().activeTab?.tabId;
    const goal = goalInput.value.trim();
    if (tabId == null || starting) return;
    if (!goal) {
      goalInput.focus();
      return;
    }
    starting = true;
    taskNotice.replaceChildren();
    render();
    try {
      const maxSteps = Number(maxStepsInput.value);
      const options = {
        dryRun: dryRunBox.checked, useProfile: useProfileBox.checked,
        ...(Number.isFinite(maxSteps) && maxSteps > 0 ? { maxSteps } : {})
      };
      handleTaskReply(await client.request(ToSW.AGENT_START, { tabId, goal, options }));
    } catch (err) {
      taskNotice.replaceChildren(createErrorBanner(
        { code: 'INTERRUPTED', message: err instanceof Error ? err.message : "Couldn't start the task." }, {}
      ));
    } finally {
      starting = false;
      render();
    }
  });

  /** Pick up the saved task when the panel opens or reconnects, e.g. after the worker restarted (§12.4). */
  async function refreshTask() {
    try {
      const reply = await client.request(ToSW.AGENT_GET_STATE, {});
      if (reply.type === ToPanel.AGENT_STATE) showTask(reply.payload?.task ?? task);
    } catch {
      /* not connected yet: the next "connected" retries */
    }
  }
  store.subscribe((s) => s.connection, (status) => {
    if (status === 'connected') refreshTask();
  });
  dryRunBox.addEventListener('change', () => { dryRunTouched = true; });
  maxStepsInput.addEventListener('input', () => { maxStepsTouched = true; });
  store.subscribe((s) => s.settingsState?.settings.agent.dryRunDefault, (on) => {
    if (!dryRunTouched && typeof on === 'boolean') dryRunBox.checked = on;
  });
  store.subscribe((s) => s.settingsState?.settings.agent.maxSteps, (n) => {
    if (!maxStepsTouched && typeof n === 'number') maxStepsInput.value = String(n);
  });

  // Esc anywhere in the panel is a kill switch while a task runs (§12.7). Controls that use Esc
  // themselves (the crop tool) mark the event handled first.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !task) return;
    if (task.status === 'DONE' || task.status === 'STOPPED') return;
    event.preventDefault();
    decide('stop');
  });

  // ---- Find it for me ----

  /** @param {string} className @param {string} text */
  function para(className, text) {
    const p = document.createElement('p');
    p.className = className;
    p.textContent = text; // names and reasons come from the page and the model: plain text only
    return p;
  }

  /** @param {import('../../background/find.js').FindResult} result @param {number} tabId */
  function showFound(result, tabId) {
    const card = document.createElement('div');
    if (result.elementId === null) {
      card.className = 'find-card not-found';
      card.append(para('find-reason', result.message ?? "I couldn't find a matching element on this screen."));
      findOut.replaceChildren(card);
      return;
    }
    card.className = 'find-card';
    const head = para('find-target', '');
    const label = document.createElement('strong');
    label.textContent = `[${result.elementId}] ${result.name || '(unnamed)'}`;
    head.append(label);
    if (result.role) {
      const role = document.createElement('span');
      role.className = 'chip chip-muted';
      role.textContent = result.role;
      head.append(' ', role);
    }
    card.append(head, para('find-reason', result.reason));
    if (result.confidence === 'low') card.append(para('note', "I'm not sure about this one. Check it's the right thing before using it."));
    if (result.protected) card.append(para('note', '🔒 You fill this in yourself. Sahayak never types into it.'));
    const status = para('note', '');
    status.setAttribute('role', 'status');
    /** @param {string} text */
    const setStatus = (text) => {
      status.textContent = text;
      status.hidden = !text;
    };
    setStatus(result.highlighted ? '' : 'The page changed before I could point at it. Try finding it again.');
    card.append(status);

    const row = document.createElement('div');
    row.className = 'row';
    const again = document.createElement('button');
    again.type = 'button';
    again.className = 'btn btn-secondary';
    again.textContent = 'Show again';
    again.addEventListener('click', async () => {
      again.disabled = true;
      try {
        const reply = await client.request(ToSW.FIND_SHOW_AGAIN, {
          tabId, snapshotId: result.snapshotId, elementId: result.elementId, fingerprint: result.fingerprint
        });
        setStatus(reply.payload?.ok ? '' : "That element isn't on the page any more. Try finding it again.");
      } catch {
        setStatus("Couldn't reach the page. Try again.");
      } finally {
        again.disabled = false;
      }
    });
    row.append(again);
    if (result.model) {
      const via = document.createElement('span');
      via.className = 'chip chip-muted';
      via.textContent = viaLabel({ model: result.model, provider: result.provider ?? 'gemini' });
      row.append(via);
    }
    card.append(row);
    findOut.replaceChildren(card);
  }

  /** @param {string} query */
  async function find(query) {
    const tabId = store.get().activeTab?.tabId;
    if (tabId == null || finding) return;
    const mine = ++findToken;
    finding = true;
    findOut.replaceChildren();
    render();
    try {
      const reply = await client.request(ToSW.FIND_ELEMENT, { tabId, query });
      if (mine !== findToken) return;
      if (reply.type === ToPanel.FIND_RESULT) {
        showFound(reply.payload, tabId);
      } else {
        findOut.replaceChildren(createErrorBanner(
          reply.payload ?? { code: 'INTERNAL', message: "Couldn't search this page.", retryable: true },
          { onRetry: () => find(query), onOpenSettings: openSettings }
        ));
      }
    } catch (err) {
      if (mine !== findToken) return;
      findOut.replaceChildren(createErrorBanner(
        { code: 'INTERRUPTED', message: err instanceof Error ? err.message : "Couldn't search this page.", retryable: true },
        { onRetry: () => find(query) }
      ));
    } finally {
      if (mine === findToken) {
        finding = false;
        render();
      }
    }
  }

  ref('findForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const query = findInput.value.trim();
    if (!query) {
      findInput.focus();
      return;
    }
    find(query);
  });

  // ---- Numbers and the action map ----

  badgesBtn.addEventListener('click', async () => {
    const tabId = store.get().activeTab?.tabId;
    if (tabId == null) return;
    badgesOn = !badgesOn;
    if (badgesOn) {
      await scan(); // scans and numbers in one go
    } else {
      render();
      client.request(ToSW.SET_BADGES, { tabId, show: false }).catch(() => {});
    }
  });
  scanBtn.addEventListener('click', scan);

  // A new page or tab: the old map no longer applies. With numbers on, number the new page too
  // (the service worker takes them off the previous tab).
  store.subscribe((s) => (s.activeTab ? `${s.activeTab.tabId}|${s.activeTab.url}|${s.activeTab.status}` : null), () => {
    const tab = store.get().activeTab;
    ref('details').hidden = true;
    ref('summary').textContent = '';
    ref('notice').replaceChildren();
    findOut.replaceChildren(); // the ring and its number belonged to the old page
    token++;
    findToken++;
    busy = false;
    finding = false;
    render();
    if (badgesOn && tab?.tabId != null && !tab.access.restricted && tab.status === 'complete') scan();
  });

  return {
    /** A task update pushed by the service worker. @param {any} payload */
    onAgentState(payload) {
      if (payload?.task) showTask(payload.task);
    }
  };
}
