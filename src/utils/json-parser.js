/**
 * Robust JSON parsing — handles markdown fences, invalid escapes,
 * duplicate blocks, truncated output, mid-output malformations,
 * and other Gemini output quirks.
 */

'use strict';

const { c } = require('./colors');

/**
 * Gemini sometimes produces invalid JSON escape sequences (e.g. \d, \s, \w from regex patterns).
 * Fix them by double-escaping backslashes that aren't valid JSON escapes.
 */
function sanitizeJsonEscapes(text) {
  return text.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\');
}

/**
 * Fix common mid-output JSON malformations that Gemini produces:
 *  - Doubled closing braces/brackets:  }}, ]] → }, ]
 *  - Doubled commas:  , , → ,
 *  - Trailing commas before closing:  ,} → }  ,] → ]
 *  - Lone commas after opening:  {, → {  [, → [
 * Operates only OUTSIDE of string literals to avoid corrupting string content.
 */
function sanitizeMalformedJson(text) {
  // Process character by character, only fix outside strings
  const chars = [...text];
  const result = [];
  let inString = false, escape = false;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (escape) { escape = false; result.push(ch); continue; }
    if (ch === '\\' && inString) { escape = true; result.push(ch); continue; }
    if (ch === '"') { inString = !inString; result.push(ch); continue; }
    if (inString) { result.push(ch); continue; }
    // Outside string — apply fixes
    result.push(ch);
  }

  let json = result.join('');

  // Now do regex-based fixes on non-string portions
  // We'll use a split-on-strings approach: split by quoted strings, fix only non-string parts
  const parts = json.split(/("(?:[^"\\]|\\.)*")/);
  for (let i = 0; i < parts.length; i += 2) {
    // Even indices are outside strings
    let p = parts[i];
    // Fix doubled closing braces: }} → } (but not inside nested objects — only when preceded by value)
    // More specifically: fix }} when the first } closes an object and the second is extraneous
    // Safest approach: fix ,} doubled patterns and trailing issues
    p = p.replace(/,\s*,/g, ',');          // doubled commas: , , → ,
    p = p.replace(/,\s*([}\]])/g, '$1');   // trailing comma before close: ,} → }
    p = p.replace(/([{[\[])\s*,/g, '$1');  // comma after open: {, → {  [, → [
    parts[i] = p;
  }
  json = parts.join('');

  // Fix doubled closing braces/brackets that aren't valid nesting
  // Pattern: value }} where the inner } closes an object but outer } is extra
  // Strategy: validate by trying to parse; if it fails, try removing extra closers
  return json;
}

/**
 * Fix doubled closing structures (}}, ]]) by re-scanning and removing extras.
 * Only called when initial parse fails.
 */
function fixDoubledClosers(text) {
  const parts = text.split(/("(?:[^"\\]|\\.)*")/);
  for (let i = 0; i < parts.length; i += 2) {
    // Replace }} with } when preceded by a value (not by another })
    // This is conservative: only fix cases where we see  value}}
    parts[i] = parts[i].replace(/\}\s*\}/g, (match) => {
      // Keep the match but remove one } — let the re-parser handle it
      return '}';
    });
    parts[i] = parts[i].replace(/\]\s*\]/g, (match) => {
      return ']';
    });
  }
  return parts.join('');
}

function tryParse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

function tryParseWithSanitize(text) {
  let result = tryParse(text);
  if (result !== undefined) return result;
  // Try fixing escape sequences
  result = tryParse(sanitizeJsonEscapes(text));
  if (result !== undefined) return result;
  // Try fixing mid-output malformations
  const sanitized = sanitizeMalformedJson(text);
  result = tryParse(sanitized);
  if (result !== undefined) return result;
  result = tryParse(sanitizeJsonEscapes(sanitized));
  if (result !== undefined) return result;
  return undefined;
}

/**
 * Attempt to repair truncated JSON.
 * When Gemini hits the output token limit, the JSON is cut mid-way.
 * We try to close any open structures so we can recover the data we have.
 * Returns parsed object or undefined.
 */
function repairTruncatedJson(text) {
  // Strip markdown fences
  let json = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  const firstBrace = json.indexOf('{');
  if (firstBrace === -1) return undefined;
  json = json.substring(firstBrace);

  // Apply mid-output sanitization FIRST (fix doubled commas, trailing commas, etc.)
  json = sanitizeMalformedJson(json);

  // Find where the valid JSON roughly ends — trim trailing incomplete values
  // Remove trailing incomplete string value  (e.g. "key": "partial text...)
  json = json.replace(/:\s*"[^"]*$/, ': null');
  // Remove trailing incomplete key (e.g.  , "partial_key...)
  json = json.replace(/,\s*"[^"]*$/, '');
  // Remove trailing comma or colon
  json = json.replace(/,\s*$/, '');
  json = json.replace(/:\s*$/, ': null');

  // Track the STACK of open structures in order, so we close them in reverse
  const stack = []; // '{' or '['
  let inString = false, escape = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('{');
    else if (ch === '}') { if (stack.length && stack[stack.length - 1] === '{') stack.pop(); }
    else if (ch === '[') stack.push('[');
    else if (ch === ']') { if (stack.length && stack[stack.length - 1] === '[') stack.pop(); }
  }

  // Close open structures in reverse order
  // First remove any trailing comma before closing
  json = json.replace(/,\s*$/, '');
  while (stack.length > 0) {
    const open = stack.pop();
    json += open === '{' ? '}' : ']';
  }

  return tryParseWithSanitize(json);
}

/**
 * Aggressive repair: try fixing doubled closers structure-wide.
 * Only used as a last resort when other strategies fail.
 */
function repairDoubledClosers(text) {
  let json = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const firstBrace = json.indexOf('{');
  if (firstBrace === -1) return undefined;
  json = json.substring(firstBrace);

  // Sanitize mid-output issues
  json = sanitizeMalformedJson(json);

  // Aggressively fix doubled closers
  let prevJson = '';
  let iterations = 0;
  while (json !== prevJson && iterations < 10) {
    prevJson = json;
    json = fixDoubledClosers(json);
    iterations++;
  }

  // Try parsing as-is
  let result = tryParseWithSanitize(json);
  if (result !== undefined) return result;

  // If still failing, combine with truncation repair
  return repairTruncatedJson(json);
}

/**
 * Extract JSON from raw AI output using multiple strategies:
 *  1. Strip markdown fences and parse (with escape + malformation sanitization)
 *  2. Brace-matching for first complete JSON object
 *  3. Regex extraction between fences
 *  4. Doubled-closer repair (fix }}, ]] etc.)
 *  5. Truncation repair — close open structures and recover partial data
 * Returns parsed object or null.
 */
function extractJson(rawText) {
  // Guard: null/undefined input (e.g. Gemini returns no text)
  if (!rawText || typeof rawText !== 'string') return null;

  // Strategy 1: Strip all markdown fences and try to parse
  const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  let parsed = tryParseWithSanitize(cleaned);
  if (parsed !== undefined) return parsed;

  // Strategy 2: Extract first complete JSON object using brace matching
  const firstBrace = rawText.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let ci = firstBrace; ci < rawText.length; ci++) {
      const c = rawText[ci];
      if (esc) { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = ci; break; } }
    }
    if (end !== -1) {
      parsed = tryParseWithSanitize(rawText.substring(firstBrace, end + 1));
      if (parsed !== undefined) return parsed;
    }
  }

  // Strategy 3: Regex extraction of JSON block between fences
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    parsed = tryParseWithSanitize(fenceMatch[1].trim());
    if (parsed !== undefined) return parsed;
  }

  // Strategy 4: Truncation repair — Gemini hit token limit mid-JSON
  // This is common for large compilation outputs (safest repair, stack-based)
  parsed = repairTruncatedJson(rawText);
  if (parsed !== undefined) {
    console.warn(`  ${c.warn('JSON was truncated — recovered partial data by closing open structures')}`);
    return parsed;
  }

  // Strategy 5: Fix doubled closers and mid-output structural errors (aggressive, last resort)
  parsed = repairDoubledClosers(rawText);
  if (parsed !== undefined) {
    console.warn(`  ${c.warn('JSON had structural errors (doubled braces/commas) — repaired')}`);
    return parsed;
  }

  return null;
}

module.exports = { extractJson };
