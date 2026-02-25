/**
 * Progress persistence — checkpoint/resume for long-running pipelines.
 *
 * Saves pipeline state to a JSON file so that if the process crashes,
 * it can resume from where it left off instead of re-doing everything.
 *
 * State file: <targetDir>/.pipeline-state.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STATE_FILE = '.pipeline-state.json';

/**
 * @typedef {object} PipelineState
 * @property {string} startedAt - ISO timestamp
 * @property {string} callName - Name of the call
 * @property {string} userName - User's name
 * @property {string} phase - Current phase: compress|upload|analyze|compile|output
 * @property {object} compression - Per-video compression status
 * @property {object} uploads - Per-segment upload status (storagePath → url)
 * @property {object} analyses - Per-segment analysis status (index → runFile)
 * @property {boolean} compilationDone - Whether compilation is complete
 * @property {string} updatedAt - Last update timestamp
 */

class Progress {
  /**
   * @param {string} targetDir - Directory for the state file
   */
  constructor(targetDir) {
    this.filePath = path.join(targetDir, STATE_FILE);
    this.state = this._load();
  }

  /**
   * Load existing state or create a fresh one.
   * @returns {PipelineState}
   */
  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch {
      // Corrupt state file — start fresh
    }
    return {
      startedAt: new Date().toISOString(),
      callName: null,
      userName: null,
      phase: 'init',
      compression: {},   // videoName → { done: boolean, segmentCount: number }
      uploads: {},        // storagePath → { url, done }
      analyses: {},       // segKey → { runFile, done }
      compilationDone: false,
      updatedAt: new Date().toISOString(),
    };
  }

  /** Save current state to disk. */
  save() {
    this.state.updatedAt = new Date().toISOString();
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (err) {
      console.warn(`  ⚠ Could not save progress: ${err.message}`);
    }
  }

  /** Initialize state for a new run. */
  init(callName, userName) {
    this.state.callName = callName;
    this.state.userName = userName;
    this.state.phase = 'init';
    this.save();
  }

  /** Set current phase. */
  setPhase(phase) {
    this.state.phase = phase;
    this.save();
  }

  /** Mark a video's compression as done. */
  markCompressed(videoName, segmentCount) {
    this.state.compression[videoName] = { done: true, segmentCount };
    this.save();
  }

  /** Check if a video has been compressed. */
  isCompressed(videoName) {
    return this.state.compression[videoName]?.done === true;
  }

  /** Mark a segment upload as done. */
  markUploaded(storagePath, url) {
    this.state.uploads[storagePath] = { url, done: true };
    this.save();
  }

  /** Check if a segment has been uploaded. Returns URL or null. */
  getUploadUrl(storagePath) {
    const entry = this.state.uploads[storagePath];
    return entry?.done ? entry.url : null;
  }

  /** Mark a segment analysis as done. */
  markAnalyzed(segKey, runFile) {
    this.state.analyses[segKey] = { runFile, done: true };
    this.save();
  }

  /** Check if a segment has been analyzed. */
  isAnalyzed(segKey) {
    return this.state.analyses[segKey]?.done === true;
  }

  /** Mark compilation as done. */
  markCompilationDone() {
    this.state.compilationDone = true;
    this.save();
  }

  /** Check if compilation is done. */
  isCompilationDone() {
    return this.state.compilationDone === true;
  }

  /** Remove the state file (on successful completion). */
  cleanup() {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
    } catch { /* ignore */ }
  }

  /** Check if there is an existing resume state. */
  hasResumableState() {
    return this.state.phase !== 'init' && (
      Object.keys(this.state.compression).length > 0 ||
      Object.keys(this.state.uploads).length > 0 ||
      Object.keys(this.state.analyses).length > 0
    );
  }

  /** Print a summary of what can be resumed. */
  printResumeSummary() {
    const comp = Object.values(this.state.compression).filter(c => c.done).length;
    const uploads = Object.values(this.state.uploads).filter(u => u.done).length;
    const analyses = Object.values(this.state.analyses).filter(a => a.done).length;
    console.log(`  Resume state found (${this.state.updatedAt}):`);
    console.log(`    Phase: ${this.state.phase}`);
    console.log(`    Compressions done: ${comp}`);
    console.log(`    Uploads done: ${uploads}`);
    console.log(`    Analyses done: ${analyses}`);
    console.log(`    Compilation: ${this.state.compilationDone ? 'done' : 'pending'}`);
  }
}

module.exports = Progress;
