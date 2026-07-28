/**
 * Input policy — the guarantee that a run never stalls waiting for a keypress.
 *
 * Prompts are useful while the user is setting a run up and actively watching.
 * They are a liability once work is in flight: background media prep and the
 * progress bar bury the question, and an unattended run can sit on stdin
 * forever. So every prompt is bounded — if no answer arrives in time, the
 * documented default is taken and the run continues.
 *
 * Three regimes:
 *   setup   — user is driving; wait a long time (they are answering pickers)
 *   running — work in flight; wait briefly, then continue with the default
 *   disabled — --no-input; never wait at all, take defaults immediately
 */

'use strict';

/** Generous: the user is actively working through the run-mode pickers. */
const SETUP_TIMEOUT_MS = 600_000; // 10 min

/** Short: anything asked mid-run must not hold up work that is already going. */
const RUNNING_TIMEOUT_MS = 30_000;

let _mode = 'setup';

/**
 * @param {'setup'|'running'|'disabled'} mode
 */
function setInputMode(mode) {
  _mode = mode;
}

function getInputMode() {
  return _mode;
}

/** True when prompts must resolve instantly with their default. */
function isInputDisabled() {
  return _mode === 'disabled' || !process.stdin.isTTY;
}

/** Milliseconds a prompt may block before defaulting. 0 = do not wait. */
function promptTimeoutMs() {
  if (isInputDisabled()) return 0;
  return _mode === 'running' ? RUNNING_TIMEOUT_MS : SETUP_TIMEOUT_MS;
}

module.exports = {
  setInputMode,
  getInputMode,
  isInputDisabled,
  promptTimeoutMs,
  SETUP_TIMEOUT_MS,
  RUNNING_TIMEOUT_MS,
};
