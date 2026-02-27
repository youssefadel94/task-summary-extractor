/**
 * Diff Engine — compares current compilation against previous runs
 * to generate a delta report: what's new, what's resolved, what changed.
 *
 * This enables incremental awareness — users can see what changed between
 * successive analyses of the same call (or across calls in a series).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ======================== PREVIOUS RUN LOADING ========================

/**
 * Find and load the most recent previous compilation for comparison.
 *
 * @param {string} targetDir - The call folder (e.g., "call 1/")
 * @param {string} [currentRunTs] - Current run timestamp to exclude
 * @returns {object|null} Previous compiled analysis, or null if none found
 */
function loadPreviousCompilation(targetDir, currentRunTs = null) {
  const runsDir = path.join(targetDir, 'runs');
  if (!fs.existsSync(runsDir)) return null;

  try {
    const runDirs = fs.readdirSync(runsDir)
      .filter(d => {
        const full = path.join(runsDir, d);
        return fs.statSync(full).isDirectory() && d !== currentRunTs;
      })
      .sort()
      .reverse(); // Most recent first

    for (const dir of runDirs) {
      const compilationPath = path.join(runsDir, dir, 'compilation.json');
      if (fs.existsSync(compilationPath)) {
        const data = JSON.parse(fs.readFileSync(compilationPath, 'utf8'));
        const parsed = data.output?.parsed || data.compiled || null;
        if (parsed) {
          return {
            timestamp: dir,
            compiled: parsed,
            runPath: path.join(runsDir, dir),
          };
        }
      }

      // Fallback: try results.json
      const resultsPath = path.join(runsDir, dir, 'results.json');
      if (fs.existsSync(resultsPath)) {
        const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
        if (results.compilation) {
          return {
            timestamp: dir,
            compiled: null, // No compiled data in results.json directly
            runPath: path.join(runsDir, dir),
          };
        }
      }
    }
  } catch (err) {
    console.warn(`  ⚠ Could not load previous compilation: ${err.message}`);
  }

  return null;
}

// ======================== DIFF GENERATION ========================

/**
 * Compare two compiled analyses and produce a diff.
 *
 * @param {object} current - Current compiled analysis
 * @param {object} previous - Previous compiled analysis
 * @returns {object} Diff report
 */
function generateDiff(current, previous) {
  if (!current || !previous) {
    return { hasDiff: false, reason: !previous ? 'no_previous_run' : 'no_current_data' };
  }

  const diff = {
    hasDiff: true,
    previousTimestamp: previous.timestamp || 'unknown',
    tickets: diffArray(current.tickets || [], previous.tickets || [], 'ticket_id'),
    changeRequests: diffArray(current.change_requests || [], previous.change_requests || [], 'id'),
    actionItems: diffArray(current.action_items || [], previous.action_items || [], 'id'),
    blockers: diffArray(current.blockers || [], previous.blockers || [], 'id'),
    scopeChanges: diffArray(current.scope_changes || [], previous.scope_changes || [], 'id'),
    summary: {
      current: current.summary || '',
      previous: previous.summary || '',
      changed: (current.summary || '') !== (previous.summary || ''),
    },
  };

  // Calculate totals
  diff.totals = {
    newItems: (diff.tickets.added?.length || 0) +
      (diff.changeRequests.added?.length || 0) +
      (diff.actionItems.added?.length || 0) +
      (diff.blockers.added?.length || 0) +
      (diff.scopeChanges.added?.length || 0),
    removedItems: (diff.tickets.removed?.length || 0) +
      (diff.changeRequests.removed?.length || 0) +
      (diff.actionItems.removed?.length || 0) +
      (diff.blockers.removed?.length || 0) +
      (diff.scopeChanges.removed?.length || 0),
    changedItems: (diff.tickets.changed?.length || 0) +
      (diff.changeRequests.changed?.length || 0) +
      (diff.actionItems.changed?.length || 0) +
      (diff.blockers.changed?.length || 0) +
      (diff.scopeChanges.changed?.length || 0),
    unchangedItems: (diff.tickets.unchanged?.length || 0) +
      (diff.changeRequests.unchanged?.length || 0) +
      (diff.actionItems.unchanged?.length || 0) +
      (diff.blockers.unchanged?.length || 0) +
      (diff.scopeChanges.unchanged?.length || 0),
  };

  return diff;
}

/**
 * Diff two arrays of items by ID field.
 *
 * @param {Array} currentArr - Current items
 * @param {Array} previousArr - Previous items
 * @param {string} idField - Field name to use as ID
 * @returns {{ added: Array, removed: Array, changed: Array, unchanged: Array }}
 */
function diffArray(currentArr, previousArr, idField) {
  const prevMap = new Map();
  for (const item of previousArr) {
    const id = item[idField];
    if (id) prevMap.set(id, item);
  }

  const currMap = new Map();
  for (const item of currentArr) {
    const id = item[idField];
    if (id) currMap.set(id, item);
  }

  const added = [];
  const changed = [];
  const unchanged = [];
  const removed = [];

  // Find added and changed
  for (const [id, currItem] of currMap) {
    if (!prevMap.has(id)) {
      added.push({ id, item: currItem, _diffStatus: 'new' });
    } else {
      const prevItem = prevMap.get(id);
      const changes = detectFieldChanges(currItem, prevItem, idField);
      if (changes.length > 0) {
        changed.push({ id, item: currItem, changes, _diffStatus: 'changed' });
      } else {
        unchanged.push({ id, _diffStatus: 'unchanged' });
      }
    }
  }

  // Find removed
  for (const [id, prevItem] of prevMap) {
    if (!currMap.has(id)) {
      removed.push({ id, item: prevItem, _diffStatus: 'removed' });
    }
  }

  return { added, removed, changed, unchanged };
}

/**
 * Detect specific field changes between two items.
 *
 * @param {object} current
 * @param {object} previous
 * @param {string} idField - Skip the ID field itself
 * @returns {Array<{field: string, from: any, to: any}>}
 */
function detectFieldChanges(current, previous, idField) {
  const changes = [];
  const importantFields = ['status', 'priority', 'assigned_to', 'assignee', 'owner', 'confidence'];

  for (const field of importantFields) {
    const curr = current[field];
    const prev = previous[field];
    if (curr !== prev && (curr || prev)) {
      changes.push({ field, from: prev || null, to: curr || null });
    }
  }

  return changes;
}

// ======================== MARKDOWN RENDERING ========================

/**
 * Render the diff as a Markdown section to append to the main report.
 *
 * @param {object} diff - From generateDiff()
 * @returns {string} Markdown section
 */
function renderDiffMarkdown(diff) {
  if (!diff || !diff.hasDiff) return '';

  const lines = [];
  const ln = (...args) => lines.push(args.join(''));

  ln('## 🔄 Changes Since Previous Run');
  ln('');
  ln(`> Compared against run from: \`${diff.previousTimestamp}\``);
  ln('');

  const t = diff.totals;
  if (t.newItems === 0 && t.removedItems === 0 && t.changedItems === 0) {
    ln('No changes detected since the previous run.');
    ln('');
    return lines.join('\n');
  }

  ln(`| Category | New | Removed | Changed | Unchanged |`);
  ln(`| --- | --- | --- | --- | --- |`);

  const categories = [
    { name: 'Tickets', d: diff.tickets },
    { name: 'Change Requests', d: diff.changeRequests },
    { name: 'Action Items', d: diff.actionItems },
    { name: 'Blockers', d: diff.blockers },
    { name: 'Scope Changes', d: diff.scopeChanges },
  ];

  for (const { name, d } of categories) {
    const a = d.added?.length || 0;
    const r = d.removed?.length || 0;
    const c = d.changed?.length || 0;
    const u = d.unchanged?.length || 0;
    if (a + r + c > 0) {
      ln(`| ${name} | ${a > 0 ? `+${a}` : '-'} | ${r > 0 ? `-${r}` : '-'} | ${c > 0 ? `~${c}` : '-'} | ${u} |`);
    }
  }
  ln('');

  // Detail new items
  const allNew = [
    ...diff.tickets.added.map(i => ({ type: 'Ticket', ...i })),
    ...diff.changeRequests.added.map(i => ({ type: 'CR', ...i })),
    ...diff.actionItems.added.map(i => ({ type: 'Action', ...i })),
    ...diff.blockers.added.map(i => ({ type: 'Blocker', ...i })),
    ...diff.scopeChanges.added.map(i => ({ type: 'Scope', ...i })),
  ];
  if (allNew.length > 0) {
    ln('### ➕ New Items');
    ln('');
    for (const n of allNew) {
      const title = n.item.title || n.item.description || n.item.ticket_id || n.id;
      ln(`- **[${n.type}]** ${n.id}: ${title}`);
    }
    ln('');
  }

  // Detail removed items
  const allRemoved = [
    ...diff.tickets.removed.map(i => ({ type: 'Ticket', ...i })),
    ...diff.changeRequests.removed.map(i => ({ type: 'CR', ...i })),
    ...diff.actionItems.removed.map(i => ({ type: 'Action', ...i })),
    ...diff.blockers.removed.map(i => ({ type: 'Blocker', ...i })),
    ...diff.scopeChanges.removed.map(i => ({ type: 'Scope', ...i })),
  ];
  if (allRemoved.length > 0) {
    ln('### ➖ Removed Items');
    ln('');
    for (const r of allRemoved) {
      const title = r.item.title || r.item.description || r.item.ticket_id || r.id;
      ln(`- **[${r.type}]** ${r.id}: ${title}`);
    }
    ln('');
  }

  // Detail changed items
  const allChanged = [
    ...diff.tickets.changed.map(i => ({ type: 'Ticket', ...i })),
    ...diff.changeRequests.changed.map(i => ({ type: 'CR', ...i })),
    ...diff.actionItems.changed.map(i => ({ type: 'Action', ...i })),
    ...diff.blockers.changed.map(i => ({ type: 'Blocker', ...i })),
    ...diff.scopeChanges.changed.map(i => ({ type: 'Scope', ...i })),
  ];
  if (allChanged.length > 0) {
    ln('### 🔀 Changed Items');
    ln('');
    for (const c of allChanged) {
      const title = c.item.title || c.item.description || c.item.ticket_id || c.id;
      ln(`- **[${c.type}]** ${c.id}: ${title}`);
      for (const ch of c.changes) {
        ln(`  - \`${ch.field}\`: ${ch.from || '_empty_'} → **${ch.to || '_empty_'}**`);
      }
    }
    ln('');
  }

  return lines.join('\n');
}

module.exports = {
  loadPreviousCompilation,
  generateDiff,
  renderDiffMarkdown,
};
