// @ts-check
// Agent tasks in chrome.storage.local (architecture §7.1, §12.2): `agentTasks` holds the last 20
// tasks by id, `activeTaskId` the one still running. Everything the controller needs survives the
// worker going to sleep, because every transition is saved here before its effects run.

/** Tasks kept after pruning, newest first; the active task is never pruned. */
export const AGENT_TASKS_KEPT = 20;

/**
 * @param {Pick<ReturnType<typeof import('../../shared/storage.js').createStorage>, 'get'|'set'>} storage
 */
export function createAgentStore(storage) {
  /** Serialises read-modify-write of agentTasks within this worker. */
  let queue = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const serial = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  /** @param {string|null|undefined} taskId @returns {Promise<import('./agent-controller.js').AgentTask|null>} */
  async function get(taskId) {
    if (!taskId) return null;
    const all = await storage.get('agentTasks');
    return all[taskId] ?? null;
  }

  return {
    get,

    /** @returns {Promise<string|null>} */
    getActiveId: () => storage.get('activeTaskId'),

    /** The running task, if any. */
    async getActive() {
      return get(await storage.get('activeTaskId'));
    },

    /**
     * Save a task, keep at most AGENT_TASKS_KEPT, and keep `activeTaskId` in step with its status.
     * @param {import('./agent-controller.js').AgentTask} task
     */
    save(task) {
      return serial(async () => {
        const activeId = await storage.get('activeTaskId');
        const all = { ...(await storage.get('agentTasks')), [task.taskId]: task };
        const keep = Object.values(all)
          .sort((a, b) => (b.taskId === activeId ? 1 : 0) - (a.taskId === activeId ? 1 : 0) || b.updatedAt - a.updatedAt)
          .slice(0, AGENT_TASKS_KEPT);
        await storage.set('agentTasks', Object.fromEntries(keep.map((t) => [t.taskId, t])));
        const finished = task.status === 'DONE' || task.status === 'STOPPED'; // ERROR can still be retried
        if (!finished && activeId !== task.taskId) await storage.set('activeTaskId', task.taskId);
        if (finished && activeId === task.taskId) await storage.set('activeTaskId', null);
      });
    },

    /** Every saved task, newest first (for the log, P3.6). */
    async list() {
      return Object.values(await storage.get('agentTasks')).sort((a, b) => b.updatedAt - a.updatedAt);
    }
  };
}
