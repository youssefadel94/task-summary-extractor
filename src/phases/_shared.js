'use strict';

const path = require('path');

// ======================== SHARED STATE ========================
// These values are set in phaseInit and read by all other phases.

let _log = null;
let _shuttingDown = false;

// PKG_ROOT = where the package is installed (for reading prompt.json, package.json)
// PROJECT_ROOT = where the user runs from (CWD) — logs, history, gemini_runs go here
const PKG_ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_ROOT = process.cwd();

function getLog() { return _log; }
function setLog(l) { _log = l; }
function isShuttingDown() { return _shuttingDown; }
function setShuttingDown(val) { _shuttingDown = !!val; }

/** Create a timing wrapper for phase profiling — also writes structured log spans */
function phaseTimer(phaseName) {
  const t0 = Date.now();
  if (_log && _log.phaseStart) _log.phaseStart(phaseName);
  return {
    end(meta = {}) {
      const ms = Date.now() - t0;
      if (_log && _log.phaseEnd) _log.phaseEnd({ ...meta, durationMs: ms });
      if (_log) _log.step(`PHASE ${phaseName} completed in ${(ms / 1000).toFixed(1)}s`);
      return ms;
    },
  };
}

module.exports = {
  PKG_ROOT,
  PROJECT_ROOT,
  getLog,
  setLog,
  isShuttingDown,
  setShuttingDown,
  phaseTimer,
};
