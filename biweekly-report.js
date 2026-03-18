/**
 * Bi-Weekly Executive Report Generator
 * Fetches tickets from YouTrack and ADO (via existing server.js and youtrack.js),
 * gathers child tickets, comments, and descriptions, then generates a formatted
 * Word report using the Q1 Bundle Premium Profiles & Network Footprint template.
 *
 * Prerequisites: Start server.js (ADO, port 3000) and youtrack.js (YouTrack, port 3001) first.
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { fetchGoogleChatSpaces } = require('./gchat-utils');
// docx import removed — report is now generated as HTML email + Gmail draft
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ADO_SERVER_URL = process.env.ADO_SERVER_URL || 'http://localhost:3000';
const YOUTRACK_SERVER_URL = process.env.YOUTRACK_SERVER_URL || 'http://localhost:3001';
const YOUTRACK_BASE_URL = process.env.YOUTRACK_BASE_URL || 'https://youtrack.internetbrands.com';

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// --- Helpers ---

function normalizeYouTrackInput(input) {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const match = trimmed.match(/([A-Z]+-\d+)/i);
  if (match) return YOUTRACK_BASE_URL + '/issue/' + match[1];
  return trimmed;
}

function parseAdoUrl(url) {
  const m = (url || '').match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_workitems\/edit\/(\d+)/);
  if (m) return { org: m[1], project: m[2], id: m[3] };
  const m2 = (url || '').match(/([^.]+)\.visualstudio\.com\/([^/]+)\/_workitems\/edit\/(\d+)/);
  if (m2) return { org: m2[1], project: m2[2], id: m2[3] };
  return null;
}

async function fetchFromYouTrack(urlOrId) {
  const url = normalizeYouTrackInput(urlOrId);
  if (!url) return { error: 'Invalid YouTrack ID or URL' };
  try {
    const res = await axios.post(YOUTRACK_SERVER_URL + '/api/analyze', { url }, { timeout: 120000 });
    return { url, data: res.data };
  } catch (e) {
    return { url, error: e.response?.data?.error || e.message };
  }
}

async function fetchFromAdo(adoUrl) {
  const trimmed = (adoUrl || '').trim();
  if (!trimmed || !parseAdoUrl(trimmed)) return { error: 'Invalid ADO URL' };
  try {
    const res = await axios.post(ADO_SERVER_URL + '/api/analyze', { url: trimmed }, { timeout: 120000 });
    return { url: trimmed, data: res.data };
  } catch (e) {
    return { url: trimmed, error: e.response?.data?.error || e.message };
  }
}

function summarizeTicketData(youtrackResults, adoResults) {
  const summary = {
    youtrack: youtrackResults.map(function (r) {
      if (r.error) return { url: r.url, error: r.error };
      const d = r.data;
      const tickets = d.tickets || {};
      const parent = tickets.parent || {};
      const children = tickets.children || [];
      return {
        source: 'youtrack',
        url: r.url,
        parentId: parent.id,
        parentTitle: parent.title,
        parentState: parent.state,
        childCount: children.length,
        children: children.map(function (c) {
          return { id: c.id, title: c.title, state: c.state, assignee: c.assignee };
        }),
        commentsCount: (tickets.allComments || []).reduce(function (sum, g) { return sum + (g.comments?.length || 0); }, 0),
        raw: d
      };
    }),
    ado: adoResults.map(function (r) {
      if (r.error) return { url: r.url, error: r.error };
      const d = r.data;
      const tickets = (d && d.tickets) ? d.tickets : d || {};
      const parent = tickets.parent || {};
      const children = tickets.children || [];
      return {
        source: 'ado',
        url: r.url,
        parentId: parent.id,
        parentTitle: parent.title,
        parentState: parent.state,
        childCount: children.length,
        children: children.map(function (c) {
          return { id: c.id, title: c.title, state: c.state, assignee: c.assignee };
        }),
        commentsCount: (tickets.allComments || []).reduce(function (sum, g) { return sum + (g.comments?.length || 0); }, 0),
        raw: d
      };
    })
  };
  return summary;
}


// Reduce payload for AI to stay under 200k token limit (~80k tokens for data target)
const MAX_DESC_PARENT = 350;
const MAX_DESC_CHILD = 150;
const MAX_COMMENT = 100;
const MAX_COMMENTS_PARENT = 4;
const MAX_COMMENTS_CHILD = 2;
const MAX_CHILDREN_PER_EPIC = 12;
const MAX_RECENT_COMMENTS_TOTAL = 20;
const MAX_EPICS_YOUTRACK = 4;
const MAX_EPICS_ADO = 4;
const MAX_ADDITIONAL_CONTEXT_CHARS = 3000;
const MAX_DATA_CHARS = 300000;

function optimizeForAI(youtrackResults, adoResults) {
  function compactTicket(t, opts) {
    const maxDesc = opts.maxDesc || 500;
    const maxComments = opts.maxComments || 6;
    const desc = (t.description || '').replace(/\s+/g, ' ').trim();
    const comments = (t.comments || []).slice(-maxComments).map(function (c) {
      const text = (c.text || '').replace(/\s+/g, ' ').trim();
      return { author: c.author, date: c.createdDate, text: text.length > MAX_COMMENT ? text.substring(0, MAX_COMMENT) + '...' : text };
    });
    return { id: t.id, title: t.title, state: t.state, assignee: t.assignee, updated: t.updatedDate || t.changedDate, description: desc.length > maxDesc ? desc.substring(0, maxDesc) + '...' : desc, comments };
  }

  function compactEpic(raw) {
    const data = raw.tickets || raw;
    const parent = data.parent;
    const children = (data.children || []).slice(0, MAX_CHILDREN_PER_EPIC);
    const allComments = data.allComments || [];
    const flatComments = [];
    allComments.forEach(function (g) {
      (g.comments || []).slice(-5).forEach(function (c) {
        const text = (c.text || '').replace(/\s+/g, ' ').trim();
        flatComments.push({ ticketId: g.issueId || g.workItemId, ticketTitle: g.issueTitle || g.workItemTitle, author: c.author || (c.createdBy), date: c.createdDate, text: text.length > MAX_COMMENT ? text.substring(0, MAX_COMMENT) + '...' : text });
      });
    });
    flatComments.sort(function (a, b) { return new Date(b.date || 0) - new Date(a.date || 0); });
    const recentComments = flatComments.slice(0, MAX_RECENT_COMMENTS_TOTAL);
    return {
      parent: parent ? compactTicket(parent, { maxDesc: MAX_DESC_PARENT, maxComments: MAX_COMMENTS_PARENT }) : null,
      children: children.map(function (c) { return compactTicket(c, { maxDesc: MAX_DESC_CHILD, maxComments: MAX_COMMENTS_CHILD }); }),
      recentComments: recentComments
    };
  }

  const youtrack = youtrackResults.filter(function (r) { return !r.error && r.data; }).slice(0, MAX_EPICS_YOUTRACK).map(function (r) {
    return { url: r.url, data: compactEpic(r.data) };
  });
  const ado = adoResults.filter(function (r) { return !r.error && r.data; }).slice(0, MAX_EPICS_ADO).map(function (r) {
    return { url: r.url, data: compactEpic(r.data) };
  });
  return { youtrack, ado };
}

const REPORT_PROMPT = `You are a Senior TPM generating a bi-weekly status update for the Q1 Bundle Premium Profiles & Network Footprint workstream.

You will receive aggregated ticket data from YouTrack (tag as [MAC]) and Azure DevOps (tag as [FindLaw]): parent epics and their child tickets, plus comments and descriptions. Optionally you may receive "Additional context from the user" (team updates, meeting notes, Airtable project status, Google Chat messages); use it heavily to infer real project names, percentages, and statuses. Use all of this to produce the report.

PROPERTY / BU LABELING (REQUIRED):
- FindLaw properties (LD, FindLaw, Abogado, Law Info) → label as "(FL)" inline or "[FindLaw]" in narratives
- MAC properties (Avvo.com, Lawyers.com, Martindale.com) → label as "(MAC)" inline or "[MAC]" in narratives
- If both → "(FL/MAC)" or "[FindLaw/MAC]"

BI-WEEKLY RECENCY (REQUIRED):
- Include ONLY updates, decisions, milestones from the last two weeks (on or after cutoffDate) in your output.
- Use older data only as background context when interpreting recent activity.

OUTPUT FORMAT: Return a single JSON object (no markdown, no code fence) with the following keys exactly:

{
  "executiveSummary": "2-3 sentence executive summary paragraph. Describe overall portfolio momentum, notable completions, health status inline (e.g. 'tracking predominantly GREEN'), and any items requiring attention.",
  "overallHealthStatus": "GREEN" | "YELLOW" | "RED",
  "majorMilestones": [
    {"text": "Cross-Network Awards MAC — Completed 3/3", "statusColor": "green"},
    {"text": "Dynamic AI Intake Form on FL & LI Profiles — 95% Delayed, end 3/29", "statusColor": "yellow"}
  ],
  "keyTechnicalDecisions": [
    {"title": "Review Categorization Experience:", "description": "Dynamic review categorization display only renders when matching Areas of Practice (AoP) are available, reducing irrelevant noise."},
    ...
  ],
  "workstreams": [
    {
      "name": "Dynamic Profiles",
      "projects": [
        {"name": "AI Summarization & Categorization by PA (FL)", "pct": "98%", "statusLabel": "On Track", "statusColor": "green", "endDate": "3/29"},
        {"name": "Dynamic AI Intake Form on FL & LI Profiles (FL)", "pct": "95%", "statusLabel": "Delayed", "statusColor": "yellow", "endDate": "3/29"}
      ]
    },
    {
      "name": "Chat & AI Intake",
      "projects": [...]
    },
    {
      "name": "Data & Analytics",
      "projects": [...]
    },
    {
      "name": "Sales Enablement & Fulfillment",
      "projects": [...]
    }
  ],
  "criticalPathItems": [
    {"title": "Dynamic AI Intake Form on FL & LI Profiles", "description": "Status: 95% complete but delayed. Expected completion 3/29. Blocking profile experience completeness across network."},
    ...
  ],
  "adoMetrics": {
    "openItems": "242 (Lawyer Directory: 117, Front End: 56, PALS: 69)",
    "accomplished": "155",
    "openFocus": "Profile/reviews platform changes (80); QA/testing validation (47); SRP/attorney-listings behavior (30)",
    "keyOpenItems": ["Attorney Listings SRP QA/code review", "Profile Bundling bugs", "Review categorization bugs (#247658, #247372)"]
  },
  "upNextWeek1Label": "Week of Mar 17–21",
  "upNextWeek1Items": ["...", ...],
  "upNextWeek2Label": "Week of Mar 24–28",
  "upNextWeek2Items": ["...", ...],
  "decisionsMade": [
    {
      "decision": "Sort-by-most-recent logic for review categorization approved for rollout",
      "source": "[FindLaw]",
      "owner": "Engineering",
      "date": "3/9",
      "context": "Passed UAT; positioned for production release post-MVP."
    },
    ...
  ],
  "decisionsPending": [{"decision": "", "owner": "", "targetDate": ""}, ...],
  "appendixRows": [{"project": "", "macPct": "", "findLawPct": "", "status": ""}, ...],
  "teamUpdatesNote": "PM Note: ..."
}

RULES:
- Use real project names and data from ticket descriptions, comments, and additional context. Do not invent ticket numbers.
- Keep tone professional, concise, action-oriented.
- Infer workstream groupings from project names: Dynamic Profiles; Chat & AI Intake; Data & Analytics; Sales Enablement & Fulfillment; Retargeting; E2E Testing. Only include workstreams that have projects.
- statusColor values: "green" = On Track/Completed, "yellow" = Delayed/At Risk, "red" = Blocked.
- adoMetrics: derive open item counts from ADO child ticket states and area paths when possible. Set to null if insufficient data.
- Limit criticalPathItems to the 2-4 most important items requiring attention.
- appendixRows status values: "Green", "Green - Unblocked", "Green - Manual MVP", "Yellow", "Red", "In Progress", "Starting ([Owner])".
- Dates: use the report date provided. Only include content from on or after cutoffDate.
- decisionsMade: scan ALL sources — ADO ticket comments and state transitions, YouTrack comments and state transitions, and Google Chat messages — for any explicit decisions, approvals, resolutions, scope confirmations, or "go/no-go" calls made on or after cutoffDate. Include the source tag ([FindLaw], [MAC], or [Chat]), the person who made or confirmed the decision (owner), approximate date, and a one-line context note. If nothing was decided this period, return an empty array.
`;

function extractJsonFromResponse(text) {
  let str = (text || '').trim();
  const codeBlock = str.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) str = codeBlock[1].trim();
  const start = str.indexOf('{');
  const end = str.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    str = str.substring(start, end + 1);
  }
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}

// --- Email HTML building ---

function statusDot(color) {
  const colors = { green: '#4caf50', yellow: '#ff9800', red: '#f44336' };
  const hex = colors[color] || '#9e9e9e';
  return '<span style="display:inline-block;width:11px;height:11px;border-radius:2px;background:' + hex + ';margin-right:7px;vertical-align:middle;"></span>';
}

function buildEmailHtml(r, reportDate, dateRange) {
  const health = (r.overallHealthStatus || 'GREEN').toUpperCase();
  const healthColor = health === 'GREEN' ? '#4caf50' : health === 'YELLOW' ? '#ff9800' : '#f44336';

  let html = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<style>body{font-family:Arial,sans-serif;font-size:14px;line-height:1.6;color:#333;background:#f9f9f9;padding:20px;}' +
    '.c{max-width:800px;background:#fff;padding:30px;border-radius:5px;box-shadow:0 1px 3px rgba(0,0,0,.1);}' +
    'h1{margin-top:0;font-size:18px;border-bottom:2px solid #333;padding-bottom:10px;}' +
    'h2{font-size:16px;margin-top:24px;color:#222;}h3{font-size:14px;margin-top:16px;color:#444;}' +
    'ul{margin:8px 0;padding-left:20px;}li{margin:5px 0;}' +
    '.metric{background:#f0f0f0;padding:10px;border-left:4px solid #2196f3;margin:12px 0;}' +
    '.footer{margin-top:30px;padding-top:20px;border-top:1px solid #ddd;font-size:13px;color:#666;}' +
    '</style></head><body><div class="c">';

  html += '<div style="font-weight:bold;margin-bottom:18px;font-size:13px;color:#666;">Subject: Q1 Bundle Premium Profiles &amp; Network Footprint — Bi-Weekly Executive Update (' + (dateRange || reportDate) + ')</div>';
  html += '<h1>Q1 Bundle: Bi-Weekly Executive Update</h1>';

  // Executive Summary
  html += '<h2>Executive Summary</h2>';
  html += '<p>' + (r.executiveSummary || '') + '</p>';
  html += '<p>Overall Health: <strong style="color:' + healthColor + ';">' + health + '</strong></p>';

  // Major Milestones
  if (r.majorMilestones && r.majorMilestones.length) {
    html += '<h2>Major Milestones Achieved (Last Two Weeks)</h2><ul>';
    r.majorMilestones.forEach(function (m) {
      const text = typeof m === 'string' ? m : (m.text || '');
      const color = typeof m === 'object' ? (m.statusColor || 'green') : 'green';
      html += '<li>' + statusDot(color) + '<strong>' + escHtml(text) + '</strong></li>';
    });
    html += '</ul>';
  }

  // Key Technical Decisions
  if (r.keyTechnicalDecisions && r.keyTechnicalDecisions.length) {
    html += '<h2>Key Technical Decisions</h2><ul>';
    r.keyTechnicalDecisions.forEach(function (d) {
      if (typeof d === 'string') {
        html += '<li>' + escHtml(d) + '</li>';
      } else {
        html += '<li><strong>' + escHtml(d.title || '') + '</strong> ' + escHtml(d.description || '') + '</li>';
      }
    });
    html += '</ul>';
  }

  // In-Flight Projects by Workstream
  if (r.workstreams && r.workstreams.length) {
    html += '<h2>In-Flight Projects — Status by Workstream</h2>';
    r.workstreams.forEach(function (ws) {
      html += '<h3>' + escHtml(ws.name || '') + '</h3><ul>';
      (ws.projects || []).forEach(function (p) {
        const color = p.statusColor || 'green';
        const label = p.statusLabel || 'On Track';
        const pct = p.pct ? p.pct + ' ' : '';
        const endDate = p.endDate ? ', end ' + p.endDate : '';
        const isBold = color !== 'green';
        const line = (p.name || '') + ' — ' + pct + label + endDate;
        html += '<li>' + statusDot(color) + (isBold ? '<strong>' + escHtml(line) + '</strong>' : escHtml(line)) + '</li>';
      });
      html += '</ul>';
    });
  }

  // Critical Path Items
  if (r.criticalPathItems && r.criticalPathItems.length) {
    html += '<h2>Critical Path Items Requiring Attention</h2>';
    r.criticalPathItems.forEach(function (c) {
      if (typeof c === 'string') {
        html += '<div class="metric">' + escHtml(c) + '</div>';
      } else {
        html += '<div class="metric"><strong>' + escHtml(c.title || '') + '</strong><br>' + escHtml(c.description || '') + '</div>';
      }
    });
  }

  // Decisions Made
  if (r.decisionsMade && r.decisionsMade.length) {
    html += '<h2>Decisions Made (Last Two Weeks)</h2>';
    html += '<table style="border-collapse:collapse;width:100%;font-size:13px;">';
    html += '<tr style="background:#f0f0f0;"><th style="border:1px solid #ccc;padding:6px 10px;text-align:left;">Decision</th><th style="border:1px solid #ccc;padding:6px 10px;text-align:left;">Source</th><th style="border:1px solid #ccc;padding:6px 10px;text-align:left;">Owner</th><th style="border:1px solid #ccc;padding:6px 10px;text-align:left;">Date</th><th style="border:1px solid #ccc;padding:6px 10px;text-align:left;">Context</th></tr>';
    r.decisionsMade.forEach(function (d) {
      html += '<tr>';
      html += '<td style="border:1px solid #ccc;padding:6px 10px;"><strong>' + escHtml(d.decision || '') + '</strong></td>';
      html += '<td style="border:1px solid #ccc;padding:6px 10px;">' + escHtml(d.source || '') + '</td>';
      html += '<td style="border:1px solid #ccc;padding:6px 10px;">' + escHtml(d.owner || '') + '</td>';
      html += '<td style="border:1px solid #ccc;padding:6px 10px;white-space:nowrap;">' + escHtml(d.date || '') + '</td>';
      html += '<td style="border:1px solid #ccc;padding:6px 10px;">' + escHtml(d.context || '') + '</td>';
      html += '</tr>';
    });
    html += '</table>';
  }

  // ADO Metrics
  if (r.adoMetrics) {
    const m = r.adoMetrics;
    html += '<h2>ADO Metrics</h2><ul>';
    if (m.openItems) html += '<li>Open work items: ' + escHtml(m.openItems) + '</li>';
    if (m.accomplished) html += '<li>Accomplished in last two weeks: ' + escHtml(m.accomplished) + '</li>';
    if (m.openFocus) html += '<li>Open work focus: ' + escHtml(m.openFocus) + '</li>';
    if (m.keyOpenItems && m.keyOpenItems.length) html += '<li>Key open items: ' + m.keyOpenItems.map(escHtml).join(', ') + '</li>';
    html += '</ul>';
  }

  // Up Next
  if ((r.upNextWeek1Items && r.upNextWeek1Items.length) || (r.upNextWeek2Items && r.upNextWeek2Items.length)) {
    html += '<h2>Up Next — Focus Areas for Next Two Weeks</h2>';
    if (r.upNextWeek1Label || (r.upNextWeek1Items && r.upNextWeek1Items.length)) {
      html += '<h3>' + escHtml(r.upNextWeek1Label || 'Week 1') + '</h3><ul>';
      (r.upNextWeek1Items || []).forEach(function (x) { html += '<li>' + escHtml(x) + '</li>'; });
      html += '</ul>';
    }
    if (r.upNextWeek2Label || (r.upNextWeek2Items && r.upNextWeek2Items.length)) {
      html += '<h3>' + escHtml(r.upNextWeek2Label || 'Week 2') + '</h3><ul>';
      (r.upNextWeek2Items || []).forEach(function (x) { html += '<li>' + escHtml(x) + '</li>'; });
      html += '</ul>';
    }
  }

  // Decisions Pending
  if (r.decisionsPending && r.decisionsPending.length) {
    html += '<h2>Decisions Pending</h2><ul>';
    r.decisionsPending.forEach(function (d) {
      html += '<li><strong>' + escHtml(d.decision || '') + '</strong> — Owner: ' + escHtml(d.owner || 'TBD') + ', by ' + escHtml(d.targetDate || 'TBD') + '</li>';
    });
    html += '</ul>';
  }

  // Team Notes
  if (r.teamUpdatesNote) {
    html += '<h2>Team Updates</h2><p>' + escHtml(r.teamUpdatesNote) + '</p>';
  }

  html += '<div class="footer"><p><strong>Contact:</strong> Romit Nath (romit.nath@internetbrands.com)<br><strong>Generated:</strong> ' + reportDate + '</p></div>';
  html += '</div></body></html>';
  return html;
}

function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// --- Gmail draft creation ---

async function createGmailDraft(subject, htmlBody) {
  const fs = require('fs');
  let tokenData, credData;
  try {
    tokenData = JSON.parse(fs.readFileSync(path.join(__dirname, 'token.json'), 'utf8'));
    credData = JSON.parse(fs.readFileSync(path.join(__dirname, 'oauth_credentials.json'), 'utf8'));
  } catch (e) {
    return { error: 'Could not read token.json or oauth_credentials.json: ' + e.message };
  }

  const creds = credData.installed || credData.web || credData;
  const clientId = creds.client_id;
  const clientSecret = creds.client_secret;
  const refreshToken = tokenData.refresh_token;

  if (!clientId || !clientSecret || !refreshToken) {
    return { error: 'Missing OAuth credentials in token.json or oauth_credentials.json' };
  }

  // Refresh access token
  let accessToken;
  try {
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    accessToken = tokenRes.data.access_token;
  } catch (e) {
    return { error: 'OAuth token refresh failed: ' + (e.response?.data?.error_description || e.message) };
  }

  // Build raw RFC2822 message
  const to = 'romit.nath@internetbrands.com';
  const boundary = 'boundary_' + Date.now();
  const rawMsg = [
    'To: ' + to,
    'Subject: ' + subject,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    htmlBody
  ].join('\r\n');

  const encodedMsg = Buffer.from(rawMsg).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  try {
    const draftRes = await axios.post(
      'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
      { message: { raw: encodedMsg } },
      { headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' } }
    );
    const draftId = draftRes.data.id;
    return { draftId, draftUrl: 'https://mail.google.com/mail/u/0/#drafts' };
  } catch (e) {
    return { error: 'Gmail draft creation failed: ' + (e.response?.data?.error?.message || e.message) };
  }
}

// --- API ---

app.post('/api/fetch-tickets', async function (req, res) {
  const youtrackInputs = [].concat(req.body.youtrackIds || req.body.youtrackUrls || []).filter(Boolean);
  const adoUrls = [].concat(req.body.adoUrls || []).filter(Boolean);

  const youtrackResults = [];
  const adoResults = [];

  for (let i = 0; i < youtrackInputs.length; i++) {
    const r = await fetchFromYouTrack(youtrackInputs[i]);
    youtrackResults.push(r);
  }
  for (let j = 0; j < adoUrls.length; j++) {
    const r = await fetchFromAdo(adoUrls[j]);
    adoResults.push(r);
  }

  const summary = summarizeTicketData(youtrackResults, adoResults);
  res.json({ summary, youtrackResults, adoResults });
});

app.post('/api/generate-report', async function (req, res) {
  const reportDate = (req.body.reportDate || new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })).trim();
  const youtrackInputs = [].concat(req.body.youtrackIds || req.body.youtrackUrls || []).filter(Boolean);
  const adoUrls = [].concat(req.body.adoUrls || []).filter(Boolean);

  if (youtrackInputs.length === 0 && adoUrls.length === 0) {
    return res.status(400).json({ error: 'Provide at least one YouTrack ID/URL or ADO URL' });
  }

  const youtrackResults = [];
  const adoResults = [];

  for (let i = 0; i < youtrackInputs.length; i++) {
    const r = await fetchFromYouTrack(youtrackInputs[i]);
    youtrackResults.push(r);
  }
  for (let j = 0; j < adoUrls.length; j++) {
    const r = await fetchFromAdo(adoUrls[j]);
    adoResults.push(r);
  }

  function parseReportDate(dateStr) {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return new Date();
    return d;
  }
  function formatShortDate(d) {
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  }
  const reportDateObj = parseReportDate(reportDate);
  const cutoffDateObj = new Date(reportDateObj);
  cutoffDateObj.setDate(cutoffDateObj.getDate() - 14);
  const cutoffDate = formatShortDate(cutoffDateObj);

  let additionalContextRaw = (req.body.additionalContext || '').trim();

  if (req.body.chatSpaces && req.body.chatSpaces.trim()) {
    const spaceNames = req.body.chatSpaces.split(/[\n,]+/).map(function(s) { return s.trim(); }).filter(Boolean);
    const chatTranscript = await fetchGoogleChatSpaces(spaceNames, req.body.chatAfterDate || null);
    if (chatTranscript) {
      additionalContextRaw = (additionalContextRaw + '\n\nGoogle Chat messages:\n' + chatTranscript).trim();
    }
  }

  const additionalContext = additionalContextRaw.length > MAX_ADDITIONAL_CONTEXT_CHARS
    ? additionalContextRaw.substring(0, MAX_ADDITIONAL_CONTEXT_CHARS) + '\n[... truncated for length]'
    : additionalContextRaw;

  let optimized = optimizeForAI(youtrackResults, adoResults);
  let payload = { reportDate, cutoffDate, youtrack: optimized.youtrack, ado: optimized.ado };
  let payloadStr = JSON.stringify(payload);
  let promptPrefix = REPORT_PROMPT + '\n\nReport date: ' + reportDate + '. Cutoff date (only include updates from this date or later in the output): ' + cutoffDate + '\n\n';
  if (additionalContext) {
    promptPrefix += 'Additional context from the user:\n' + additionalContext + '\n\n';
  }
  promptPrefix += 'Ticket data (YouTrack and ADO epics with children and comments):\n';
  const maxDataChars = Math.min(MAX_DATA_CHARS, 200000 * 4 - promptPrefix.length - 5000);
  if (payloadStr.length > maxDataChars) {
    optimized = optimizeForAI(youtrackResults.slice(0, 3), adoResults.slice(0, 3));
    payload = { reportDate, cutoffDate, youtrack: optimized.youtrack, ado: optimized.ado };
    payloadStr = JSON.stringify(payload);
  }
  if (payloadStr.length > maxDataChars) {
    payload.youtrack.forEach(function (epic) {
      if (epic.data && epic.data.recentComments) epic.data.recentComments = epic.data.recentComments.slice(0, 12);
      if (epic.data && epic.data.children) epic.data.children = epic.data.children.slice(0, 8);
    });
    payload.ado.forEach(function (epic) {
      if (epic.data && epic.data.recentComments) epic.data.recentComments = epic.data.recentComments.slice(0, 12);
      if (epic.data && epic.data.children) epic.data.children = epic.data.children.slice(0, 8);
    });
    payloadStr = JSON.stringify(payload);
  }
  while (payloadStr.length > maxDataChars && (payload.youtrack.length > 1 || payload.ado.length > 1)) {
    if (payload.youtrack.length > payload.ado.length) {
      payload.youtrack.pop();
    } else {
      payload.ado.pop();
    }
    payloadStr = JSON.stringify(payload);
  }
  if (payloadStr.length > maxDataChars) {
    return res.status(400).json({ error: 'Ticket data is too large for the model. Use fewer YouTrack/ADO tickets (e.g. 2–3 epics total) or shorter additional context.' });
  }
  const prompt = promptPrefix + payloadStr;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 16000,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = msg.content[0].text;
    const reportJson = extractJsonFromResponse(text);
    if (!reportJson) {
      return res.status(500).json({ error: 'AI did not return valid JSON', raw: text.substring(0, 2000) });
    }

    const reportDateObj2 = new Date(reportDate);
    const cutoffDateObj2 = new Date(reportDateObj2);
    cutoffDateObj2.setDate(cutoffDateObj2.getDate() - 14);
    const dateRange = [
      (cutoffDateObj2.getMonth() + 1) + '/' + cutoffDateObj2.getDate(),
      '–',
      (reportDateObj2.getMonth() + 1) + '/' + reportDateObj2.getDate() + ', ' + reportDateObj2.getFullYear()
    ].join(' ');

    const htmlBody = buildEmailHtml(reportJson, reportDate, dateRange);
    const subject = 'Q1 Bundle Premium Profiles & Network Footprint — Bi-Weekly Executive Update (' + dateRange + ')';

    const draftResult = await createGmailDraft(subject, htmlBody);

    res.json({
      success: true,
      subject,
      draftId: draftResult.draftId || null,
      draftUrl: draftResult.draftUrl || null,
      draftError: draftResult.error || null,
      htmlPreview: htmlBody
    });
  } catch (e) {
    console.error('Generate report error:', e);
    res.status(500).json({ error: e.message });
  }
});

// --- Dashboard ---

const DASHBOARD_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Bi-Weekly Executive Report | Q1 Bundle</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-white min-h-screen p-6">
  <div class="max-w-4xl mx-auto">
    <h1 class="text-3xl font-bold text-center mb-2">Bi-Weekly Executive Report</h1>
    <p class="text-slate-400 text-center mb-6">Q1 Bundle Premium Profiles &amp; Network Footprint — Enter YouTrack and ADO ticket IDs/URLs; report is generated from parent and child tickets, comments, and descriptions.</p>

    <div class="bg-slate-800 rounded-xl p-4 mb-4">
      <p class="text-sm text-amber-200 mb-4">Prerequisites: Start <strong>server.js</strong> (ADO, port 3000) and <strong>youtrack.js</strong> (YouTrack, port 3001) before generating the report.</p>
      <label class="block text-sm font-medium text-slate-300 mb-2">Report date</label>
      <input type="text" id="reportDate" placeholder="e.g. 2/2/2026" class="w-full bg-slate-700 rounded-lg p-3 border border-slate-600 mb-4" value="">
      <label class="block text-sm font-medium text-slate-300 mb-2">YouTrack ticket IDs or URLs (one per line)</label>
      <textarea id="youtrackIds" rows="4" placeholder="UNSER-1141&#10;CSMR-15266&#10;https://youtrack.internetbrands.com/issue/UNSER-1141" class="w-full bg-slate-700 rounded-lg p-3 border border-slate-600 font-mono text-sm mb-4"></textarea>
      <label class="block text-sm font-medium text-slate-300 mb-2">ADO ticket URLs (one per line)</label>
      <textarea id="adoUrls" rows="4" placeholder="https://dev.azure.com/org/project/_workitems/edit/12345" class="w-full bg-slate-700 rounded-lg p-3 border border-slate-600 font-mono text-sm mb-4"></textarea>
      <label class="block text-sm font-medium text-slate-300 mb-2">Google Chat spaces (optional — name or ID, one per line)</label>
      <textarea id="chatSpaces" rows="3" placeholder="Q1 Bundles - PMO&#10;MAC Review Aggregation Service (RAS)&#10;spaces/AAQARjk9mWY" class="w-full bg-slate-700 rounded-lg p-3 border border-slate-600 font-mono text-sm mb-2"></textarea>
      <input type="text" id="chatAfterDate" placeholder="Chat messages after date (e.g. 2026-03-01)" class="w-full bg-slate-700 rounded-lg p-3 border border-slate-600 font-mono text-sm mb-4">
      <label class="block text-sm font-medium text-slate-300 mb-2">Additional context (optional)</label>
      <textarea id="additionalContext" rows="4" placeholder="Paste team updates, meeting notes, exclusions, or any extra context to include when generating the report. Max ~3000 characters." class="w-full bg-slate-700 rounded-lg p-3 border border-slate-600 text-sm mb-4"></textarea>
      <div class="flex gap-3">
        <button type="button" id="btnFetch" class="px-6 py-3 bg-slate-600 hover:bg-slate-500 rounded-lg font-medium">Fetch tickets only</button>
        <button type="button" id="btnGenerate" class="px-6 py-3 bg-teal-600 hover:bg-teal-500 rounded-lg font-medium">Generate report &amp; create Gmail draft</button>
      </div>
      <div id="status" class="mt-3 text-sm text-slate-400"></div>
    </div>

    <div id="fetchResult" class="hidden bg-slate-800 rounded-xl p-4 mb-4 overflow-auto max-h-96">
      <h3 class="font-bold mb-2">Fetched summary</h3>
      <pre id="fetchPre" class="text-xs text-slate-300 whitespace-pre-wrap"></pre>
    </div>

    <div id="previewSection" class="hidden bg-white rounded-xl mb-4">
      <div class="bg-slate-800 rounded-t-xl px-4 py-2 flex justify-between items-center">
        <span class="font-bold text-sm">Email Preview</span>
      </div>
      <iframe id="previewFrame" class="w-full rounded-b-xl" style="height:600px;border:none;"></iframe>
    </div>
  </div>

  <script>
    document.getElementById('reportDate').value = new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });

    function getPayload() {
      const youtrackRaw = (document.getElementById('youtrackIds').value || '').trim().split(/[\\n,;]/).map(function(s) { return s.trim(); }).filter(Boolean);
      const adoRaw = (document.getElementById('adoUrls').value || '').trim().split(/[\\n,;]/).map(function(s) { return s.trim(); }).filter(Boolean);
      const chatSpaces = (document.getElementById('chatSpaces').value || '').trim();
      const chatAfterDate = (document.getElementById('chatAfterDate').value || '').trim();
      return {
        reportDate: document.getElementById('reportDate').value.trim(),
        youtrackIds: youtrackRaw,
        adoUrls: adoRaw,
        chatSpaces: chatSpaces || undefined,
        chatAfterDate: chatAfterDate || undefined,
        additionalContext: (document.getElementById('additionalContext').value || '').trim()
      };
    }

    document.getElementById('btnFetch').onclick = async function() {
      var payload = getPayload();
      if (payload.youtrackIds.length === 0 && payload.adoUrls.length === 0) {
        document.getElementById('status').textContent = 'Enter at least one YouTrack ID/URL or ADO URL.';
        return;
      }
      document.getElementById('status').textContent = 'Fetching tickets...';
      document.getElementById('btnFetch').disabled = true;
      try {
        var res = await fetch('/api/fetch-tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        var data = await res.json();
        document.getElementById('fetchPre').textContent = JSON.stringify(data.summary, null, 2);
        document.getElementById('fetchResult').classList.remove('hidden');
        document.getElementById('status').textContent = 'Fetched: ' + (data.youtrackResults || []).length + ' YouTrack, ' + (data.adoResults || []).length + ' ADO. Check summary above.';
      } catch (e) {
        document.getElementById('status').textContent = 'Error: ' + e.message;
      }
      document.getElementById('btnFetch').disabled = false;
    };

    document.getElementById('btnGenerate').onclick = async function() {
      var payload = getPayload();
      if (payload.youtrackIds.length === 0 && payload.adoUrls.length === 0) {
        document.getElementById('status').textContent = 'Enter at least one YouTrack ID/URL or ADO URL.';
        return;
      }
      document.getElementById('status').textContent = 'Fetching tickets and generating report...';
      document.getElementById('btnGenerate').disabled = true;
      try {
        var res = await fetch('/api/generate-report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!res.ok) {
          var err = await res.json().catch(function() { return {}; });
          throw new Error(err.error || res.statusText);
        }
        var data = await res.json();
        var statusEl = document.getElementById('status');
        if (data.draftUrl && !data.draftError) {
          statusEl.innerHTML = '✅ Gmail draft created — <a href="' + data.draftUrl + '" target="_blank" style="color:#5eead4;">Open in Gmail</a>';
        } else {
          var msg = '✅ Report generated.';
          if (data.draftError) msg += ' (Gmail draft failed: ' + data.draftError + ')';
          statusEl.textContent = msg;
        }
        if (data.htmlPreview) {
          document.getElementById('previewFrame').srcdoc = data.htmlPreview;
          document.getElementById('previewSection').classList.remove('hidden');
        }
      } catch (e) {
        document.getElementById('status').textContent = 'Error: ' + e.message;
      }
      document.getElementById('btnGenerate').disabled = false;
    };
  </script>
</body>
</html>`;

app.get('/', function (req, res) {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(DASHBOARD_HTML);
});

const PORT = process.env.BIWEEKLY_REPORT_PORT || 3002;
app.listen(PORT, function () {
  console.log('========================================');
  console.log('  Bi-Weekly Executive Report Generator');
  console.log('  Open http://localhost:' + PORT);
  console.log('  Ensure server.js (ADO :3000) and youtrack.js (YouTrack :3001) are running.');
  console.log('========================================');
});
