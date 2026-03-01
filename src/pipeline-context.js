/**
 * Pipeline context — shared state definition and factory.
 *
 * Each phase receives ctx and returns an augmented copy.
 * This module defines the shape and provides a factory function.
 *
 * @typedef {object} PipelineContext
 * @property {object} opts           - Parsed CLI options
 * @property {string} targetDir      - Absolute path to call folder
 * @property {object} progress       - Checkpoint tracker
 * @property {object} costTracker    - Cost tracking instance
 * @property {string[]} videoFiles   - (after discover)
 * @property {string[]} audioFiles   - (after discover)
 * @property {object[]} allDocFiles  - (after discover)
 * @property {string} userName       - (after discover)
 * @property {string} inputMode      - 'video' | 'audio' | 'document' (after discover)
 * @property {object} storage        - Firebase storage ref (after services)
 * @property {boolean} firebaseReady - (after services)
 * @property {object} ai             - Gemini client (after services)
 * @property {object[]} contextDocs  - Prepared docs (after services)
 * @property {string} callName       - (after services)
 * @property {object} docStorageUrls - (after services)
 */

'use strict';

/**
 * Create a fresh pipeline context from initial values.
 * @param {object} initial - Initial context properties
 * @returns {PipelineContext}
 */
function createContext(initial = {}) {
  return { ...initial };
}

module.exports = { createContext };
