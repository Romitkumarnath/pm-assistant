require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ADO_PAT = process.env.ADO_PAT;
const ORG = 'Findlaw';
const PROJECT = 'FindLawADO';

// Requested scope: Lawyer Directory + Front End (user phrasing: "frontend and backend")
const AREA_PATHS = [
  'FindLawADO\\Lawyer Directory',
  'FindLawADO\\Front End',
  'FindLawADO\\PALS'
];
const ITERATION_PATH_PREFIX = '';
const SEED_WORK_ITEM_IDS = [
  243325,
  243327,
  244939,
  228126,
  245184,
  243584,
  243585
];
const RELATION_TRAVERSAL_DEPTH = 4;

const CLOSED_STATES = ['Closed', 'Done', 'Removed', 'Cut'];

if (!ADO_PAT) {
  console.error('Missing ADO_PAT in .env');
  process.exit(1);
}

const BASE = `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit`;
const AUTH = Buffer.from(':' + ADO_PAT).toString('base64');
const HEADERS = { Authorization: 'Basic ' + AUTH };

function escWiql(value) {
  return String(value).replace(/'/g, "''");
}

function stripHtml(input) {
  return String(input || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function toDays(fromIso, toIso) {
  const from = new Date(fromIso);
  const to = new Date(toIso || new Date());
  const ms = to - from;
  if (Number.isNaN(ms) || ms < 0) return 0;
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function areaClause(areaPaths) {
  const parts = areaPaths.map(function(a) {
    const safe = escWiql(a);
    return `([System.AreaPath] = '${safe}' OR [System.AreaPath] UNDER '${safe}')`;
  });
  return parts.join(' OR ');
}

function collectIterationNodes(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.path && typeof node.id === 'number') {
    out.push({ id: node.id, path: String(node.path).replace(/^\\+/, '') });
  }
  const children = Array.isArray(node.children) ? node.children : [];
  children.forEach(function(child) { collectIterationNodes(child, out); });
}

function wildcardToRegex(pattern) {
  const escaped = String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$', 'i');
}

function iterationCandidatePatterns(pattern) {
  const p = String(pattern || '');
  const out = [p];
  const root = PROJECT + '\\';
  if (p.startsWith(root) && !p.startsWith(root + 'Iteration\\')) {
    out.push(p.replace(root, root + 'Iteration\\'));
  }
  return Array.from(new Set(out));
}

async function resolveIterationIdsByPrefix(pathPrefix) {
  const url = `${BASE}/classificationnodes/iterations?$depth=10&api-version=7.0`;
  const res = await axios.get(url, { headers: HEADERS });
  const nodes = [];
  collectIterationNodes(res.data, nodes);
  const patterns = iterationCandidatePatterns(pathPrefix).map(wildcardToRegex);
  return nodes
    .filter(function(n) { return patterns.some(function(rx) { return rx.test(n.path); }); })
    .map(function(n) { return n.id; });
}

function iterationIdClause(iterationIds) {
  if (!iterationIds.length) return '(1 = 0)';
  return `[System.IterationId] IN (${iterationIds.join(', ')})`;
}

async function runWiql(query) {
  const url = `${BASE}/wiql?api-version=7.0`;
  const res = await axios.post(url, { query }, {
    headers: { ...HEADERS, 'Content-Type': 'application/json' }
  });
  return (res.data.workItems || []).map(function(w) { return w.id; });
}

async function fetchWorkItems(ids, includeRelations) {
  if (!ids.length) return [];
  const fields = [
    'System.Id',
    'System.Title',
    'System.State',
    'System.WorkItemType',
    'System.AreaPath',
    'System.AssignedTo',
    'System.CreatedDate',
    'System.ChangedDate',
    'System.Tags',
    'System.Description',
    'System.IterationPath',
    'System.Parent'
  ].join(',');
  const all = [];
  const batchSize = 200;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize).join(',');
    const url = includeRelations
      ? `${BASE}/workitems?ids=${batch}&$expand=relations&api-version=7.0`
      : `${BASE}/workitems?ids=${batch}&fields=${fields}&api-version=7.0`;
    const res = await axios.get(url, { headers: HEADERS });
    all.push(...(res.data.value || []));
  }
  return all.map(function(item) {
    const f = item.fields || {};
    const relationParent = (item.relations || []).find(function(r) {
      return r.rel === 'System.LinkTypes.Hierarchy-Reverse';
    });
    const relationParentId = relationParent ? Number(String(relationParent.url).split('/').pop()) : null;
    const parentId = Number(f['System.Parent']) || relationParentId || null;
    return {
      id: item.id,
      title: f['System.Title'] || '',
      state: f['System.State'] || '',
      type: f['System.WorkItemType'] || '',
      areaPath: f['System.AreaPath'] || '',
      iterationPath: f['System.IterationPath'] || '',
      assignee: (f['System.AssignedTo'] && f['System.AssignedTo'].displayName) || null,
      createdDate: f['System.CreatedDate'] || '',
      changedDate: f['System.ChangedDate'] || '',
      tags: f['System.Tags'] || '',
      description: stripHtml(f['System.Description'] || ''),
      parentId: parentId,
      relations: item.relations || []
    };
  });
}

async function fetchComments(workItemId) {
  const url = `${BASE}/workitems/${workItemId}/comments?api-version=7.0-preview.3`;
  try {
    const res = await axios.get(url, { headers: HEADERS });
    return (res.data.comments || []).map(function(c) {
      return {
        author: c.createdBy ? c.createdBy.displayName : 'Unknown',
        createdDate: c.createdDate,
        text: stripHtml(c.text || '')
      };
    });
  } catch (_) {
    return [];
  }
}

async function fetchUpdates(workItemId) {
  const url = `${BASE}/workitems/${workItemId}/updates?api-version=7.0`;
  try {
    const res = await axios.get(url, { headers: HEADERS });
    return res.data.value || [];
  } catch (_) {
    return [];
  }
}

function findUnassignedStartDate(item, updates) {
  // If assigned now, not unassigned.
  if (item.assignee) return null;

  // Track last time assignment changed to unassigned.
  let unassignedStart = null;
  updates.forEach(function(u) {
    const fields = u.fields || {};
    const assigneeChange = fields['System.AssignedTo'];
    if (!assigneeChange) return;
    const newValue = assigneeChange.newValue;
    const becameUnassigned =
      newValue == null ||
      (typeof newValue === 'string' && newValue.trim() === '') ||
      (typeof newValue === 'object' && !newValue.displayName);
    if (becameUnassigned) {
      unassignedStart = u.revisedDate || unassignedStart;
    }
  });
  return unassignedStart || item.createdDate;
}

function findOpenStartDate(item) {
  return item.createdDate || null;
}

function getStream(areaPath) {
  return areaPath.includes('\\Front End') ? 'Frontend' : 'Backend';
}

function isUnderArea(areaPath, basePath) {
  return areaPath === basePath || areaPath.startsWith(basePath + '\\');
}

function isLawyersDirectoryArea(areaPath) {
  return (
    isUnderArea(areaPath, 'FindLawADO\\Lawyer Directory') ||
    isUnderArea(areaPath, 'FindLawADO\\Front End')
  );
}

function isQaAutomationItem(item) {
  const corpus = [
    item.title || '',
    item.areaPath || '',
    item.tags || '',
    item.description || ''
  ].join(' ').toLowerCase();
  return /\bqa automation\b/.test(corpus);
}

function isTestCaseType(item) {
  return String(item.type || '').toLowerCase() === 'test case';
}

function extractRelationIds(item) {
  const rels = Array.isArray(item.relations) ? item.relations : [];
  return rels
    .map(function(r) {
      const id = Number(String((r && r.url) || '').split('/').pop());
      return Number.isFinite(id) ? id : null;
    })
    .filter(Boolean);
}

function hasRelationToIdSet(item, byId, idSet) {
  if (idSet.has(item.id)) return true;

  const relationIds = extractRelationIds(item);
  if (relationIds.some(function(id) { return idSet.has(id); })) {
    return true;
  }

  // Walk parent chain (System.Parent ancestry).
  let cursorId = item.parentId;
  let safety = 0;
  while (cursorId && safety < 20) {
    if (idSet.has(cursorId)) return true;
    const parent = byId[cursorId];
    cursorId = parent ? parent.parentId : null;
    safety += 1;
  }

  return false;
}

async function buildRelationClosure(seedIds, byId, maxDepth) {
  const closure = new Set(seedIds);
  let frontier = Array.from(new Set(seedIds));
  let depth = 0;

  while (frontier.length && depth < maxDepth) {
    const missing = frontier.filter(function(id) { return !byId[id]; });
    if (missing.length) {
      const fetched = await fetchWorkItems(missing, true);
      fetched.forEach(function(item) { byId[item.id] = item; });
    }

    const next = new Set();
    frontier.forEach(function(id) {
      const item = byId[id];
      if (!item) return;

      const neighbors = extractRelationIds(item);
      if (item.parentId) neighbors.push(item.parentId);

      neighbors.forEach(function(neighborId) {
        if (!closure.has(neighborId)) {
          closure.add(neighborId);
          next.add(neighborId);
        }
      });
    });

    frontier = Array.from(next);
    depth += 1;
  }

  return closure;
}

const REQUESTED_GROUPS = [
  {
    label: 'FindLawADO\\PALS\\Super Lawyers',
    match: function(i) { return isUnderArea(i.areaPath, 'FindLawADO\\PALS\\Super Lawyers'); }
  },
  {
    label: 'FindLawADO\\PALS',
    match: function(i) { return isUnderArea(i.areaPath, 'FindLawADO\\PALS'); }
  },
  {
    label: 'Lawyers Directory Frontend',
    match: function(i) { return i.stream === 'Frontend'; }
  },
  {
    label: 'Lawyers Directory Backend',
    match: function(i) { return i.stream === 'Backend'; }
  },
  {
    label: 'FindLawADO\\Lawyer Directory\\ProfileUpdate',
    match: function(i) { return isUnderArea(i.areaPath, 'FindLawADO\\Lawyer Directory\\ProfileUpdate'); }
  },
  {
    label: 'FindLawADO\\Front End',
    match: function(i) { return isUnderArea(i.areaPath, 'FindLawADO\\Front End'); }
  }
];

function getAreaRoot(areaPath) {
  const match = AREA_PATHS.find(function(a) {
    return areaPath === a || areaPath.startsWith(a + '\\');
  });
  return match || 'Other';
}

function groupBy(items, keyFn) {
  return items.reduce(function(acc, item) {
    const k = keyFn(item);
    if (!acc[k]) acc[k] = [];
    acc[k].push(item);
    return acc;
  }, {});
}

function labelWorkItem(item) {
  if (!item) return 'No Parent';
  return `#${item.id} [${item.type || 'Unknown'}] ${item.title || '(Untitled)'}`;
}

function firstInLineageByType(lineage, typeList) {
  return lineage.find(function(x) {
    return typeList.includes((x.type || '').toLowerCase());
  }) || null;
}

function renderHierarchy(lines, list) {
  if (!list.length) {
    lines.push('- None');
    lines.push('');
    return;
  }

  const byParent = groupBy(list, function(i) { return i.parentKey; });
  Object.keys(byParent)
    .sort(function(a, b) {
      return (byParent[b] || []).length - (byParent[a] || []).length;
    })
    .forEach(function(parentKey) {
      const parentItems = byParent[parentKey] || [];
      const parentLabel = parentItems[0].parentLabel;
      lines.push(`#### Parent: ${parentLabel}`);
      lines.push(`- Total items under parent: ${parentItems.length}`);
      lines.push('');

      const byFeature = groupBy(parentItems, function(i) { return i.featureKey; });
      Object.keys(byFeature).forEach(function(featureKey) {
        const featureItems = byFeature[featureKey] || [];
        const featureLabel = featureItems[0].featureLabel;
        lines.push(`- Feature: ${featureLabel}`);

        const byStory = groupBy(featureItems, function(i) { return i.storyKey; });
        Object.keys(byStory).forEach(function(storyKey) {
          const storyItems = byStory[storyKey] || [];
          const storyLabel = storyItems[0].storyLabel;
          lines.push(`  - Story: ${storyLabel}`);
          lines.push(`  - Items: ${storyItems.length}`);

          storyItems
            .slice()
            .sort(function(a, b) {
              if (b.openDays !== a.openDays) {
                return b.openDays - a.openDays;
              }
              return new Date(b.changedDate) - new Date(a.changedDate);
            })
            .forEach(function(i) {
              lines.push(`    - #${i.id} ${i.title}`);
              lines.push(`      - About: ${i.about}`);
              lines.push(`      - Area: ${i.areaPath || 'N/A'}`);
              lines.push(`      - State: ${i.state}`);
              lines.push(`      - Assignee: ${i.assignee || 'Unassigned'}`);
              lines.push(`      - Days open: ${i.openDays}`);
              lines.push(`      - MVP: ${i.mvp}`);
              lines.push(`      - Risk from comments: ${i.risk.level} — ${i.risk.summary}`);
              lines.push(`      - Iteration: ${i.iterationPath || 'N/A'}`);
              lines.push('');
            });
        });
        lines.push('');
      });
      lines.push('');
    });
}

function buildNonOverlappingGroupMap(items, groups) {
  const assigned = new Set();
  const out = {};
  groups.forEach(function(group) {
    const list = items.filter(function(item) {
      if (assigned.has(item.id)) return false;
      if (!group.match(item)) return false;
      assigned.add(item.id);
      return true;
    });
    out[group.label] = list;
  });
  return out;
}

function mvpStatus(item, comments) {
  const corpus = [
    item.title,
    item.tags,
    item.description,
    comments.map(function(c) { return c.text; }).join(' ')
  ].join(' ').toLowerCase();

  if (/\bnon[-\s]?mvp\b/.test(corpus) || /\bnot\s+mvp\b/.test(corpus)) return 'Non-MVP';
  if (/\bmvp\b/.test(corpus)) return 'MVP';
  return 'Not specified';
}

function summarizeBug(item) {
  const title = String(item.title || '').trim();
  const desc = String(item.description || '').replace(/\s+/g, ' ').trim();

  if (!desc) return title || '(No summary available)';

  const firstSentence = (desc.match(/(.+?[.!?])(?:\s|$)/) || [])[1] || desc;
  const cleanedSentence = firstSentence.replace(/\s+/g, ' ').trim();

  // Pull a simple module cue from title tags like [QA][Profile Bundling].
  const bracketTags = (title.match(/\[[^\]]+\]/g) || [])
    .map(function(t) { return t.replace(/[\[\]]/g, '').trim(); })
    .filter(Boolean);
  const moduleCue = bracketTags.length ? bracketTags.join(' / ') : null;

  const base = cleanedSentence;

  if (!moduleCue) return base;
  return `${base} (Module: ${moduleCue})`;
}

function riskFromComments(comments) {
  if (!comments.length) {
    return { level: 'Low', summary: 'No discussion in comments; no explicit delivery risk captured.' };
  }

  const text = comments.map(function(c) { return c.text; }).join(' ').toLowerCase();
  const highPatterns = [
    /blocked|blocker|outage|production down|critical/,
    /waiting on|depends on|dependency|pending external/,
    /cannot reproduce|unknown root cause|intermittent/
  ];
  const mediumPatterns = [
    /qa failed|test failed|re-open|reopened|needs retest/,
    /scope change|unclear requirement|needs clarification/
  ];

  let level = 'Low';
  if (highPatterns.some(function(r) { return r.test(text); })) level = 'High';
  else if (mediumPatterns.some(function(r) { return r.test(text); })) level = 'Medium';

  const keyLine = comments
    .map(function(c) { return c.text; })
    .find(function(line) {
      return /(block|risk|wait|depend|failed|re-open|clarif|mvp|scope)/i.test(line);
    });

  return {
    level: level,
    summary: keyLine ? keyLine.slice(0, 220) : 'No explicit blocker/dependency called out in comments.'
  };
}

function renderReport(items) {
  const nowIso = new Date().toISOString();
  const frontend = items.filter(function(i) { return i.stream === 'Frontend'; });
  const backend = items.filter(function(i) { return i.stream === 'Backend'; });
  const unassigned = items.filter(function(i) { return !i.assignee; });

  const lines = [];
  lines.push('# Lawyer Directory Open Related Tickets Report');
  lines.push('');
  lines.push(`Generated: ${nowIso}`);
  lines.push(`Organization: ${ORG}`);
  lines.push(`Project: ${PROJECT}`);
  lines.push(`Scope area paths: ${AREA_PATHS.join(', ')}`);
  lines.push(`Iteration filter: ${ITERATION_PATH_PREFIX || 'None'}`);
  lines.push(`Relation filter seed IDs: ${SEED_WORK_ITEM_IDS.join(', ')}`);
  lines.push('');
  lines.push('## Executive Summary');
  lines.push(`- Total open related tickets in scope: **${items.length}**`);
  lines.push(`- Frontend open tickets: **${frontend.length}**`);
  lines.push(`- Backend open tickets: **${backend.length}**`);
  lines.push(`- Unassigned open tickets: **${unassigned.length}**`);
  lines.push('- Action signal: unassigned tickets should be triaged and assigned to an owner.');
  lines.push('');

  lines.push('## Unassigned Tickets (Needs Owner)');
  if (!unassigned.length) {
    lines.push('- None');
  } else {
    unassigned
      .sort(function(a, b) { return b.openDays - a.openDays; })
      .forEach(function(i) {
        lines.push(`- #${i.id} [${i.stream}] [${i.type}] ${i.title} | State: ${i.state} | MVP: ${i.mvp} | Days open: **${i.openDays}**`);
      });
  }
  lines.push('');

  lines.push('## Detailed Ticket Summary');
  lines.push('');
  lines.push('Grouping: Requested Group -> Parent -> Feature -> Story -> Items');
  lines.push('Note: groups are non-overlapping; each bug appears only once based on the group order below.');
  lines.push('');
  const grouped = buildNonOverlappingGroupMap(items, REQUESTED_GROUPS);
  REQUESTED_GROUPS.forEach(function(group) {
    const list = grouped[group.label] || [];
    lines.push(`### ${group.label}`);
    lines.push(`- Total items: ${list.length}`);
    lines.push('');
    renderHierarchy(lines, list);
  });

  return lines.join('\n');
}

function renderEmailDraft(items) {
  const unassigned = items.filter(function(i) { return !i.assignee; }).length;
  const highRisk = items.filter(function(i) { return i.risk.level === 'High'; }).length;
  return [
    'Subject: Lawyer Directory Open Related Tickets Report (Frontend + Backend)',
    '',
    'Team,',
    '',
    'Attached is the latest open related tickets report for Lawyer Directory (Frontend + Backend).',
    '',
    `- Total open related tickets: ${items.length}`,
    `- Unassigned tickets: ${unassigned}`,
    `- High-risk tickets from comment signals: ${highRisk}`,
    '',
    'The report includes:',
    '- what each bug is about,',
    '- assignment status and days open,',
    '- MVP signal when mentioned in ticket/comments,',
    '- risk callouts derived from comment discussions.',
    '',
    'Please prioritize assigning unowned bugs and confirm risk/blocked items in triage.',
    '',
    'Thanks'
  ].join('\n');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function groupByMvpThenIteration(items) {
  const out = {
    MVP: {},
    'Non-MVP': {},
    'Not specified': {}
  };
  items.forEach(function(item) {
    const mvp = out[item.mvp] ? item.mvp : 'Not specified';
    const iteration = item.iterationPath || 'No Iteration';
    if (!out[mvp][iteration]) out[mvp][iteration] = [];
    out[mvp][iteration].push(item);
  });
  return out;
}

function renderHtmlReport(items) {
  const grouped = groupByMvpThenIteration(items);
  const mvpColors = {
    MVP: '#14532d',
    'Non-MVP': '#7f1d1d',
    'Not specified': '#334155'
  };

  const cards = Object.keys(grouped).map(function(mvpKey) {
    const iterations = grouped[mvpKey];
    const total = Object.values(iterations).reduce(function(sum, arr) { return sum + arr.length; }, 0);
    const iterBlocks = Object.keys(iterations).sort().map(function(iteration) {
      const rows = iterations[iteration]
        .slice()
        .sort(function(a, b) { return new Date(b.changedDate) - new Date(a.changedDate); })
        .map(function(i) {
          const riskColor = i.risk.level === 'High' ? '#b91c1c' : (i.risk.level === 'Medium' ? '#b45309' : '#166534');
          return `
            <tr>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb;">#${i.id}</td>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(i.type)}</td>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(i.title)}</td>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(i.areaPath)}</td>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(i.state)}</td>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(i.assignee || 'Unassigned')}</td>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${i.openDays}</td>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb;color:${riskColor};font-weight:600;">${escapeHtml(i.risk.level)}</td>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${escapeHtml(i.about)}</td>
            </tr>
          `;
        }).join('');

      return `
        <div style="margin:12px 0 20px 0;">
          <h4 style="margin:0 0 8px 0;color:#1f2937;">Iteration: ${escapeHtml(iteration)} (${iterations[iteration].length})</h4>
          <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;">
            <thead>
              <tr style="background:#f3f4f6;text-align:left;">
                <th style="padding:8px;">ID</th>
                <th style="padding:8px;">Type</th>
                <th style="padding:8px;">Title</th>
                <th style="padding:8px;">Area</th>
                <th style="padding:8px;">State</th>
                <th style="padding:8px;">Assignee</th>
                <th style="padding:8px;">Days Open</th>
                <th style="padding:8px;">Risk</th>
                <th style="padding:8px;">About</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }).join('');

    return `
      <section style="margin:16px 0;padding:12px;border:1px solid #e5e7eb;border-radius:8px;background:#ffffff;">
        <h3 style="margin:0 0 8px 0;padding:8px 10px;border-radius:6px;color:#fff;background:${mvpColors[mvpKey]};">
          ${escapeHtml(mvpKey)} (${total})
        </h3>
        ${iterBlocks || '<p>No items</p>'}
      </section>
    `;
  }).join('');

  return `
  <html>
    <body style="font-family:Arial,Helvetica,sans-serif;background:#f8fafc;color:#111827;padding:16px;">
      <h1 style="margin:0 0 8px 0;color:#1d4ed8;">Lawyer Directory Open Related Tickets Report</h1>
      <p style="margin:0 0 12px 0;">Generated: ${new Date().toISOString()}</p>
      <p style="margin:0 0 12px 0;">Organization: ${ORG} | Project: ${PROJECT}</p>
      <p style="margin:0 0 16px 0;">Grouped by <b>MVP status</b> and then <b>Iteration</b> (color-coded).</p>
      ${cards}
    </body>
  </html>
  `;
}

async function main() {
  const areaFilter = areaClause(AREA_PATHS);
  const notClosed = CLOSED_STATES.map(function(s) {
    return `[System.State] <> '${escWiql(s)}'`;
  }).join(' AND ');

  const query = [
    'SELECT [System.Id]',
    'FROM WorkItems',
    `WHERE (${areaFilter})`,
    `AND ${notClosed}`,
    'ORDER BY [System.ChangedDate] DESC'
  ].join(' ');

  console.log('Querying open tickets...');
  const ids = await runWiql(query);
  console.log('Open ticket IDs:', ids.length);
  const allItems = await fetchWorkItems(ids, true);
  const baseItems = allItems.filter(function(item) {
    return isLawyersDirectoryArea(item.areaPath) || isUnderArea(item.areaPath, 'FindLawADO\\PALS');
  });

  const byId = {};
  baseItems.forEach(function(i) { byId[i.id] = i; });
  let frontier = Array.from(new Set(baseItems.map(function(i) { return i.parentId; }).filter(Boolean)));
  let hops = 0;
  while (frontier.length && hops < 8) {
    const missing = frontier.filter(function(id) { return !byId[id]; });
    if (!missing.length) break;
    const parents = await fetchWorkItems(missing, true);
    parents.forEach(function(p) { byId[p.id] = p; });
    frontier = Array.from(new Set(parents.map(function(p) { return p.parentId; }).filter(Boolean)));
    hops += 1;
  }

  const seedClosure = await buildRelationClosure(SEED_WORK_ITEM_IDS, byId, RELATION_TRAVERSAL_DEPTH);
  console.log('Expanded relation ID set size:', seedClosure.size);
  const relatedItems = baseItems.filter(function(item) {
    return hasRelationToIdSet(item, byId, seedClosure);
  });
  console.log('After relation-to-seed filter:', relatedItems.length);
  const scopedItems = relatedItems.filter(function(item) {
    return !isQaAutomationItem(item) && !isTestCaseType(item);
  });
  console.log('After removing QA Automation + Test Case items:', scopedItems.length);

  const enriched = [];
  for (const item of scopedItems) {
    const [comments, updates] = await Promise.all([
      fetchComments(item.id),
      fetchUpdates(item.id)
    ]);
    const openSince = findOpenStartDate(item) || findUnassignedStartDate(item, updates);
    const openDays = openSince ? toDays(openSince) : 0;
    const lineage = [];
    let cursor = item.parentId ? byId[item.parentId] : null;
    let safety = 0;
    while (cursor && safety < 10) {
      lineage.push(cursor);
      cursor = cursor.parentId ? byId[cursor.parentId] : null;
      safety += 1;
    }
    const directParent = lineage[0] || null;
    const feature = firstInLineageByType(lineage, ['feature']);
    const story = firstInLineageByType(lineage, ['user story', 'story', 'product backlog item', 'backlog item']);

    enriched.push({
      ...item,
      stream: getStream(item.areaPath),
      areaRoot: getAreaRoot(item.areaPath),
      about: summarizeBug(item),
      comments: comments,
      risk: riskFromComments(comments),
      mvp: mvpStatus(item, comments),
      openDays: openDays,
      parentKey: directParent ? String(directParent.id) : 'none',
      parentLabel: labelWorkItem(directParent),
      featureKey: feature ? String(feature.id) : 'none',
      featureLabel: labelWorkItem(feature),
      storyKey: story ? String(story.id) : 'none',
      storyLabel: labelWorkItem(story)
    });
  }

  const report = renderReport(enriched);
  const reportPath = path.join(__dirname, 'lawyer-directory-open-bugs-report.md');
  fs.writeFileSync(reportPath, report, 'utf8');
  const htmlReport = renderHtmlReport(enriched);
  const htmlReportPath = path.join(__dirname, 'lawyer-directory-open-bugs-report.html');
  fs.writeFileSync(htmlReportPath, htmlReport, 'utf8');

  const emailDraft = renderEmailDraft(enriched);
  const emailPath = path.join(__dirname, 'lawyer-directory-open-bugs-email-draft.txt');
  fs.writeFileSync(emailPath, emailDraft, 'utf8');

  console.log('\nWrote report:', reportPath);
  console.log('Wrote HTML report:', htmlReportPath);
  console.log('Wrote email draft:', emailPath);
}

main().catch(function(err) {
  console.error(err.response ? (err.response.data || err.response.statusText) : err.message);
  process.exit(1);
});

