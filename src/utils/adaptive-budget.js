/**
 * Adaptive Thinking Budget — dynamically scales Gemini thinking tokens
 * based on segment complexity analysis.
 *
 * Factors considered:
 *  - Segment position in call (later segments need more cross-referencing)
 *  - VTT transcript density (more dialogue = more complex)
 *  - Context document count and relevance
 *  - Previous analysis density (accumulated ticket/CR count)
 *  - Segment boundary context (mid-conversation segments need more thought)
 *
 * Returns exact thinking budget per segment rather than using a flat value.
 */

'use strict';

const config = require('../config');

// ======================== BUDGET RANGES ========================

const BUDGET = {
  /** Absolute minimum thinking budget */
  MIN: 8192,
  /** Base thinking budget for a simple segment */
  BASE: 16384,
  /** Maximum thinking budget per segment — dynamically read from model config */
  get MAX() { return config.getMaxThinkingBudget(); },
  /** Base compilation thinking budget */
  COMPILATION_BASE: 10240,
  /** Max compilation thinking budget — dynamically read from model config */
  get COMPILATION_MAX() { return config.getMaxThinkingBudget(); },
};

// ======================== COMPLEXITY ANALYSIS ========================

/**
 * Analyze VTT/transcript content to estimate segment complexity.
 *
 * @param {string} vttContent - Raw VTT/SRT transcript text
 * @returns {{ speakerCount: number, cueCount: number, wordCount: number,
 *            hasTechnicalTerms: boolean, hasCodeReferences: boolean,
 *            topicDensity: number, complexityScore: number }}
 */
function analyzeTranscriptComplexity(vttContent) {
  if (!vttContent || typeof vttContent !== 'string') {
    return {
      speakerCount: 0, cueCount: 0, wordCount: 0,
      hasTechnicalTerms: false, hasCodeReferences: false,
      topicDensity: 0, complexityScore: 0,
    };
  }

  const lines = vttContent.split('\n');

  // Count cues (lines with timestamps)
  const cueCount = lines.filter(l => /\d{2}:\d{2}/.test(l)).length;

  // Extract text lines (non-timestamp, non-empty, non-WEBVTT header)
  const textLines = lines.filter(l => {
    const t = l.trim();
    return t && !t.startsWith('WEBVTT') && !t.startsWith('NOTE') &&
      !/^\d+$/.test(t) && !/-->/.test(t);
  });
  const fullText = textLines.join(' ');
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;

  // Detect speakers (name prefixes like "Mohamed Elhadi: " or "<v Mohamed>")
  const speakerPatterns = new Set();
  for (const line of textLines) {
    // WebVTT voice tags: <v Name>
    const voiceMatch = line.match(/<v\s+([^>]+)>/);
    if (voiceMatch) speakerPatterns.add(voiceMatch[1].toLowerCase().trim());
    // Colon-separated speakers: "Name: text"
    const colonMatch = line.match(/^([A-Z][a-zA-Z\s]{2,30}):\s/);
    if (colonMatch) speakerPatterns.add(colonMatch[1].toLowerCase().trim());
  }
  const speakerCount = speakerPatterns.size;

  // Detect technical terms
  const techPatterns = /\b(API|backend|frontend|endpoint|database|migration|deploy|merge|branch|commit|sprint|bug|regression|hotfix|release|staging|production|microservice|dockerfile|kubernetes|nginx|redis|elasticsearch|JWT|OAuth|CORS|webhook|CI\/CD|pipeline|schema|query|index|enum|interface|repository)\b/gi;
  const techMatchCount = (fullText.match(techPatterns) || []).length;
  const hasTechnicalTerms = techMatchCount > 3;

  // Detect code/file references
  const codePatterns = /\b([A-Z][a-z]+(?:Service|Controller|Repository|Component|Module|Factory|Provider|Handler|Middleware|DTO|Entity|Model|Mapper|Resolver|Guard|Interceptor|Filter|Pipe|Directive))\b|\b(\.cs|\.ts|\.js|\.html|\.scss|\.json|\.yaml|\.xml)\b|[a-zA-Z]+\.[a-zA-Z]+\.[a-zA-Z]+/g;
  const codeMatchCount = (fullText.match(codePatterns) || []).length;
  const hasCodeReferences = codeMatchCount > 2;

  // Topic density: rough estimate of distinct topics via keyword clustering
  const ticketPatterns = /\b(CR\s*\d+|ticket\s*#?\d+|bug\s*#?\d+|task\s*#?\d+|item\s*#?\d+|issue\s*#?\d+)\b/gi;
  const ticketMentions = (fullText.match(ticketPatterns) || []).length;

  // Complexity score (0-100)
  let complexityScore = 20; // base

  // Word count factor: more words = more complex
  if (wordCount > 2000) complexityScore += 20;
  else if (wordCount > 1000) complexityScore += 10;
  else if (wordCount > 500) complexityScore += 5;

  // Speaker count: more speakers = more complex
  if (speakerCount >= 4) complexityScore += 15;
  else if (speakerCount >= 2) complexityScore += 8;

  // Technical density
  if (hasTechnicalTerms) complexityScore += 10;
  if (hasCodeReferences) complexityScore += 10;

  // Ticket mentions
  if (ticketMentions >= 5) complexityScore += 15;
  else if (ticketMentions >= 2) complexityScore += 8;
  else if (ticketMentions >= 1) complexityScore += 3;

  // Cue density (more cues = more conversation = more complex)
  if (cueCount > 100) complexityScore += 10;
  else if (cueCount > 50) complexityScore += 5;

  return {
    speakerCount,
    cueCount,
    wordCount,
    hasTechnicalTerms,
    hasCodeReferences,
    topicDensity: ticketMentions,
    complexityScore: Math.min(100, complexityScore),
  };
}

/**
 * Calculate thinking budget for a segment based on multiple complexity factors.
 *
 * @param {object} params
 * @param {number} params.segmentIndex - 0-based segment index
 * @param {number} params.totalSegments - Total number of segments
 * @param {Array}  params.previousAnalyses - All prior segment analyses
 * @param {Array}  params.contextDocs - Available context documents
 * @param {string} [params.vttContent] - VTT transcript content for this segment
 * @param {number} [params.baseBudget] - Override base budget from config
 * @returns {{ budget: number, reason: string, complexity: object }}
 */
function calculateThinkingBudget(params) {
  const {
    segmentIndex = 0,
    totalSegments = 1,
    previousAnalyses = [],
    contextDocs = [],
    vttContent = '',
    baseBudget = BUDGET.BASE,
  } = params;

  let budget = baseBudget;
  const reasons = [];

  // 1. Segment position scaling — later segments accumulate more cross-references
  const positionRatio = totalSegments > 1 ? segmentIndex / (totalSegments - 1) : 0;
  const positionBoost = Math.round(positionRatio * 6144); // up to +6K for last segment
  if (positionBoost > 0) {
    budget += positionBoost;
    reasons.push(`+${positionBoost} position (seg ${segmentIndex + 1}/${totalSegments})`);
  }

  // 2. Previous analysis density — more accumulated items = more cross-referencing needed
  let totalItems = 0;
  for (const prev of previousAnalyses) {
    totalItems += (prev.tickets?.length || 0);
    totalItems += (prev.action_items?.length || 0);
    totalItems += (prev.change_requests?.length || 0);
    totalItems += (prev.blockers?.length || 0);
  }
  if (totalItems > 20) {
    const crossRefBoost = Math.min(4096, Math.round(totalItems * 100));
    budget += crossRefBoost;
    reasons.push(`+${crossRefBoost} cross-ref (${totalItems} accumulated items)`);
  } else if (totalItems > 8) {
    const crossRefBoost = Math.min(2048, Math.round(totalItems * 80));
    budget += crossRefBoost;
    reasons.push(`+${crossRefBoost} cross-ref (${totalItems} items)`);
  }

  // 3. Context document complexity
  const docCount = contextDocs.length;
  if (docCount > 5) {
    const docBoost = Math.min(3072, docCount * 256);
    budget += docBoost;
    reasons.push(`+${docBoost} docs (${docCount} context docs)`);
  }

  // 4. Transcript complexity analysis
  const txComplexity = analyzeTranscriptComplexity(vttContent);
  if (txComplexity.complexityScore > 60) {
    const txBoost = Math.round((txComplexity.complexityScore - 40) * 80);
    budget += txBoost;
    reasons.push(`+${txBoost} transcript (complexity: ${txComplexity.complexityScore}/100)`);
  } else if (txComplexity.complexityScore > 30) {
    const txBoost = Math.round((txComplexity.complexityScore - 30) * 40);
    budget += txBoost;
    reasons.push(`+${txBoost} transcript (complexity: ${txComplexity.complexityScore}/100)`);
  }

  // 5. First segment bonus — the first segment sets the context foundation
  if (segmentIndex === 0 && totalSegments > 1) {
    budget += 2048;
    reasons.push('+2048 first-segment foundation');
  }

  // Clamp
  budget = Math.max(BUDGET.MIN, Math.min(BUDGET.MAX, budget));

  return {
    budget,
    reason: reasons.length > 0 ? reasons.join(', ') : 'base budget',
    complexity: txComplexity,
  };
}

/**
 * Calculate compilation thinking budget based on total analysis size.
 *
 * @param {Array} allSegmentAnalyses - All segment analyses to compile
 * @param {number} [baseBudget] - Override base
 * @returns {{ budget: number, reason: string }}
 */
function calculateCompilationBudget(allSegmentAnalyses, baseBudget = BUDGET.COMPILATION_BASE) {
  let budget = baseBudget;
  const reasons = [];

  // Scale with segment count
  const segCount = allSegmentAnalyses.length;
  if (segCount > 4) {
    const segBoost = Math.min(8192, (segCount - 4) * 2048);
    budget += segBoost;
    reasons.push(`+${segBoost} segments (${segCount} to compile)`);
  }

  // Scale with total item count
  let totalItems = 0;
  for (const analysis of allSegmentAnalyses) {
    totalItems += (analysis.tickets?.length || 0);
    totalItems += (analysis.action_items?.length || 0);
    totalItems += (analysis.change_requests?.length || 0);
    totalItems += (analysis.blockers?.length || 0);
    totalItems += (analysis.scope_changes?.length || 0);
  }
  if (totalItems > 30) {
    const itemBoost = Math.min(6144, Math.round(totalItems * 100));
    budget += itemBoost;
    reasons.push(`+${itemBoost} items (${totalItems} total to dedup)`);
  } else if (totalItems > 10) {
    const itemBoost = Math.min(3072, Math.round(totalItems * 80));
    budget += itemBoost;
    reasons.push(`+${itemBoost} items (${totalItems} total)`);
  }

  // Clamp
  budget = Math.max(BUDGET.COMPILATION_BASE, Math.min(BUDGET.COMPILATION_MAX, budget));

  return {
    budget,
    reason: reasons.length > 0 ? reasons.join(', ') : 'base budget',
  };
}

module.exports = {
  calculateThinkingBudget,
  calculateCompilationBudget,
};
