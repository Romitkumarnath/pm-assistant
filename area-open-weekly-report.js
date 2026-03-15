require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ADO_PAT = process.env.ADO_PAT;
const ORG = 'Findlaw';
const PROJECT = 'FindLawADO';

const AREA_PATHS = [
  'FindLawADO\\Lawyer Directory',
  'FindLawADO\\FindLaw - UX',
  'FindLawADO\\Front End',
  'FindLawADO\\PALS'
];
const ITERATION_PATH_PREFIX = 'FindLawADO\\2026\\26.3*';

const CLOSED_STATES = ['Closed', 'Done', 'Removed', 'Cut'];
const ACCOMPLISHED_STATES = ['Closed', 'Done', 'Resolved'];
const LOOKBACK_DAYS = 7;

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

function areaClause(areaPaths) {
  const parts = areaPaths.map(function(a) {
    const safe = escWiql(a);
    return `([System.AreaPath] = '${safe}' OR [System.AreaPath] UNDER '${safe}')`;
  });
  return parts.join(' OR ');
}

function listClause(field, values) {
  return values.map(function(v) {
    return `[${field}] = '${escWiql(v)}'`;
  }).join(' OR ');
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
    .filter(function(n) {
      return patterns.some(function(rx) { return rx.test(n.path); });
    })
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

async function fetchWorkItems(ids) {
  if (!ids.length) return [];
  const fields = [
    'System.Id',
    'System.Title',
    'System.State',
    'System.WorkItemType',
    'System.AreaPath',
    'System.AssignedTo',
    'System.ChangedDate',
    'System.CreatedDate',
    'Microsoft.VSTS.Common.Priority'
  ].join(',');
  const all = [];
  const batchSize = 200;
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize).join(',');
    const url = `${BASE}/workitems?ids=${batch}&fields=${fields}&api-version=7.0`;
    const res = await axios.get(url, { headers: HEADERS });
    all.push(...(res.data.value || []));
  }
  return all.map(function(item) {
    const f = item.fields || {};
    return {
      id: item.id,
      title: f['System.Title'] || '',
      state: f['System.State'] || '',
      type: f['System.WorkItemType'] || '',
      areaPath: f['System.AreaPath'] || '',
      assignee: (f['System.AssignedTo'] && f['System.AssignedTo'].displayName) || 'Unassigned',
      changedDate: f['System.ChangedDate'] || '',
      createdDate: f['System.CreatedDate'] || '',
      priority: f['Microsoft.VSTS.Common.Priority']
    };
  });
}

function groupByRequestedArea(items, requestedAreas) {
  const map = {};
  requestedAreas.forEach(function(a) { map[a] = []; });
  map.Other = [];

  items.forEach(function(item) {
    const match = requestedAreas.find(function(a) {
      return item.areaPath === a || item.areaPath.startsWith(a + '\\');
    });
    if (match) map[match].push(item);
    else map.Other.push(item);
  });

  return map;
}

function stateCounts(items) {
  return items.reduce(function(acc, item) {
    acc[item.state] = (acc[item.state] || 0) + 1;
    return acc;
  }, {});
}

function typeCounts(items) {
  return items.reduce(function(acc, item) {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {});
}

function fmtDate(v) {
  if (!v) return 'N/A';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toISOString().slice(0, 10);
}

function topN(items, n) {
  return items.slice(0, n);
}

function summarizeThemes(items) {
  if (!items.length) return 'No notable themes (no items).';
  const counts = {
    qaTesting: 0,
    srpListings: 0,
    profile: 0,
    badgesAwards: 0,
    schemaSeo: 0,
    chatAi: 0,
    securityInfra: 0,
    automation: 0
  };

  items.forEach(function(i) {
    const t = String(i.title || '').toLowerCase();
    if (/(qa|uat|test failed|testing|aqa)/.test(t)) counts.qaTesting += 1;
    if (/(srp|attorney listings|serp|pagination|tabs?)/.test(t)) counts.srpListings += 1;
    if (/(profile|rradmin|ratingsapi|review)/.test(t)) counts.profile += 1;
    if (/(badge|badges|award|super lawyers|slpoap)/.test(t)) counts.badgesAwards += 1;
    if (/(schema|seo|datalayer|structured data)/.test(t)) counts.schemaSeo += 1;
    if (/(chat|ai intake|ask a lawyer|n?gage)/.test(t)) counts.chatAi += 1;
    if (/(trivy|vulnerab|security|outage|db|api)/.test(t)) counts.securityInfra += 1;
    if (/(automate|automation|auto-tests|gha|pipeline)/.test(t)) counts.automation += 1;
  });

  const labelMap = {
    qaTesting: 'QA/testing validation',
    srpListings: 'SRP/attorney-listings behavior',
    profile: 'profile/reviews platform changes',
    badgesAwards: 'badges/awards work',
    schemaSeo: 'schema/SEO/data-layer updates',
    chatAi: 'chat/AI intake enhancements',
    securityInfra: 'security/infrastructure hardening',
    automation: 'test/build automation'
  };

  const ranked = Object.keys(counts)
    .map(function(k) { return { key: k, count: counts[k] }; })
    .filter(function(x) { return x.count > 0; })
    .sort(function(a, b) { return b.count - a.count; })
    .slice(0, 3);

  if (!ranked.length) return 'Work is broadly mixed across multiple unrelated items.';
  return ranked.map(function(x) {
    return `${labelMap[x.key]} (${x.count})`;
  }).join('; ') + '.';
}

function totalCountByAreas(grouped, areas) {
  return areas.reduce(function(sum, area) {
    return sum + ((grouped[area] || []).length);
  }, 0);
}

function collectAllByAreas(grouped, areas) {
  return areas.reduce(function(acc, area) {
    return acc.concat(grouped[area] || []);
  }, []);
}

function renderReport(openGrouped, accomplishedGrouped, metadata) {
  const lines = [];
  lines.push('# Open Items + Last Week Accomplishments Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Organization: ${ORG}`);
  lines.push(`Project: ${PROJECT}`);
  lines.push(`Lookback window: last ${LOOKBACK_DAYS} days`);
  lines.push(`Iteration filter: ${ITERATION_PATH_PREFIX}`);
  lines.push('');

  const totalOpen = totalCountByAreas(openGrouped, metadata.requestedAreas);
  const totalAccomplished = totalCountByAreas(accomplishedGrouped, metadata.requestedAreas);
  const highestOpenArea = metadata.requestedAreas
    .map(function(a) { return { area: a, count: (openGrouped[a] || []).length }; })
    .sort(function(a, b) { return b.count - a.count; })[0];
  const highestAccomplishedArea = metadata.requestedAreas
    .map(function(a) { return { area: a, count: (accomplishedGrouped[a] || []).length }; })
    .sort(function(a, b) { return b.count - a.count; })[0];
  const openThemeRollup = summarizeThemes(collectAllByAreas(openGrouped, metadata.requestedAreas));
  const accomplishedThemeRollup = summarizeThemes(collectAllByAreas(accomplishedGrouped, metadata.requestedAreas));

  lines.push('## Executive Summary');
  lines.push(`- Total open items in scope: **${totalOpen}**`);
  lines.push(`- Total accomplished in last ${LOOKBACK_DAYS} days: **${totalAccomplished}**`);
  lines.push(`- Highest open backlog area: **${highestOpenArea.area}** (${highestOpenArea.count})`);
  lines.push(`- Highest accomplished volume area: **${highestAccomplishedArea.area}** (${highestAccomplishedArea.count})`);
  lines.push(`- Open work focus: ${openThemeRollup}`);
  lines.push(`- Last-week accomplishments focus: ${accomplishedThemeRollup}`);
  lines.push('');

  lines.push('## Area Paths');
  metadata.requestedAreas.forEach(function(a) { lines.push(`- ${a}`); });
  lines.push('');

  lines.push('## Open Items Summary (Grouped by Area Path)');
  lines.push('');
  metadata.requestedAreas.forEach(function(area) {
    const items = openGrouped[area] || [];
    const states = stateCounts(items);
    const types = typeCounts(items);
    lines.push(`### ${area}`);
    lines.push(`- Total open: ${items.length}`);
    lines.push(`- By state: ${JSON.stringify(states)}`);
    lines.push(`- By type: ${JSON.stringify(types)}`);
    lines.push(`- Summary (what open changes are about): ${summarizeThemes(items)}`);

    const sorted = items.slice().sort(function(a, b) {
      return new Date(b.changedDate) - new Date(a.changedDate);
    });
    const sample = topN(sorted, 20);
    lines.push('- Open items (top 20 by most recently changed):');
    if (!sample.length) {
      lines.push('  - None');
    } else {
      sample.forEach(function(i) {
        lines.push(`  - #${i.id} [${i.type}] ${i.title} | ${i.state} | ${i.assignee} | Changed ${fmtDate(i.changedDate)}`);
      });
    }
    lines.push('');
  });

  lines.push('## Accomplishments in Last 1 Week (Grouped by Area Path)');
  lines.push('');
  metadata.requestedAreas.forEach(function(area) {
    const items = accomplishedGrouped[area] || [];
    const types = typeCounts(items);
    lines.push(`### ${area}`);
    lines.push(`- Completed/resolved in last ${LOOKBACK_DAYS} days: ${items.length}`);
    lines.push(`- By type: ${JSON.stringify(types)}`);
    lines.push(`- Summary (what accomplished changes were about): ${summarizeThemes(items)}`);
    const sorted = items.slice().sort(function(a, b) {
      return new Date(b.changedDate) - new Date(a.changedDate);
    });
    const sample = topN(sorted, 25);
    lines.push('- Accomplished items (top 25 by most recently changed):');
    if (!sample.length) {
      lines.push('  - None');
    } else {
      sample.forEach(function(i) {
        lines.push(`  - #${i.id} [${i.type}] ${i.title} | ${i.state} | ${i.assignee} | Changed ${fmtDate(i.changedDate)}`);
      });
    }
    lines.push('');
  });

  return lines.join('\n');
}

async function main() {
  console.log('Resolving iteration IDs for prefix:', ITERATION_PATH_PREFIX);
  const iterationIds = await resolveIterationIdsByPrefix(ITERATION_PATH_PREFIX);
  if (!iterationIds.length) {
    console.log('No iteration nodes found for prefix:', ITERATION_PATH_PREFIX);
    return;
  }
  console.log('Matched iteration IDs:', iterationIds.length);

  const areaFilter = areaClause(AREA_PATHS);
  const iterationFilter = iterationIdClause(iterationIds);
  const openStateFilter = CLOSED_STATES.map(function(s) { return `[System.State] <> '${escWiql(s)}'`; }).join(' AND ');
  const accomplishedStateFilter = `(${listClause('System.State', ACCOMPLISHED_STATES)})`;

  const openQuery = [
    'SELECT [System.Id]',
    'FROM WorkItems',
    `WHERE (${areaFilter})`,
    `AND ${iterationFilter}`,
    `AND ${openStateFilter}`,
    'ORDER BY [System.ChangedDate] DESC'
  ].join(' ');

  const accomplishedQuery = [
    'SELECT [System.Id]',
    'FROM WorkItems',
    `WHERE (${areaFilter})`,
    `AND ${iterationFilter}`,
    `AND ${accomplishedStateFilter}`,
    `AND [System.ChangedDate] >= @Today - ${LOOKBACK_DAYS}`,
    'ORDER BY [System.ChangedDate] DESC'
  ].join(' ');

  console.log('Querying open items...');
  const openIds = await runWiql(openQuery);
  console.log('Open IDs:', openIds.length);

  console.log('Querying accomplishments in last week...');
  const accomplishedIds = await runWiql(accomplishedQuery);
  console.log('Accomplished IDs:', accomplishedIds.length);

  const [openItems, accomplishedItems] = await Promise.all([
    fetchWorkItems(openIds),
    fetchWorkItems(accomplishedIds)
  ]);

  const openGrouped = groupByRequestedArea(openItems, AREA_PATHS);
  const accomplishedGrouped = groupByRequestedArea(accomplishedItems, AREA_PATHS);

  const report = renderReport(openGrouped, accomplishedGrouped, {
    requestedAreas: AREA_PATHS
  });

  const outPath = path.join(__dirname, 'area-path-open-weekly-report.md');
  fs.writeFileSync(outPath, report, 'utf8');

  console.log('\nReport written to:', outPath);
  AREA_PATHS.forEach(function(area) {
    console.log(
      '-',
      area,
      '| open:',
      (openGrouped[area] || []).length,
      '| accomplished last week:',
      (accomplishedGrouped[area] || []).length
    );
  });
}

main().catch(function(err) {
  console.error(err.response ? (err.response.data || err.response.statusText) : err.message);
  process.exit(1);
});

