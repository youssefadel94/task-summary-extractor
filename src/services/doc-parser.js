/**
 * Document parser service — converts rich document formats (DOCX, DOC, XLSX,
 * PPTX, RTF, ODT, EPUB, HTML) to plain text for Gemini AI ingestion.
 *
 * Strategy:
 *  1. mammoth — DOCX → clean text (best quality, preserves structure)
 *  2. xlsx    — XLSX/XLS/CSV → text tables
 *  3. officeparser — DOC, PPTX, ODT, RTF, EPUB (broad fallback)
 *  4. Built-in — HTML → text (regex strip), JSON/XML → passthrough
 *
 * All parsers return plain text. Binary files that can't be parsed
 * are skipped with a warning (no crash).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { c } = require('../utils/colors');

// ======================== PARSER REGISTRY ========================

/**
 * Extensions handled by each parser strategy.
 * Order matters: first match wins.
 */
const PARSER_MAP = {
  // pdf-parse — PDF text extraction
  '.pdf': 'pdf',

  // mammoth — high-quality DOCX conversion
  '.docx': 'mammoth',

  // xlsx — Excel spreadsheets
  '.xlsx': 'xlsx',
  '.xls':  'xlsx',

  // officeparser — broad Office/ODF/EPUB support
  '.doc':  'officeparser',
  '.pptx': 'officeparser',
  '.ppt':  'officeparser',
  '.odt':  'officeparser',
  '.odp':  'officeparser',
  '.ods':  'officeparser',
  '.rtf':  'officeparser',
  '.epub': 'officeparser',

  // Built-in parsers
  '.html': 'html',
  '.htm':  'html',
  '.xml':  'builtin-text',
  '.json': 'builtin-text',
};

/**
 * All extensions this module can parse (union of PARSER_MAP keys).
 * Exported for config.js to extend DOC_EXTS and remove GEMINI_UNSUPPORTED.
 */
const PARSEABLE_EXTS = Object.keys(PARSER_MAP);

/**
 * Extensions that were previously unsupported but are now parseable.
 * Used to update GEMINI_UNSUPPORTED → INLINE_TEXT_EXTS migration.
 */
const NEWLY_SUPPORTED_EXTS = ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.odt', '.odp', '.ods', '.rtf', '.epub', '.html', '.htm'];

// ======================== PDF (pdf-parse) ========================

/**
 * Parse a PDF file to plain text using pdf-parse.
 *
 * @param {string} filePath - Absolute path to .pdf file
 * @returns {Promise<{ text: string, warnings: string[] }>}
 */
async function parsePdf(filePath) {
  const { PDFParse } = require('pdf-parse');
  const warnings = [];

  try {
    const buffer = await fs.promises.readFile(filePath);
    const data = new Uint8Array(buffer);
    const parser = new PDFParse(data);
    const result = await parser.getText();

    let text = (result.text || '').trim();

    if (!text) {
      warnings.push('PDF produced no text (may be image-based / scanned)');
    }

    return { text, warnings };
  } catch (err) {
    return { text: '', warnings: [`pdf-parse failed: ${err.message}`] };
  }
}

// ======================== MAMMOTH (DOCX) ========================

/**
 * Parse a DOCX file to plain text using mammoth.
 * Falls back to raw text extraction if styled conversion fails.
 *
 * @param {string} filePath - Absolute path to .docx file
 * @returns {Promise<{ text: string, warnings: string[] }>}
 */
async function parseDocx(filePath) {
  const mammoth = require('mammoth');
  const warnings = [];

  try {
    // First try: extract raw text (most reliable, preserves all content)
    const result = await mammoth.extractRawText({ path: filePath });
    if (result.messages && result.messages.length > 0) {
      for (const msg of result.messages) {
        warnings.push(`mammoth: ${msg.message}`);
      }
    }

    let text = (result.value || '').trim();

    // If raw text is empty, try HTML conversion as fallback
    if (!text) {
      const htmlResult = await mammoth.convertToHtml({ path: filePath });
      text = stripHtml(htmlResult.value || '');
      if (htmlResult.messages) {
        for (const msg of htmlResult.messages) {
          warnings.push(`mammoth-html: ${msg.message}`);
        }
      }
    }

    return { text, warnings };
  } catch (err) {
    return { text: '', warnings: [`mammoth parse failed: ${err.message}`] };
  }
}

// ======================== XLSX (Excel) ========================

/**
 * Parse an Excel file (XLSX/XLS) to text tables.
 * Each sheet becomes a section with rows formatted as pipe-delimited tables.
 *
 * @param {string} filePath - Absolute path to .xlsx/.xls file
 * @returns {Promise<{ text: string, warnings: string[] }>}
 */
async function parseExcel(filePath) {
  const XLSX = require('xlsx');
  const warnings = [];

  try {
    const workbook = XLSX.readFile(filePath, { type: 'file' });
    const sections = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;

      // Convert sheet to array of arrays
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      if (rows.length === 0) continue;

      const lines = [`=== Sheet: ${sheetName} ===`];

      // Format as pipe-delimited table (Gemini reads this well)
      for (const row of rows) {
        const cells = row.map(cell => {
          if (cell === null || cell === undefined) return '';
          return String(cell).replace(/\|/g, '\\|').replace(/\n/g, ' ');
        });
        lines.push(`| ${cells.join(' | ')} |`);
      }

      sections.push(lines.join('\n'));
    }

    const text = sections.join('\n\n');
    if (!text) warnings.push('Excel file has no readable content');

    return { text, warnings };
  } catch (err) {
    return { text: '', warnings: [`xlsx parse failed: ${err.message}`] };
  }
}

// ======================== OFFICEPARSER (DOC, PPTX, ODT, RTF, EPUB) ========================

/**
 * Parse a document using officeparser (broad format support).
 * Handles: .doc, .pptx, .ppt, .odt, .odp, .ods, .rtf, .epub
 *
 * @param {string} filePath - Absolute path to document
 * @returns {Promise<{ text: string, warnings: string[] }>}
 */
async function parseWithOfficeParser(filePath) {
  const officeparser = require('officeparser');
  const warnings = [];

  try {
    const text = await officeparser.parseOfficeAsync(filePath);
    if (!text || !text.trim()) {
      warnings.push('officeparser returned empty text');
    }
    return { text: (text || '').trim(), warnings };
  } catch (err) {
    return { text: '', warnings: [`officeparser failed: ${err.message}`] };
  }
}

// ======================== HTML STRIP ========================

/**
 * Strip HTML tags to extract plain text.
 * Handles common elements: headings, paragraphs, lists, tables, breaks.
 *
 * @param {string} html - HTML content
 * @returns {string} Plain text
 */
function stripHtml(html) {
  if (!html) return '';

  let text = html;

  // Convert block elements to newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');

  // Convert list items
  text = text.replace(/<li[^>]*>/gi, '- ');

  // Convert headings to markdown-style
  text = text.replace(/<h1[^>]*>/gi, '\n# ');
  text = text.replace(/<h2[^>]*>/gi, '\n## ');
  text = text.replace(/<h3[^>]*>/gi, '\n### ');
  text = text.replace(/<h[4-6][^>]*>/gi, '\n#### ');

  // Convert table cells
  text = text.replace(/<td[^>]*>/gi, ' | ');
  text = text.replace(/<th[^>]*>/gi, ' | ');

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, ' ');

  // Clean up excessive whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}

// ======================== BUILT-IN TEXT ========================

/**
 * Read a file as UTF-8 text (for JSON, XML, etc.).
 * @param {string} filePath
 * @returns {Promise<{ text: string, warnings: string[] }>}
 */
async function parseBuiltinText(filePath) {
  try {
    const content = (await fs.promises.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
    return { text: content.trim(), warnings: [] };
  } catch (err) {
    return { text: '', warnings: [`Failed to read file: ${err.message}`] };
  }
}

/**
 * Parse an HTML file by reading it and stripping tags.
 * @param {string} filePath
 * @returns {Promise<{ text: string, warnings: string[] }>}
 */
async function parseHtmlFile(filePath) {
  try {
    const html = (await fs.promises.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
    const text = stripHtml(html);
    return { text, warnings: [] };
  } catch (err) {
    return { text: '', warnings: [`Failed to read HTML: ${err.message}`] };
  }
}

// ======================== MAIN PARSE FUNCTION ========================

/**
 * Parse any supported document to plain text.
 *
 * @param {string} filePath - Absolute path to the document
 * @param {object} [opts]
 * @param {number} [opts.maxLength] - Truncate output to this many characters (default: unlimited)
 * @param {boolean} [opts.silent] - Suppress console warnings (default: false)
 * @returns {Promise<{ text: string, ext: string, parser: string, warnings: string[], success: boolean }>}
 */
async function parseDocument(filePath, opts = {}) {
  const ext = path.extname(filePath).toLowerCase();
  const parser = PARSER_MAP[ext];

  if (!parser) {
    return {
      text: '',
      ext,
      parser: 'none',
      warnings: [`No parser available for extension "${ext}"`],
      success: false,
    };
  }

  let result;
  switch (parser) {
    case 'pdf':
      result = await parsePdf(filePath);
      break;
    case 'mammoth':
      result = await parseDocx(filePath);
      break;
    case 'xlsx':
      result = await parseExcel(filePath);
      break;
    case 'officeparser':
      result = await parseWithOfficeParser(filePath);
      break;
    case 'html':
      result = await parseHtmlFile(filePath);
      break;
    case 'builtin-text':
      result = await parseBuiltinText(filePath);
      break;
    default:
      result = { text: '', warnings: [`Unknown parser "${parser}" for "${ext}"`] };
  }

  let text = result.text || '';
  const warnings = result.warnings || [];

  // Truncate if requested
  if (opts.maxLength && text.length > opts.maxLength) {
    text = text.slice(0, opts.maxLength) + '\n\n... (truncated — original was ' + result.text.length.toLocaleString() + ' chars)';
    warnings.push(`Output truncated to ${opts.maxLength.toLocaleString()} chars`);
  }

  // Log warnings if not silent
  if (!opts.silent && warnings.length > 0) {
    for (const w of warnings) {
      console.warn(`    ${c.warn(`${path.basename(filePath)}: ${w}`)}`);
    }
  }

  return {
    text,
    ext,
    parser,
    warnings,
    success: text.length > 0,
  };
}

/**
 * Check if a file extension is parseable by this module.
 * @param {string} ext - Extension including dot (e.g. '.docx')
 * @returns {boolean}
 */
function canParse(ext) {
  return ext.toLowerCase() in PARSER_MAP;
}

module.exports = {
  parseDocument,
  canParse,
  stripHtml,
  PARSEABLE_EXTS,
  NEWLY_SUPPORTED_EXTS,
  PARSER_MAP,
};
