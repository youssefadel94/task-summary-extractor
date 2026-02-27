/**
 * Change Detector — correlates git changes and document updates with
 * items from a previous call analysis.
 *
 * Uses multiple matching strategies:
 *  1. File path matching — git changed files vs. analysis file_references/code_changes
 *  2. ID matching — ticket/CR IDs in commit messages
 *  3. Keyword matching — semantic overlap between item descriptions and commit messages
 *  4. Document change detection — mtime comparison for docs in the call folder
 *
 * Produces a unified change report consumed by progress-updater.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  isGitAvailable,
  findGitRoot,
  getCommitsWithFiles,
  getChangedFilesSince,
  getDiffSummary,
  getWorkingTreeChanges,
  getCurrentBranch,
  normPath,
} = require('../services/git');

// ======================== STOP WORDS ========================

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'to', 'of',
  'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about',
  'and', 'but', 'or', 'not', 'no', 'nor', 'so', 'if', 'then', 'than',
  'that', 'this', 'these', 'those', 'it', 'its', 'we', 'our', 'they',
  'them', 'he', 'she', 'his', 'her', 'you', 'your', 'i', 'my', 'me',
  'string', 'null', 'true', 'false', 'new', 'each', 'all', 'any',
  'add', 'use', 'get', 'set', 'make', 'update', 'change', 'fix',
]);

// ======================== ITEM EXTRACTION ========================

/**
 * Extract all trackable items from a compiled analysis into a flat list
 * with searchable metadata.
 *
 * @param {object} analysis - Compiled analysis
 * @returns {Array<{id: string, type: string, title: string, description: string, keywords: string[], fileRefs: string[]}>}
 */
function extractTrackableItems(analysis) {
  if (!analysis) return [];

  const items = [];

  // Tickets
  for (const t of (analysis.tickets || [])) {
    const fileRefs = [];
    for (const cc of (t.code_changes || [])) {
      if (cc.file_path) fileRefs.push(normPath(cc.file_path));
    }
    items.push({
      id: t.ticket_id || t.id || `ticket_${items.length}`,
      type: 'ticket',
      title: t.title || '',
      description: t.discussed_state?.summary || t.description || '',
      status: t.status || 'unknown',
      assignee: t.assignee || null,
      keywords: extractKeywords(`${t.title || ''} ${t.discussed_state?.summary || ''} ${t.description || ''}`),
      fileRefs,
      confidence: t.confidence || null,
    });
  }

  // Change requests
  for (const cr of (analysis.change_requests || [])) {
    const fileRefs = [];
    if (cr.where?.file_path) fileRefs.push(normPath(cr.where.file_path));
    items.push({
      id: cr.id || `cr_${items.length}`,
      type: 'change_request',
      title: cr.title || '',
      description: cr.what || cr.description || '',
      status: cr.status || 'unknown',
      assignee: cr.assigned_to || null,
      keywords: extractKeywords(`${cr.title || ''} ${cr.what || ''} ${cr.how || ''} ${cr.where?.component || ''}`),
      fileRefs,
      confidence: cr.confidence || null,
    });
  }

  // Action items
  for (const ai of (analysis.action_items || [])) {
    items.push({
      id: ai.id || `ai_${items.length}`,
      type: 'action_item',
      title: ai.description || '',
      description: ai.description || '',
      status: ai.status || 'unknown',
      assignee: ai.assigned_to || null,
      keywords: extractKeywords(ai.description || ''),
      fileRefs: [],
      confidence: ai.confidence || null,
    });
  }

  // Blockers
  for (const b of (analysis.blockers || [])) {
    items.push({
      id: b.id || `blk_${items.length}`,
      type: 'blocker',
      title: b.description || '',
      description: b.description || '',
      status: b.status || 'open',
      assignee: b.owner || null,
      keywords: extractKeywords(b.description || ''),
      fileRefs: [],
      confidence: b.confidence || null,
    });
  }

  // Scope changes
  for (const sc of (analysis.scope_changes || [])) {
    items.push({
      id: sc.id || `sc_${items.length}`,
      type: 'scope_change',
      title: sc.new_scope || sc.description || '',
      description: `${sc.original_scope || ''} → ${sc.new_scope || ''}`,
      status: 'noted',
      assignee: sc.decided_by || null,
      keywords: extractKeywords(`${sc.original_scope || ''} ${sc.new_scope || ''}`),
      fileRefs: [],
      confidence: sc.confidence || null,
    });
  }

  // File references — add to existing items' fileRefs
  for (const fr of (analysis.file_references || [])) {
    if (fr.resolved_path) {
      const normRef = normPath(fr.resolved_path);
      // Attach to related tickets
      for (const tid of (fr.mentioned_in_tickets || [])) {
        const item = items.find(i => i.id === tid);
        if (item && !item.fileRefs.includes(normRef)) {
          item.fileRefs.push(normRef);
        }
      }
      // Attach to related CRs
      for (const cid of (fr.mentioned_in_changes || [])) {
        const item = items.find(i => i.id === cid);
        if (item && !item.fileRefs.includes(normRef)) {
          item.fileRefs.push(normRef);
        }
      }
    }
  }

  return items;
}

/**
 * Extract meaningful keywords from text.
 * Removes stop words, splits on word boundaries, lowercases.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractKeywords(text) {
  if (!text) return [];
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\-_.\/\\]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
  return [...new Set(words)];
}

// ======================== CORRELATION ENGINE ========================

/**
 * Match analysis items against git changes using multiple strategies.
 *
 * @param {Array} items - From extractTrackableItems()
 * @param {object} gitData - { commits, changedFiles, workingChanges }
 * @returns {Map<string, object>} Map of itemId → correlation data
 */
function correlateItemsWithChanges(items, gitData) {
  const { commits, changedFiles, workingChanges } = gitData;

  // Build searchable indexes
  const allChangedPaths = new Set(changedFiles.map(f => f.path));
  const workingPaths = new Set((workingChanges || []).map(f => f.path));
  const allCommitMessages = commits.map(c => c.message.toLowerCase());
  const allCommitText = commits.map(c => `${c.message} ${(c.files || []).join(' ')}`).join(' ').toLowerCase();

  const correlations = new Map();

  for (const item of items) {
    const evidence = [];
    let score = 0;

    // Strategy 1: File path matching
    for (const ref of item.fileRefs) {
      const refBase = path.basename(ref).toLowerCase();
      const refNorm = ref.toLowerCase();

      for (const changed of changedFiles) {
        const changedNorm = changed.path.toLowerCase();
        const changedBase = path.basename(changed.path).toLowerCase();

        // Exact path match or suffix match
        if (changedNorm === refNorm || changedNorm.endsWith(refNorm) || refNorm.endsWith(changedNorm)) {
          score += 0.4;
          evidence.push({
            type: 'file_match',
            detail: `${changed.path} (${changed.status}, touched ${changed.changes}x)`,
            confidence: 'high',
          });
        } else if (refBase === changedBase) {
          // Same filename, different path
          score += 0.2;
          evidence.push({
            type: 'file_name_match',
            detail: `${changed.path} — same filename as referenced ${ref}`,
            confidence: 'medium',
          });
        }
      }

      // Also check working tree
      if (workingPaths.has(ref.toLowerCase()) || [...workingPaths].some(p => p.endsWith(refBase))) {
        score += 0.1;
        evidence.push({
          type: 'working_tree',
          detail: `${ref} has uncommitted changes`,
          confidence: 'medium',
        });
      }
    }

    // Strategy 2: ID matching in commit messages
    const itemIdPattern = item.id.replace(/[-_]/g, '[-_\\s]?');
    const idRegex = new RegExp(itemIdPattern, 'i');
    for (const commit of commits) {
      if (idRegex.test(commit.message)) {
        score += 0.5;
        evidence.push({
          type: 'id_in_commit',
          detail: `Commit ${commit.hash}: "${commit.message}"`,
          confidence: 'high',
        });
      }
    }

    // Strategy 3: Keyword matching in commits
    const matchedKeywords = [];
    for (const kw of item.keywords) {
      if (kw.length < 4) continue; // skip very short keywords
      if (allCommitText.includes(kw)) {
        matchedKeywords.push(kw);
      }
    }
    if (matchedKeywords.length > 0) {
      const kwScore = Math.min(0.3, matchedKeywords.length * 0.05);
      score += kwScore;
      evidence.push({
        type: 'keyword_match',
        detail: `Keywords found in commits: ${matchedKeywords.slice(0, 8).join(', ')}`,
        confidence: matchedKeywords.length >= 3 ? 'medium' : 'low',
      });
    }

    // Strategy 4: Per-commit file overlap
    for (const commit of commits) {
      if (!commit.files) continue;
      const overlapFiles = item.fileRefs.filter(ref => {
        const refLower = ref.toLowerCase();
        return commit.files.some(f => f.toLowerCase().endsWith(refLower) || refLower.endsWith(f.toLowerCase()));
      });
      if (overlapFiles.length > 0 && !evidence.some(e => e.type === 'id_in_commit' && e.detail.includes(commit.hash))) {
        score += 0.15;
        evidence.push({
          type: 'commit_file_overlap',
          detail: `Commit ${commit.hash}: "${commit.message}" touches ${overlapFiles.length} referenced file(s)`,
          confidence: 'medium',
        });
      }
    }

    // Clamp score to [0, 1]
    score = Math.min(1.0, score);

    correlations.set(item.id, {
      itemId: item.id,
      itemType: item.type,
      score,
      evidence,
      localAssessment: score >= 0.6 ? 'DONE' : score >= 0.25 ? 'IN_PROGRESS' : 'NOT_STARTED',
      localConfidence: score >= 0.6 ? 'MEDIUM' : score >= 0.25 ? 'LOW' : 'LOW',
    });
  }

  return correlations;
}

// ======================== DOCUMENT CHANGES ========================

/**
 * Detect document changes in the call folder since the analysis timestamp.
 * Checks file modification times against sinceTimestamp.
 *
 * @param {string} callDir - The call folder path
 * @param {string} sinceISO - ISO timestamp of the previous analysis
 * @returns {Array<{path: string, relPath: string, modified: string, status: string}>}
 */
function detectDocumentChanges(callDir, sinceISO) {
  const sinceMs = new Date(sinceISO).getTime();
  if (isNaN(sinceMs)) return [];

  const docExts = new Set(['.md', '.txt', '.vtt', '.srt', '.csv', '.json', '.pdf', '.docx']);
  const skipDirs = new Set(['node_modules', '.git', 'compressed', 'runs', 'gemini_runs', 'logs']);
  const changes = [];

  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }

    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }

      if (stat.isDirectory()) {
        if (!skipDirs.has(entry)) walk(full);
      } else if (stat.isFile() && docExts.has(path.extname(entry).toLowerCase())) {
        const mtime = stat.mtimeMs;
        if (mtime > sinceMs) {
          changes.push({
            path: full,
            relPath: path.relative(callDir, full),
            modified: new Date(mtime).toISOString(),
            status: 'modified',
          });
        }
      }
    }
  }

  walk(callDir);
  return changes;
}

// ======================== MAIN DETECTION ========================

/**
 * Run full change detection — git + documents.
 *
 * @param {object} opts
 * @param {string} [opts.repoPath] - Git repo path (auto-detected if not provided)
 * @param {string} opts.callDir - Call folder path
 * @param {string} opts.sinceISO - Timestamp of the previous analysis
 * @param {object} opts.analysis - The compiled analysis to check progress for
 * @returns {object} Change report
 */
function detectAllChanges({ repoPath, callDir, sinceISO, analysis }) {
  const report = {
    timestamp: new Date().toISOString(),
    sinceTimestamp: sinceISO,
    git: {
      available: false,
      repoPath: null,
      branch: null,
      commits: [],
      changedFiles: [],
      workingChanges: [],
      summary: 'Git not available',
    },
    documents: {
      changes: [],
    },
    items: [],
    correlations: new Map(),
    totals: {
      commits: 0,
      filesChanged: 0,
      docsChanged: 0,
      itemsWithMatches: 0,
      itemsWithoutMatches: 0,
    },
  };

  // --- Extract trackable items from analysis ---
  report.items = extractTrackableItems(analysis);

  // --- Git change detection ---
  if (isGitAvailable()) {
    // Resolve repo path: explicit > callDir > cwd
    let resolvedRepo = repoPath ? findGitRoot(path.resolve(repoPath)) : null;
    if (!resolvedRepo) resolvedRepo = findGitRoot(callDir);
    if (!resolvedRepo) resolvedRepo = findGitRoot(process.cwd());

    if (resolvedRepo) {
      report.git.available = true;
      report.git.repoPath = resolvedRepo;
      report.git.branch = getCurrentBranch(resolvedRepo);
      report.git.commits = getCommitsWithFiles(resolvedRepo, sinceISO, 100);
      report.git.changedFiles = getChangedFilesSince(resolvedRepo, sinceISO);
      report.git.workingChanges = getWorkingTreeChanges(resolvedRepo);
      report.git.summary = getDiffSummary(resolvedRepo, sinceISO);

      report.totals.commits = report.git.commits.length;
      report.totals.filesChanged = report.git.changedFiles.length;
    } else {
      report.git.summary = 'No git repository found';
    }
  }

  // --- Document change detection ---
  report.documents.changes = detectDocumentChanges(callDir, sinceISO);
  report.totals.docsChanged = report.documents.changes.length;

  // --- Correlate items with changes ---
  if (report.git.available && report.git.commits.length > 0) {
    report.correlations = correlateItemsWithChanges(report.items, report.git);
  }

  // --- Compute totals ---
  let withMatches = 0;
  let withoutMatches = 0;
  for (const item of report.items) {
    const corr = report.correlations.get(item.id);
    if (corr && corr.score > 0.1) {
      withMatches++;
    } else {
      withoutMatches++;
    }
  }
  report.totals.itemsWithMatches = withMatches;
  report.totals.itemsWithoutMatches = withoutMatches;

  return report;
}

/**
 * Serialize a change report for JSON output.
 * Converts the correlations Map to a plain object.
 *
 * @param {object} report - From detectAllChanges()
 * @returns {object} JSON-serializable report
 */
function serializeReport(report) {
  return {
    ...report,
    correlations: Object.fromEntries(report.correlations),
  };
}

module.exports = {
  detectAllChanges,
  serializeReport,
  extractTrackableItems,
  extractKeywords,
  correlateItemsWithChanges,
  detectDocumentChanges,
};
