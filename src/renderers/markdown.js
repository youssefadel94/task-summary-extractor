/**
 * Markdown renderer — generates action-focused Markdown from compiled results.
 *
 * Improvements over v1:
 *  - Name clustering: merges case variants, role-suffix variants, partial matches
 *  - ID-based dedup: every ticket, CR, blocker, scope-change, action-item appears ONCE
 *  - User-first layout: the current user's section is promoted to the top
 *  - Cleaner formatting: owned tickets inline, concise tables, no repeated content
 *
 * This renderer expects the FINAL COMPILED analysis (after AI compilation pass),
 * not raw per-segment data. It produces a single coherent task document.
 */

'use strict';

// Shared renderer utilities (name clustering, dedup, badges)
const {
  stripParens, normalizeKey, clusterNames, resolve,
  dedupBy, normalizeDesc, dedupByDesc,
  fmtTs, priBadge, confBadge, confBadgeFull, shortVideo,
} = require('./shared');

/**
 * Render the final compiled analysis into a comprehensive Markdown report.
 *
 * @param {object} options
 * @param {object} options.compiled - The AI-compiled unified analysis
 * @param {object} options.meta - Call metadata (enriched with compilation stats, segments, settings)
 * @returns {string} Markdown content
 */
function renderResultsMarkdown({ compiled, meta }) {
  const lines = [];
  const ln = (...args) => lines.push(args.join(''));
  const hr = () => ln('---');

  if (!compiled) {
    return '# Call Analysis\n\nNo compiled result available — AI compilation may have failed.\n';
  }

  // ── Extract & deduplicate all data ──
  const allTickets = dedupBy(compiled.tickets || [], t => t.ticket_id);
  const allCRs = dedupBy(compiled.change_requests || [], cr => cr.id);
  const allActions = dedupBy(compiled.action_items || [], ai => ai.id);
  const allBlockers = dedupBy(compiled.blockers || [], b => b.id);
  const allScope = dedupBy(compiled.scope_changes || [], sc => sc.id);
  const allFiles = dedupBy(compiled.file_references || [], f => f.resolved_path || f.file_name);
  const summary = compiled.summary || compiled.executive_summary || '';
  const yourTasks = compiled.your_tasks || null;

  // ── Discover & cluster participant names ──
  const rawNames = new Set();
  const addName = n => { if (n && n.trim()) rawNames.add(n.trim()); };

  allActions.forEach(ai => addName(ai.assigned_to));
  allCRs.forEach(cr => addName(cr.assigned_to));
  allBlockers.forEach(b => addName(b.owner));
  allScope.forEach(sc => addName(sc.decided_by));
  allTickets.forEach(t => { addName(t.assignee); addName(t.reviewer); });
  if (yourTasks?.user_name) addName(yourTasks.user_name);
  if (yourTasks) {
    (yourTasks.tasks_waiting_on_others || []).forEach(w => addName(w.waiting_on));
  }

  const clusterMap = clusterNames([...rawNames]);

  // Remove generic team references
  const teamKeywords = ['team', 'qa', 'dba', 'devops', 'db team', 'external'];
  const people = [...clusterMap.keys()]
    .filter(n => n && !teamKeywords.some(kw => n.toLowerCase() === kw))
    .sort();

  // Name matcher using cluster resolution
  const nameMatch = (raw, canonical) => {
    if (!raw || !canonical) return false;
    return resolve(raw, clusterMap) === canonical;
  };

  // Detect current user's canonical name
  const currentUserCanonical = meta.userName ? resolve(meta.userName, clusterMap) : null;

  // Put current user first, others after
  const orderedPeople = [];
  if (currentUserCanonical && people.includes(currentUserCanonical)) {
    orderedPeople.push(currentUserCanonical);
  }
  for (const p of people) {
    if (p !== currentUserCanonical) orderedPeople.push(p);
  }

  // ══════════════════════════════════════════════════════
  //  HEADER
  // ══════════════════════════════════════════════════════
  ln(`# 📋 Call Analysis — ${meta.callName || 'Unknown'}`);
  ln('');
  ln(`> **Date**: ${meta.processedAt ? meta.processedAt.slice(0, 10) : 'N/A'}  `);
  ln(`> **Participants**: ${orderedPeople.join(', ') || 'Unknown'}  `);
  ln(`> **Segments analyzed**: ${meta.segmentCount || 'N/A'}  `);
  ln(`> **Model**: ${meta.geminiModel || 'N/A'}  `);

  // Compilation stats
  const comp = meta.compilation;
  if (comp) {
    const tu = comp.tokenUsage || {};
    const durSec = comp.durationMs ? (comp.durationMs / 1000).toFixed(1) : '?';
    ln(`> **Compilation**: ${durSec}s | ${(tu.inputTokens || 0).toLocaleString()} input → ${(tu.outputTokens || 0).toLocaleString()} output tokens | thinking: ${(tu.thoughtTokens || 0).toLocaleString()}  `);
  }
  ln(`> **Compiled**: Yes — AI-merged final result`);

  // Cost summary
  const cost = meta.costSummary;
  if (cost && cost.totalTokens > 0) {
    ln(`> **Cost estimate**: $${cost.totalCost.toFixed(4)} (${cost.totalTokens.toLocaleString()} tokens | ${(cost.totalDurationMs / 1000).toFixed(1)}s AI time)  `);
  }
  ln('');

  // Confidence filter notice
  if (compiled._filterMeta && compiled._filterMeta.minConfidence !== 'LOW') {
    const fm = compiled._filterMeta;
    const levelLabel = fm.minConfidence === 'HIGH' ? 'HIGH' : 'MEDIUM and HIGH';
    ln(`> ⚠️ **Confidence filter active:** showing only ${levelLabel} confidence items.  `);
    ln(`> Kept ${fm.filteredCounts.total}/${fm.originalCounts.total} items (${fm.removed} removed). Full unfiltered data in \`results.json\`.  `);
    ln('');
  }

  // ── File Integrity Warnings ──
  const intWarnings = meta.integrityWarnings;
  if (intWarnings && intWarnings.length > 0) {
    ln('> ⚠️ **File Integrity Issues Detected**');
    ln('>');
    for (const w of intWarnings) {
      const icon = w.severity === 'error' ? '🔴' : w.severity === 'warning' ? '🟡' : 'ℹ️';
      ln(`> ${icon} **${w.file}** (${w.type}) — ${w.message}  `);
      if (w.detail) ln(`>   _${w.detail}_  `);
    }
    ln('>');
    const hasErrors = intWarnings.some(w => w.severity === 'error');
    if (hasErrors) {
      ln('> **Some files may be broken.** Results may be incomplete — re-download or replace broken files.  ');
    } else {
      ln('> Results may be affected — review flagged files for completeness.  ');
    }
    ln('');
  }

  // Segment breakdown (grouped by video)
  const segs = meta.segments || [];
  if (segs.length > 0) {
    // Group segments by video name
    const videoGroups = [];
    const videoOrder = [];
    const videoMap = {};
    for (const s of segs) {
      const key = s.video || 'Unknown';
      if (!videoMap[key]) {
        videoMap[key] = [];
        videoOrder.push(key);
      }
      videoMap[key].push(s);
    }
    for (const v of videoOrder) videoGroups.push({ video: v, segs: videoMap[v] });

    const multiVideo = videoGroups.length > 1;
    ln('<details>');
    ln(`<summary>📼 Segment Details (${segs.length} segments${multiVideo ? ` from ${videoGroups.length} videos` : ''})</summary>`);
    ln('');

    let globalIdx = 0;
    for (const group of videoGroups) {
      if (multiVideo) {
        ln(`**🎬 ${group.video}** (${group.segs.length} segments)`);
        ln('');
      }
      ln('| # | File | Duration | Size |');
      ln('| --- | --- | --- | --- |');
      for (const s of group.segs) {
        globalIdx++;
        ln(`| ${globalIdx} | ${s.file} | ${s.duration || '?'} | ${s.sizeMB || '?'} MB |`);
      }
      const groupDur = group.segs.reduce((sum, s) => sum + (s.durationSeconds || 0), 0);
      const groupSize = group.segs.reduce((sum, s) => sum + (parseFloat(s.sizeMB) || 0), 0);
      ln(`| | **Subtotal** | **${Math.floor(groupDur / 60)}:${String(Math.round(groupDur % 60)).padStart(2, '0')}** | **${groupSize.toFixed(2)} MB** |`);
      ln('');
    }

    if (multiVideo) {
      const totalDur = segs.reduce((sum, s) => sum + (s.durationSeconds || 0), 0);
      const totalSize = segs.reduce((sum, s) => sum + (parseFloat(s.sizeMB) || 0), 0);
      ln(`> **Overall Total**: ${segs.length} segments | **${Math.floor(totalDur / 60)}:${String(Math.round(totalDur % 60)).padStart(2, '0')}** | **${totalSize.toFixed(2)} MB**`);
      ln('');
    }

    if (meta.settings) {
      ln(`> Speed: ${meta.settings.speed}x | Preset: ${meta.settings.preset} | Segment time: ${meta.settings.segmentTimeSec}s`);
    }
    ln('</details>');
    ln('');
  }

  hr();
  ln('');

  // ══════════════════════════════════════════════════════
  //  CONFIDENCE DISTRIBUTION
  // ══════════════════════════════════════════════════════
  const allConfItems = [
    ...allTickets, ...allCRs, ...allActions, ...allBlockers, ...allScope,
  ];
  if (allConfItems.length > 0) {
    const confHigh = allConfItems.filter(i => i.confidence === 'HIGH').length;
    const confMed = allConfItems.filter(i => i.confidence === 'MEDIUM').length;
    const confLow = allConfItems.filter(i => i.confidence === 'LOW').length;
    const confMissing = allConfItems.length - confHigh - confMed - confLow;
    const confTotal = allConfItems.length;

    if (confHigh + confMed + confLow > 0) {
      ln('### 📊 Confidence Distribution');
      ln('');
      ln(`| Level | Count | % |`);
      ln(`| --- | --- | --- |`);
      if (confHigh > 0) ln(`| 🟢 HIGH | ${confHigh} | ${((confHigh / confTotal) * 100).toFixed(0)}% |`);
      if (confMed > 0) ln(`| 🟡 MEDIUM | ${confMed} | ${((confMed / confTotal) * 100).toFixed(0)}% |`);
      if (confLow > 0) ln(`| 🔴 LOW | ${confLow} | ${((confLow / confTotal) * 100).toFixed(0)}% |`);
      if (confMissing > 0) ln(`| ⚪ UNSET | ${confMissing} | ${((confMissing / confTotal) * 100).toFixed(0)}% |`);
      ln('');
      if (confLow > 0) {
        ln('> ⚠️ **LOW confidence items** need human verification before acting on them.');
        ln('');
      }
    }
  }

  // ══════════════════════════════════════════════════════
  //  EXECUTIVE SUMMARY
  // ══════════════════════════════════════════════════════
  ln('## 📝 Executive Summary');
  ln('');
  if (summary) ln(summary);
  ln('');

  // ══════════════════════════════════════════════════════
  //  COMPLETED IN CALL
  // ══════════════════════════════════════════════════════
  const completedInCall = yourTasks?.completed_in_call || [];
  if (completedInCall.length > 0) {
    ln('### ✅ Resolved During This Call');
    ln('');
    for (const item of completedInCall) {
      ln(`- ✅ ${item}`);
    }
    ln('');
  }

  hr();
  ln('');

  // ══════════════════════════════════════════════════════
  //  YOUR TASKS (current user — prominent top section)
  // ══════════════════════════════════════════════════════
  if (currentUserCanonical && yourTasks) {
    ln(`## ⭐ Your Tasks — ${currentUserCanonical}`);
    ln('');

    // Your overall summary
    if (yourTasks.summary) {
      ln(`> ${yourTasks.summary}`);
      ln('');
    }

    // Owned tickets (compact)
    const myTickets = dedupBy(
      allTickets.filter(t => nameMatch(t.assignee, currentUserCanonical)),
      t => t.ticket_id
    );
    if (myTickets.length > 0) {
      ln(`**🎫 Your Tickets**: ${myTickets.map(t => `${t.ticket_id} (${(t.status || '?').replace(/_/g, ' ')})`).join(' · ')}`);
      ln('');
    }

    // To-do items (merged from your_tasks.tasks_todo + action_items assigned to user)
    const todoItems = dedupByDesc(yourTasks.tasks_todo || []);
    const myActions = allActions.filter(ai =>
      nameMatch(ai.assigned_to, currentUserCanonical) &&
      (ai.status === 'todo' || ai.status === 'in_progress')
    );
    const allTodos = [...todoItems];
    // Add action items not already in todo list (fuzzy match to avoid near-duplicates)
    const todoDescKeys = new Set(allTodos.map(t => normalizeDesc(t.description)));
    for (const ai of myActions) {
      const dk = normalizeDesc(ai.description);
      if (!todoDescKeys.has(dk)) {
        allTodos.push(ai);
        todoDescKeys.add(dk);
      }
    }
    if (allTodos.length > 0) {
      ln('### 📌 To Do');
      ln('');
      for (const item of allTodos) {
        const pri = priBadge(item.priority);
        const conf = confBadge(item.confidence);
        const source = item.source ? ` _(${item.source})_` : '';
        const ts = item.referenced_at ? ` @ ${fmtTs(item.referenced_at, item.source_segment, item.source_video)}` : '';
        const blocker = item.blocked_by ? `\n  - ⛔ **Blocked by**: ${item.blocked_by}` : '';
        const relTickets = (item.related_tickets || []).length > 0 ? `\n  - Tickets: ${item.related_tickets.join(', ')}` : '';
        const relChanges = (item.related_changes || []).length > 0 ? `\n  - Changes: ${item.related_changes.join(', ')}` : '';
        ln(`- [ ] ${item.description}${pri}${conf}${source}${ts}${blocker}${relTickets}${relChanges}`);
      }
      ln('');
    }

    // CRs assigned to user
    const myCRs = dedupBy(
      allCRs.filter(cr => nameMatch(cr.assigned_to, currentUserCanonical) && cr.status !== 'completed'),
      cr => cr.id
    );
    if (myCRs.length > 0) {
      ln('### 🔧 Your Change Requests');
      ln('');
      for (const cr of myCRs) {
        const status = cr.status ? ` \`${cr.status}\`` : '';
        const pri = priBadge(cr.priority);
        const where = cr.where?.file_path ? ` → \`${cr.where.file_path}\`` : '';
        const ts = cr.referenced_at ? ` @ ${fmtTs(cr.referenced_at, cr.source_segment, cr.source_video)}` : '';
        const type = cr.type ? ` _[${cr.type}]_` : '';
        ln(`- **${cr.id}**: ${cr.title || cr.what}${status}${pri}${type}${where}${ts}`);
        if (cr.what && cr.what !== cr.title) ln(`  - **What**: ${cr.what}`);
        if (cr.how) ln(`  - **How**: ${cr.how}`);
        if (cr.why) ln(`  - **Why**: ${cr.why}`);
        if (cr.blocked_by) ln(`  - ⛔ **Blocked by**: ${cr.blocked_by}`);
        if (cr.code_map_match) ln(`  - Code map: \`${cr.code_map_match}\``);
        if ((cr.related_tickets || []).length > 0) ln(`  - Tickets: ${cr.related_tickets.join(', ')}`);
      }
      ln('');
    }

    // Waiting on others
    const waitingItems = dedupByDesc(yourTasks.tasks_waiting_on_others || []);
    if (waitingItems.length > 0) {
      ln('### ⏳ Waiting On Others');
      ln('');
      for (const w of waitingItems) {
        const resolvedWho = w.waiting_on ? resolve(w.waiting_on, clusterMap) : 'someone';
        const ts = w.referenced_at ? ` @ ${fmtTs(w.referenced_at, w.source_segment, w.source_video)}` : '';
        ln(`- ⏳ ${w.description} → waiting on **${resolvedWho}**${w.source ? ` _(${w.source})_` : ''}${ts}`);
      }
      ln('');
    }

    // Decisions needed
    const decisionItems = dedupByDesc(yourTasks.decisions_needed || []);
    if (decisionItems.length > 0) {
      ln('### ❓ Decisions Needed');
      ln('');
      for (const d of decisionItems) {
        const resolvedWho = d.from_whom ? resolve(d.from_whom, clusterMap) : 'someone';
        const ts = d.referenced_at ? ` @ ${fmtTs(d.referenced_at, d.source_segment, d.source_video)}` : '';
        ln(`- ${d.description} → from **${resolvedWho}**${d.source ? ` _(${d.source})_` : ''}${ts}`);
      }
      ln('');
    }

    // Blockers owned by user
    const myBlockers = dedupBy(
      allBlockers.filter(b => nameMatch(b.owner, currentUserCanonical)),
      b => b.id
    );
    if (myBlockers.length > 0) {
      ln('### 🚫 Your Blockers');
      ln('');
      for (const b of myBlockers) {
        const env = (b.environments || []).length > 0 ? ` [${b.environments.join(', ')}]` : '';
        const status = b.status ? ` (${b.status})` : '';
        const type = b.type ? ` _[${b.type.replace(/_/g, ' ')}]_` : '';
        const ts = b.referenced_at ? ` @ ${fmtTs(b.referenced_at, b.source_segment, b.source_video)}` : '';
        const bConf = confBadge(b.confidence);
        ln(`- **${b.id}**: ${b.description}${env}${status}${type}${bConf}${ts}`);
        if (b.blocks?.length > 0) ln(`  - Blocks: ${b.blocks.join(', ')}`);
        if (b.checklist_match) ln(`  - Checklist: ${b.checklist_match}`);
      }
      ln('');
    }

    hr();
    ln('');
  }

  // ══════════════════════════════════════════════════════
  //  DETAILED TICKET ANALYSIS
  // ══════════════════════════════════════════════════════
  if (allTickets.length > 0) {
    ln('## 🎫 Detailed Ticket Analysis');
    ln('');

    for (const t of allTickets) {
      const assignee = t.assignee ? resolve(t.assignee, clusterMap) : 'Unassigned';
      const reviewer = t.reviewer ? resolve(t.reviewer, clusterMap) : null;
      const status = (t.status || 'unknown').replace(/_/g, ' ');

      const tConf = confBadge(t.confidence);
      ln(`### ${t.ticket_id} — ${t.title || 'Untitled'}${tConf}`);
      ln('');
      ln(`> **Status**: ${status} | **Assignee**: ${assignee}${reviewer ? ` | **Reviewer**: ${reviewer}` : ''}`);
      if (t.confidence_reason) ln(`> **Confidence**: ${t.confidence} — ${t.confidence_reason}`);
      ln('');

      // Documented state
      const ds = t.documented_state;
      if (ds) {
        ln('#### 📄 Documented State');
        ln('');
        if (ds.source) ln(`- **Source**: \`${ds.source}\``);
        if (ds.plan_status) ln(`- **Plan Status**: ${ds.plan_status}`);
        if (ds.checklist_progress) ln(`- **Checklist**: ${ds.checklist_progress}`);

        // Sub-tickets
        if (ds.sub_tickets && ds.sub_tickets.length > 0) {
          ln('- **Sub-tickets**:');
          for (const st of ds.sub_tickets) {
            ln(`  - **${st.id}** ${st.title} — ${st.documented_status || '?'}`);
          }
        }

        // Open blockers from docs
        if (ds.open_blockers && ds.open_blockers.length > 0) {
          ln('- **Documented Blockers**:');
          for (const ob of ds.open_blockers) {
            ln(`  - ⚠️ ${ob}`);
          }
        }
        ln('');
      }

      // Discussed state (what happened in the call)
      const disc = t.discussed_state;
      if (disc) {
        ln('#### 💬 Discussed in Call');
        ln('');
        if (disc.summary) ln(disc.summary);
        ln('');

        // Discrepancies between docs and call
        if (disc.discrepancies && disc.discrepancies.length > 0) {
          ln('**⚡ Discrepancies (docs vs. call)**:');
          ln('');
          for (const d of disc.discrepancies) {
            ln(`- ⚡ ${d}`);
          }
          ln('');
        }
      }

      // Video segments (timestamps)
      const vs = t.video_segments || [];
      if (vs.length > 0) {
        ln('#### 🎬 Video Segments');
        ln('');
        for (const seg of vs) {
          const start = seg.start_time || '?';
          const end = seg.end_time || '?';
          const segLabel = seg.source_segment ? ` _(Seg ${seg.source_segment})_` : '';
          ln(`- \`${start}\` → \`${end}\`${segLabel}: ${seg.description}`);
        }
        ln('');
      }

      // Key comments (with timestamps and speakers)
      const comments = t.comments || [];
      if (comments.length > 0) {
        ln('#### 🗣️ Key Quotes');
        ln('');
        for (const c of comments) {
          const speaker = c.speaker ? resolve(c.speaker, clusterMap) : 'Unknown';
          const ts = c.timestamp ? `\`${c.timestamp}\`` : '';
          const segLabel = c.source_segment ? ` _(Seg ${c.source_segment})_` : '';
          ln(`- ${ts}${segLabel} **${speaker}**: "${c.text}"`);
        }
        ln('');
      }

      // Code changes
      const codeChanges = t.code_changes || [];
      if (codeChanges.length > 0) {
        ln('#### 💻 Code Changes');
        ln('');
        for (const cc of codeChanges) {
          const type = cc.type ? `[${cc.type}]` : '';
          const pri = priBadge(cc.priority);
          const ts = cc.referenced_at ? ` @ ${fmtTs(cc.referenced_at, cc.source_segment, cc.source_video)}` : '';
          ln(`- ${type} \`${cc.file_path || '?'}\`${pri}${ts}`);
          ln(`  - ${cc.description}`);
          if (cc.details && cc.details !== cc.description) {
            ln(`  - Details: ${cc.details}`);
          }
        }
        ln('');
      }

      // Related CRs for this ticket
      const ticketCRs = allCRs.filter(cr => (cr.related_tickets || []).includes(t.ticket_id));
      if (ticketCRs.length > 0) {
        ln(`#### 🔗 Change Requests for ${t.ticket_id}`);
        ln('');
        for (const cr of ticketCRs) {
          const status = cr.status ? ` \`${cr.status}\`` : '';
          const assignee = cr.assigned_to ? resolve(cr.assigned_to, clusterMap) : '?';
          const ts = cr.referenced_at ? ` @ ${fmtTs(cr.referenced_at, cr.source_segment, cr.source_video)}` : '';
          ln(`- **${cr.id}**: ${cr.title || cr.what}${status} → ${assignee}${ts}`);
          if (cr.what && cr.what !== cr.title) ln(`  - What: ${cr.what}`);
          if (cr.how) ln(`  - How: ${cr.how}`);
          if (cr.why) ln(`  - Why: ${cr.why}`);
          if (cr.where?.file_path) ln(`  - File: \`${cr.where.file_path}\``);
        }
        ln('');
      }

      // Related blockers for this ticket
      const ticketBlockers = allBlockers.filter(b => (b.blocks || []).includes(t.ticket_id));
      if (ticketBlockers.length > 0) {
        ln(`#### 🚫 Blockers for ${t.ticket_id}`);
        ln('');
        for (const b of ticketBlockers) {
          const env = (b.environments || []).length > 0 ? ` [${b.environments.join(', ')}]` : '';
          const status = b.status ? ` (${b.status})` : '';
          const owner = b.owner ? ` → ${resolve(b.owner, clusterMap)}` : '';
          const ts = b.referenced_at ? ` @ ${fmtTs(b.referenced_at, b.source_segment, b.source_video)}` : '';
          ln(`- **${b.id}**: ${b.description}${env}${status}${owner}${ts}`);
        }
        ln('');
      }

      hr();
      ln('');
    }
  }

  // ══════════════════════════════════════════════════════
  //  ALL ACTION ITEMS (full detail table)
  // ══════════════════════════════════════════════════════
  if (allActions.length > 0) {
    ln('## 📋 All Action Items');
    ln('');
    ln('| ID | Description | Assigned To | Status | Priority | Conf | Ref | Timestamp |');
    ln('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const ai of allActions) {
      const assignee = ai.assigned_to ? resolve(ai.assigned_to, clusterMap) : '-';
      const status = (ai.status || '?').replace(/_/g, ' ');
      const pri = ai.priority || '-';
      const conf = ai.confidence || '-';
      const confIcon = { HIGH: '🟢', MEDIUM: '🟡', LOW: '🔴' }[conf] || '';
      const ref = [...(ai.related_tickets || []), ...(ai.related_changes || [])].join(', ') || '-';
      const ts = ai.referenced_at || '-';
      const seg = ai.source_segment ? `Seg ${ai.source_segment}` : '';
      const dep = ai.depends_on ? ` ⛔ ${ai.depends_on}` : '';
      const check = ai.checklist_match ? ` ✓${ai.checklist_match}` : '';
      ln(`| ${ai.id} | ${ai.description}${dep}${check} | ${assignee} | ${status} | ${pri} | ${confIcon}${conf} | ${ref} | ${ts} ${seg} |`);
    }
    ln('');
  }

  // ══════════════════════════════════════════════════════
  //  OTHER PARTICIPANTS
  // ══════════════════════════════════════════════════════
  const otherPeople = orderedPeople.filter(p => p !== currentUserCanonical);
  if (otherPeople.length > 0) {
    ln('## 👥 Other Participants');
    ln('');

    for (const person of otherPeople) {
      const personActions = allActions.filter(ai => nameMatch(ai.assigned_to, person));
      const personCRs = dedupBy(
        allCRs.filter(cr => nameMatch(cr.assigned_to, person) && cr.status !== 'completed'),
        cr => cr.id
      );
      const personBlockersOwned = dedupBy(
        allBlockers.filter(b => nameMatch(b.owner, person)),
        b => b.id
      );
      const personTickets = dedupBy(
        allTickets.filter(t => nameMatch(t.assignee, person)),
        t => t.ticket_id
      );

      // Check if person has anything
      const hasContent = personActions.length > 0 || personCRs.length > 0 ||
        personBlockersOwned.length > 0 || personTickets.length > 0;

      if (!hasContent) continue;

      ln(`### ${person}`);
      ln('');

      // Owned tickets (inline)
      if (personTickets.length > 0) {
        ln(`**🎫 Tickets**: ${personTickets.map(t => `${t.ticket_id} (${(t.status || '?').replace(/_/g, ' ')})`).join(' · ')}`);
        ln('');
      }

      // Action items
      const actionableTodos = dedupByDesc(
        personActions.filter(ai => ai.status === 'todo' || ai.status === 'in_progress')
      );
      if (actionableTodos.length > 0) {
        ln('**📌 To Do**');
        ln('');
        for (const item of actionableTodos) {
          const pri = priBadge(item.priority);
          const ts = item.referenced_at ? ` @ ${fmtTs(item.referenced_at, item.source_segment, item.source_video)}` : '';
          const ref = (item.related_tickets || []).length > 0 ? ` _(${item.related_tickets.join(', ')})_` : '';
          const dep = item.depends_on ? ` ⛔ blocked by: ${item.depends_on}` : '';
          ln(`- [ ] ${item.description}${pri}${ref}${ts}${dep}`);
        }
        ln('');
      }

      // Change requests
      if (personCRs.length > 0) {
        ln('**🔧 Change Requests**');
        ln('');
        for (const cr of personCRs) {
          const status = cr.status ? ` \`${cr.status}\`` : '';
          const pri = priBadge(cr.priority);
          const where = cr.where?.file_path ? ` → \`${cr.where.file_path}\`` : '';
          const ts = cr.referenced_at ? ` @ ${fmtTs(cr.referenced_at, cr.source_segment, cr.source_video)}` : '';
          ln(`- **${cr.id}**: ${cr.title || cr.what}${status}${pri}${where}${ts}`);
          if (cr.what && cr.what !== cr.title) ln(`  - What: ${cr.what}`);
          if (cr.how) ln(`  - How: ${cr.how}`);
          if (cr.why) ln(`  - Why: ${cr.why}`);
        }
        ln('');
      }

      // Blockers
      if (personBlockersOwned.length > 0) {
        ln('**🚫 Blockers**');
        ln('');
        for (const b of personBlockersOwned) {
          const env = (b.environments || []).length > 0 ? ` [${b.environments.join(', ')}]` : '';
          const status = b.status ? ` (${b.status})` : '';
          const type = b.type ? ` _[${b.type.replace(/_/g, ' ')}]_` : '';
          const ts = b.referenced_at ? ` @ ${fmtTs(b.referenced_at, b.source_segment, b.source_video)}` : '';
          ln(`- **${b.id}**: ${b.description}${env}${status}${type}${ts}`);

          if (b.blocks?.length > 0) ln(`  - Blocks: ${b.blocks.join(', ')}`);
        }
        ln('');
      }

      hr();
      ln('');
    }
  }

  // ══════════════════════════════════════════════════════
  //  TEAM / EXTERNAL BLOCKERS
  // ══════════════════════════════════════════════════════
  const teamBlockers = dedupBy(
    allBlockers.filter(b => !orderedPeople.some(p => nameMatch(b.owner, p))),
    b => b.id
  );
  if (teamBlockers.length > 0) {
    ln('## 🚫 Team / External Blockers');
    ln('');
    for (const b of teamBlockers) {
      const env = (b.environments || []).length > 0 ? ` [${b.environments.join(', ')}]` : '';
      const status = b.status ? ` (${b.status})` : '';
      const type = b.type ? ` _[${b.type.replace(/_/g, ' ')}]_` : '';
      const ts = b.referenced_at ? ` @ ${fmtTs(b.referenced_at, b.source_segment, b.source_video)}` : '';
      const check = b.checklist_match ? ` ✓${b.checklist_match}` : '';
      ln(`- **${b.id}** (${b.owner || 'unassigned'}): ${b.description}${env}${status}${type}${ts}${check}`);
      if (b.blocks?.length > 0) ln(`  - Blocks: ${b.blocks.join(', ')}`);
    }
    ln('');
    hr();
    ln('');
  }

  // ══════════════════════════════════════════════════════
  //  SCOPE CHANGES
  // ══════════════════════════════════════════════════════
  if (allScope.length > 0) {
    ln('## 🔀 Scope Changes');
    ln('');
    for (const sc of allScope) {
      const icon = { added: '➕', removed: '➖', deferred: '⏸️', approach_changed: '🔄', ownership_changed: '👤', requirements_changed: '📋' }[sc.type] || '🔀';
      const decidedBy = sc.decided_by ? resolve(sc.decided_by, clusterMap) : null;
      const ts = sc.referenced_at ? ` @ ${fmtTs(sc.referenced_at, sc.source_segment, sc.source_video)}` : '';
      const scConf = confBadge(sc.confidence);
      ln(`- ${icon} **${sc.id}** (${(sc.type || '').replace(/_/g, ' ')}): ${sc.new_scope}${scConf}${ts}`);
      if (sc.original_scope && sc.original_scope !== 'not documented') {
        ln(`  - **Was**: ${sc.original_scope}`);
      }
      if (sc.reason) ln(`  - **Reason**: ${sc.reason}`);
      if (decidedBy) ln(`  - **Decided by**: ${decidedBy}`);
      if (sc.impact) ln(`  - **Impact**: \`${sc.impact}\``);
      if ((sc.related_tickets || []).length > 0) ln(`  - **Tickets**: ${sc.related_tickets.join(', ')}`);
    }
    ln('');
    hr();
    ln('');
  }

  // ══════════════════════════════════════════════════════
  //  ALL CHANGE REQUESTS (complete table)
  // ══════════════════════════════════════════════════════
  if (allCRs.length > 0) {
    ln('## 🔧 All Change Requests');
    ln('');
    ln('| ID | Title | Type | Status | Priority | Conf | Assignee | File | Timestamp |');
    ln('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const cr of allCRs) {
      const assignee = cr.assigned_to ? resolve(cr.assigned_to, clusterMap) : '-';
      const status = cr.status || '-';
      const pri = cr.priority || '-';
      const conf = cr.confidence || '-';
      const confIcon = { HIGH: '🟢', MEDIUM: '🟡', LOW: '🔴' }[conf] || '';
      const type = cr.type || '-';
      const file = cr.where?.file_path ? `\`${cr.where.file_path}\`` : '-';
      const ts = cr.referenced_at || '-';
      const seg = cr.source_segment ? (cr.source_video ? `${shortVideo(cr.source_video)} · Seg ${cr.source_segment}` : `Seg ${cr.source_segment}`) : '';
      ln(`| ${cr.id} | ${cr.title || cr.what || '-'} | ${type} | ${status} | ${pri} | ${confIcon}${conf} | ${assignee} | ${file} | ${ts} ${seg} |`);
    }
    ln('');

    // Detailed breakdown in collapsible
    ln('<details>');
    ln('<summary>📖 Change Request Details</summary>');
    ln('');
    for (const cr of allCRs) {
      const assignee = cr.assigned_to ? resolve(cr.assigned_to, clusterMap) : '?';
      const status = cr.status ? ` \`${cr.status}\`` : '';
      const ts = cr.referenced_at ? ` @ ${fmtTs(cr.referenced_at, cr.source_segment, cr.source_video)}` : '';
      ln(`**${cr.id}**: ${cr.title || cr.what}${status} → ${assignee}${ts}`);
      if (cr.what && cr.what !== cr.title) ln(`- What: ${cr.what}`);
      if (cr.how) ln(`- How: ${cr.how}`);
      if (cr.why) ln(`- Why: ${cr.why}`);
      if (cr.where?.file_path) ln(`- File: \`${cr.where.file_path}\` (${cr.where.module || '?'}/${cr.where.component || '?'})`);

      if (cr.code_map_match) ln(`- Code map: \`${cr.code_map_match}\``);
      if ((cr.related_tickets || []).length > 0) ln(`- Tickets: ${cr.related_tickets.join(', ')}`);
      ln('');
    }
    ln('</details>');
    ln('');
    hr();
    ln('');
  }

  // ══════════════════════════════════════════════════════
  //  FILE REFERENCES (complete — not just actionable)
  // ══════════════════════════════════════════════════════
  if (allFiles.length > 0) {
    // Split into actionable and reference-only
    const actionableFiles = allFiles.filter(f => f.role && !['reference_only', 'source_of_truth'].includes(f.role));
    const referenceFiles = allFiles.filter(f => !f.role || ['reference_only', 'source_of_truth'].includes(f.role));

    if (actionableFiles.length > 0) {
      ln('## 📂 Files Requiring Action');
      ln('');
      ln('| File | Role | Type | Tickets | Changes | Path |');
      ln('| --- | --- | --- | --- | --- | --- |');
      for (const f of actionableFiles) {
        const role = (f.role || '').replace(/_/g, ' ');
        const type = (f.file_type || '').replace(/_/g, ' ');
        const tickets = (f.mentioned_in_tickets || []).join(', ') || '-';
        const changes = (f.mentioned_in_changes || []).join(', ') || '-';
        const fpath = f.resolved_path || '-';
        ln(`| ${f.file_name} | ${role} | ${type} | ${tickets} | ${changes} | \`${fpath}\` |`);
      }
      ln('');
    }

    if (referenceFiles.length > 0) {
      ln('<details>');
      ln(`<summary>📎 Reference Files (${referenceFiles.length} files — not requiring changes)</summary>`);
      ln('');
      ln('| File | Type | Tickets | Context Doc | Notes |');
      ln('| --- | --- | --- | --- | --- |');
      for (const f of referenceFiles) {
        const type = (f.file_type || '').replace(/_/g, ' ');
        const tickets = (f.mentioned_in_tickets || []).join(', ') || '-';
        const ctxDoc = f.context_doc_match || '-';
        const notes = f.notes ? f.notes.slice(0, 80) + (f.notes.length > 80 ? '...' : '') : '-';
        ln(`| ${f.file_name} | ${type} | ${tickets} | ${ctxDoc} | ${notes} |`);
      }
      ln('');
      ln('</details>');
      ln('');
    }
  }

  // ── Footer ──
  hr();
  ln('');
  const genTs = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const stats = [];
  stats.push(`${allTickets.length} tickets`);
  stats.push(`${allCRs.length} change requests`);
  stats.push(`${allActions.length} action items`);
  stats.push(`${allBlockers.length} blockers`);
  stats.push(`${allScope.length} scope changes`);
  stats.push(`${allFiles.length} file references`);
  ln(`_Generated ${genTs} — AI-compiled final result | ${stats.join(' · ')}_`);
  ln('');

  return lines.join('\n');
}

/**
 * Legacy renderer — renders from the raw results object (merges all segment analyses).
 * Applies ID-based dedup before rendering to reduce duplicates from naive flat merge.
 * Kept for backward compatibility. Use renderResultsMarkdown() for new code.
 */
function renderResultsMarkdownLegacy(results) {
  // Collect all analyses across all files/segments
  const allAnalyses = [];
  for (const file of (results.files || [])) {
    for (const seg of (file.segments || [])) {
      if (seg.analysis && !seg.analysis.error) {
        allAnalyses.push({ seg: seg.segmentFile, ...seg.analysis });
      }
    }
  }

  if (allAnalyses.length === 0) {
    return '# Call Analysis\n\nNo segments were successfully analyzed.\n';
  }

  // Merge all data — dedup applied at render time via dedupBy
  const merged = {
    tickets: allAnalyses.flatMap(a => a.tickets || []),
    change_requests: allAnalyses.flatMap(a => a.change_requests || []),
    action_items: allAnalyses.flatMap(a => a.action_items || []),
    blockers: allAnalyses.flatMap(a => a.blockers || []),
    scope_changes: allAnalyses.flatMap(a => a.scope_changes || []),
    file_references: allAnalyses.flatMap(a => a.file_references || []),
    summary: allAnalyses.map(a => a.summary).filter(Boolean).pop() || '',
    your_tasks: allAnalyses.map(a => a.your_tasks).filter(Boolean).pop() || null,
  };

  const segmentCount = allAnalyses.length;

  return renderResultsMarkdown({
    compiled: merged,
    meta: {
      callName: results.callName,
      processedAt: results.processedAt,
      geminiModel: results.settings?.geminiModel,
      userName: results.userName,
      segmentCount,
    },
  });
}

module.exports = { renderResultsMarkdown, renderResultsMarkdownLegacy };
