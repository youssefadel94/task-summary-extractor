/**
 * Context manager — intelligent context prioritization, VTT slicing,
 * and token-budget-aware document selection for Gemini AI calls.
 *
 * Problem solved: sending 69 docs (~1.5MB) to each segment wastes tokens
 * on general reference docs, diluting AI focus from task/ticket extraction.
 *
 * Solution: 4-tier priority system + VTT time-slicing + budget management.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { formatHMS } = require('./format');

// ════════════════════════════════════════════════════════════
//  Token Estimation
// ════════════════════════════════════════════════════════════

/** Rough token estimate — ~0.3 tokens per byte for mixed English/Arabic markdown. */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length * 0.3);
}

/** Estimate tokens for a prepared context doc. */
function estimateDocTokens(doc) {
  if (doc.type === 'inlineText') return estimateTokens(doc.content);
  if (doc.type === 'fileData') return 2000; // PDFs: rough estimate, actual varies
  return 500;
}

// ════════════════════════════════════════════════════════════
//  Priority Classification
// ════════════════════════════════════════════════════════════

/**
 * Priority tiers for context documents:
 *  P0 — CRITICAL: VTT subtitle, execution plans, checklists (always include)
 *  P1 — HIGH: file maps (.robot/ top-level), code-maps from .tasks (always include)
 *  P2 — MEDIUM: .docs/summary/ (condensed reference), sub-tickets, business-req docs
 *  P3 — LOW: .robot/core/ patterns, remaining .tasks non-essential docs
 *  P4 — BACKGROUND: .docs/ full deep-dives (only if budget allows)
 */
const PRIORITY = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, BACKGROUND: 4 };

/**
 * Classify a document by its file path into a priority tier.
 */
function classifyDocPriority(fileName) {
  const fl = fileName.toLowerCase().replace(/\\/g, '/');

  // P0 — VTT/subtitle files & execution plans/checklists
  if (fl.endsWith('.vtt') || fl.endsWith('.srt')) return PRIORITY.CRITICAL;
  if (fl.includes('.tasks/') && (
    fl.includes('execution-plan') ||
    fl.includes('checklist') ||
    fl.includes('remaining-work')
  )) return PRIORITY.CRITICAL;

  // P1 — File maps and code maps
  if (fl.includes('.tasks/') && fl.includes('code-map')) return PRIORITY.HIGH;
  if (fl.includes('.robot/') && !fl.includes('/core/')) return PRIORITY.HIGH;

  // P2 — Summaries, sub-tickets, business docs
  if (fl.includes('.docs/summary/')) return PRIORITY.MEDIUM;
  if (fl.includes('.tasks/') && fl.includes('sub-tickets/')) return PRIORITY.MEDIUM;
  if (fl.includes('.tasks/') && fl.includes('business-requirements')) return PRIORITY.MEDIUM;
  if (fl.includes('.tasks/') && fl.includes('call-transcript')) return PRIORITY.MEDIUM;

  // P3 — Robot core patterns, PR templates, merge checks, remaining .tasks docs
  if (fl.includes('.robot/core/')) return PRIORITY.LOW;
  if (fl.includes('.tasks/')) return PRIORITY.LOW; // remaining .tasks docs (PR templates, merge checks, etc.)

  // P4 — Full .docs deep-dives
  if (fl.includes('.docs/')) return PRIORITY.BACKGROUND;

  // Other root-level docs
  if (fl.endsWith('.md') || fl.endsWith('.txt')) return PRIORITY.MEDIUM;
  return PRIORITY.LOW;
}

/**
 * Select documents for a segment within a token budget, ordered by priority.
 *
 * @param {Array} allDocs - All prepared context docs [{type, fileName, content?, ...}]
 * @param {number} tokenBudget - Max tokens to allocate for documents
 * @param {object} [opts] - Options
 * @param {number} [opts.segmentIndex] - Current segment index (for logging)
 * @returns {{ selected: Array, excluded: Array, stats: object }}
 */
function selectDocsByBudget(allDocs, tokenBudget, opts = {}) {
  // Classify and sort by priority
  const classified = allDocs.map(doc => ({
    doc,
    priority: classifyDocPriority(doc.fileName),
    tokens: estimateDocTokens(doc),
  })).sort((a, b) => a.priority - b.priority || a.tokens - b.tokens);

  const selected = [];
  const excluded = [];
  let usedTokens = 0;

  for (const item of classified) {
    if (usedTokens + item.tokens <= tokenBudget) {
      selected.push(item.doc);
      usedTokens += item.tokens;
    } else if (item.priority <= PRIORITY.HIGH) {
      // P0 and P1 are always included even if over budget
      selected.push(item.doc);
      usedTokens += item.tokens;
    } else {
      excluded.push({ fileName: item.doc.fileName, priority: item.priority, tokens: item.tokens });
    }
  }

  const stats = {
    totalDocs: allDocs.length,
    selectedDocs: selected.length,
    excludedDocs: excluded.length,
    estimatedTokens: usedTokens,
    tokenBudget,
    segmentIndex: opts.segmentIndex,
  };

  return { selected, excluded, stats };
}

// ════════════════════════════════════════════════════════════
//  VTT Time-Slicing
// ════════════════════════════════════════════════════════════

/**
 * Parse a VTT file into an array of cue objects.
 * @param {string} vttContent - Raw VTT file content
 * @returns {Array<{startSec: number, endSec: number, text: string}>}
 */
function parseVttCues(vttContent) {
  const cues = [];
  const blocks = vttContent.split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    // Find the timestamp line
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(
        /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/
      );
      if (match) {
        const startSec = +match[1] * 3600 + +match[2] * 60 + +match[3] + +match[4] / 1000;
        const endSec = +match[5] * 3600 + +match[6] * 60 + +match[7] + +match[8] / 1000;
        const textLines = lines.slice(i + 1).join('\n').trim();
        if (textLines) {
          cues.push({ startSec, endSec, text: textLines });
        }
        break;
      }
    }
  }
  return cues;
}

/**
 * Slice VTT content to only include cues within a time range.
 * Used to give each segment ONLY the relevant portion of the transcript.
 *
 * @param {string} vttContent - Full VTT content
 * @param {number} segStartSec - Segment start time in seconds  
 * @param {number} segEndSec - Segment end time in seconds
 * @param {number} [overlapSec=30] - Overlap margin to include context
 * @returns {string} Sliced VTT content (or full content if parsing fails)
 */
function sliceVttForSegment(vttContent, segStartSec, segEndSec, overlapSec = 30) {
  const cues = parseVttCues(vttContent);
  if (cues.length === 0) return vttContent; // fallback: return full VTT

  const rangeStart = Math.max(0, segStartSec - overlapSec);
  const rangeEnd = segEndSec + overlapSec;

  const filtered = cues.filter(c => c.endSec >= rangeStart && c.startSec <= rangeEnd);

  if (filtered.length === 0) return vttContent; // fallback

  const header = `WEBVTT\n\n[Segment transcript: ${formatHMS(segStartSec)} — ${formatHMS(segEndSec)}]\n[Showing cues from ${formatHMS(rangeStart)} to ${formatHMS(rangeEnd)} with ${overlapSec}s overlap]\n`;

  const body = filtered.map(c => {
    const start = formatVttTime(c.startSec);
    const end = formatVttTime(c.endSec);
    return `${start} --> ${end}\n${c.text}`;
  }).join('\n\n');

  return header + '\n' + body;
}

function formatVttTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

// ════════════════════════════════════════════════════════════
//  Previous-Segment Context Compression
// ════════════════════════════════════════════════════════════

/**
 * Build compressed previous-analyses context with progressive detail:
 *  - Most recent segment: FULL detail (all fields)
 *  - Older segments: COMPRESSED (IDs + statuses only, no verbose descriptions)
 *
 * This prevents unbounded growth of previous-segment context.
 *
 * @param {Array} previousAnalyses - All prior segment analyses
 * @param {string} userName - Current user name
 * @returns {string|null} Context text or null if no previous analyses
 */
function buildProgressiveContext(previousAnalyses, userName) {
  if (previousAnalyses.length === 0) return null;

  const parts = [];
  parts.push('PREVIOUS SEGMENT ANALYSES — maintain continuity, reuse REAL ticket IDs, continue numbering.');
  parts.push('Rules: DO NOT repeat already-extracted items. Only add NEW information or STATE CHANGES.');
  parts.push(`Track tasks for "${userName}" consistently across segments.\n`);

  for (let idx = 0; idx < previousAnalyses.length; idx++) {
    const prev = previousAnalyses[idx];
    const isRecent = idx >= previousAnalyses.length - 2; // last 2 segments get full detail

    if (isRecent) {
      // FULL detail for recent segments
      parts.push(buildFullSegmentSummary(prev, idx));
    } else {
      // COMPRESSED for older segments
      parts.push(buildCompressedSegmentSummary(prev, idx));
    }
  }

  return parts.join('\n');
}

/** Full detail summary for a segment (recent segments). */
function buildFullSegmentSummary(prev, idx) {
  const lines = [`=== SEGMENT ${idx + 1} (FULL DETAIL) ===`];

  // Summary
  if (prev.summary) lines.push(`Summary: ${prev.summary}`);

  // Tickets
  if (prev.tickets?.length > 0) {
    lines.push('Tickets:');
    for (const t of prev.tickets) {
      lines.push(`  ${t.ticket_id} (${t.status}) — ${t.title || 'untitled'}`);
      if (t.documented_state?.plan_status) lines.push(`    Doc state: ${t.documented_state.plan_status}`);
      if (t.discussed_state?.summary) lines.push(`    Discussed: ${t.discussed_state.summary.substring(0, 200)}`);
    }
  }

  // Change requests
  if (prev.change_requests?.length > 0) {
    lines.push('Change Requests:');
    for (const cr of prev.change_requests) {
      lines.push(`  ${cr.id}: ${cr.title || cr.what} [${cr.status}] → ${cr.assigned_to || 'unassigned'}`);
      if (cr.where?.file_path) lines.push(`    File: ${cr.where.file_path}`);
      if (cr.blocked_by) lines.push(`    Blocked by: ${cr.blocked_by}`);
    }
  }

  // Action items
  if (prev.action_items?.length > 0) {
    lines.push('Action Items:');
    for (const ai of prev.action_items) {
      lines.push(`  ${ai.id}: ${ai.description} → ${ai.assigned_to} [${ai.status}]`);
    }
  }

  // Scope changes
  if (prev.scope_changes?.length > 0) {
    lines.push('Scope Changes:');
    for (const sc of prev.scope_changes) {
      lines.push(`  ${sc.id} (${sc.type}): ${sc.new_scope} [${sc.impact}]`);
    }
  }

  // Blockers
  if (prev.blockers?.length > 0) {
    lines.push('Blockers:');
    for (const b of prev.blockers) {
      lines.push(`  ${b.id}: ${b.description} → ${b.owner} [${b.status}]`);
    }
  }

  // User tasks summary
  if (prev.your_tasks) {
    const yt = prev.your_tasks;
    lines.push(`User Tasks (${yt.user_name || userName}):`);
    lines.push(`  Todo: ${(yt.tasks_todo || []).length} | Waiting: ${(yt.tasks_waiting_on_others || []).length} | Completed: ${(yt.completed_in_call || []).length}`);
    if (yt.summary) lines.push(`  Focus: ${yt.summary.substring(0, 200)}`);
  }

  // File references (compact)
  if (prev.file_references?.length > 0) {
    const fileList = prev.file_references
      .map(f => `${f.file_name} (${f.role})${f.resolved_path ? ' → ' + f.resolved_path : ''}`)
      .join(', ');
    lines.push(`Files: ${fileList}`);
  }

  return lines.join('\n') + '\n';
}

/** Compressed summary for older segments — IDs and states only. */
function buildCompressedSegmentSummary(prev, idx) {
  const lines = [`=== SEGMENT ${idx + 1} (COMPRESSED — older segment) ===`];

  // One-line summary
  if (prev.summary) lines.push(`Summary: ${prev.summary.substring(0, 150)}...`);

  // Tickets: just IDs and statuses
  if (prev.tickets?.length > 0) {
    const ticketList = prev.tickets.map(t => `${t.ticket_id}(${t.status})`).join(', ');
    lines.push(`Tickets: [${ticketList}]`);
  }

  // CRs: just IDs, statuses, assignees
  if (prev.change_requests?.length > 0) {
    const crList = prev.change_requests.map(cr => `${cr.id}[${cr.status}]`).join(', ');
    lines.push(`CRs: [${crList}]`);
  }

  // Action items: just IDs and who
  if (prev.action_items?.length > 0) {
    const aiList = prev.action_items.map(ai => `${ai.id}→${ai.assigned_to}[${ai.status}]`).join(', ');
    lines.push(`Actions: [${aiList}]`);
  }

  // Blockers: IDs only
  if (prev.blockers?.length > 0) {
    const bList = prev.blockers.map(b => `${b.id}[${b.status}]`).join(', ');
    lines.push(`Blockers: [${bList}]`);
  }

  // Scope changes count
  if (prev.scope_changes?.length > 0) {
    lines.push(`Scope changes: ${prev.scope_changes.length} recorded`);
  }

  return lines.join('\n') + '\n';
}

// ════════════════════════════════════════════════════════════
//  Segment Focus Instructions
// ════════════════════════════════════════════════════════════

/**
 * Generate dynamic per-segment focus instructions.
 * Tells the AI what's been found so far and what to look for.
 *
 * @param {number} segmentIndex - Current segment (0-based)
 * @param {number} totalSegments - Total segments
 * @param {Array} previousAnalyses - Analyses from prior segments
 * @param {string} userName - Current user name
 * @returns {string} Focus instructions text
 */
function buildSegmentFocus(segmentIndex, totalSegments, previousAnalyses, userName) {
  const lines = [];

  lines.push(`SEGMENT POSITION: ${segmentIndex + 1} of ${totalSegments} (${
    segmentIndex === 0 ? 'FIRST — establish baseline' :
    segmentIndex === totalSegments - 1 ? 'LAST — capture final decisions & wrap-up tasks' :
    'MIDDLE — track changes & new items'
  })`);

  if (segmentIndex === 0) {
    lines.push('FOCUS: Identify ALL tickets, participants, and initial task assignments.');
    lines.push('Establish the baseline state for each ticket. Cross-reference everything against task documents.');
    lines.push(`Pay special attention to tasks assigned to "${userName}".`);
  } else {
    // Build awareness of what's been found
    const allTicketIds = new Set();
    const allCrIds = new Set();
    const allActionIds = new Set();
    const allBlockerIds = new Set();
    const allScopeIds = new Set();

    for (const prev of previousAnalyses) {
      (prev.tickets || []).forEach(t => allTicketIds.add(t.ticket_id));
      (prev.change_requests || []).forEach(cr => allCrIds.add(cr.id));
      (prev.action_items || []).forEach(ai => allActionIds.add(ai.id));
      (prev.blockers || []).forEach(b => allBlockerIds.add(b.id));
      (prev.scope_changes || []).forEach(sc => allScopeIds.add(sc.id));
    }

    lines.push(`ALREADY FOUND in previous segments:`);
    if (allTicketIds.size > 0) lines.push(`  Tickets: ${[...allTicketIds].join(', ')}`);
    if (allCrIds.size > 0) lines.push(`  CRs: ${[...allCrIds].slice(0, 20).join(', ')}${allCrIds.size > 20 ? ` (+${allCrIds.size - 20} more)` : ''}`);
    if (allActionIds.size > 0) lines.push(`  Actions: ${[...allActionIds].join(', ')}`);
    if (allBlockerIds.size > 0) lines.push(`  Blockers: ${[...allBlockerIds].join(', ')}`);

    lines.push('');
    lines.push('FOCUS for this segment:');
    lines.push('1. DETECT NEW tickets, CRs, action items, blockers not yet found');
    lines.push('2. TRACK STATE CHANGES to already-known items (status updates, new decisions, scope changes)');
    lines.push('3. CAPTURE any tasks assigned, re-assigned, or completed during this segment');
    lines.push(`4. UPDATE ${userName}'s task list — any new assignments, completions, or blockers`);
    lines.push('5. NOTE discussion depth — conversations with detailed decisions have HIGH task relevance');

    if (segmentIndex === totalSegments - 1) {
      lines.push('');
      lines.push('LAST SEGMENT SPECIAL:');
      lines.push('- Capture all FINAL DECISIONS and wrap-up action items');
      lines.push('- Note any "next steps" or "follow-up" items mentioned');
      lines.push('- Identify items that were discussed but NOT resolved — these become blockers/waiting items');
    }
  }

  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════
//  Smart Boundary Overlap Detection
// ════════════════════════════════════════════════════════════

/**
 * Analyze the VTT content near segment boundaries to detect if a
 * conversation was cut mid-sentence or mid-topic. This helps Gemini
 * understand that continuity context is especially important.
 *
 * Returns a boundary context note to inject into the prompt, or null.
 *
 * @param {string} vttContent - Full VTT content
 * @param {number} segmentStartSec - This segment's start time (in call time)
 * @param {number} segmentEndSec - This segment's end time
 * @param {number} segmentIndex - 0-based segment index
 * @param {object} [previousAnalysis] - The analysis from the previous segment
 * @returns {string|null} Boundary context note or null
 */
function detectBoundaryContext(vttContent, segmentStartSec, segmentEndSec, segmentIndex, previousAnalysis) {
  if (segmentIndex === 0 || !vttContent) return null;

  const cues = parseVttCues(vttContent);
  if (cues.length === 0) return null;

  const notes = [];

  // Check if there's VTT content very near the start of the segment (within 5s)
  // This suggests the conversation was already ongoing when the segment started
  const earlyStartCues = cues.filter(c => c.startSec >= segmentStartSec && c.startSec < segmentStartSec + 5);
  if (earlyStartCues.length > 0) {
    notes.push('This segment starts MID-CONVERSATION — a discussion was already in progress.');
  }

  // Check if the last cue is near the end of the segment (within 3s of end)
  // This suggests the conversation continues into the next segment
  const lastCue = cues[cues.length - 1];
  if (lastCue && segmentEndSec - lastCue.endSec < 3) {
    notes.push('This segment ends MID-CONVERSATION — the discussion likely continues in the next segment.');
  }

  // If previous analysis exists, check for open topics
  if (previousAnalysis) {
    // Check for open tickets still being discussed
    const openTickets = (previousAnalysis.tickets || [])
      .filter(t => t.status === 'in_progress' || t.status === 'open');
    if (openTickets.length > 0) {
      const openIds = openTickets.map(t => t.ticket_id).join(', ');
      notes.push(`Previous segment had ${openTickets.length} open ticket(s) that may continue here: ${openIds}`);
    }

    // Check for unresolved blockers
    const openBlockers = (previousAnalysis.blockers || [])
      .filter(b => b.status === 'open');
    if (openBlockers.length > 0) {
      notes.push(`Previous segment had ${openBlockers.length} unresolved blocker(s) — check if they're addressed in this segment.`);
    }

    // Check if previous summary suggests ongoing discussion
    const prevSummary = previousAnalysis.summary || '';
    if (prevSummary.toLowerCase().includes('continu') || prevSummary.toLowerCase().includes('next') ||
        prevSummary.toLowerCase().includes('follow') || prevSummary.toLowerCase().includes('مستمر')) {
      notes.push('Previous segment\'s summary suggests topics carry over into this segment.');
    }
  }

  if (notes.length === 0) return null;

  return `SEGMENT BOUNDARY CONTEXT:\n${notes.map(n => `• ${n}`).join('\n')}\n→ Pay special attention to continuity — pick up where the previous segment left off. Do NOT re-extract items that were already captured in previous segments unless their status changed.`;
}

module.exports = {
  PRIORITY,
  estimateTokens,
  estimateDocTokens,
  classifyDocPriority,
  selectDocsByBudget,
  parseVttCues,
  sliceVttForSegment,
  buildProgressiveContext,
  buildSegmentFocus,
  detectBoundaryContext,
};
