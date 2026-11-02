// @ts-check
// Keyboard shortcuts (manifest "commands"). Alt+Shift+X stops the agent from anywhere in Chrome,
// even when the side panel doesn't have focus (architecture §12.7).

/** Must match the key in manifest.json → commands. */
export const STOP_AGENT_COMMAND = 'stop-agent';

/**
 * Register the command listener. Call synchronously at the worker's top level.
 * @param {{ stopAgent: () => Promise<unknown> }} deps
 */
export function initCommands({ stopAgent }) {
  chrome.commands.onCommand.addListener((command) => {
    if (command === STOP_AGENT_COMMAND) stopAgent().catch(() => {});
  });
}
