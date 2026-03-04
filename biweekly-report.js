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
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  PageBreak,
  AlignmentType,
  ShadingType,
  convertInchesToTwip
} = require('docx');
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

You will receive aggregated ticket data from YouTrack and Azure DevOps (ADO): parent epics and their child tickets, plus comments and descriptions. Optionally you may receive "Additional context from the user" (team updates, meeting notes, exclusions); use it to inform the report when provided. Use all of this to fill the report structure below. Extract:
- Major milestones, completions, and production releases from ticket statuses and comments
- Key technical decisions from comments and descriptions
- Critical path items, blockers, risks from comments and status
- Milestones (next 2-4 weeks), scope/schedule changes, project status items, up next, decisions pending
- Appendix: project completion summary table; key technical decisions this period; team updates

PROPERTY / BU LABELING (REQUIRED):
When an update, milestone, or item applies to one of these property groups, explicitly indicate it in the output:
- **FindLaw properties**: LD (Legal Directories), FindLaw, Abogado, Law Info — label as "[FindLaw]" or name the specific property (e.g. "[FindLaw - LD]", "[Law Info]").
- **MAC properties**: Avvo.com, Lawyers.com, Martindale.com — label as "[MAC]" or name the specific property (e.g. "[MAC - Avvo]", "[Lawyers.com]").
Use this in bullets, project status lines, key milestones, and appendix where the context is FindLaw vs MAC. If it applies to both or the whole bundle, you may say so instead of labeling a single property.

BI-WEEKLY RECENCY (REQUIRED):
- You will receive reportDate and cutoffDate (14 days before report date). Use older comments/updates only for context when interpreting recent work.
- In the report OUTPUT (all JSON fields you return), include ONLY updates, decisions, milestones, and items that are from the last two weeks (on or after cutoffDate). Do not write into the report narrative or bullets any detail that is older than two weeks.
- Summarize the current state and recent (≤2 week) activity; omit historical detail from the written output.

OUTPUT FORMAT: Return a single JSON object (no markdown, no code fence) with the following keys. Use the exact keys so the document generator can parse them.

{
  "majorMilestones": ["bullet 1", "bullet 2", ...],
  "oneSentenceSummary": "Teams are executing on remaining scope with all projects tracking [COLOR] for completion by [TARGET DATE].",
  "keyTechnicalDecisionsFinalized": ["(1) Decision name—brief description", ...],
  "criticalPathItems": ["item 1", "item 2", ...],
  "overallHealthStatus": "GREEN" or "YELLOW" or "RED",
  "overallHealthAssessment": "1-2 sentence summary of overall program health",
  "keyMilestones": [{"milestone": "", "targetDate": "", "owner": "", "status": "On Track|At Risk|Blocked"}, ...],
  "scopeText": "No new scope changes this period." or bullet list string,
  "schedulesText": "No schedule changes this period." or bullet list string,
  "projectStatusItems": [{"projectName": "", "keyStatusLine": "", "secondStatusLine": "", "updateDate": "", "bullets": ["", ...], "decisionMade": ["", ...] or null, "decisionNeeded": "" or null, "pathToGreen": ""}, ...],
  "upNextWeek1Label": "Week of Feb 2–6",
  "upNextWeek1Items": ["", ...],
  "upNextWeek2Label": "Week of Feb 9–13",
  "upNextWeek2Items": ["", ...],
  "decisionsPending": [{"decision": "", "owner": "", "targetDate": ""}, ...],
  "appendixRows": [{"project": "", "macPct": "", "findLawPct": "", "status": ""}, ...],
  "keyTechnicalDecisionsTable": [{"decision": "", "details": "", "impact": ""}, ...],
  "teamUpdatesNote": "PM Note: ..."
}

RULES:
- Use only information inferred from the provided ticket data (statuses, comments, descriptions). Do not invent ticket numbers.
- Keep tone professional, concise, action-oriented. No jargon without context.
- Status values for appendix: "Green", "Green - Unblocked", "Green - Manual MVP", "Yellow", "Red", "In Progress", "Starting ([Owner])".
- For percentages use "N/A" where not applicable.
- Limit keyMilestones to 4-6; criticalPathItems to 2-3; projectStatusItems to items requiring attention.
- Dates: use the report date provided for "current" context. Only include in your output content from on or after cutoffDate (last two weeks).
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

// --- Docx building (template formatting) ---

const DARK_TEAL = '1F4E5F';
const LIGHT_GRAY = 'CCCCCC';

function docTitle(reportDate) {
  return new Paragraph({
    children: [
      new TextRun({ text: 'Q1 Bundle Premium Profiles & Network Footprint', bold: true, size: 32, color: DARK_TEAL, font: 'Arial' })
    ],
    spacing: { after: 120 }
  });
}

function docSubtitle(reportDate) {
  return new Paragraph({
    children: [
      new TextRun({ text: 'Bi-Weekly Status Update | ' + reportDate, size: 22, font: 'Arial' })
    ],
    spacing: { after: 360 }
  });
}

function sectionHeading(num, text) {
  return new Paragraph({
    children: [
      new TextRun({ text: '(' + num + ') ' + text, bold: true, size: 26, color: DARK_TEAL, font: 'Arial' })
    ],
    spacing: { before: 240, after: 180 }
  });
}

function bodyParagraph(htmlOrText) {
  const text = (htmlOrText || '').replace(/<[^>]+>/g, ' ').trim();
  return new Paragraph({
    children: [new TextRun({ text: text || ' ', size: 20, font: 'Arial' })],
    spacing: { after: 120 },
    indent: { left: 720 }
  });
}

function bulletParagraph(text) {
  return new Paragraph({
    children: [new TextRun({ text: '• ' + (text || ' '), size: 20, font: 'Arial' })],
    spacing: { after: 80 },
    indent: { left: 720 }
  });
}

function tableHeaderRow(cells) {
  return new TableRow({
    children: cells.map(function (cellText) {
      return new TableCell({
        children: [
          new Paragraph({
            children: [new TextRun({ text: cellText, bold: true, size: 20, color: 'FFFFFF', font: 'Arial' })]
          })
        ],
        shading: { fill: DARK_TEAL, type: ShadingType.CLEAR },
        margins: { top: 480, bottom: 480, left: 720, right: 720 }
      });
    })
  });
}

function tableDataRow(cells, options) {
  return new TableRow({
    children: cells.map(function (cellText, i) {
      const bold = options && options.boldCells && options.boldCells.indexOf(i) !== -1;
      return new TableCell({
        children: [
          new Paragraph({
            alignment: options && options.centeredCells && options.centeredCells.indexOf(i) !== -1 ? AlignmentType.CENTER : undefined,
            children: [new TextRun({ text: String(cellText || ''), bold: !!bold, size: 20, font: 'Arial' })]
          })
        ],
        margins: { top: 480, bottom: 480, left: 720, right: 720 }
      });
    })
  });
}

function buildDocx(reportJson, reportDate) {
  const r = reportJson || {};
  const children = [];

  children.push(docTitle(reportDate));
  children.push(docSubtitle(reportDate));

  children.push(new Paragraph({
    children: [new TextRun({ text: 'Executive Summary', bold: true, size: 26, color: DARK_TEAL, font: 'Arial' })]
  }));
  children.push(new Paragraph({ children: [new TextRun({ text: 'Major milestones achieved this period:', bold: true, size: 20, font: 'Arial' })] }));
  (r.majorMilestones || []).forEach(function (m) {
    children.push(bulletParagraph(m));
  });
  children.push(new Paragraph({ children: [new TextRun({ text: r.oneSentenceSummary || '', size: 20, font: 'Arial' })] }));
  children.push(new Paragraph({ children: [new TextRun({ text: 'Key technical decisions finalized this period:', bold: true, size: 20, font: 'Arial' })] }));
  (r.keyTechnicalDecisionsFinalized || []).forEach(function (d) {
    children.push(bulletParagraph(d));
  });
  children.push(new Paragraph({ children: [new TextRun({ text: 'Critical path items requiring attention:', bold: true, size: 20, font: 'Arial' })] }));
  (r.criticalPathItems || []).forEach(function (c) {
    children.push(bulletParagraph(c));
  });

  children.push(sectionHeading(1, 'Overall Health'));
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY }, bottom: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY }, left: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY }, right: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY } },
    rows: [
      tableHeaderRow(['Status', 'Assessment']),
      tableDataRow([r.overallHealthStatus || 'N/A', r.overallHealthAssessment || ''], { boldCells: [0], centeredCells: [0] })
    ]
  }));

  children.push(sectionHeading(2, 'Key Milestones (Upcoming)'));
  const milestoneRows = [tableHeaderRow(['Milestone', 'Target Date', 'Owner', 'Status'])];
  (r.keyMilestones || []).forEach(function (m) {
    milestoneRows.push(tableDataRow([m.milestone || '', m.targetDate || '', m.owner || '', m.status || ''], { centeredCells: [3] }));
  });
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY }, bottom: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY }, left: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY }, right: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY } },
    rows: milestoneRows
  }));

  children.push(sectionHeading(3, 'Scope'));
  children.push(bodyParagraph(r.scopeText || 'No new scope changes this period.'));

  children.push(sectionHeading(4, 'Schedules'));
  children.push(bodyParagraph(r.schedulesText || 'No schedule changes this period.'));

  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(sectionHeading(5, 'Project Status - Items Requiring Attention'));
  (r.projectStatusItems || []).forEach(function (p) {
    children.push(new Paragraph({ children: [new TextRun({ text: p.projectName || '', bold: true, size: 20, font: 'Arial' })] }));
    children.push(bodyParagraph(p.keyStatusLine || ''));
    if (p.secondStatusLine) children.push(bodyParagraph(p.secondStatusLine));
    children.push(new Paragraph({ children: [new TextRun({ text: 'Update (' + (p.updateDate || '') + '):', bold: true, size: 20, font: 'Arial' })] }));
    (p.bullets || []).forEach(function (b) { children.push(bulletParagraph(b)); });
    if (p.decisionMade && p.decisionMade.length) {
      children.push(new Paragraph({ children: [new TextRun({ text: 'Decision Made:', bold: true, size: 20, font: 'Arial' })] }));
      p.decisionMade.forEach(function (d) { children.push(bulletParagraph(d)); });
    }
    if (p.decisionNeeded) {
      children.push(new Paragraph({ children: [new TextRun({ text: 'Decision Needed: ' + p.decisionNeeded, size: 20, font: 'Arial' })] }));
    }
    if (p.pathToGreen) {
      children.push(new Paragraph({ children: [new TextRun({ text: 'Path to Green: ' + p.pathToGreen, size: 20, font: 'Arial' })] }));
    }
    children.push(new Paragraph({ spacing: { after: 180 } }));
  });

  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(sectionHeading(6, 'Up Next - Focus Areas for Next Two Weeks'));
  children.push(new Paragraph({ children: [new TextRun({ text: r.upNextWeek1Label || 'Week of [Date Range 1]', bold: true, size: 20, font: 'Arial' })] }));
  (r.upNextWeek1Items || []).forEach(function (x) { children.push(bulletParagraph(x)); });
  children.push(new Paragraph({ children: [new TextRun({ text: r.upNextWeek2Label || 'Week of [Date Range 2]', bold: true, size: 20, font: 'Arial' })] }));
  (r.upNextWeek2Items || []).forEach(function (x) { children.push(bulletParagraph(x)); });

  children.push(new Paragraph({ children: [new TextRun({ text: 'Decisions Pending', bold: true, size: 26, color: DARK_TEAL, font: 'Arial' })] }));
  const pendingRows = [tableHeaderRow(['Decision', 'Owner', 'Target Date'])];
  (r.decisionsPending || []).forEach(function (d) {
    pendingRows.push(tableDataRow([d.decision || '', d.owner || '', d.targetDate || '']));
  });
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY }, bottom: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY }, left: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY }, right: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY } },
    rows: pendingRows
  }));

  children.push(new Paragraph({ children: [new TextRun({ text: 'Appendix: Project Completion Summary', bold: true, size: 26, color: DARK_TEAL, font: 'Arial' })] }));
  const appendixRows = [tableHeaderRow(['Project', 'MAC %', 'FindLaw %', 'Status'])];
  (r.appendixRows || []).forEach(function (row) {
    appendixRows.push(tableDataRow([row.project || '', row.macPct || '', row.findLawPct || '', row.status || ''], { boldCells: [3], centeredCells: [3] }));
  });
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY }, bottom: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY }, left: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY }, right: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY } },
    rows: appendixRows
  }));

  children.push(new Paragraph({ children: [new TextRun({ text: 'Key Technical Decisions This Period', bold: true, size: 26, color: DARK_TEAL, font: 'Arial' })] }));
  const techRows = [tableHeaderRow(['Decision', 'Details', 'Impact'])];
  (r.keyTechnicalDecisionsTable || []).forEach(function (row) {
    techRows.push(tableDataRow([row.decision || '', row.details || '', row.impact || '']));
  });
  children.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY }, bottom: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY }, left: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY }, right: { style: BorderStyle.SINGLE, size: 4, color: LIGHT_GRAY } },
    rows: techRows
  }));

  children.push(new Paragraph({ children: [new TextRun({ text: 'Team Updates Summary', bold: true, size: 26, color: DARK_TEAL, font: 'Arial' })] }));
  children.push(new Paragraph({ children: [new TextRun({ text: 'PM Note:', bold: true, size: 20, font: 'Arial' })] }));
  children.push(bodyParagraph(r.teamUpdatesNote || ''));
  children.push(new Paragraph({ children: [new TextRun({ text: 'Thanks,\nRomit', size: 20, font: 'Arial' })] }));

  const doc = new Document({
    styles: { default: { document: { run: { font: 'Arial', size: 20 } } } },
    sections: [{
      properties: {
        page: {
          margin: {
            top: convertInchesToTwip(0.75),
            right: convertInchesToTwip(0.75),
            bottom: convertInchesToTwip(0.75),
            left: convertInchesToTwip(0.75)
          }
        }
      },
      children: children
    }]
  });

  return Packer.toBuffer(doc);
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

  const additionalContextRaw = (req.body.additionalContext || '').trim();
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
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }]
    });
    const text = msg.content[0].text;
    const reportJson = extractJsonFromResponse(text);
    if (!reportJson) {
      return res.status(500).json({ error: 'AI did not return valid JSON', raw: text.substring(0, 2000) });
    }
    const buffer = await buildDocx(reportJson, reportDate);
    const filename = 'Q1-Bundle-BiWeekly-Status-' + reportDate.replace(/\//g, '-') + '.docx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(Buffer.from(buffer));
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
      <label class="block text-sm font-medium text-slate-300 mb-2">Additional context (optional)</label>
      <textarea id="additionalContext" rows="4" placeholder="Paste team updates, meeting notes, exclusions, or any extra context to include when generating the report. Max ~3000 characters." class="w-full bg-slate-700 rounded-lg p-3 border border-slate-600 text-sm mb-4"></textarea>
      <div class="flex gap-3">
        <button type="button" id="btnFetch" class="px-6 py-3 bg-slate-600 hover:bg-slate-500 rounded-lg font-medium">Fetch tickets only</button>
        <button type="button" id="btnGenerate" class="px-6 py-3 bg-teal-600 hover:bg-teal-500 rounded-lg font-medium">Generate report (.docx)</button>
      </div>
      <div id="status" class="mt-3 text-sm text-slate-400"></div>
    </div>

    <div id="fetchResult" class="hidden bg-slate-800 rounded-xl p-4 mb-4 overflow-auto max-h-96">
      <h3 class="font-bold mb-2">Fetched summary</h3>
      <pre id="fetchPre" class="text-xs text-slate-300 whitespace-pre-wrap"></pre>
    </div>
  </div>

  <script>
    document.getElementById('reportDate').value = new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });

    function getPayload() {
      const youtrackRaw = (document.getElementById('youtrackIds').value || '').trim().split(/[\\n,;]/).map(function(s) { return s.trim(); }).filter(Boolean);
      const adoRaw = (document.getElementById('adoUrls').value || '').trim().split(/[\\n,;]/).map(function(s) { return s.trim(); }).filter(Boolean);
      return {
        reportDate: document.getElementById('reportDate').value.trim(),
        youtrackIds: youtrackRaw,
        adoUrls: adoRaw,
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
        var blob = await res.blob();
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = res.headers.get('Content-Disposition')?.split('filename=')[1]?.replace(/\"/g, '') || 'biweekly-report.docx';
        a.click();
        URL.revokeObjectURL(a.href);
        document.getElementById('status').textContent = 'Report downloaded.';
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
