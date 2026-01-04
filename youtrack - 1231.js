require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const YOUTRACK_TOKEN = process.env.YOUTRACK_TOKEN;
const YOUTRACK_BASE_URL = process.env.YOUTRACK_BASE_URL || 'https://youtrack.internetbrands.com';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!YOUTRACK_TOKEN || !ANTHROPIC_API_KEY) {
  console.error('Missing YOUTRACK_TOKEN or ANTHROPIC_API_KEY in .env file');
  console.error('Get your YouTrack token from: Profile -> Account Security -> Tokens -> New Token');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const headers = {
  'Authorization': 'Bearer ' + YOUTRACK_TOKEN,
  'Accept': 'application/json',
  'Content-Type': 'application/json'
};

// Map YouTrack link types to friendly names
const LINK_TYPES = {
  "Subtask": { outward: "Parent for", inward: "Subtask of" },
  "Depend": { outward: "Depends on", inward: "Is required for" },
  "Relates": { outward: "Relates to", inward: "Relates to" },
  "Duplicate": { outward: "Duplicates", inward: "Is duplicated by" }
};

function parseYouTrackUrl(url) {
  // Handle formats like:
  // https://youtrack.internetbrands.com/issue/UNSER-1141
  // https://youtrack.internetbrands.com/issue/UNSER-1141/Some-Title
  const m = url.match(/([^\/]+)\/issue\/([A-Z]+-\d+)/i);
  if (m) {
    return {
      baseUrl: url.substring(0, url.indexOf('/issue/')),
      issueId: m[2]
    };
  }
  return null;
}

async function fetchIssue(baseUrl, issueId) {
  try {
    // YouTrack API - fetch issue with all fields
    const fields = [
      'id', 'idReadable', 'summary', 'description', 'created', 'updated', 'resolved',
      'reporter(login,fullName,email)',
      'updatedBy(login,fullName)',
      'assignee(login,fullName,email)',
      'project(id,name,shortName)',
      'state(name)',
      'priority(name)',
      'type(name)',
      'tags(name,color(background,foreground))',
      'estimation(presentation)',
      'spent(presentation)',
      'customFields(name,value(name,text,presentation,login,fullName,minutes))',
      'links(direction,linkType(name,sourceToTarget,targetToSource),issues(id,idReadable,summary,state(name),assignee(fullName)))'
    ].join(',');

    const response = await axios.get(
      baseUrl + '/api/issues/' + issueId + '?fields=' + encodeURIComponent(fields),
      { headers }
    );
    return response.data;
  } catch (e) {
    console.log('Error fetching issue', issueId, ':', e.response?.data?.error || e.message);
    return null;
  }
}

async function fetchComments(baseUrl, issueId) {
  try {
    const fields = 'id,text,created,updated,author(login,fullName),deleted';
    const response = await axios.get(
      baseUrl + '/api/issues/' + issueId + '/comments?fields=' + encodeURIComponent(fields),
      { headers }
    );
    return (response.data || [])
      .filter(c => !c.deleted)
      .map(c => ({
        id: c.id,
        text: c.text || '',
        author: c.author ? (c.author.fullName || c.author.login) : 'Unknown',
        createdDate: c.created,
        modifiedDate: c.updated
      }));
  } catch (e) {
    console.log('Could not fetch comments for', issueId, ':', e.message);
    return [];
  }
}

async function fetchActivityItems(baseUrl, issueId) {
  // Fetch activity/history for additional context
  try {
    const fields = 'id,timestamp,author(login,fullName),added,removed,field(name)';
    const response = await axios.get(
      baseUrl + '/api/issues/' + issueId + '/activities?fields=' + encodeURIComponent(fields) + '&categories=CommentsCategory,CustomFieldCategory',
      { headers }
    );
    return response.data || [];
  } catch (e) {
    console.log('Could not fetch activity for', issueId);
    return [];
  }
}

function parseIssueData(issue, comments) {
  if (!issue) return null;

  // Extract custom fields
  const customFields = {};
  (issue.customFields || []).forEach(cf => {
    const name = cf.name;
    let value = cf.value;
    if (value) {
      if (Array.isArray(value)) {
        value = value.map(v => v.name || v.text || v.presentation || v.fullName || v).join(', ');
      } else if (typeof value === 'object') {
        value = value.name || value.text || value.presentation || value.fullName || JSON.stringify(value);
      }
    }
    customFields[name] = value;
  });

  // Parse links into categories
  const children = [];
  const parents = [];
  const relatedItems = [];
  const dependencies = [];

  (issue.links || []).forEach(link => {
    const linkType = link.linkType?.name || 'Related';
    const direction = link.direction;
    
    (link.issues || []).forEach(linkedIssue => {
      const item = {
        id: linkedIssue.idReadable,
        internalId: linkedIssue.id,
        title: linkedIssue.summary,
        state: linkedIssue.state?.name || 'Unknown',
        assignee: linkedIssue.assignee?.fullName || 'Unassigned',
        linkType: linkType,
        direction: direction
      };

      if (linkType === 'Subtask') {
        if (direction === 'OUTWARD') {
          children.push(item);
        } else {
          parents.push(item);
        }
      } else if (linkType === 'Depend') {
        item.dependencyType = direction === 'OUTWARD' ? 'Depends on' : 'Required for';
        dependencies.push(item);
      } else {
        item.relationType = direction === 'OUTWARD' 
          ? (link.linkType?.sourceToTarget || linkType) 
          : (link.linkType?.targetToSource || linkType);
        relatedItems.push(item);
      }
    });
  });

  return {
    id: issue.idReadable,
    internalId: issue.id,
    type: issue.type?.name || customFields['Type'] || 'Issue',
    title: issue.summary,
    description: issue.description || '',
    state: issue.state?.name || 'Unknown',
    priority: issue.priority?.name || customFields['Priority'] || 'Normal',
    assignee: issue.assignee?.fullName || 'Unassigned',
    assigneeEmail: issue.assignee?.email || '',
    reporter: issue.reporter?.fullName || 'Unknown',
    reporterEmail: issue.reporter?.email || '',
    project: issue.project?.name || '',
    projectKey: issue.project?.shortName || '',
    estimation: issue.estimation?.presentation || customFields['Estimation'] || '',
    spentTime: issue.spent?.presentation || '',
    tags: (issue.tags || []).map(t => t.name),
    createdDate: issue.created,
    updatedDate: issue.updated,
    resolvedDate: issue.resolved,
    updatedBy: issue.updatedBy?.fullName || '',
    customFields: customFields,
    comments: comments,
    children: children,
    parents: parents,
    relatedItems: relatedItems,
    dependencies: dependencies
  };
}

async function crawlYouTrack(baseUrl, issueId) {
  console.log('Fetching issue', issueId, 'from', baseUrl);
  
  // Fetch main issue
  const mainIssue = await fetchIssue(baseUrl, issueId);
  if (!mainIssue) {
    throw new Error('Could not fetch issue ' + issueId);
  }
  
  const mainComments = await fetchComments(baseUrl, issueId);
  const parent = parseIssueData(mainIssue, mainComments);
  
  const result = {
    baseUrl: baseUrl,
    projectKey: parent.projectKey,
    parent: parent,
    children: [],
    relatedItems: [],
    dependencies: [],
    allComments: []
  };

  // Collect parent comments
  if (parent.comments && parent.comments.length) {
    result.allComments.push({
      issueId: parent.id,
      issueTitle: parent.title,
      comments: parent.comments
    });
  }

  // Include related items and dependencies from parent
  result.relatedItems = parent.relatedItems || [];
  result.dependencies = parent.dependencies || [];

  // Combine subtasks (children) and related items for crawling
  // Many projects use "Relates to" instead of "Subtask" for linked work
  const allLinkedItems = [
    ...parent.children.map(c => ({ ...c, linkType: 'Subtask' })),
    ...parent.relatedItems.map(r => ({ ...r, linkType: r.relationType || 'Related' }))
  ];
  
  // Deduplicate by ID
  const uniqueLinkedItems = [];
  const seenIds = new Set();
  allLinkedItems.forEach(item => {
    if (!seenIds.has(item.id)) {
      seenIds.add(item.id);
      uniqueLinkedItems.push(item);
    }
  });

  console.log('Found', parent.children.length, 'subtasks and', parent.relatedItems.length, 'related items');
  console.log('Crawling', uniqueLinkedItems.length, 'total linked issues');

  // Fetch all linked items with their comments
  for (let i = 0; i < uniqueLinkedItems.length; i++) {
    const linkedRef = uniqueLinkedItems[i];
    console.log('  Fetching [' + (i+1) + '/' + uniqueLinkedItems.length + ']:', linkedRef.id, '(' + linkedRef.linkType + ')');
    
    const linkedIssue = await fetchIssue(baseUrl, linkedRef.id);
    if (linkedIssue) {
      const linkedComments = await fetchComments(baseUrl, linkedRef.id);
      const linked = parseIssueData(linkedIssue, linkedComments);
      
      if (linked) {
        linked.linkTypeToParent = linkedRef.linkType;
        result.children.push(linked);
        
        if (linked.comments && linked.comments.length) {
          result.allComments.push({
            issueId: linked.id,
            issueTitle: linked.title,
            comments: linked.comments
          });
        }

        // Collect dependencies from linked items
        if (linked.dependencies) {
          linked.dependencies.forEach(dep => {
            if (!result.dependencies.find(d => d.id === dep.id) && dep.id !== parent.id) {
              dep.sourceIssue = linked.id;
              result.dependencies.push(dep);
            }
          });
        }
      }
    }
  }

  // Clear relatedItems since we've crawled them into children
  result.relatedItems = [];

  // Build summary statistics
  result.stats = {
    totalChildren: result.children.length,
    totalRelated: result.relatedItems.length,
    totalDependencies: result.dependencies.length,
    totalComments: result.allComments.reduce((sum, ic) => sum + ic.comments.length, 0),
    childrenByState: {},
    childrenByType: {},
    childrenByAssignee: {}
  };

  result.children.forEach(c => {
    const state = c.state || 'Unknown';
    const type = c.type || 'Issue';
    const assignee = c.assignee || 'Unassigned';
    result.stats.childrenByState[state] = (result.stats.childrenByState[state] || 0) + 1;
    result.stats.childrenByType[type] = (result.stats.childrenByType[type] || 0) + 1;
    result.stats.childrenByAssignee[assignee] = (result.stats.childrenByAssignee[assignee] || 0) + 1;
  });

  return result;
}

async function analyze(data) {
  const prompt = `You are a Senior TPM creating an executive briefing. Analyze these YouTrack tickets including their comments and related items.

IMPORTANT: Pay close attention to:
1. Comments on tickets - they contain discussion, decisions, blockers, and context
2. Related tickets and dependencies - they show connected work
3. Custom fields that may contain sprint, story points, or other metadata

Return JSON with:
- projectOverview (name, description, businessImpact, owner, status, completion, startDate, completionDate, totalDuration)
- executiveSummary (comprehensive 5 paragraphs incorporating insights from comments)
- keyAccomplishments (array: accomplishment, ticketIds, impact, team)
- keyDecisions (array: decision, context, madeBy, ticketId, date) - extracted from comments
- discussionHighlights (array: topic, summary, participants, ticketId) - key discussion threads from comments
- workBreakdown (array: category, description, status, tickets array with id/title/state/assignee)
- teamContributions (array: person, ticketsCompleted as ID array, keyContributions, commentCount)
- dependencies (array: dependency, type, status, owner, impact, relatedTicketId)
- blockers (array: blocker, ticket, severity, status, resolution, mentionedInComments)
- risks (array: risk, likelihood, impact, mitigation, owner, sourceTicketId)
- relatedWork (array: ticketId, title, relationTypes, status, relevance) - from related items
- openQuestions (array: question, ticketId, askedBy) - unresolved questions from comments
- metrics (total, completed, inProgress, notStarted, blocked, completionRate, totalComments, relatedItemsCount)
- recommendations (array: priority, recommendation, rationale, owner, category)
- nextSteps (array: action, owner, priority)

Use ticket IDs (like UNSER-1141). Extract insights from comments.

DATA: ${JSON.stringify(data)}`;

  console.log('Analyzing with Claude...');
  const r = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }]
  });
  
  const txt = r.content[0].text;
  try {
    // Try to extract JSON from various formats
    let jsonStr = txt;
    
    // Try ```json ... ``` format
    const jsonBlockMatch = txt.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
      jsonStr = jsonBlockMatch[1];
    } else {
      // Try to find JSON object directly
      const jsonStart = txt.indexOf('{');
      const jsonEnd = txt.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        jsonStr = txt.substring(jsonStart, jsonEnd + 1);
      }
    }
    
    return JSON.parse(jsonStr.trim());
  } catch (e) { 
    console.log('Parse error:', e.message);
    console.log('Raw response length:', txt.length);
  }
  return { raw: txt };
}

app.post('/api/chat', async (req, res) => {
  try {
    const prompt = `You are a PM assistant with full project data including all comments and related tickets from YouTrack.
Answer questions using ticket IDs and specifics. Reference comments and discussions when relevant.
When asked about decisions, context, or discussions, look at the comments.
When asked about dependencies or related work, look at relatedItems and dependencies.

DATA: ${JSON.stringify(req.body.context)}

QUESTION: ${req.body.question}`;
    
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ response: r.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  try {
    const parsed = parseYouTrackUrl(req.body.url);
    if (!parsed) return res.status(400).json({ error: 'Invalid YouTrack URL' });
    
    const data = await crawlYouTrack(parsed.baseUrl, parsed.issueId);
    const analysis = await analyze(data);
    res.json({ tickets: data, analysis: analysis });
  } catch (e) {
    console.error('Analysis error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>PM Intelligence Assistant - YouTrack</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-white min-h-screen p-6">
  <div class="max-w-6xl mx-auto">
    <h1 class="text-3xl font-bold text-center mb-2">PM Intelligence Assistant</h1>
    <p class="text-slate-400 text-center mb-6">YouTrack Crawler + Comments + Related Items + AI Analysis</p>
    
    <div class="bg-slate-800 rounded-xl p-4 mb-4">
      <input type="text" id="url" placeholder="https://youtrack.internetbrands.com/issue/UNSER-1141" class="w-full bg-slate-700 rounded-lg p-3 mb-3 border border-slate-600" value="https://youtrack.internetbrands.com/issue/UNSER-1141">
      <button onclick="run()" id="btn" class="w-full py-3 bg-purple-600 hover:bg-purple-500 rounded-lg font-medium">Crawl and Generate Report</button>
      <div id="status" class="mt-3 text-sm text-slate-400"></div>
    </div>
    
    <div id="chatBox" class="hidden bg-slate-800 rounded-xl p-4 mb-4">
      <h3 class="text-lg font-bold mb-3">💬 Ask Questions</h3>
      <div id="chatLog" class="bg-slate-900 rounded-lg p-3 h-48 overflow-y-auto mb-3"></div>
      <div class="flex gap-2">
        <input type="text" id="chatIn" placeholder="Ask anything about this project..." class="flex-1 bg-slate-700 rounded-lg p-3 border border-slate-600" onkeypress="if(event.key==='Enter')chat()">
        <button onclick="chat()" id="chatBtn" class="px-6 py-3 bg-green-600 hover:bg-green-500 rounded-lg">Send</button>
      </div>
      <div class="mt-2 flex flex-wrap gap-2">
        <button onclick="ask('Draft a status email for leadership')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">📧 Status email</button>
        <button onclick="ask('What are the blockers?')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">🚫 Blockers</button>
        <button onclick="ask('Summarize the risks')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">⚠️ Risks</button>
        <button onclick="ask('Who contributed the most?')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">👥 Team</button>
        <button onclick="ask('Create a 1-page executive summary')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">📋 1-pager</button>
        <button onclick="ask('What decisions were made in the comments?')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">🎯 Decisions</button>
        <button onclick="ask('What are the dependencies?')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">🔗 Dependencies</button>
        <button onclick="ask('Summarize the key discussions')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">💭 Discussions</button>
      </div>
    </div>
    
    <div id="results"></div>
  </div>
  
<script>
var DATA = null;
var BASE = "";

function link(id) {
  return '<a href="' + BASE + '/issue/' + id + '" target="_blank" class="text-purple-400 underline">' + id + '</a>';
}

function linkify(txt) {
  if (!txt || !BASE) return txt || "";
  return String(txt).replace(/\\b([A-Z]+-\\d+)\\b/g, function(m) {
    return '<a href="' + BASE + '/issue/' + m + '" target="_blank" class="text-purple-400 underline">' + m + '</a>';
  });
}

function stripHtml(html) {
  var tmp = document.createElement("div");
  tmp.innerHTML = html || "";
  return tmp.textContent || tmp.innerText || "";
}

function formatDate(ts) {
  if (!ts) return "N/A";
  return new Date(ts).toLocaleDateString();
}

function ask(q) { document.getElementById("chatIn").value = q; chat(); }

async function chat() {
  var q = document.getElementById("chatIn").value.trim();
  if (!q || !DATA) return;
  var log = document.getElementById("chatLog");
  log.innerHTML += '<div class="mb-2"><span class="text-purple-400 font-bold">You:</span> ' + q + '</div>';
  document.getElementById("chatIn").value = "";
  document.getElementById("chatBtn").disabled = true;
  log.innerHTML += '<div id="loading" class="text-slate-500">Thinking...</div>';
  log.scrollTop = log.scrollHeight;
  
  try {
    var res = await fetch("/api/chat", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ question: q, context: DATA })
    });
    var d = await res.json();
    document.getElementById("loading").remove();
    log.innerHTML += '<div class="mb-2 bg-slate-800 rounded p-2"><span class="text-green-400 font-bold">AI:</span><div class="whitespace-pre-wrap mt-1">' + linkify(d.response || d.error) + '</div></div>';
  } catch(e) {
    document.getElementById("loading").remove();
    log.innerHTML += '<div class="text-red-400">Error: ' + e.message + '</div>';
  }
  document.getElementById("chatBtn").disabled = false;
  log.scrollTop = log.scrollHeight;
}

async function run() {
  var url = document.getElementById("url").value;
  if (!url) return alert("Enter URL");
  document.getElementById("btn").disabled = true;
  document.getElementById("btn").textContent = "Crawling...";
  document.getElementById("status").textContent = "Fetching tickets, comments, and related items...";
  document.getElementById("results").innerHTML = "";
  document.getElementById("chatBox").classList.add("hidden");
  document.getElementById("chatLog").innerHTML = "";
  DATA = null;
  
  try {
    var res = await fetch("/api/analyze", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ url: url })
    });
    var d = await res.json();
    if (d.error) throw new Error(d.error);
    
    DATA = d;
    BASE = d.tickets.baseUrl;
    var stats = d.tickets.stats || {};
    document.getElementById("status").textContent = "Done! " + (d.tickets.children.length + 1) + " tickets, " + (stats.totalComments || 0) + " comments, " + (stats.totalRelated || 0) + " related, " + (stats.totalDependencies || 0) + " dependencies";
    document.getElementById("chatBox").classList.remove("hidden");
    
    var a = d.analysis;
    var h = "";
    
    // Project Overview
    if (a.projectOverview) {
      var p = a.projectOverview;
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4">';
      h += '<div class="flex justify-between mb-2"><h2 class="text-2xl font-bold">' + (p.name||d.tickets.parent.title||"Project") + '</h2>';
      h += '<span class="px-3 py-1 rounded-full text-sm ' + (p.status=="Completed"?"bg-green-500/20 text-green-400":"bg-purple-500/20 text-purple-400") + '">' + (p.status||d.tickets.parent.state||"") + '</span></div>';
      h += '<p class="text-slate-300 mb-2">' + (p.description||"") + '</p>';
      if (p.businessImpact) h += '<p class="text-slate-400 text-sm mb-2"><b>Impact:</b> ' + p.businessImpact + '</p>';
      h += '<div class="grid grid-cols-4 gap-2 text-center text-sm">';
      h += '<div class="bg-slate-700 rounded p-2"><div class="text-green-400 font-bold">' + (p.completion||"N/A") + '</div><div class="text-xs text-slate-400">Complete</div></div>';
      h += '<div class="bg-slate-700 rounded p-2"><div class="font-bold">' + (p.startDate||formatDate(d.tickets.parent.createdDate)) + '</div><div class="text-xs text-slate-400">Start</div></div>';
      h += '<div class="bg-slate-700 rounded p-2"><div class="font-bold">' + (p.completionDate||"N/A") + '</div><div class="text-xs text-slate-400">End</div></div>';
      h += '<div class="bg-slate-700 rounded p-2"><div class="font-bold">' + (p.totalDuration||"N/A") + '</div><div class="text-xs text-slate-400">Duration</div></div>';
      h += '</div></div>';
    }
    
    // Executive Summary
    if (a.executiveSummary) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">📋 Executive Summary</h3>';
      h += '<div class="text-slate-300 whitespace-pre-wrap">' + linkify(a.executiveSummary) + '</div></div>';
    }
    
    // Metrics
    if (a.metrics) {
      var m = a.metrics;
      h += '<div class="grid grid-cols-8 gap-2 mb-4 text-center">';
      h += '<div class="bg-slate-800 rounded-xl p-3"><div class="text-2xl font-bold">' + (m.total||0) + '</div><div class="text-xs text-slate-400">Total</div></div>';
      h += '<div class="bg-slate-800 rounded-xl p-3"><div class="text-2xl font-bold text-green-400">' + (m.completed||0) + '</div><div class="text-xs text-slate-400">Done</div></div>';
      h += '<div class="bg-slate-800 rounded-xl p-3"><div class="text-2xl font-bold text-blue-400">' + (m.inProgress||0) + '</div><div class="text-xs text-slate-400">In Progress</div></div>';
      h += '<div class="bg-slate-800 rounded-xl p-3"><div class="text-2xl font-bold text-slate-400">' + (m.notStarted||0) + '</div><div class="text-xs text-slate-400">Not Started</div></div>';
      h += '<div class="bg-slate-800 rounded-xl p-3"><div class="text-2xl font-bold text-red-400">' + (m.blocked||0) + '</div><div class="text-xs text-slate-400">Blocked</div></div>';
      h += '<div class="bg-slate-800 rounded-xl p-3"><div class="text-2xl font-bold text-purple-400">' + (m.completionRate||"N/A") + '</div><div class="text-xs text-slate-400">Rate</div></div>';
      h += '<div class="bg-slate-800 rounded-xl p-3"><div class="text-2xl font-bold text-amber-400">' + (m.totalComments||0) + '</div><div class="text-xs text-slate-400">Comments</div></div>';
      h += '<div class="bg-slate-800 rounded-xl p-3"><div class="text-2xl font-bold text-cyan-400">' + (m.relatedItemsCount||0) + '</div><div class="text-xs text-slate-400">Related</div></div>';
      h += '</div>';
    }
    
    // Key Accomplishments
    if (a.keyAccomplishments && a.keyAccomplishments.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">🏆 Key Accomplishments</h3>';
      a.keyAccomplishments.forEach(function(x) {
        var links = (x.ticketIds||[]).map(function(i){return link(i);}).join(", ");
        h += '<div class="bg-slate-700 rounded p-3 mb-2 border-l-4 border-green-500">';
        h += '<div class="text-green-400 font-medium">' + x.accomplishment + '</div>';
        h += '<p class="text-sm text-slate-300">' + (x.impact||"") + '</p>';
        h += '<div class="text-xs text-slate-400">Team: ' + (x.team||"N/A") + (links ? " | Tickets: " + links : "") + '</div></div>';
      });
      h += '</div>';
    }
    
    // Key Decisions (from comments)
    if (a.keyDecisions && a.keyDecisions.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">🎯 Key Decisions (from Comments)</h3>';
      a.keyDecisions.forEach(function(x) {
        h += '<div class="bg-slate-700 rounded p-3 mb-2 border-l-4 border-purple-500">';
        h += '<div class="text-purple-400 font-medium">' + linkify(x.decision) + '</div>';
        h += '<p class="text-sm text-slate-300">' + (x.context||"") + '</p>';
        h += '<div class="text-xs text-slate-400">Made by: ' + (x.madeBy||"N/A") + ' | Ticket: ' + (x.ticketId ? link(x.ticketId) : "N/A") + '</div></div>';
      });
      h += '</div>';
    }
    
    // Discussion Highlights
    if (a.discussionHighlights && a.discussionHighlights.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">💭 Discussion Highlights</h3>';
      a.discussionHighlights.forEach(function(x) {
        h += '<div class="bg-slate-700 rounded p-3 mb-2">';
        h += '<div class="font-medium text-cyan-400">' + linkify(x.topic) + '</div>';
        h += '<p class="text-sm text-slate-300">' + (x.summary||"") + '</p>';
        h += '<div class="text-xs text-slate-400">Participants: ' + (x.participants||"N/A") + ' | Ticket: ' + (x.ticketId ? link(x.ticketId) : "N/A") + '</div></div>';
      });
      h += '</div>';
    }
    
    // Team Contributions
    if (a.teamContributions && a.teamContributions.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">👥 Team Contributions</h3><div class="grid grid-cols-2 gap-2">';
      a.teamContributions.forEach(function(x) {
        var links = (x.ticketsCompleted||[]).map(function(i){return link(i);}).join(", ");
        h += '<div class="bg-slate-700 rounded p-3"><div class="flex justify-between"><span class="font-medium">' + x.person + '</span>';
        h += '<div><span class="text-purple-400 text-sm">' + (x.ticketsCompleted||[]).length + ' tickets</span>';
        if (x.commentCount) h += '<span class="text-amber-400 text-sm ml-2">' + x.commentCount + ' comments</span>';
        h += '</div></div>';
        h += '<p class="text-sm text-slate-400">' + (x.keyContributions||"") + '</p>';
        if (links) h += '<div class="text-xs text-slate-500 mt-1">' + links + '</div>';
        h += '</div>';
      });
      h += '</div></div>';
    }
    
    // Work Breakdown
    if (a.workBreakdown && a.workBreakdown.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">📁 Work Breakdown</h3>';
      a.workBreakdown.forEach(function(w) {
        h += '<div class="bg-slate-700 rounded p-3 mb-2"><div class="flex justify-between mb-1"><span class="font-medium">' + w.category + '</span>';
        h += '<span class="text-sm px-2 py-0.5 rounded ' + (w.status=="Complete"?"bg-green-500/20 text-green-400":"bg-purple-500/20 text-purple-400") + '">' + (w.status||"") + '</span></div>';
        h += '<p class="text-sm text-slate-400 mb-2">' + (w.description||"") + '</p>';
        if (w.tickets && w.tickets.length) {
          h += '<div class="space-y-1">';
          w.tickets.forEach(function(t) {
            h += '<div class="bg-slate-800 rounded p-2 text-sm flex items-center gap-2">' + link(t.id);
            h += '<span class="flex-1 truncate">' + t.title + '</span>';
            h += '<span class="text-xs text-slate-500">' + (t.assignee||"") + '</span>';
            h += '<span class="text-xs px-2 py-0.5 rounded ' + (t.state=="Done"||t.state=="Closed"||t.state=="Resolved"?"bg-green-500/20 text-green-400":"bg-slate-600") + '">' + (t.state||"") + '</span></div>';
          });
          h += '</div>';
        }
        h += '</div>';
      });
      h += '</div>';
    }
    
    // Dependencies
    if (a.dependencies && a.dependencies.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">🔗 Dependencies</h3>';
      a.dependencies.forEach(function(d) {
        h += '<div class="bg-slate-700 rounded p-3 mb-2"><div class="flex justify-between"><span class="font-medium">' + linkify(d.dependency) + '</span>';
        h += '<span class="text-xs px-2 py-1 rounded ' + (d.status=="Resolved"?"bg-green-500/20 text-green-400":"bg-amber-500/20 text-amber-400") + '">' + (d.status||"") + '</span></div>';
        h += '<p class="text-sm text-slate-400">Type: ' + (d.type||"N/A") + ' | Owner: ' + (d.owner||"N/A") + '</p>';
        if (d.relatedTicketId) h += '<div class="text-xs text-slate-500">Related: ' + link(d.relatedTicketId) + '</div>';
        h += '</div>';
      });
      h += '</div>';
    }
    
    // Related Work
    if (a.relatedWork && a.relatedWork.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">🔗 Related Work</h3>';
      a.relatedWork.forEach(function(r) {
        var types = Array.isArray(r.relationTypes) ? r.relationTypes.join(", ") : (r.relationTypes || "Related");
        h += '<div class="bg-slate-700 rounded p-3 mb-2 flex items-center gap-3">';
        h += '<div class="flex-1">' + link(r.ticketId) + ' <span class="text-slate-300">' + (r.title||"") + '</span></div>';
        h += '<span class="text-xs bg-cyan-500/20 text-cyan-400 px-2 py-1 rounded">' + types + '</span>';
        h += '<span class="text-xs px-2 py-1 rounded ' + (r.status=="Done"||r.status=="Closed"?"bg-green-500/20 text-green-400":"bg-slate-600") + '">' + (r.status||"") + '</span></div>';
      });
      h += '</div>';
    }
    
    // Risks
    if (a.risks && a.risks.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2 text-amber-400">⚠️ Risks</h3>';
      a.risks.forEach(function(r) {
        h += '<div class="bg-slate-700 rounded p-3 mb-2 border-l-4 ' + (r.likelihood=="High"?"border-red-500":"border-amber-500") + '">';
        h += '<div class="flex justify-between"><span class="font-medium">' + r.risk + '</span>';
        h += '<span class="text-xs px-2 py-1 rounded ' + (r.likelihood=="High"?"bg-red-500/20 text-red-400":"bg-amber-500/20 text-amber-400") + '">' + (r.likelihood||"") + '</span></div>';
        h += '<p class="text-sm text-slate-400">Impact: ' + (r.impact||"N/A") + '</p>';
        h += '<p class="text-sm text-green-400">Mitigation: ' + (r.mitigation||"N/A") + '</p>';
        if (r.sourceTicketId) h += '<div class="text-xs text-slate-500">Source: ' + link(r.sourceTicketId) + '</div>';
        h += '</div>';
      });
      h += '</div>';
    }
    
    // Blockers
    if (a.blockers && a.blockers.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2 text-red-400">🚫 Blockers</h3>';
      a.blockers.forEach(function(b) {
        h += '<div class="bg-slate-700 rounded p-3 mb-2 border-l-4 border-red-500">';
        h += '<div class="font-medium">' + linkify(b.blocker) + '</div>';
        if (b.ticket) h += '<p class="text-sm text-slate-400">Ticket: ' + link(b.ticket) + '</p>';
        if (b.resolution) h += '<p class="text-sm text-green-400">Resolution: ' + b.resolution + '</p>';
        if (b.mentionedInComments) h += '<div class="text-xs text-amber-400">📝 Mentioned in comments</div>';
        h += '</div>';
      });
      h += '</div>';
    }
    
    // Open Questions
    if (a.openQuestions && a.openQuestions.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">❓ Open Questions</h3>';
      a.openQuestions.forEach(function(q) {
        h += '<div class="bg-slate-700 rounded p-3 mb-2 border-l-4 border-yellow-500">';
        h += '<div class="text-yellow-400">' + linkify(q.question) + '</div>';
        h += '<div class="text-xs text-slate-400">Asked by: ' + (q.askedBy||"N/A") + ' | Ticket: ' + (q.ticketId ? link(q.ticketId) : "N/A") + '</div></div>';
      });
      h += '</div>';
    }
    
    // Recommendations
    if (a.recommendations && a.recommendations.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">✅ Recommendations</h3>';
      a.recommendations.forEach(function(r,i) {
        h += '<div class="bg-slate-700 rounded p-3 mb-2 flex gap-3"><span class="text-2xl font-bold text-purple-400">#' + (r.priority||(i+1)) + '</span>';
        h += '<div><div class="font-medium">' + r.recommendation + '</div>';
        h += '<p class="text-sm text-slate-400">' + (r.rationale||"") + '</p>';
        h += '<div class="text-xs text-slate-500">Owner: ' + (r.owner||"N/A") + '</div></div></div>';
      });
      h += '</div>';
    }
    
    // Next Steps
    if (a.nextSteps && a.nextSteps.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">➡️ Next Steps</h3>';
      a.nextSteps.forEach(function(n) {
        h += '<div class="bg-slate-700 rounded p-3 mb-2 flex justify-between"><div>';
        h += '<div class="font-medium">' + linkify(n.action) + '</div>';
        h += '<div class="text-sm text-slate-400">Owner: ' + (n.owner||"N/A") + '</div></div>';
        h += '<span class="text-purple-400">' + (n.priority||"") + '</span></div>';
      });
      h += '</div>';
    }
    
    // Comments Section
    if (d.tickets.allComments && d.tickets.allComments.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">💬 All Comments (' + stats.totalComments + ')</h3>';
      d.tickets.allComments.forEach(function(ic) {
        h += '<div class="bg-slate-700 rounded p-3 mb-3">';
        h += '<div class="font-medium text-purple-400 mb-2">' + link(ic.issueId) + ' - ' + ic.issueTitle + '</div>';
        ic.comments.forEach(function(c) {
          h += '<div class="bg-slate-800 rounded p-2 mb-2 ml-4 border-l-2 border-slate-600">';
          h += '<div class="flex justify-between text-xs text-slate-400 mb-1"><span class="font-medium text-slate-300">' + c.author + '</span>';
          h += '<span>' + formatDate(c.createdDate) + '</span></div>';
          h += '<div class="text-sm text-slate-300">' + stripHtml(c.text) + '</div></div>';
        });
        h += '</div>';
      });
      h += '</div>';
    }
    
    // Raw Dependencies from YouTrack
    if (d.tickets.dependencies && d.tickets.dependencies.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">🔗 YouTrack Dependencies (' + d.tickets.dependencies.length + ')</h3>';
      h += '<table class="w-full text-sm"><tr class="text-left text-slate-400 border-b border-slate-700"><th class="p-2">ID</th><th class="p-2">Title</th><th class="p-2">Type</th><th class="p-2">State</th><th class="p-2">Assignee</th></tr>';
      d.tickets.dependencies.forEach(function(t) {
        h += '<tr class="border-b border-slate-700"><td class="p-2">' + link(t.id) + '</td><td class="p-2">' + t.title + '</td><td class="p-2 text-amber-400">' + (t.dependencyType||t.linkType) + '</td><td class="p-2 ' + (t.state=="Done"||t.state=="Closed"?"text-green-400":"") + '">' + t.state + '</td><td class="p-2">' + t.assignee + '</td></tr>';
      });
      h += '</table></div>';
    }
    
    // Related Items Section
    if (d.tickets.relatedItems && d.tickets.relatedItems.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">🔗 Related Items (' + d.tickets.relatedItems.length + ')</h3>';
      h += '<table class="w-full text-sm"><tr class="text-left text-slate-400 border-b border-slate-700"><th class="p-2">ID</th><th class="p-2">Title</th><th class="p-2">Relation</th><th class="p-2">State</th><th class="p-2">Assignee</th></tr>';
      d.tickets.relatedItems.forEach(function(t) {
        h += '<tr class="border-b border-slate-700"><td class="p-2">' + link(t.id) + '</td><td class="p-2">' + t.title + '</td><td class="p-2 text-cyan-400">' + (t.relationType||t.linkType) + '</td><td class="p-2 ' + (t.state=="Done"||t.state=="Closed"?"text-green-400":"") + '">' + t.state + '</td><td class="p-2">' + t.assignee + '</td></tr>';
      });
      h += '</table></div>';
    }
    
    // All Tickets Table
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">📄 All Tickets</h3>';
    h += '<table class="w-full text-sm"><tr class="text-left text-slate-400 border-b border-slate-700"><th class="p-2">ID</th><th class="p-2">Title</th><th class="p-2">Type</th><th class="p-2">State</th><th class="p-2">Assignee</th><th class="p-2">Comments</th></tr>';
    var p = d.tickets.parent;
    var parentCommentCount = (p.comments||[]).length;
    h += '<tr class="border-b border-slate-700 bg-slate-700/30"><td class="p-2">' + link(p.id) + '</td><td class="p-2">' + p.title + '</td><td class="p-2">' + p.type + '</td><td class="p-2">' + p.state + '</td><td class="p-2">' + p.assignee + '</td><td class="p-2 text-amber-400">' + parentCommentCount + '</td></tr>';
    d.tickets.children.forEach(function(t) {
      var commentCount = (t.comments||[]).length;
      h += '<tr class="border-b border-slate-700"><td class="p-2">' + link(t.id) + '</td><td class="p-2">' + t.title + '</td><td class="p-2">' + t.type + '</td><td class="p-2 ' + (t.state=="Done"||t.state=="Closed"||t.state=="Resolved"?"text-green-400":"") + '">' + t.state + '</td><td class="p-2">' + t.assignee + '</td><td class="p-2 text-amber-400">' + commentCount + '</td></tr>';
    });
    h += '</table></div>';
    
    // Raw JSON
    h += '<div class="bg-slate-800 rounded-xl p-4"><h3 class="text-xl font-bold mb-2">🔧 Raw JSON</h3>';
    h += '<pre class="text-xs overflow-auto max-h-64 bg-slate-900 p-3 rounded">' + JSON.stringify(a,null,2) + '</pre></div>';
    
    document.getElementById("results").innerHTML = h;
  } catch(e) {
    document.getElementById("status").textContent = "Error: " + e.message;
    console.error(e);
  }
  document.getElementById("btn").disabled = false;
  document.getElementById("btn").textContent = "Crawl and Generate Report";
}
</script>
</body>
</html>`);
});

const PORT = process.env.YOUTRACK_PORT || 3001;
app.listen(PORT, () => {
  console.log("========================================");
  console.log("  PM Intelligence Assistant - YouTrack");
  console.log("  Open http://localhost:" + PORT);
  console.log("========================================");
});