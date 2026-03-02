/**
 * Shared renderer utilities — name clustering, deduplication, badge formatting.
 *
 * Extracted from markdown.js so both the Markdown and HTML renderers
 * share the same data normalisation logic.
 */

'use strict';

// ════════════════════════════════════════════════════════════
//  Name Clustering Utilities
// ════════════════════════════════════════════════════════════

/**
 * Strip parenthetical suffixes and normalize whitespace.
 * "Mohamed Elhadi (Service Desk)" → "Mohamed Elhadi"
 */
function stripParens(name) {
  return (name || '').replace(/\s*\([^)]*\)\s*/g, '').trim();
}

/**
 * Normalize a name to lowercase stripped form for comparison.
 */
function normalizeKey(name) {
  return stripParens(name).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Build a Map<canonicalName, Set<rawVariants>> from a list of raw name strings.
 * Clustering rules applied in order:
 *  1. Exact normalized match (case-insensitive, parens stripped)
 *  2. Substring containment after stripping
 *
 * The canonical name chosen is the longest proper-cased variant (no parens).
 */
function clusterNames(rawNames) {
  const clusters = new Map();
  const normToCluster = new Map();

  for (const raw of rawNames) {
    const stripped = stripParens(raw).trim();
    if (!stripped) continue;
    const nk = normalizeKey(raw);

    if (normToCluster.has(nk)) {
      const c = normToCluster.get(nk);
      c.variants.add(raw);
      if (stripped.length >= c.canonical.length && stripped[0] === stripped[0].toUpperCase()) {
        c.canonical = stripped;
      }
      continue;
    }

    let merged = false;
    for (const [existNk, c] of normToCluster) {
      // Only merge via substring if the shorter name is at least 5 chars
      // to prevent false merges (e.g. "Ed" matching "Jeddah Dev")
      const shorter = nk.length < existNk.length ? nk : existNk;
      if (shorter.length >= 5 && (existNk.includes(nk) || nk.includes(existNk))) {
        c.variants.add(raw);
        normToCluster.set(nk, c);
        if (stripped.length >= c.canonical.length && stripped[0] === stripped[0].toUpperCase()) {
          c.canonical = stripped;
        }
        merged = true;
        break;
      }
    }
    if (merged) continue;

    const cluster = { canonical: stripped[0] === stripped[0].toUpperCase() ? stripped : raw, variants: new Set([raw]) };
    clusters.set(nk, cluster);
    normToCluster.set(nk, cluster);
  }

  const result = new Map();
  for (const c of clusters.values()) {
    if (!result.has(c.canonical)) result.set(c.canonical, new Set());
    for (const v of c.variants) {
      result.get(c.canonical).add(v);
    }
  }
  return result;
}

/**
 * Given a raw name and a cluster map, return the canonical form.
 */
function resolve(name, clusterMap) {
  if (!name) return name;
  const nk = normalizeKey(name);
  for (const [canonical, variants] of clusterMap) {
    for (const v of variants) {
      if (normalizeKey(v) === nk) return canonical;
    }
    const cnk = normalizeKey(canonical);
    const shorter = nk.length < cnk.length ? nk : cnk;
    if (shorter.length >= 5 && (cnk.includes(nk) || nk.includes(cnk))) return canonical;
  }
  return stripParens(name).trim() || name;
}

// ════════════════════════════════════════════════════════════
//  Dedup Utilities
// ════════════════════════════════════════════════════════════

/** Deduplicate an array by a key function. First occurrence wins. */
function dedupBy(arr, keyFn) {
  const seen = new Map();
  const result = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (!k) { result.push(item); continue; }
    if (seen.has(k)) {
      const existing = seen.get(k);
      for (const [field, val] of Object.entries(item)) {
        if (val && !existing[field]) existing[field] = val;
      }
      continue;
    }
    seen.set(k, item);
    result.push(item);
  }
  return result;
}

/** Normalize a description for fuzzy matching. */
function normalizeDesc(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[\w\-./\\]+\/[\w\-./\\]+\.(cs|ts|js|json|html|resx|png|md)/g, m => {
      const parts = m.replace(/\\/g, '/').split('/');
      return parts[parts.length - 1];
    })
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Deduplicate by description text similarity. */
function dedupByDesc(arr, descField = 'description') {
  const seen = new Set();
  return arr.filter(item => {
    const key = normalizeDesc(item[descField]);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ════════════════════════════════════════════════════════════
//  Badge / Formatting Utilities
// ════════════════════════════════════════════════════════════

/** Format a timestamp string for display, optionally with segment number and video name. */
function fmtTs(ts, seg, video) {
  if (!ts) return '';
  if (seg && video) return `\`${ts}\` _(${shortVideo(video)} · Seg ${seg})_`;
  if (seg) return `\`${ts}\` _(Seg ${seg})_`;
  return `\`${ts}\``;
}

/** Shorten a video filename to a readable label. */
function shortVideo(name) {
  if (!name) return '';
  // Strip extension
  let s = name.replace(/\.[^.]+$/, '');
  // Truncate long names; keep first 30 chars + ellipsis
  if (s.length > 35) s = s.substring(0, 30) + '…';
  return s;
}

/** Make a compact priority badge */
function priBadge(p) {
  if (!p) return '';
  const icons = { high: '🔴', medium: '🟡', low: '🟢', critical: '🔴' };
  return ` ${icons[p] || '⚪'} \`${p}\``;
}

/** Make a compact confidence badge */
function confBadge(c) {
  if (!c) return '';
  const icons = { HIGH: '🟢', MEDIUM: '🟡', LOW: '🔴' };
  return ` ${icons[c] || '⚪'}\`${c}\``;
}

/** Make a confidence badge with reason tooltip */
function confBadgeFull(c, reason) {
  if (!c) return '';
  const icons = { HIGH: '🟢', MEDIUM: '🟡', LOW: '🔴' };
  const badge = `${icons[c] || '⚪'}\`${c}\``;
  if (reason) return ` ${badge} _(${reason})_`;
  return ` ${badge}`;
}

// ════════════════════════════════════════════════════════════
//  HTML-safe escaping
// ════════════════════════════════════════════════════════════

/** Escape a string for safe HTML insertion. */
function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  stripParens,
  normalizeKey,
  clusterNames,
  resolve,
  dedupBy,
  normalizeDesc,
  dedupByDesc,
  fmtTs,
  shortVideo,
  priBadge,
  confBadge,
  confBadgeFull,
  escHtml,
};
