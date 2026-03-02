/**
 * Schema Validator — validates AI analysis output against JSON schemas
 * using Ajv. Provides human-readable error messages and retry hints.
 *
 * @module schema-validator
 */

'use strict';

const Ajv = require('ajv');
const { c } = require('./colors');

// Load schemas (require works for JSON files)
const segmentSchema = require('../schemas/analysis-segment.schema.json');
const compiledSchema = require('../schemas/analysis-compiled.schema.json');

// ======================== AJV INSTANCE ========================

const ajv = new Ajv({
  allErrors: true,        // Report ALL errors, not just the first
  verbose: true,          // Include failing data in error objects
  strict: false,          // Allow draft-07 features without strict-mode warnings
  coerceTypes: false,     // Don't coerce types — report mismatches
  allowUnionTypes: true,  // Support type: ["string", "null"]
});

// Compile validators
const validateSegment = ajv.compile(segmentSchema);
const validateCompiled = ajv.compile(compiledSchema);

// ======================== PUBLIC API ========================

/**
 * @typedef {Object} SchemaReport
 * @property {boolean} valid          - Whether the data passed schema validation
 * @property {number}  errorCount     - Number of schema errors
 * @property {Array<SchemaError>} errors - Human-readable error descriptions
 * @property {string[]} retryHints    - Actionable hints for Gemini retry prompts
 * @property {string}  summary        - Single line summary (for logging)
 */

/**
 * @typedef {Object} SchemaError
 * @property {string} path      - JSON path to the error (e.g. "/tickets/0/ticket_id")
 * @property {string} message   - Human-readable error message
 * @property {string} keyword   - Ajv keyword that failed (e.g. "required", "type", "enum")
 * @property {*}      [actual]  - Actual value (only for type/enum mismatches)
 * @property {*}      [expected] - Expected value/type
 */

/**
 * Validate an analysis object against the appropriate schema.
 *
 * @param {object} data - The parsed analysis output to validate
 * @param {'segment'|'compiled'} type - Which schema to validate against
 * @returns {SchemaReport}
 */
function validateAnalysis(data, type = 'segment') {
  if (!data || typeof data !== 'object') {
    return {
      valid: false,
      errorCount: 1,
      errors: [{ path: '/', message: 'Analysis is null or not an object', keyword: 'type' }],
      retryHints: ['Your response could not be parsed as a valid JSON object. Return ONLY valid JSON starting with { and ending with }.'],
      summary: 'Schema: FAIL — analysis is null/non-object',
    };
  }

  // Skip validation for error objects (segments that failed Gemini)
  if (data.error || data.rawResponse) {
    return {
      valid: false,
      errorCount: 0,
      errors: [],
      retryHints: [],
      summary: 'Schema: SKIP — error/raw response object',
    };
  }

  const validate = type === 'compiled' ? validateCompiled : validateSegment;
  const valid = validate(data);

  if (valid) {
    return {
      valid: true,
      errorCount: 0,
      errors: [],
      retryHints: [],
      summary: `Schema: PASS (${type})`,
    };
  }

  // Convert Ajv errors to human-readable format
  const errors = formatErrors(validate.errors || []);
  const retryHints = buildSchemaRetryHints(validate.errors || [], type);
  const errorCount = errors.length;

  return {
    valid,
    errorCount,
    errors,
    retryHints,
    summary: `Schema: ${errorCount} error(s) in ${type} output — ${errors.slice(0, 3).map(e => e.message).join('; ')}${errorCount > 3 ? ` (+${errorCount - 3} more)` : ''}`,
  };
}

// ======================== ERROR FORMATTING ========================

/**
 * Convert Ajv error objects to human-readable SchemaError objects.
 * Deduplicates and groups related errors.
 *
 * @param {import('ajv').ErrorObject[]} ajvErrors
 * @returns {SchemaError[]}
 */
function formatErrors(ajvErrors) {
  const seen = new Set();
  const errors = [];

  for (const err of ajvErrors) {
    const dataPath = err.instancePath || '';

    let message;
    let actual;
    let expected;

    switch (err.keyword) {
      case 'required': {
        const field = err.params.missingProperty;
        message = `Missing required field "${field}" at ${dataPath || '/'}`;
        expected = field;
        break;
      }
      case 'type': {
        const expType = err.params.type;
        const actType = Array.isArray(err.data) ? 'array' : typeof err.data;
        message = `Expected type "${expType}" but got "${actType}" at ${dataPath}`;
        actual = actType;
        expected = expType;
        break;
      }
      case 'enum': {
        const allowed = err.params.allowedValues;
        actual = err.data;
        expected = allowed;
        message = `Invalid value "${err.data}" at ${dataPath} — allowed: ${allowed.join(', ')}`;
        break;
      }
      case 'minLength': {
        message = `Value at ${dataPath} is too short (minimum length: ${err.params.limit})`;
        actual = typeof err.data === 'string' ? err.data.length : 0;
        expected = err.params.limit;
        break;
      }
      case 'additionalProperties': {
        // Shouldn't fire since we allow additional properties, but just in case
        message = `Unexpected property "${err.params.additionalProperty}" at ${dataPath}`;
        break;
      }
      default: {
        message = `Validation error at ${dataPath}: ${err.message}`;
        break;
      }
    }

    const key = `${dataPath}:${err.keyword}:${err.params?.missingProperty || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    errors.push({
      path: dataPath || '/',
      message,
      keyword: err.keyword,
      ...(actual !== undefined && { actual }),
      ...(expected !== undefined && { expected }),
    });
  }

  return errors;
}

// ======================== RETRY HINTS ========================

/**
 * Build actionable retry hints from schema errors to inject into Gemini
 * retry prompts. Grouped by error category for concise prompts.
 *
 * @param {import('ajv').ErrorObject[]} ajvErrors
 * @param {'segment'|'compiled'} type
 * @returns {string[]}
 */
function buildSchemaRetryHints(ajvErrors, type) {
  if (!ajvErrors || ajvErrors.length === 0) return [];

  const hints = [];
  const missingFields = new Set();
  const typeMismatches = new Set();
  const enumViolations = new Set();

  for (const err of ajvErrors) {
    const dataPath = err.instancePath || '';

    switch (err.keyword) {
      case 'required':
        missingFields.add(`${dataPath}/${err.params.missingProperty}`);
        break;
      case 'type':
        typeMismatches.add(`${dataPath} (expected ${err.params.type}, got ${typeof err.data})`);
        break;
      case 'enum':
        enumViolations.add(`${dataPath} = "${err.data}" (allowed: ${err.params.allowedValues.join('|')})`);
        break;
    }
  }

  // Missing required fields
  if (missingFields.size > 0) {
    const topLevel = [...missingFields].filter(f => f.split('/').length <= 2);
    const nested = [...missingFields].filter(f => f.split('/').length > 2);

    if (topLevel.length > 0) {
      hints.push(
        `CRITICAL: Missing required top-level fields: ${topLevel.map(f => f.replace(/^\//, '')).join(', ')}. ` +
        `You MUST include ALL of these in your response. Use empty arrays [] if no items exist.`
      );
    }

    if (nested.length > 0) {
      // Group by parent path for readability
      const groups = {};
      for (const field of nested) {
        const parts = field.split('/');
        const parent = parts.slice(0, -1).join('/');
        const child = parts[parts.length - 1];
        if (!groups[parent]) groups[parent] = [];
        groups[parent].push(child);
      }

      const summaries = Object.entries(groups)
        .slice(0, 5) // Don't overwhelm the retry prompt
        .map(([parent, fields]) => `${parent}: needs ${fields.join(', ')}`);

      hints.push(
        `Missing required fields in nested objects: ${summaries.join(' | ')}. ` +
        `Each item must have all required properties.`
      );
    }
  }

  // Type mismatches
  if (typeMismatches.size > 0) {
    const examples = [...typeMismatches].slice(0, 3).join('; ');
    hints.push(
      `Type errors found: ${examples}. ` +
      `Ensure arrays are [], objects are {}, strings are quoted, and null is used for missing optional values.`
    );
  }

  // Enum violations
  if (enumViolations.size > 0) {
    const examples = [...enumViolations].slice(0, 3).join('; ');
    hints.push(
      `Invalid enum values: ${examples}. ` +
      `Use ONLY the allowed values specified in the output structure. Check status, type, priority, and confidence fields.`
    );
  }

  return hints;
}

// ======================== QUALITY GATE INTEGRATION ========================

/**
 * Compute a schema quality penalty for integration with quality-gate.js.
 * Returns a number 0-100 where 100 = no schema errors.
 *
 * @param {SchemaReport} report
 * @returns {number} Schema score (0-100)
 */
function schemaScore(report) {
  if (report.valid) return 100;
  if (report.errorCount === 0) return 100; // skip/raw response

  // Penalty scaling: more errors = lower score
  // 1 error = 85, 3 errors = 60, 5+ = 40, 10+ = 20, 20+ = 0
  if (report.errorCount <= 1) return 85;
  if (report.errorCount <= 3) return 60;
  if (report.errorCount <= 5) return 40;
  if (report.errorCount <= 10) return 20;
  return 0;
}

/**
 * Format a single-line schema validation result for console output.
 *
 * @param {SchemaReport} report
 * @returns {string}
 */
function formatSchemaLine(report) {
  if (report.valid) {
    return `    ${c.success('Schema: valid')}`;
  }
  if (report.errorCount === 0) {
    return '    ○ Schema: skipped (error/raw response)';
  }
  return `    ${c.warn(`Schema: ${report.errorCount} error(s) — ${report.errors.slice(0, 2).map(e => e.message).join('; ')}`)}`;
}

// ======================== POST-PARSE NORMALIZATION ========================

/** Array fields that should default to [] when missing from analysis output. */
const ARRAY_DEFAULTS = [
  'tickets', 'action_items', 'change_requests',
  'blockers', 'scope_changes', 'file_references',
];

/**
 * Normalize a parsed analysis object by filling in missing array fields
 * with empty arrays, ensuring required string fields exist, and patching
 * item-level required fields (e.g. confidence) with sensible defaults.
 *
 * This prevents downstream code from crashing when a segment legitimately
 * has no tickets/action_items/etc., and avoids schema-validation failures
 * on truncated AI outputs.
 *
 * Mutates `data` in-place and returns it for convenience.
 *
 * @param {object} data - Parsed analysis (may have missing fields)
 * @returns {object} The same object with defaults applied
 */
function normalizeAnalysis(data) {
  if (!data || typeof data !== 'object') return data;

  // Fill missing array fields
  for (const field of ARRAY_DEFAULTS) {
    if (data[field] === undefined || data[field] === null) {
      data[field] = [];
    }
  }

  // Ensure top-level required string fields
  if (!data.summary && data.summary !== '') {
    data.summary = data.segment_summary || data.overview || '';
  }

  // Patch ticket items — fill missing required fields with defaults
  if (Array.isArray(data.tickets)) {
    for (const ticket of data.tickets) {
      if (!ticket || typeof ticket !== 'object') continue;
      if (!ticket.confidence) ticket.confidence = 'MEDIUM';
      if (!ticket.discussed_state && ticket.discussed_state !== null) {
        ticket.discussed_state = { summary: '' };
      }
    }
  }

  // Patch action_items — fill missing confidence
  if (Array.isArray(data.action_items)) {
    for (const item of data.action_items) {
      if (!item || typeof item !== 'object') continue;
      if (!item.confidence) item.confidence = 'MEDIUM';
    }
  }

  return data;
}

module.exports = {
  validateAnalysis,
  buildSchemaRetryHints,
  schemaScore,
  formatSchemaLine,
  normalizeAnalysis,
};
