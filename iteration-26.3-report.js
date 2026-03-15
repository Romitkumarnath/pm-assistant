/**
 * List all work items in iteration path 26.3.* for Findlaw/FindLawADO.
 * Uses Azure DevOps WiQL and work items API. Requires ADO_PAT in .env.
 *
 * Run: node iteration-26.3-report.js
 * Optional: node iteration-26.3-report.js --json   (write results to iteration-26.3-report.json)
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ADO_PAT = process.env.ADO_PAT;
const ORG = 'Findlaw';
const PROJECT = 'FindLawADO';
const ITERATION_PREFIX = '26.3';  // default match token for iteration segment names

if (!ADO_PAT) {
  console.error('Missing ADO_PAT in .env');
  process.exit(1);
}

const BASE = `https://dev.azure.com/${ORG}/${PROJECT}/_apis/wit`;
const AUTH = Buffer.from(':' + ADO_PAT).toString('base64');
const HEADERS = { Authorization: 'Basic ' + AUTH };

function escapeWiqlValue(value) {
  return String(value || '').replace(/'/g, "''");
}

function normalizeIterationPath(p) {
  return String(p || '').replace(/^\\+/, '');
}

function is26Dot3Segment(segment) {
  return /^26\.3(?:\.|$)/.test(String(segment || ''));
}

function collectIterationNodes(node, out) {
  if (!node || typeof node !== 'object') return;
  if (node.path && typeof node.id === 'number') {
    out.push({
      id: node.id,
      name: node.name || '',
      path: normalizeIterationPath(node.path)
    });
  }
  const children = Array.isArray(node.children) ? node.children : [];
  children.forEach(function(child) {
    collectIterationNodes(child, out);
  });
}

async function fetchAllIterationNodes() {
  const url = BASE + '/classificationnodes/iterations?$depth=10&api-version=7.0';
  const res = await axios.get(url, { headers: HEADERS });
  const nodes = [];
  collectIterationNodes(res.data, nodes);
  return nodes;
}

async function resolveTargetIterationNodes(cliPath) {
  const all = await fetchAllIterationNodes();

  if (cliPath) {
    const raw = normalizeIterationPath(cliPath);
    const target = raw.toLowerCase();
    const exact = all.filter(function(n) { return n.path.toLowerCase() === target; });
    if (exact.length) return exact;

    // Wildcard support:
    // - If user passes "...\\26.3*" we treat it as prefix on the final segment.
    // - If exact path is not found, also fall back to matching final-segment prefix.
    const finalSegment = raw.split('\\').pop() || '';
    const segmentPrefix = finalSegment.replace(/\*+$/, '').toLowerCase();
    if (segmentPrefix) {
      const matchedBySegment = all.filter(function(n) {
        const segments = n.path.toLowerCase().split('\\');
        return segments.some(function(seg) {
          return seg.startsWith(segmentPrefix);
        });
      });
      if (matchedBySegment.length) {
        console.log('No exact path match; using wildcard segment match for:', finalSegment);
        return matchedBySegment;
      }
    }

    // Additional fallback: if caller includes '*' in the whole path, treat everything before '*' as path prefix.
    if (raw.includes('*')) {
      const wholePrefix = raw.slice(0, raw.indexOf('*')).toLowerCase();
      const matchedByPathPrefix = all.filter(function(n) {
        return n.path.toLowerCase().startsWith(wholePrefix);
      });
      if (matchedByPathPrefix.length) {
        console.log('No exact path match; using wildcard path-prefix match for:', raw);
        return matchedByPathPrefix;
      }
    }

    console.warn('Explicit path pattern not found in iteration tree:', cliPath);
    return [];
  }

  const matched = all.filter(function(n) {
    const fullPath = n.path;
    const segments = fullPath.split('\\');
    return segments.some(is26Dot3Segment);
  });
  return matched;
}

async function queryIdsByIterationNodeIds(iterationIds) {
  if (!iterationIds || iterationIds.length === 0) return [];

  const idList = iterationIds.join(', ');
  const wiql = {
    query: [
      "SELECT [System.Id]",
      "FROM WorkItems",
      "WHERE [System.IterationId] IN (" + idList + ")"
    ].join(' ')
  };
  const url = BASE + '/wiql?api-version=7.0';
  const res = await axios.post(url, wiql, { headers: { ...HEADERS, 'Content-Type': 'application/json' } });
  const workItems = res.data.workItems || [];
  return workItems.map(function(w) { return w.id; });
}

/**
 * Fetch full work item details in batches (API allows up to 200 per request).
 */
async function fetchWorkItemDetails(ids) {
  if (ids.length === 0) return [];
  const fields = 'System.Id,System.Title,System.State,System.WorkItemType,System.IterationPath,System.AssignedTo,System.CreatedDate,System.ChangedDate,Microsoft.VSTS.Common.Priority';
  const batchSize = 200;
  const all = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const idsParam = batch.join(',');
    const url = `${BASE}/workitems?ids=${idsParam}&fields=${fields}&api-version=7.0`;
    const res = await axios.get(url, { headers: HEADERS });
    const items = res.data.value || [];
    all.push(...items);
  }
  return all;
}

function toSummary(item) {
  const f = item.fields || {};
  return {
    id: item.id,
    title: f['System.Title'],
    state: f['System.State'],
    type: f['System.WorkItemType'],
    iterationPath: f['System.IterationPath'],
    assignee: (f['System.AssignedTo'] && f['System.AssignedTo'].displayName) || 'Unassigned',
    priority: f['Microsoft.VSTS.Common.Priority'],
    created: f['System.CreatedDate'],
    changed: f['System.ChangedDate']
  };
}

function printReport(items) {
  const byType = {};
  const byState = {};
  const byIteration = {};
  items.forEach(s => {
    byType[s.type] = (byType[s.type] || 0) + 1;
    byState[s.state] = (byState[s.state] || 0) + 1;
    byIteration[s.iterationPath] = (byIteration[s.iterationPath] || 0) + 1;
  });

  console.log('\n--- Iteration 26.3.* summary ---');
  console.log('Org:', ORG, '| Project:', PROJECT);
  console.log('Total work items:', items.length);
  console.log('\nBy type:', JSON.stringify(byType, null, 2));
  console.log('\nBy state:', JSON.stringify(byState, null, 2));
  console.log('\nBy iteration path:', JSON.stringify(byIteration, null, 2));

  console.log('\n--- List (id, type, state, iteration, assignee, title) ---');
  items.forEach(s => {
    console.log([s.id, s.type, s.state, s.iterationPath, s.assignee, s.title].join('\t'));
  });
}

async function main() {
  const writeJson = process.argv.includes('--json');
  // CLI args: [node, script, ...userArgs]. First non-flag arg is optional explicit full path.
  const userArgs = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const explicitPath = userArgs[0] || process.env.ITERATION_PATH || '';

  if (explicitPath) {
    console.log('Querying work items for explicit iteration path:', normalizeIterationPath(explicitPath));
  } else {
    console.log('No explicit path provided; auto-discovering iteration paths matching', ITERATION_PREFIX + '*');
  }

  const targetNodes = await resolveTargetIterationNodes(explicitPath);
  if (!targetNodes.length) {
    console.log('No matching iteration paths found.');
    return;
  }

  console.log('Using', targetNodes.length, 'iteration node(s):');
  targetNodes.forEach(function(n) { console.log(' -', n.path, '(id:', n.id + ')'); });

  const iterationIds = targetNodes.map(function(n) { return n.id; });
  const ids = await queryIdsByIterationNodeIds(iterationIds);
  console.log('Found', ids.length, 'work item(s).');
  if (ids.length === 0) {
    console.log('No work items in 26.3.*. Exiting.');
    return;
  }
  const raw = await fetchWorkItemDetails(ids);
  const items = raw.map(toSummary);
  printReport(items);
  if (writeJson) {
    const outPath = path.join(__dirname, 'iteration-26.3-report.json');
    fs.writeFileSync(outPath, JSON.stringify({ iterationNodes: targetNodes, count: items.length, items }, null, 2), 'utf8');
    console.log('\nWrote', outPath);
  }
}

main().catch(err => {
  console.error(err.response ? (err.response.data || err.response.statusText) : err.message);
  process.exit(1);
});
