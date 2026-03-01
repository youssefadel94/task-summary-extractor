/**
 * Progress Bar — visual progress display for pipeline phases.
 *
 * Features:
 *  - Real-time bar with phase name, percentage, and ETA
 *  - Segment-level sub-progress during media processing
 *  - Live cost display via CostTracker integration
 *  - Non-TTY fallback: one line per event (CI-friendly)
 *  - Writes to stderr to avoid polluting piped stdout
 *
 * @module progress-bar
 */

'use strict';

const { fmtDuration } = require('./format');

// ======================== PHASE DEFINITIONS ========================

const PHASES = [
  { key: 'init',       label: 'Init',         index: 1 },
  { key: 'discover',   label: 'Discover',     index: 2 },
  { key: 'services',   label: 'Services',     index: 3 },
  { key: 'compress',   label: 'Compress',     index: 4 },
  { key: 'upload',     label: 'Upload',       index: 5 },
  { key: 'analyze',    label: 'Analyze',      index: 6 },
  { key: 'compile',    label: 'Compile',      index: 7 },
  { key: 'output',     label: 'Output',       index: 8 },
  { key: 'summary',    label: 'Summary',      index: 9 },
  { key: 'deep-dive',  label: 'Deep Dive',    index: 10 },
];

const PHASE_MAP = Object.fromEntries(PHASES.map(p => [p.key, p]));
const TOTAL_PHASES = PHASES.length;

// ======================== BAR CHARACTERS ========================

const BAR_FILLED = '\u2501';   // ━
const BAR_EMPTY  = '\u2500';   // ─
const BAR_LEFT   = '';
const BAR_RIGHT  = '';

// ======================== PROGRESS BAR CLASS ========================

class ProgressBar {
  /**
   * @param {object} [opts]
   * @param {number} [opts.width=40]          - Bar width in characters
   * @param {NodeJS.WriteStream} [opts.stream] - Output stream (default: stderr)
   * @param {boolean} [opts.enabled]          - Force enable/disable (default: auto-detect TTY)
   * @param {object} [opts.costTracker]       - CostTracker instance for live cost display
   * @param {string} [opts.callName]          - Name of the current call/project
   */
  constructor(opts = {}) {
    this.width = opts.width || 40;
    this.stream = opts.stream || process.stderr;
    this.enabled = opts.enabled !== undefined ? opts.enabled : (this.stream.isTTY === true);
    this.costTracker = opts.costTracker || null;
    this.callName = opts.callName || '';

    // Phase tracking
    this.phaseKey = 'init';
    this.phaseLabel = 'Init';
    this.phaseIndex = 1;

    // Item tracking within a phase
    this.total = 0;
    this.current = 0;
    this.itemLabel = '';

    // Time tracking
    this.startTime = Date.now();
    this.phaseStartTime = Date.now();

    // Sub-status for long operations
    this.subStatus = '';

    // Track if we need to restore cursor
    this._lastLineLength = 0;
    this._rendered = false;
  }

  // ======================== PUBLIC API ========================

  /**
   * Set the current pipeline phase.
   * @param {string} key    - Phase key (e.g. 'compress', 'analyze')
   * @param {number} [total] - Total items in this phase
   */
  setPhase(key, total) {
    const phase = PHASE_MAP[key];
    if (phase) {
      this.phaseKey = key;
      this.phaseLabel = phase.label;
      this.phaseIndex = phase.index;
    } else {
      this.phaseKey = key;
      this.phaseLabel = key;
    }

    this.total = total || 0;
    this.current = 0;
    this.itemLabel = '';
    this.subStatus = '';
    this.phaseStartTime = Date.now();

    if (this.enabled) {
      this._clearLine();
      this.render();
    } else {
      this._logEvent(`[Phase ${this.phaseIndex}/${TOTAL_PHASES}] ${this.phaseLabel}`);
    }
  }

  /**
   * Set total items for the current phase.
   * @param {number} n
   */
  setTotal(n) {
    this.total = n;
    if (this.enabled) this.render();
  }

  /**
   * Increment progress by 1 and update the item label.
   * @param {string} [label] - Current item description (e.g. "segment_01.mp4")
   */
  tick(label) {
    this.current = Math.min(this.current + 1, Math.max(this.total, this.current + 1));
    if (label) this.itemLabel = label;
    this.subStatus = '';

    if (this.enabled) {
      this.render();
    } else if (label) {
      this._logEvent(`  ${label} (${this.current}/${this.total})`);
    }
  }

  /**
   * Update the sub-status text without incrementing.
   * @param {string} text - Status text (e.g. "Uploading to Storage...")
   */
  status(text) {
    this.subStatus = text;
    if (this.enabled) this.render();
  }

  /**
   * Finish the progress bar — print a final newline and clear.
   */
  finish() {
    if (this.enabled && this._rendered) {
      this._clearLine();
      const elapsed = fmtDuration((Date.now() - this.startTime) / 1000);
      const cost = this._getCostString();
      const line = `  Done in ${elapsed}${cost ? ` | ${cost}` : ''}`;
      this.stream.write(line + '\n');
    }
    this._rendered = false;
  }

  /**
   * Cleanup — restore terminal state.
   */
  cleanup() {
    if (this._rendered) {
      this._clearLine();
    }
  }

  // ======================== RENDERING ========================

  /**
   * Render the progress bar to the stream.
   */
  render() {
    if (!this.enabled) return;

    const pct = this.total > 0 ? Math.min(100, Math.round((this.current / this.total) * 100)) : 0;
    const filledWidth = this.total > 0
      ? Math.min(this.width, Math.round((this.current / this.total) * this.width))
      : 0;
    const emptyWidth = Math.max(0, this.width - filledWidth);

    // Build bar
    const bar = BAR_LEFT +
      BAR_FILLED.repeat(filledWidth) +
      BAR_EMPTY.repeat(emptyWidth) +
      BAR_RIGHT;

    // Phase info
    const phaseStr = `Phase ${this.phaseIndex}/${TOTAL_PHASES}: ${this.phaseLabel}`;

    // ETA
    const eta = this._eta();
    const etaStr = eta ? ` | ETA: ${eta}` : '';

    // Cost
    const costStr = this._getCostString();
    const costPart = costStr ? ` | ${costStr}` : '';

    // Item label or sub-status
    const detail = this.subStatus || this.itemLabel;
    const detailStr = detail ? ` ${detail}` : '';

    // Progress counts
    const countStr = this.total > 0 ? ` ${this.current}/${this.total}` : '';

    // Build line
    const line = `  ${bar} ${pct}% | ${phaseStr}${countStr}${detailStr}${etaStr}${costPart}`;

    // Write with \r to overwrite
    this._clearLine();
    this.stream.write('\r' + line);
    this._lastLineLength = line.length;
    this._rendered = true;
  }

  // ======================== INTERNAL ========================

  /**
   * Calculate ETA based on elapsed time and progress.
   * @returns {string|null}
   */
  _eta() {
    if (this.total <= 0 || this.current <= 0) return null;

    const elapsed = Date.now() - this.phaseStartTime;
    if (elapsed < 2000) return null; // Don't show ETA for first 2s (unreliable)

    const msPerItem = elapsed / this.current;
    const remaining = (this.total - this.current) * msPerItem;

    if (remaining < 1000) return null;
    return fmtDuration(remaining / 1000);
  }

  /**
   * Get formatted cost string from CostTracker.
   * @returns {string}
   */
  _getCostString() {
    if (!this.costTracker) return '';
    try {
      const summary = this.costTracker.getSummary();
      if (summary.totalCost > 0) {
        return `$${summary.totalCost.toFixed(4)}`;
      }
    } catch {
      // CostTracker not ready
    }
    return '';
  }

  /**
   * Clear the current line.
   */
  _clearLine() {
    if (this._lastLineLength > 0) {
      this.stream.write('\r' + ' '.repeat(this._lastLineLength + 2) + '\r');
    }
  }

  /**
   * Non-TTY fallback: print a simple log line.
   * @param {string} msg
   */
  _logEvent(msg) {
    this.stream.write(msg + '\n');
  }
}

// ======================== FACTORY ========================

/**
 * Create a ProgressBar instance with sensible defaults.
 *
 * @param {object} [opts] - Same as ProgressBar constructor
 * @returns {ProgressBar}
 */
function createProgressBar(opts = {}) {
  return new ProgressBar(opts);
}

module.exports = { ProgressBar, createProgressBar, PHASES, PHASE_MAP };
