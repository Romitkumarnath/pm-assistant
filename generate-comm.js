#!/usr/bin/env node
/**
 * generate-comm.js — Backend communication generator for PM Assistant
 *
 * Generates executive communications (biweekly, weekly, e2e, deep-dive)
 * by pulling data from ADO, YouTrack, Google Chat, Airtable, and Google Sheets,
 * then calling the Claude API to produce a formatted HTML email + source references document.
 *
 * Usage:
 *   node generate-comm.js --type <biweekly|weekly|e2e|deep-dive> [options]
 *
 * Options:
 *   --type <type>              Communication type (required)
 *   --ado-urls <urls>          Comma-separated ADO work item URLs
 *   --youtrack-ids <ids>       Comma-separated YouTrack issue IDs
 *   --airtable-projects <names> Comma-separated Airtable project names (or "all")
 *   --ado-dashboard <url>      ADO dashboard URL for bug overview
 *   --youtrack-dashboard <id>  YouTrack dashboard URL/ID
 *   --sheets <ids>             Comma-separated Google Sheet IDs
 *   --include-chat <spaces>    Comma-separated Google Chat space IDs
 *   --include-ado-area-report  Run area-open-weekly-report.js and include output
 *   --date-range <start:end>   Date range in YYYY-MM-DD:YYYY-MM-DD format
 *   --draft                    Create Gmail draft after generating
 *   --to <email>               Recipient (default: romit.nath@internetbrands.com)
 *   --cc <emails>              CC recipients
 *   --output-dir <dir>         Output directory (default: current dir)
 *   --no-references            Skip references doc generation (NOT recommended)
 *   --dry-run                  Show what would be gathered without calling Claude
 *   --help                     Show this help
 *
 * Examples:
 *   node generate-comm.js --type biweekly --airtable-projects "all" --date-range "2026-03-01:2026-03-15"
 *   node generate-comm.js --type e2e --include-chat "spaces/AAQAve0AYtw" --ado-dashboard "https://..." --draft
 *   node generate-comm.js --type weekly --include-ado-area-report --airtable-projects "all"
 *
 * Environment variables (in .env):
 *   ANTHROPIC_API_KEY   — Claude API key (required)
 *   ADO_PAT             — Azure DevOps personal access token
 *   YOUTRACK_TOKEN       — YouTrack permanent token
 *   AIRTABLE_API_KEY     — Airtable API key
 *   GMAIL_CLIENT_ID      — Gmail OAuth client ID (for --draft)
 *   GMAIL_CLIENT_SECRET  — Gmail OAuth client secret (for --draft)
 *   GOOGLE_OAUTH_CREDENTIALS — Path to oauth_credentials.json (default: oauth_credentials.json)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync, spawn } = require('child_process');

// Load .env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, ...vals] = line.split('=');
    if (key && !key.startsWith('#')) {
      process.env[key.trim()] = vals.join('=').trim().replace(/^["']|["']$/g, '');
    }
  });
}

// ─────────────────────────────────────────────
// CLI Argument Parser
// ─────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    type: null,
    adoUrls: [],
    youtrackIds: [],
    airtableProjects: [],
    adoDashboard: null,
    youtrackDashboard: null,
    sheets: [],
    chatSpaces: [],
    includeAdoAreaReport: false,
    dateRange: null,
    draft: false,
    to: 'romit.nath@internetbrands.com',
    cc: null,
    outputDir: __dirname,
    noReferences: false,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--type':             opts.type = args[++i]; break;
      case '--ado-urls':         opts.adoUrls = args[++i].split(',').map(s => s.trim()); break;
      case '--youtrack-ids':     opts.youtrackIds = args[++i].split(',').map(s => s.trim()); break;
      case '--airtable-projects': opts.airtableProjects = args[++i].split(',').map(s => s.trim()); break;
      case '--ado-dashboard':    opts.adoDashboard = args[++i]; break;
      case '--youtrack-dashboard': opts.youtrackDashboard = args[++i]; break;
      case '--sheets':           opts.sheets = args[++i].split(',').map(s => s.trim()); break;
      case '--include-chat':     opts.chatSpaces = args[++i].split(',').map(s => s.trim()); break;
      case '--include-ado-area-report': opts.includeAdoAreaReport = true; break;
      case '--date-range':       opts.dateRange = args[++i]; break;
      case '--draft':            opts.draft = true; break;
      case '--to':               opts.to = args[++i]; break;
      case '--cc':               opts.cc = args[++i]; break;
      case '--output-dir':       opts.outputDir = args[++i]; break;
      case '--no-references':    opts.noReferences = true; break;
      case '--dry-run':          opts.dryRun = true; break;
      case '--help':
        console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1]);
        process.exit(0);
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!opts.type) {
    console.error('Error: --type is required. Use --help for usage.');
    process.exit(1);
  }

  const validTypes = ['biweekly', 'weekly', 'e2e', 'deep-dive'];
  if (!validTypes.includes(opts.type)) {
    console.error(`Error: --type must be one of: ${validTypes.join(', ')}`);
    process.exit(1);
  }

  return opts;
}

// ─────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────
function httpPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(data));
    req.end();
  });
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
    };
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─────────────────────────────────────────────
// Data Gatherers
// ─────────────────────────────────────────────
const sources = []; // Track all sources for references doc

function trackSource(name, type, method, url, data) {
  sources.push({
    name,
    type,
    method,
    url: url || 'N/A',
    accessedAt: new Date().toISOString(),
    recordCount: Array.isArray(data) ? data.length : (data ? 1 : 0),
  });
}

async function fetchAdoTickets(urls) {
  const results = [];
  for (const url of urls) {
    try {
      console.log(`  [ADO] Fetching: ${url}`);
      const data = await httpPost('http://localhost:3000/api/analyze', { url });
      trackSource('Azure DevOps', 'Bug Tracker', 'ADO Server (port 3000)', url, data);
      results.push({ url, data });
    } catch (err) {
      console.error(`  [ADO] Failed to fetch ${url}: ${err.message}`);
      // Try direct ADO API as fallback
      if (process.env.ADO_PAT) {
        try {
          const idMatch = url.match(/edit\/(\d+)/);
          if (idMatch) {
            const apiUrl = `https://dev.azure.com/Findlaw/FindLawADO/_apis/wit/workitems/${idMatch[1]}?$expand=all&api-version=7.0`;
            const data = await httpGet(apiUrl, {
              'Authorization': `Basic ${Buffer.from(`:${process.env.ADO_PAT}`).toString('base64')}`,
            });
            trackSource('Azure DevOps (Direct API)', 'Bug Tracker', 'ADO REST API', url, data);
            results.push({ url, data });
          }
        } catch (err2) {
          console.error(`  [ADO] Direct API also failed: ${err2.message}`);
        }
      }
    }
  }
  return results;
}

async function fetchYouTrackTickets(ids) {
  const results = [];
  for (const id of ids) {
    try {
      console.log(`  [YouTrack] Fetching: ${id}`);
      const url = `https://youtrack.internetbrands.com/issue/${id}`;
      const data = await httpPost('http://localhost:3001/api/analyze', { url });
      trackSource('YouTrack', 'Bug Tracker', 'YouTrack Server (port 3001)', url, data);
      results.push({ id, data });
    } catch (err) {
      console.error(`  [YouTrack] Failed to fetch ${id}: ${err.message}`);
      // Try direct YouTrack API as fallback
      if (process.env.YOUTRACK_TOKEN) {
        try {
          const apiUrl = `https://youtrack.internetbrands.com/api/issues/${id}?fields=id,idReadable,summary,description,created,updated,resolved,reporter(login,fullName),customFields(name,value(name,login,text,presentation))`;
          const data = await httpGet(apiUrl, {
            'Authorization': `Bearer ${process.env.YOUTRACK_TOKEN}`,
            'Accept': 'application/json',
          });
          trackSource('YouTrack (Direct API)', 'Bug Tracker', 'YouTrack REST API', apiUrl, data);
          results.push({ id, data });
        } catch (err2) {
          console.error(`  [YouTrack] Direct API also failed: ${err2.message}`);
        }
      }
    }
  }
  return results;
}

async function fetchAirtableProjects(projectNames) {
  if (!process.env.AIRTABLE_API_KEY) {
    console.error('  [Airtable] No AIRTABLE_API_KEY in .env — skipping');
    return [];
  }

  const baseId = 'appq6NWOEqbz4eRN9';
  const statusTableId = 'tblRNAKuSGEdCtBMb';
  const headers = {
    'Authorization': `Bearer ${process.env.AIRTABLE_API_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    console.log(`  [Airtable] Fetching status reports...`);
    let url = `https://api.airtable.com/v0/${baseId}/${statusTableId}?sort%5B0%5D%5Bfield%5D=Date&sort%5B0%5D%5Bdirection%5D=desc&maxRecords=50`;

    // If specific projects, add filter
    if (projectNames.length > 0 && !projectNames.includes('all')) {
      const formula = `OR(${projectNames.map(p => `SEARCH("${p}", {Project Name})`).join(',')})`;
      url += `&filterByFormula=${encodeURIComponent(formula)}`;
    }

    const data = await httpGet(url, headers);
    trackSource('Airtable Status Reports', 'Project Management', 'Airtable REST API', url, data.records);
    return data.records || [];
  } catch (err) {
    console.error(`  [Airtable] Failed: ${err.message}`);
    return [];
  }
}

async function fetchGoogleChatMessages(spaceIds, dateRange) {
  const tokenPath = path.join(__dirname, 'token.json');
  const credPath = path.join(__dirname, process.env.GOOGLE_OAUTH_CREDENTIALS || 'oauth_credentials.json');

  if (!fs.existsSync(tokenPath)) {
    console.error('  [Google Chat] No token.json found — skipping');
    return [];
  }

  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

  // Refresh the token
  try {
    console.log('  [Google Chat] Refreshing OAuth token...');
    const tokenResponse = await httpPost('https://oauth2.googleapis.com/token', null, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    // Use form-encoded for token refresh
    const refreshData = new URLSearchParams({
      client_id: token.client_id,
      client_secret: token.client_secret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    });

    const refreshResponse = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve(JSON.parse(body)));
      });
      req.on('error', reject);
      req.write(refreshData.toString());
      req.end();
    });

    if (!refreshResponse.access_token) {
      console.error('  [Google Chat] Token refresh failed:', refreshResponse);
      return [];
    }

    const accessToken = refreshResponse.access_token;
    const allMessages = [];

    for (const spaceId of spaceIds) {
      const space = spaceId.startsWith('spaces/') ? spaceId : `spaces/${spaceId}`;
      console.log(`  [Google Chat] Fetching messages from ${space}...`);

      let pageToken = null;
      let pageCount = 0;
      const maxPages = 3; // Limit to 150 messages per space

      do {
        let apiUrl = `https://chat.googleapis.com/v1/${space}/messages?pageSize=50&orderBy=createTime%20desc`;
        if (pageToken) apiUrl += `&pageToken=${pageToken}`;

        const msgs = await httpGet(apiUrl, { 'Authorization': `Bearer ${accessToken}` });

        if (msgs.messages) {
          // Filter by date range if provided
          let filtered = msgs.messages;
          if (dateRange) {
            const [start, end] = dateRange.split(':');
            filtered = msgs.messages.filter(m => {
              const created = m.createTime.split('T')[0];
              return created >= start && created <= (end || '9999-99-99');
            });
          }
          allMessages.push(...filtered.map(m => ({
            space,
            createTime: m.createTime,
            sender: m.sender?.displayName || m.sender?.name || 'Unknown',
            text: m.text || '',
          })));
        }

        pageToken = msgs.nextPageToken;
        pageCount++;
      } while (pageToken && pageCount < maxPages);

      trackSource(`Google Chat (${space})`, 'Chat Messages', 'Google Chat REST API', `https://chat.googleapis.com/v1/${space}/messages`, allMessages.filter(m => m.space === space));
    }

    return allMessages;
  } catch (err) {
    console.error(`  [Google Chat] Failed: ${err.message}`);
    return [];
  }
}

async function runAdoAreaReport() {
  const scriptPath = path.join(__dirname, 'area-open-weekly-report.js');
  if (!fs.existsSync(scriptPath)) {
    console.error('  [ADO Area Report] Script not found — skipping');
    return null;
  }

  try {
    console.log('  [ADO Area Report] Running area-open-weekly-report.js...');
    const output = execSync(`node "${scriptPath}"`, {
      cwd: __dirname,
      timeout: 120000,
      encoding: 'utf8',
    });
    trackSource('ADO Area Report', 'Generated Report', 'area-open-weekly-report.js', 'local script', output);
    return output;
  } catch (err) {
    console.error(`  [ADO Area Report] Failed: ${err.message}`);
    // Fall back to existing report file
    const reportPath = path.join(__dirname, 'area-path-open-weekly-report.md');
    if (fs.existsSync(reportPath)) {
      const content = fs.readFileSync(reportPath, 'utf8');
      trackSource('ADO Area Report (cached)', 'Generated Report', 'File read', reportPath, content);
      return content;
    }
    return null;
  }
}

// ─────────────────────────────────────────────
// Claude API Call
// ─────────────────────────────────────────────
async function callClaude(systemPrompt, userPrompt) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  console.log('\n📝 Calling Claude API to generate communication...');

  const response = await httpPost('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  }, {
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  });

  if (response.content && response.content[0]) {
    return response.content[0].text;
  }
  throw new Error('Claude API returned unexpected response: ' + JSON.stringify(response));
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  const opts = parseArgs();
  const today = new Date().toISOString().split('T')[0];

  console.log(`\n🚀 Generating ${opts.type} communication for ${today}`);
  console.log(`   Output dir: ${opts.outputDir}\n`);

  // ── Gather Data ──
  console.log('📊 Gathering data from sources...\n');

  const gatheredData = {};

  // ADO tickets
  if (opts.adoUrls.length > 0) {
    gatheredData.adoTickets = await fetchAdoTickets(opts.adoUrls);
  }

  // YouTrack tickets
  if (opts.youtrackIds.length > 0) {
    gatheredData.youtrackTickets = await fetchYouTrackTickets(opts.youtrackIds);
  }

  // Airtable projects
  if (opts.airtableProjects.length > 0) {
    gatheredData.airtableRecords = await fetchAirtableProjects(opts.airtableProjects);
  }

  // Google Chat
  if (opts.chatSpaces.length > 0) {
    gatheredData.chatMessages = await fetchGoogleChatMessages(opts.chatSpaces, opts.dateRange);
  }

  // ADO Area Report
  if (opts.includeAdoAreaReport) {
    gatheredData.adoAreaReport = await runAdoAreaReport();
  }

  // Dry run — just show what was gathered
  if (opts.dryRun) {
    console.log('\n📋 Dry run — data gathered:\n');
    console.log(JSON.stringify({
      sourcesAccessed: sources.length,
      sources: sources.map(s => `${s.name} (${s.type}): ${s.recordCount} records`),
      dataKeys: Object.keys(gatheredData),
    }, null, 2));
    return;
  }

  // ── Load Skill Prompt ──
  const skillPath = path.join(__dirname, 'exec-comms', 'SKILL.md');
  let skillPrompt = '';
  if (fs.existsSync(skillPath)) {
    skillPrompt = fs.readFileSync(skillPath, 'utf8');
  } else {
    console.warn('  Warning: exec-comms/SKILL.md not found — using built-in defaults');
  }

  // ── Build Claude Prompt ──
  const typeLabels = {
    biweekly: 'Bi-Weekly Executive Update (Type 1)',
    weekly: 'Weekly Update (Type 2)',
    'deep-dive': 'Detailed Project Deep-Dive (Type 3)',
    e2e: 'End-to-End Testing Status Update (Type 4)',
  };

  const systemPrompt = `You are a PM communication generator. Follow these skill instructions exactly:\n\n${skillPrompt}\n\nIMPORTANT: You must output TWO clearly separated sections:\n1. The HTML email body (wrapped in <html-output> tags)\n2. The source references markdown document (wrapped in <references-output> tags)\n\nEvery data point in the email must be traceable in the references document.`;

  const userPrompt = `Generate a ${typeLabels[opts.type]} communication for ${today}.

Date range: ${opts.dateRange || 'last 7 days'}
Recipient: ${opts.to}

Here is the gathered data from all sources:

${JSON.stringify(gatheredData, null, 2)}

Sources accessed:
${sources.map((s, i) => `${i + 1}. ${s.name} (${s.type}) — accessed via ${s.method} at ${s.accessedAt} — ${s.recordCount} records — ${s.url}`).join('\n')}

Please generate:
1. The full HTML email body following the ${typeLabels[opts.type]} template from the skill
2. A comprehensive source references markdown document mapping every data point to its source

Tag [FindLaw] for ADO-sourced items and [MAC] for YouTrack-sourced items. For Airtable items, use the BU field to determine the tag.`;

  // ── Call Claude ──
  const response = await callClaude(systemPrompt, userPrompt);

  // ── Parse Output ──
  let htmlContent = response;
  let referencesContent = '';

  const htmlMatch = response.match(/<html-output>([\s\S]*?)<\/html-output>/);
  const refMatch = response.match(/<references-output>([\s\S]*?)<\/references-output>/);

  if (htmlMatch) htmlContent = htmlMatch[1].trim();
  if (refMatch) referencesContent = refMatch[1].trim();

  // If no structured tags, try to split on a common separator
  if (!htmlMatch && !refMatch) {
    const splitIndex = response.indexOf('# ');
    if (splitIndex > 200) {
      htmlContent = response.substring(0, splitIndex).trim();
      referencesContent = response.substring(splitIndex).trim();
    }
  }

  // ── Save Outputs ──
  const commFilename = `${opts.type}-${today}.html`;
  const refFilename = `${opts.type}-references-${today}.md`;
  const commPath = path.join(opts.outputDir, commFilename);
  const refPath = path.join(opts.outputDir, refFilename);

  fs.writeFileSync(commPath, htmlContent, 'utf8');
  console.log(`\n✅ Communication saved: ${commPath}`);

  if (!opts.noReferences && referencesContent) {
    fs.writeFileSync(refPath, referencesContent, 'utf8');
    console.log(`✅ References saved: ${refPath}`);
  } else if (!opts.noReferences) {
    // Generate a basic references doc from our source tracking
    const basicRef = generateBasicReferences(opts.type, today);
    fs.writeFileSync(refPath, basicRef, 'utf8');
    console.log(`✅ References saved (basic): ${refPath}`);
  }

  // ── Create Gmail Draft (optional) ──
  if (opts.draft) {
    console.log('\n📧 Creating Gmail draft...');
    // Gmail draft creation requires OAuth — use the token.json approach
    try {
      const subjectMap = {
        biweekly: `Q1 Bundle Projects — Bi-Weekly Executive Update (${today})`,
        weekly: `Weekly Project Update — ${today}`,
        'deep-dive': `Project Deep-Dive — ${today}`,
        e2e: `E2E Testing Status Update — Q1 Authority Bundles (${today})`,
      };

      // Refresh token and create draft via Gmail API
      const token = JSON.parse(fs.readFileSync(path.join(__dirname, 'token.json'), 'utf8'));
      const refreshData = new URLSearchParams({
        client_id: token.client_id,
        client_secret: token.client_secret,
        refresh_token: token.refresh_token,
        grant_type: 'refresh_token',
      });

      const refreshResponse = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'oauth2.googleapis.com',
          path: '/token',
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', reject);
        req.write(refreshData.toString());
        req.end();
      });

      if (refreshResponse.access_token) {
        const subject = subjectMap[opts.type] || `Project Update — ${today}`;
        const rawEmail = Buffer.from(
          `To: ${opts.to}\r\n` +
          (opts.cc ? `Cc: ${opts.cc}\r\n` : '') +
          `Subject: ${subject}\r\n` +
          `Content-Type: text/html; charset=UTF-8\r\n\r\n` +
          htmlContent
        ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        const draftResponse = await httpPost('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
          message: { raw: rawEmail }
        }, {
          'Authorization': `Bearer ${refreshResponse.access_token}`,
        });

        if (draftResponse.id) {
          console.log(`✅ Gmail draft created: ${draftResponse.id}`);
          console.log(`   Open: https://mail.google.com/mail/u/0/#drafts`);
        } else {
          console.error('   Gmail draft creation failed:', draftResponse);
        }
      }
    } catch (err) {
      console.error(`   Gmail draft failed: ${err.message}`);
      console.log('   You can manually create the draft from the generated HTML file.');
    }
  }

  console.log('\n🎉 Done!\n');
}

function generateBasicReferences(type, date) {
  return `# ${type.charAt(0).toUpperCase() + type.slice(1)} Communication — Source References
**Date:** ${date}
**Generated by:** generate-comm.js (backend script)

## Data Sources Used

| # | Source | Type | Access Method | Records | Accessed At |
|---|--------|------|---------------|---------|-------------|
${sources.map((s, i) => `| ${i + 1} | ${s.name} | ${s.type} | ${s.method} | ${s.recordCount} | ${s.accessedAt} |`).join('\n')}

## Source URLs

| Source | URL / Identifier |
|--------|-----------------|
${sources.map(s => `| ${s.name} | ${s.url} |`).join('\n')}

---
*Generated ${date} by generate-comm.js for eval/audit traceability.*
*Note: This is a basic references doc. For detailed section-by-section mapping, use Cowork mode.*
`;
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
