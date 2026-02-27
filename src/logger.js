/**
 * Logger — dual-file logger with buffered writes, configurable log levels,
 * structured JSON logging, phase timing spans, and reversible console patching.
 *
 * v6 improvements:
 *  - Structured JSON log file: machine-parseable logs alongside human-readable
 *  - Phase spans: automatic timing of pipeline phases with structured events
 *  - Operation context: attach context (phase, segment, etc.) to log entries
 *  - Log aggregation: summary stats computed from structured entries
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  /**
   * @param {string} logsDir - Directory for log files
   * @param {string} callName - Name used in the log filename
   * @param {object} [opts]
   * @param {string} [opts.level='info'] - Minimum log level: debug|info|warn|error
   * @param {number} [opts.flushIntervalMs=500] - How often to flush buffers
   */
  constructor(logsDir, callName, opts = {}) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.mkdirSync(logsDir, { recursive: true });

    this.detailedPath = path.join(logsDir, `${callName}_${ts}_detailed.log`);
    this.minimalPath = path.join(logsDir, `${callName}_${ts}_minimal.log`);
    this.structuredPath = path.join(logsDir, `${callName}_${ts}_structured.jsonl`);
    this.startTime = Date.now();
    this.level = LOG_LEVELS[opts.level] ?? LOG_LEVELS.info;
    this.closed = false;
    this.callName = callName;

    // Buffered write system — accumulate lines, flush periodically
    this._detailedBuffer = [];
    this._minimalBuffer = [];
    this._structuredBuffer = [];
    this._flushInterval = setInterval(() => this._flush(), opts.flushIntervalMs || 500);
    // Prevent the interval from keeping the process alive
    if (this._flushInterval.unref) this._flushInterval.unref();

    // Original console methods (for unpatch)
    this._origLog = null;
    this._origWarn = null;
    this._origError = null;

    // Phase tracking for spans
    this._activePhase = null;
    this._phaseStart = null;
    this._phases = []; // Completed phase records

    // Operation context stack
    this._context = {};

    // Write headers
    const header = `=== ${callName} | ${new Date().toISOString()} ===\n`;
    this._detailedBuffer.push(header);
    this._minimalBuffer.push(header);
    this._writeStructured({
      event: 'session_start',
      callName,
      timestamp: new Date().toISOString(),
      level: 'info',
    });
    this._flush(); // Flush headers immediately
  }

  _ts() {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    return `[${new Date().toISOString().slice(11, 19)} +${elapsed}s]`;
  }

  _elapsedMs() {
    return Date.now() - this.startTime;
  }

  _shouldLog(level) {
    return LOG_LEVELS[level] >= this.level;
  }

  _writeDetailed(line) {
    if (this.closed) return;
    this._detailedBuffer.push(line + '\n');
  }

  _writeMinimal(line) {
    if (this.closed) return;
    this._minimalBuffer.push(line + '\n');
  }

  _writeBoth(line) {
    this._writeDetailed(line);
    this._writeMinimal(line);
  }

  /**
   * Write a structured JSON entry to the JSONL log.
   * @param {object} entry - Structured log entry (will have timestamp/elapsed added)
   */
  _writeStructured(entry) {
    if (this.closed) return;
    const enriched = {
      ...entry,
      elapsedMs: this._elapsedMs(),
      ...(this._activePhase ? { phase: this._activePhase } : {}),
      ...(Object.keys(this._context).length > 0 ? { context: { ...this._context } } : {}),
    };
    try {
      this._structuredBuffer.push(JSON.stringify(enriched) + '\n');
    } catch { /* ignore serialization errors */ }
  }

  _flush(sync = false) {
    const writeFn = sync
      ? (p, d) => fs.appendFileSync(p, d)
      : (p, d) => fs.appendFile(p, d, () => {});

    if (this._detailedBuffer.length > 0) {
      const data = this._detailedBuffer.join('');
      this._detailedBuffer.length = 0;
      try { writeFn(this.detailedPath, data); }
      catch { /* ignore write errors */ }
    }
    if (this._minimalBuffer.length > 0) {
      const data = this._minimalBuffer.join('');
      this._minimalBuffer.length = 0;
      try { writeFn(this.minimalPath, data); }
      catch { /* ignore write errors */ }
    }
    if (this._structuredBuffer.length > 0) {
      const data = this._structuredBuffer.join('');
      this._structuredBuffer.length = 0;
      try { writeFn(this.structuredPath, data); }
      catch { /* ignore write errors */ }
    }
  }

  // ======================== CONTEXT ========================

  /**
   * Set operation context that will be attached to all subsequent log entries.
   * @param {object} ctx - Context fields (e.g., { segment: 'seg_00', phase: 'analyze' })
   */
  setContext(ctx) {
    this._context = { ...this._context, ...ctx };
  }

  /**
   * Clear specific context keys.
   * @param {...string} keys - Keys to remove
   */
  clearContext(...keys) {
    for (const k of keys) delete this._context[k];
  }

  // ======================== PHASE SPANS ========================

  /**
   * Start a named phase span for timing.
   * @param {string} phaseName - Name of the phase
   */
  phaseStart(phaseName) {
    // End previous phase if active
    if (this._activePhase) {
      this.phaseEnd();
    }

    this._activePhase = phaseName;
    this._phaseStart = Date.now();

    this._writeStructured({
      event: 'phase_start',
      phase: phaseName,
      timestamp: new Date().toISOString(),
      level: 'info',
    });
  }

  /**
   * End the current phase span and record timing.
   * @param {object} [meta] - Optional metadata to attach to the phase record
   * @returns {number} Duration in milliseconds
   */
  phaseEnd(meta = {}) {
    if (!this._activePhase) return 0;

    const durationMs = Date.now() - this._phaseStart;
    const record = {
      phase: this._activePhase,
      durationMs,
      ...meta,
    };
    this._phases.push(record);

    this._writeStructured({
      event: 'phase_end',
      phase: this._activePhase,
      durationMs,
      timestamp: new Date().toISOString(),
      level: 'info',
      meta,
    });

    const name = this._activePhase;
    this._activePhase = null;
    this._phaseStart = null;

    return durationMs;
  }

  /**
   * Get all completed phase records.
   * @returns {Array<{phase: string, durationMs: number}>}
   */
  getPhases() {
    return [...this._phases];
  }

  // ======================== LOG METHODS ========================

  /** Detailed log only — verbose/debug info */
  debug(msg, data = null) {
    if (!this._shouldLog('debug')) return;
    this._writeDetailed(`${this._ts()} DBG  ${msg}`);
    this._writeStructured({ event: 'log', level: 'debug', message: msg, ...(data ? { data } : {}) });
  }

  /** Both logs — standard info */
  info(msg, data = null) {
    if (!this._shouldLog('info')) return;
    this._writeDetailed(`${this._ts()} INFO ${msg}`);
    this._writeStructured({ event: 'log', level: 'info', message: msg, ...(data ? { data } : {}) });
  }

  /** Both logs — warnings */
  warn(msg, data = null) {
    if (!this._shouldLog('warn')) return;
    this._writeBoth(`${this._ts()} WARN ${msg}`);
    this._writeStructured({ event: 'log', level: 'warn', message: msg, ...(data ? { data } : {}) });
  }

  /** Both logs — errors */
  error(msg, data = null) {
    // Errors always logged regardless of level
    this._writeBoth(`${this._ts()} ERR  ${msg}`);
    this._writeStructured({ event: 'log', level: 'error', message: msg, ...(data ? { data } : {}) });
  }

  /** Minimal + detailed — key milestone events */
  step(msg, data = null) {
    this._writeBoth(`${this._ts()} STEP ${msg}`);
    this._writeStructured({ event: 'step', level: 'info', message: msg, ...(data ? { data } : {}) });
  }

  /**
   * Log a structured metric event (e.g., token usage, quality scores).
   * Only goes to structured log — not human-readable logs.
   * @param {string} metric - Metric name
   * @param {object} value - Metric data
   */
  metric(metric, value) {
    this._writeStructured({
      event: 'metric',
      metric,
      value,
      timestamp: new Date().toISOString(),
      level: 'info',
    });
  }

  /** Patch console so ALL output also goes to detailed log */
  patchConsole() {
    this._origLog = console.log.bind(console);
    this._origWarn = console.warn.bind(console);
    this._origError = console.error.bind(console);
    const self = this;

    console.log = function (...args) {
      self._origLog(...args);
      try { self.info(args.map(String).join(' ')); } catch { /* ignore */ }
    };
    console.warn = function (...args) {
      self._origWarn(...args);
      try { self.warn(args.map(String).join(' ')); } catch { /* ignore */ }
    };
    console.error = function (...args) {
      self._origError(...args);
      try { self.error(args.map(String).join(' ')); } catch { /* ignore */ }
    };
  }

  /** Restore original console methods */
  unpatchConsole() {
    if (this._origLog) console.log = this._origLog;
    if (this._origWarn) console.warn = this._origWarn;
    if (this._origError) console.error = this._origError;
  }

  /** Write a final summary block to minimal log */
  summary(lines) {
    const block = '\n--- SUMMARY ---\n' + lines.join('\n') + '\n';
    this._writeBoth(block);

    this._writeStructured({
      event: 'session_summary',
      phases: this._phases,
      totalElapsedMs: this._elapsedMs(),
      timestamp: new Date().toISOString(),
      level: 'info',
    });
  }

  /** Flush buffers and close the logger. Safe to call multiple times. */
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this._flushInterval);
    this.unpatchConsole();

    // End active phase if any
    if (this._activePhase) {
      this.phaseEnd();
    }

    // Write footer
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const footer = `\n=== CLOSED | elapsed: ${elapsed}s | ${new Date().toISOString()} ===\n`;
    this._detailedBuffer.push(footer);
    this._minimalBuffer.push(footer);
    this._writeStructured({
      event: 'session_end',
      totalElapsedMs: this._elapsedMs(),
      phases: this._phases,
      timestamp: new Date().toISOString(),
      level: 'info',
    });
    this._flush(true); // sync flush on close to ensure data is written before process exits
  }

  /** Get human-readable elapsed time */
  elapsed() {
    const sec = (Date.now() - this.startTime) / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const min = Math.floor(sec / 60);
    const remainder = (sec % 60).toFixed(0);
    return `${min}m ${remainder}s`;
  }
}

module.exports = Logger;
