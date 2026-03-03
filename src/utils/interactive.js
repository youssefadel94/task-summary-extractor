/**
 * Interactive prompt engine — zero dependencies, arrow-key navigation.
 *
 * Provides:
 *   selectOne()   — single-select with ↑↓ arrows + Enter
 *   selectMany()  — multi-select with ↑↓ arrows + Space (toggle) + Enter (confirm)
 *
 * Falls back to number input when stdin is not a TTY.
 *
 * Rendering strategy:
 *   Uses a **windowed viewport** so the list never exceeds the terminal height.
 *   The viewport slides to keep the cursor visible.  After every draw(), the
 *   terminal cursor sits on the LAST rendered viewport line.  Before each
 *   subsequent redraw we move UP by (viewportHeight − 1) to reach the first
 *   viewport line, then overwrite every line top-to-bottom.
 */

'use strict';

const { c, strip } = require('./colors');

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE  = '\x1b[2K';

/** Move cursor up N lines */
const UP   = (n) => n > 0 ? `\x1b[${n}A` : '';
/** Move cursor down N lines */
const DOWN = (n) => n > 0 ? `\x1b[${n}B` : '';
/** Carriage return — column 0 */
const CR   = '\r';

// ── Render helpers ────────────────────────────────────────────────────────────

/** Maximum visible item rows — leave room for title, separator, footer, etc. */
function getMaxVisibleRows() {
  const termRows = process.stdout.rows || 24;
  // Reserve 6 lines: title, separator, footer, prompt, plus margin
  return Math.max(5, termRows - 6);
}

/**
 * Compute the window [start, end) to show, keeping cursor visible.
 * @param {number} cursor  Current highlighted index
 * @param {number} total   Total items
 * @param {number} maxRows Maximum visible rows
 * @param {number} prevOffset  Previous scroll offset
 * @returns {{ start: number, end: number }}
 */
function computeWindow(cursor, total, maxRows, prevOffset) {
  if (total <= maxRows) return { start: 0, end: total };

  let start = prevOffset;
  let end = start + maxRows;

  // Scroll down if cursor is below viewport
  if (cursor >= end) {
    end = cursor + 1;
    start = end - maxRows;
  }
  // Scroll up if cursor is above viewport
  if (cursor < start) {
    start = cursor;
    end = start + maxRows;
  }
  // Clamp
  if (start < 0) { start = 0; end = maxRows; }
  if (end > total) { end = total; start = Math.max(0, end - maxRows); }

  return { start, end };
}

/**
 * Truncate a string that may contain ANSI escape codes to fit within
 * `maxCols` visible characters.  Preserves ANSI sequences so colours are
 * not broken, and appends '…' when truncation occurs.
 */
function fitToWidth(str, maxCols) {
  if (!maxCols || maxCols <= 0) return str;
  const visible = strip(str);
  if (visible.length <= maxCols) return str;

  let visCount = 0;
  let i = 0;
  const target = maxCols - 1; // leave room for '…'
  while (i < str.length && visCount < target) {
    if (str[i] === '\x1b') {
      // Skip full ANSI sequence: ESC [ ... m
      const end = str.indexOf('m', i);
      if (end !== -1) { i = end + 1; continue; }
    }
    visCount++;
    i++;
  }
  return str.slice(0, i) + '\x1b[0m…';
}

/**
 * Build display strings for visible items within a window.
 *
 * @param {Array<{label: string, hint?: string}>} items  All items
 * @param {number}      cursor   Currently highlighted index (global)
 * @param {Set<number>} [selected]  For multi-select: selected indices (global)
 * @param {boolean}     [multi=false]
 * @param {number}      [windowStart=0]
 * @param {number}      [windowEnd=items.length]
 * @param {number}      [total=items.length]  Total items (for scroll indicator)
 * @returns {string[]}
 */
function renderList(items, cursor, selected, multi = false, windowStart = 0, windowEnd = items.length, total = items.length) {
  const lines = [];

  // Scroll-up indicator
  if (windowStart > 0) {
    lines.push(c.dim(`    ↑ ${windowStart} more above`));
  }

  for (let i = windowStart; i < windowEnd; i++) {
    const item = items[i];
    const isCursor = i === cursor;
    const prefix = isCursor ? c.cyan('❯') : ' ';

    let checkbox = '';
    if (multi) {
      const isChecked = selected && selected.has(i);
      checkbox = isChecked ? c.green(' ◉') : c.dim(' ○');
    }

    const label = isCursor ? c.bold(c.cyan(strip(item.label))) : item.label;
    const hint  = item.hint
      ? (isCursor ? c.dim(` ${strip(item.hint)}`) : c.dim(` ${item.hint}`))
      : '';

    lines.push(`  ${prefix}${checkbox} ${label}${hint}`);
  }

  // Scroll-down indicator
  if (windowEnd < total) {
    lines.push(c.dim(`    ↓ ${total - windowEnd} more below`));
  }

  return lines;
}

/**
 * Write an array of strings to stdout, one per line.
 * Each line is preceded by CR + CLEAR_LINE so the entire row is wiped first.
 * Lines are truncated to terminal width to prevent wrapping (which breaks
 * cursor-UP repositioning on redraw).
 *
 * @param {string[]} lines  Lines to write
 * @param {number} [totalSlots=0]  If > lines.length, blank-clear the remaining lines
 */
function writeLines(lines, totalSlots = 0) {
  const cols = process.stdout.columns || 80;
  const count = Math.max(lines.length, totalSlots);
  for (let i = 0; i < count; i++) {
    if (i > 0) process.stdout.write('\n');
    process.stdout.write(CR + CLEAR_LINE);
    if (i < lines.length) {
      process.stdout.write(fitToWidth(lines[i], cols - 1));
    }
  }
}

// ── Key decoder ───────────────────────────────────────────────────────────────

/**
 * Decode a raw keypress buffer into a named action.
 * @param {Buffer} buf
 * @returns {'up'|'down'|'space'|'enter'|'escape'|'a'|null}
 */
function decodeKey(buf) {
  if (buf[0] === 0x1b && buf[1] === 0x5b) {
    if (buf[2] === 0x41) return 'up';
    if (buf[2] === 0x42) return 'down';
    return null;
  }
  if (buf[0] === 0x1b && buf.length === 1) return 'escape';
  if (buf[0] === 0x0d || buf[0] === 0x0a) return 'enter';
  if (buf[0] === 0x20) return 'space';
  if (buf[0] === 0x03) return 'ctrl-c';
  if (buf[0] === 0x61 || buf[0] === 0x41) return 'a';
  return null;
}

// ── Core: selectOne ───────────────────────────────────────────────────────────

/**
 * Interactive single-select with arrow-key navigation.
 *
 * @param {Object} opts
 * @param {string}  opts.title   - Heading text (printed once)
 * @param {Array<{label: string, hint?: string, value: any}>} opts.items
 * @param {number}  [opts.default=0]  - Default highlighted index
 * @param {string}  [opts.footer]     - Hint line below the list
 * @returns {Promise<{index: number, value: any}>}
 */
function selectOne({ title, items, default: defaultIdx = 0, footer }) {
  if (!items || items.length === 0) {
    return Promise.resolve({ index: -1, value: undefined });
  }

  if (!process.stdin.isTTY) {
    return _fallbackSelectOne({ title, items, default: defaultIdx });
  }

  return new Promise((resolve) => {
    let cursor = defaultIdx;
    const total = items.length;
    const hasFooter = !!footer;
    const maxRows = getMaxVisibleRows();
    let scrollOffset = 0;
    // Fixed slot count: viewport items + up/down indicators + footer
    // This keeps redraw height stable regardless of scroll position.
    const visibleItems = Math.min(total, maxRows);
    const hasScrollIndicators = total > maxRows;
    const itemSlots = visibleItems + (hasScrollIndicators ? 2 : 0);
    const fixedLineCount = itemSlots + (hasFooter ? 1 : 0);
    let firstDraw = true;

    // ── Title (printed once, never overwritten) ────────
    if (title) {
      console.log('');
      console.log(`  ${title}`);
      console.log(c.dim('  ' + '─'.repeat(60)));
    }

    process.stdout.write(HIDE_CURSOR);

    // ── Draw / redraw ──────────────────────────────────
    const draw = () => {
      if (!firstDraw) {
        // Terminal cursor is on the last rendered line — go back to first
        process.stdout.write(UP(fixedLineCount - 1) + CR);
      }
      const { start, end } = computeWindow(cursor, total, maxRows, scrollOffset);
      scrollOffset = start;
      const lines = renderList(items, cursor, null, false, start, end, total);
      writeLines(lines, itemSlots);
      if (hasFooter) {
        const cols = process.stdout.columns || 80;
        process.stdout.write('\n');
        process.stdout.write(`${CR}${CLEAR_LINE}${fitToWidth(c.dim(`  ${footer}`), cols - 1)}`);
      }
      // Terminal cursor is now on the LAST rendered line
      firstDraw = false;
    };

    draw(); // initial render

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onKey);
      process.stdout.write(CR + SHOW_CURSOR + '\n');
    };

    const onKey = (buf) => {
      const key = decodeKey(buf);
      if (key === 'up') {
        cursor = (cursor - 1 + total) % total;
        draw();
      } else if (key === 'down') {
        cursor = (cursor + 1) % total;
        draw();
      } else if (key === 'enter') {
        cleanup();
        const chosen = items[cursor];
        console.log(c.success(`${strip(chosen.label)}`));
        resolve({ index: cursor, value: chosen.value });
      } else if (key === 'escape') {
        cleanup();
        const chosen = items[defaultIdx];
        console.log(c.success(`${strip(chosen.label)}`));
        resolve({ index: defaultIdx, value: chosen.value });
      } else if (key === 'ctrl-c') {
        cleanup();
        console.log('');
        process.exit(130);
      }
    };

    process.stdin.on('data', onKey);
  });
}

// ── Core: selectMany ──────────────────────────────────────────────────────────

/**
 * Interactive multi-select with arrow-key navigation + Space toggle.
 *
 * @param {Object} opts
 * @param {string}  opts.title
 * @param {Array<{label: string, hint?: string, value: any}>} opts.items
 * @param {Set<number>} [opts.defaultSelected]  - Pre-selected indices
 * @param {string}  [opts.footer]
 * @returns {Promise<{indices: number[], values: any[]}>}
 */
function selectMany({ title, items, defaultSelected, footer }) {
  if (!items || items.length === 0) {
    return Promise.resolve({ indices: [], values: [] });
  }

  if (!process.stdin.isTTY) {
    return _fallbackSelectMany({ title, items, defaultSelected });
  }

  return new Promise((resolve) => {
    let cursor = 0;
    const selected = new Set(defaultSelected || []);
    const total = items.length;
    const maxRows = getMaxVisibleRows();
    let scrollOffset = 0;

    const footerText = footer || '↑↓ navigate · Space toggle · A all/none · Enter confirm';
    // Fixed slot count: viewport items + up/down indicators + footer
    const visibleItems = Math.min(total, maxRows);
    const hasScrollIndicators = total > maxRows;
    const itemSlots = visibleItems + (hasScrollIndicators ? 2 : 0);
    const fixedLineCount = itemSlots + 1; // +1 for footer (always shown)
    let firstDraw = true;

    if (title) {
      console.log('');
      console.log(`  ${title}`);
      console.log(c.dim('  ' + '─'.repeat(60)));
    }

    process.stdout.write(HIDE_CURSOR);

    const draw = () => {
      if (!firstDraw) {
        process.stdout.write(UP(fixedLineCount - 1) + CR);
      }
      const { start, end } = computeWindow(cursor, total, maxRows, scrollOffset);
      scrollOffset = start;
      const lines = renderList(items, cursor, selected, true, start, end, total);
      writeLines(lines, itemSlots);
      const cols = process.stdout.columns || 80;
      process.stdout.write('\n');
      process.stdout.write(`${CR}${CLEAR_LINE}${fitToWidth(c.dim(`  ${footerText}`), cols - 1)}`);
      firstDraw = false;
    };

    draw();

    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onKey);
      process.stdout.write(CR + SHOW_CURSOR + '\n');
    };

    const onKey = (buf) => {
      const key = decodeKey(buf);
      if (key === 'up') {
        cursor = (cursor - 1 + total) % total;
        draw();
      } else if (key === 'down') {
        cursor = (cursor + 1) % total;
        draw();
      } else if (key === 'space') {
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
        draw();
      } else if (key === 'a') {
        if (selected.size === total) selected.clear();
        else { for (let i = 0; i < total; i++) selected.add(i); }
        draw();
      } else if (key === 'enter') {
        cleanup();
        const indices = [...selected].sort((a, b) => a - b);
        const values  = indices.map(i => items[i].value);
        const labels  = indices.map(i => strip(items[i].label));
        if (labels.length === 0) {
          console.log(c.dim('  None selected'));
        } else if (labels.length === total) {
          console.log(c.success('All selected'));
        } else {
          console.log(c.success(labels.join(', ')));
        }
        resolve({ indices, values });
      } else if (key === 'escape') {
        cleanup();
        const indices = [...(defaultSelected || [])].sort((a, b) => a - b);
        const values  = indices.map(i => items[i].value);
        resolve({ indices, values });
      } else if (key === 'ctrl-c') {
        cleanup();
        console.log('');
        process.exit(130);
      }
    };

    process.stdin.on('data', onKey);
  });
}

// ── Fallback implementations (non-TTY) ───────────────────────────────────────

async function _fallbackSelectOne({ title, items, default: defaultIdx }) {
  const readline = require('readline');
  if (title) {
    console.log('');
    console.log(`  ${title}`);
    console.log(c.dim('  ' + '─'.repeat(50)));
  }

  items.forEach((item, i) => {
    const marker = i === defaultIdx ? c.green(' ← default') : '';
    console.log(`    ${c.cyan(`[${i + 1}]`)} ${item.label}${item.hint ? c.dim(` ${item.hint}`) : ''}${marker}`);
  });
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`  Select [1-${items.length}] (Enter = default): `, answer => {
      rl.close();
      const trimmed = (answer || '').trim();
      if (!trimmed) {
        resolve({ index: defaultIdx, value: items[defaultIdx].value });
        return;
      }
      const num = parseInt(trimmed, 10);
      if (num >= 1 && num <= items.length) {
        resolve({ index: num - 1, value: items[num - 1].value });
        return;
      }
      resolve({ index: defaultIdx, value: items[defaultIdx].value });
    });
  });
}

async function _fallbackSelectMany({ title, items, defaultSelected }) {
  const readline = require('readline');
  if (title) {
    console.log('');
    console.log(`  ${title}`);
    console.log(c.dim('  ' + '─'.repeat(50)));
  }

  items.forEach((item, i) => {
    console.log(`    ${c.cyan(`[${i + 1}]`)} ${item.label}${item.hint ? c.dim(` ${item.hint}`) : ''}`);
  });
  console.log(`    ${c.cyan('[A]')} All`);
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('  Select (e.g. 1,3 or A for all) [Enter = all]: ', answer => {
      rl.close();
      const trimmed = (answer || '').trim().toLowerCase();
      if (!trimmed || trimmed === 'a' || trimmed === 'all') {
        const all = items.map((_, i) => i);
        resolve({ indices: all, values: items.map(it => it.value) });
        return;
      }
      const parts = trimmed.split(/[\s,]+/).filter(Boolean);
      const indices = [];
      for (const p of parts) {
        const num = parseInt(p, 10);
        if (num >= 1 && num <= items.length) indices.push(num - 1);
      }
      if (indices.length === 0) {
        const all = items.map((_, i) => i);
        resolve({ indices: all, values: items.map(it => it.value) });
        return;
      }
      resolve({ indices, values: indices.map(i => items[i].value) });
    });
  });
}

module.exports = { selectOne, selectMany, computeWindow, getMaxVisibleRows };
