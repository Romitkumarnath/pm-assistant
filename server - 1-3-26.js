require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const ADO_PAT = process.env.ADO_PAT;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ADO_PAT || !ANTHROPIC_API_KEY) {
  console.error('Missing ADO_PAT or ANTHROPIC_API_KEY in .env file');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const fs = require('fs');
const path = require('path');

// Persistent history storage
const HISTORY_FILE = path.join(__dirname, 'history.json');
const MAX_HISTORY = 50;

function loadHistoryFromFile() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Error loading history file:', e.message);
  }
  return [];
}

function saveHistoryToFile(history) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving history file:', e.message);
  }
}

// Load history on startup
let analysisHistory = loadHistoryFromFile();
console.log(`Loaded ${analysisHistory.length} history items from file`);

function addToHistory(ticketId, url, data, analysis) {
  const historyItem = {
    id: Date.now().toString(),
    ticketId: ticketId,
    url: url,
    timestamp: new Date().toISOString(),
    projectName: analysis.projectOverview?.name || `Ticket ${ticketId}`,
    status: analysis.projectOverview?.status || 'N/A',
    totalTickets: (data.children?.length || 0) + 1,
    totalComments: data.stats?.totalComments || 0,
    data: data,
    analysis: analysis
  };
  
  analysisHistory.unshift(historyItem);
  if (analysisHistory.length > MAX_HISTORY) {
    analysisHistory.pop();
  }
  
  saveHistoryToFile(analysisHistory);
  return historyItem.id;
}

function parseAdoUrl(url) {
  const m = url.match(/dev\.azure\.com\/([^\/]+)\/([^\/]+)\/_workitems\/edit\/(\d+)/);
  if (m) return { org: m[1], project: m[2], id: m[3] };
  const m2 = url.match(/([^\.]+)\.visualstudio\.com\/([^\/]+)\/_workitems\/edit\/(\d+)/);
  if (m2) return { org: m2[1], project: m2[2], id: m2[3] };
  return null;
}

// Map relation types to friendly names
const RELATION_TYPES = {
  "System.LinkTypes.Hierarchy-Forward": "Child",
  "System.LinkTypes.Hierarchy-Reverse": "Parent",
  "System.LinkTypes.Related": "Related",
  "System.LinkTypes.Dependency-Forward": "Successor",
  "System.LinkTypes.Dependency-Reverse": "Predecessor",
  "Microsoft.VSTS.Common.Affects-Forward": "Affects",
  "Microsoft.VSTS.Common.Affects-Reverse": "Affected By",
  "System.LinkTypes.Duplicate-Forward": "Duplicate Of",
  "System.LinkTypes.Duplicate-Reverse": "Duplicated By",
  "Microsoft.VSTS.Common.TestedBy-Forward": "Tested By",
  "Microsoft.VSTS.Common.TestedBy-Reverse": "Tests"
};

async function fetchComments(base, headers, workitemId) {
  try {
    const response = await axios.get(
      base + "/workitems/" + workitemId + "/comments?api-version=7.0-preview.3",
      { headers }
    );
    return (response.data.comments || []).map(function(c) {
      return {
        id: c.id,
        text: c.text,
        author: c.createdBy ? c.createdBy.displayName : "Unknown",
        createdDate: c.createdDate,
        modifiedDate: c.modifiedDate
      };
    });
  } catch (e) {
    console.log("  Could not fetch comments for", workitemId, ":", e.message);
    return [];
  }
}

async function fetchWorkItem(base, headers, id, includeComments = true) {
  try {
    const response = await axios.get(
      base + "/workitems/" + id + "?$expand=relations&api-version=7.0",
      { headers }
    );
    const item = response.data;
    const f = item.fields;
    
    const result = {
      id: item.id,
      type: f["System.WorkItemType"],
      title: f["System.Title"],
      state: f["System.State"],
      assignee: f["System.AssignedTo"] ? f["System.AssignedTo"].displayName : "Unassigned",
      description: f["System.Description"] || "",
      acceptanceCriteria: f["Microsoft.VSTS.Common.AcceptanceCriteria"] || "",
      area: f["System.AreaPath"],
      iteration: f["System.IterationPath"],
      priority: f["Microsoft.VSTS.Common.Priority"],
      storyPoints: f["Microsoft.VSTS.Scheduling.StoryPoints"],
      originalEstimate: f["Microsoft.VSTS.Scheduling.OriginalEstimate"],
      remainingWork: f["Microsoft.VSTS.Scheduling.RemainingWork"],
      completedWork: f["Microsoft.VSTS.Scheduling.CompletedWork"],
      createdBy: f["System.CreatedBy"] ? f["System.CreatedBy"].displayName : "Unknown",
      createdDate: f["System.CreatedDate"],
      changedDate: f["System.ChangedDate"],
      changedBy: f["System.ChangedBy"] ? f["System.ChangedBy"].displayName : "Unknown",
      reason: f["System.Reason"],
      tags: f["System.Tags"] || "",
      relations: item.relations || [],
      comments: []
    };
    
    if (includeComments) {
      result.comments = await fetchComments(base, headers, id);
    }
    
    return result;
  } catch (e) {
    console.log("  Error fetching work item", id, ":", e.message);
    return null;
  }
}

async function crawlAdo(org, project, id) {
  const base = "https://dev.azure.com/" + org + "/" + project + "/_apis/wit";
  const auth = Buffer.from(":" + ADO_PAT).toString("base64");
  const headers = { Authorization: "Basic " + auth };

  console.log("Fetching ticket", id);
  const parent = await fetchWorkItem(base, headers, id, true);
  
  if (!parent) {
    throw new Error("Could not fetch work item " + id);
  }

  const result = {
    org: org,
    project: project,
    parent: parent,
    children: [],
    relatedItems: [],
    allComments: []
  };

  // Collect parent comments
  if (parent.comments && parent.comments.length) {
    result.allComments.push({
      workItemId: parent.id,
      workItemTitle: parent.title,
      comments: parent.comments
    });
  }

  // Process all relations
  const childIds = [];
  const relatedIds = [];
  const relationsMap = {};

  (parent.relations || []).forEach(function(r) {
    const relType = r.rel;
    const targetId = r.url.split("/").pop();
    const friendlyType = RELATION_TYPES[relType] || relType;
    
    if (!relationsMap[targetId]) {
      relationsMap[targetId] = {
        id: targetId,
        relationTypes: [],
        attributes: r.attributes || {}
      };
    }
    relationsMap[targetId].relationTypes.push(friendlyType);
    
    if (relType === "System.LinkTypes.Hierarchy-Forward") {
      childIds.push(targetId);
    } else if (relType !== "System.LinkTypes.Hierarchy-Reverse" && 
               !relType.includes("Hyperlink") && 
               !relType.includes("AttachedFile") &&
               !relType.includes("ArtifactLink")) {
      relatedIds.push(targetId);
    }
  });

  console.log("Found", childIds.length, "children and", relatedIds.length, "related items");

  // Fetch all children with comments
  for (var i = 0; i < childIds.length; i++) {
    var cid = childIds[i];
    console.log("  Fetching child:", cid);
    var child = await fetchWorkItem(base, headers, cid, true);
    if (child) {
      result.children.push(child);
      if (child.comments && child.comments.length) {
        result.allComments.push({
          workItemId: child.id,
          workItemTitle: child.title,
          comments: child.comments
        });
      }
    }
  }

  // Fetch related items (without deep comment fetching to avoid too many API calls)
  const uniqueRelatedIds = [...new Set(relatedIds)].filter(function(rid) {
    return !childIds.includes(rid);
  });
  
  for (var j = 0; j < uniqueRelatedIds.length; j++) {
    var rid = uniqueRelatedIds[j];
    console.log("  Fetching related:", rid);
    var related = await fetchWorkItem(base, headers, rid, false);
    if (related) {
      related.relationToParent = relationsMap[rid] ? relationsMap[rid].relationTypes : ["Related"];
      result.relatedItems.push(related);
    }
  }

  // Build summary statistics
  result.stats = {
    totalChildren: result.children.length,
    totalRelated: result.relatedItems.length,
    totalComments: result.allComments.reduce(function(sum, wc) {
      return sum + wc.comments.length;
    }, 0),
    childrenByState: {},
    relatedByType: {}
  };

  result.children.forEach(function(c) {
    var state = c.state || "Unknown";
    result.stats.childrenByState[state] = (result.stats.childrenByState[state] || 0) + 1;
  });

  result.relatedItems.forEach(function(r) {
    var types = r.relationToParent || ["Related"];
    types.forEach(function(t) {
      result.stats.relatedByType[t] = (result.stats.relatedByType[t] || 0) + 1;
    });
  });

  return result;
}

async function analyze(data) {
  var prompt = `You are a Senior TPM creating an executive briefing. Analyze these ADO tickets including their comments and related items.

IMPORTANT: Pay close attention to:
1. Comments on tickets - they contain discussion, decisions, blockers, and context
2. Related tickets - they show dependencies, duplicates, and connected work
3. The relationship types between tickets

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

Use ticket IDs. Extract insights from comments.

DATA: ${JSON.stringify(data)}`;

  console.log("Analyzing with Claude...");
  var r = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 16000,
    temperature: 0,
    messages: [{ role: "user", content: prompt }]
  });
  
  var txt = r.content[0].text;
  console.log("Raw response length:", txt.length);
  
  try {
    // Try to extract JSON from various formats
    let jsonStr = txt;
    
    // Try ```json ... ``` format
    const jsonBlockMatch = txt.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
      jsonStr = jsonBlockMatch[1];
      console.log("Extracted from code block");
    } else {
      // Try to find JSON object directly
      const jsonStart = txt.indexOf('{');
      const jsonEnd = txt.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
        jsonStr = txt.substring(jsonStart, jsonEnd + 1);
        console.log("Extracted JSON object directly");
      }
    }
    
    // Clean up common JSON issues
    jsonStr = jsonStr.trim();
    
    const parsed = JSON.parse(jsonStr);
    console.log("Successfully parsed JSON");
    return parsed;
  } catch (e) { 
    console.log("Parse error:", e.message);
    console.log("Error at position:", e.message.match(/position (\d+)/)?.[1]);
    console.log("First 1000 chars:", txt.substring(0, 1000));
    console.log("Last 500 chars:", txt.substring(txt.length - 500));
    
    // Try to salvage what we can
    try {
      const jsonStart = txt.indexOf('{');
      if (jsonStart !== -1) {
        // Try to find a valid closing brace by testing progressively
        for (let i = txt.length - 1; i > jsonStart; i--) {
          if (txt[i] === '}') {
            try {
              const candidate = txt.substring(jsonStart, i + 1);
              const parsed = JSON.parse(candidate);
              console.log("Recovered partial JSON");
              return parsed;
            } catch (e2) {
              continue;
            }
          }
        }
      }
    } catch (recovery) {
      console.log("Recovery failed:", recovery.message);
    }
    
    return { 
      error: "Failed to parse AI response",
      parseError: e.message,
      raw: txt.substring(0, 2000) + "..." 
    };
  }
}

app.post("/api/chat", async function(req, res) {
  try {
    var prompt = `You are a PM assistant with full project data including all comments and related tickets. 
Answer questions using ticket IDs and specifics. Reference comments and discussions when relevant.
When asked about decisions, context, or discussions, look at the comments.
When asked about dependencies or related work, look at relatedItems.

DATA: ${JSON.stringify(req.body.context)}

QUESTION: ${req.body.question}`;
    
    var r = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }]
    });
    res.json({ response: r.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/analyze", async function(req, res) {
  try {
    var parsed = parseAdoUrl(req.body.url);
    if (!parsed) return res.status(400).json({ error: "Invalid URL" });
    var data = await crawlAdo(parsed.org, parsed.project, parsed.id);
    var analysis = await analyze(data);
    
    // Add to history
    var historyId = addToHistory(parsed.id, req.body.url, data, analysis);
    
    res.json({ tickets: data, analysis: analysis, historyId: historyId });
  } catch (e) {
    console.error("Analysis error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/history", function(req, res) {
  const summary = analysisHistory.map(function(item) {
    return {
      id: item.id,
      ticketId: item.ticketId,
      projectName: item.projectName,
      status: item.status,
      timestamp: item.timestamp,
      totalTickets: item.totalTickets,
      totalComments: item.totalComments
    };
  });
  res.json({ history: summary });
});

app.get("/api/history/:id", function(req, res) {
  const item = analysisHistory.find(function(h) { return h.id === req.params.id; });
  if (!item) return res.status(404).json({ error: "History item not found" });
  res.json({ tickets: item.data, analysis: item.analysis, url: item.url });
});

app.delete("/api/history/:id", function(req, res) {
  const index = analysisHistory.findIndex(function(h) { return h.id === req.params.id; });
  if (index === -1) return res.status(404).json({ error: "History item not found" });
  analysisHistory.splice(index, 1);
  saveHistoryToFile(analysisHistory);
  res.json({ success: true });
});

// Separate the HTML from JavaScript to avoid escaping issues
const clientScript = `
var DATA = null;
var BASE = "";

function link(id) {
  return '<a href="' + BASE + id + '" target="_blank" class="text-blue-400 underline">' + id + '</a>';
}

function linkify(txt) {
  if (!txt || !BASE) return txt || "";
  return String(txt).replace(/\\b(\\d{5,7})\\b/g, function(m) {
    return '<a href="' + BASE + m + '" target="_blank" class="text-blue-400 underline">' + m + '</a>';
  });
}

function stripHtml(html) {
  var tmp = document.createElement("div");
  tmp.innerHTML = html || "";
  return tmp.textContent || tmp.innerText || "";
}

function ask(q) { document.getElementById("chatIn").value = q; chat(); }

async function chat() {
  var q = document.getElementById("chatIn").value.trim();
  if (!q || !DATA) return;
  var log = document.getElementById("chatLog");
  log.innerHTML += '<div class="mb-2"><span class="text-blue-400 font-bold">You:</span> ' + q + '</div>';
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

async function loadHistory() {
  try {
    var res = await fetch("/api/history");
    var data = await res.json();
    var list = document.getElementById("historyList");
    
    if (!data.history || data.history.length === 0) {
      list.innerHTML = '<div class="text-sm text-slate-500 text-center py-8">No history yet</div>';
      return;
    }
    
    list.innerHTML = data.history.map(function(item) {
      var date = new Date(item.timestamp);
      var timeAgo = getTimeAgo(date);
      var statusColor = item.status === "Completed" ? "text-green-400" : 
                       item.status === "In Progress" ? "text-blue-400" : "text-slate-400";
      
      return '<div class="bg-slate-700 rounded-lg p-3 hover:bg-slate-600 cursor-pointer transition" onclick="loadFromHistory(\\'' + item.id + '\\')">' +
        '<div class="flex justify-between items-start mb-1">' +
        '<div class="font-medium text-sm truncate flex-1">' + item.projectName + '</div>' +
        '<button onclick="event.stopPropagation(); deleteHistory(\\'' + item.id + '\\')" class="text-red-400 hover:text-red-300 text-xs ml-2">X</button>' +
        '</div>' +
        '<div class="text-xs text-slate-400">Ticket #' + item.ticketId + '</div>' +
        '<div class="flex justify-between items-center mt-2">' +
        '<span class="text-xs ' + statusColor + '">' + item.status + '</span>' +
        '<span class="text-xs text-slate-500">' + timeAgo + '</span>' +
        '</div>' +
        '<div class="flex gap-2 mt-1 text-xs text-slate-500">' +
        '<span>Tickets: ' + item.totalTickets + '</span>' +
        '<span>Comments: ' + item.totalComments + '</span>' +
        '</div>' +
        '</div>';
    }).join('');
  } catch(e) {
    console.error("Failed to load history:", e);
  }
}

function getTimeAgo(date) {
  var seconds = Math.floor((new Date() - date) / 1000);
  var intervals = {
    year: 31536000,
    month: 2592000,
    week: 604800,
    day: 86400,
    hour: 3600,
    minute: 60
  };
  
  for (var key in intervals) {
    var interval = Math.floor(seconds / intervals[key]);
    if (interval >= 1) {
      return interval + ' ' + key + (interval > 1 ? 's' : '') + ' ago';
    }
  }
  return 'just now';
}

async function loadFromHistory(id) {
  try {
    var res = await fetch("/api/history/" + id);
    var d = await res.json();
    if (d.error) throw new Error(d.error);
    
    DATA = d;
    BASE = "https://dev.azure.com/" + d.tickets.org + "/" + d.tickets.project + "/_workitems/edit/";
    document.getElementById("url").value = d.url || "";
    
    var stats = d.tickets.stats || {};
    document.getElementById("status").textContent = "Loaded from history! " + (d.tickets.children.length + 1) + " tickets, " + (stats.totalComments || 0) + " comments";
    document.getElementById("chatBox").classList.remove("hidden");
    document.getElementById("chatLog").innerHTML = "";
    
    displayResults(d);
  } catch(e) {
    alert("Failed to load from history: " + e.message);
  }
}

async function deleteHistory(id) {
  if (!confirm("Delete this history item?")) return;
  try {
    await fetch("/api/history/" + id, { method: "DELETE" });
    loadHistory();
  } catch(e) {
    alert("Failed to delete: " + e.message);
  }
}

function displayResults(d) {
  renderAnalysis(d);
  loadHistory();
}

window.addEventListener('DOMContentLoaded', function() {
  loadHistory();
});

function renderAnalysis(d) {
  var a = d.analysis;
  var stats = d.tickets.stats || {};
  var h = "";
  
  try {
    
    // Project Overview
    if (a.projectOverview) {
      var p = a.projectOverview;
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4">';
      h += '<div class="flex justify-between mb-2"><h2 class="text-2xl font-bold">' + (p.name||"Project") + '</h2>';
      h += '<span class="px-3 py-1 rounded-full text-sm ' + (p.status=="Completed"?"bg-green-500/20 text-green-400":"bg-blue-500/20 text-blue-400") + '">' + (p.status||"") + '</span></div>';
      h += '<p class="text-slate-300 mb-2">' + (p.description||"") + '</p>';
      if (p.businessImpact) h += '<p class="text-slate-400 text-sm mb-2"><b>Impact:</b> ' + p.businessImpact + '</p>';
      h += '<div class="grid grid-cols-4 gap-2 text-center text-sm">';
      h += '<div class="bg-slate-700 rounded p-2"><div class="text-green-400 font-bold">' + (p.completion||"N/A") + '</div><div class="text-xs text-slate-400">Complete</div></div>';
      h += '<div class="bg-slate-700 rounded p-2"><div class="font-bold">' + (p.startDate||"N/A") + '</div><div class="text-xs text-slate-400">Start</div></div>';
      h += '<div class="bg-slate-700 rounded p-2"><div class="font-bold">' + (p.completionDate||"N/A") + '</div><div class="text-xs text-slate-400">End</div></div>';
      h += '<div class="bg-slate-700 rounded p-2"><div class="font-bold">' + (p.totalDuration||"N/A") + '</div><div class="text-xs text-slate-400">Duration</div></div>';
      h += '</div></div>';
    }
    
    // Executive Summary
    if (a.executiveSummary) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Executive Summary</h3>';
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
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Key Accomplishments</h3>';
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
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Key Decisions (from Comments)</h3>';
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
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Discussion Highlights</h3>';
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
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Team Contributions</h3><div class="grid grid-cols-2 gap-2">';
      a.teamContributions.forEach(function(x) {
        var links = (x.ticketsCompleted||[]).map(function(i){return link(i);}).join(", ");
        h += '<div class="bg-slate-700 rounded p-3"><div class="flex justify-between"><span class="font-medium">' + x.person + '</span>';
        h += '<div><span class="text-blue-400 text-sm">' + (x.ticketsCompleted||[]).length + ' tickets</span>';
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
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Work Breakdown</h3>';
      a.workBreakdown.forEach(function(w) {
        h += '<div class="bg-slate-700 rounded p-3 mb-2"><div class="flex justify-between mb-1"><span class="font-medium">' + w.category + '</span>';
        h += '<span class="text-sm px-2 py-0.5 rounded ' + (w.status=="Complete"?"bg-green-500/20 text-green-400":"bg-blue-500/20 text-blue-400") + '">' + (w.status||"") + '</span></div>';
        h += '<p class="text-sm text-slate-400 mb-2">' + (w.description||"") + '</p>';
        if (w.tickets && w.tickets.length) {
          h += '<div class="space-y-1">';
          w.tickets.forEach(function(t) {
            h += '<div class="bg-slate-800 rounded p-2 text-sm flex items-center gap-2">' + link(t.id);
            h += '<span class="flex-1 truncate">' + t.title + '</span>';
            h += '<span class="text-xs text-slate-500">' + (t.assignee||"") + '</span>';
            h += '<span class="text-xs px-2 py-0.5 rounded ' + (t.state=="Closed"?"bg-green-500/20 text-green-400":"bg-slate-600") + '">' + (t.state||"") + '</span></div>';
          });
          h += '</div>';
        }
        h += '</div>';
      });
      h += '</div>';
    }
    
    // Related Work
    if (a.relatedWork && a.relatedWork.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Related Work</h3>';
      a.relatedWork.forEach(function(r) {
        var types = Array.isArray(r.relationTypes) ? r.relationTypes.join(", ") : (r.relationTypes || "Related");
        h += '<div class="bg-slate-700 rounded p-3 mb-2 flex items-center gap-3">';
        h += '<div class="flex-1">' + link(r.ticketId) + ' <span class="text-slate-300">' + (r.title||"") + '</span></div>';
        h += '<span class="text-xs bg-cyan-500/20 text-cyan-400 px-2 py-1 rounded">' + types + '</span>';
        h += '<span class="text-xs px-2 py-1 rounded ' + (r.status=="Closed"?"bg-green-500/20 text-green-400":"bg-slate-600") + '">' + (r.status||"") + '</span></div>';
      });
      h += '</div>';
    }
    
    // Risks
    if (a.risks && a.risks.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2 text-amber-400">Risks</h3>';
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
    
    // Dependencies
    if (a.dependencies && a.dependencies.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Dependencies</h3>';
      a.dependencies.forEach(function(d) {
        h += '<div class="bg-slate-700 rounded p-3 mb-2"><div class="flex justify-between"><span class="font-medium">' + linkify(d.dependency) + '</span>';
        h += '<span class="text-xs px-2 py-1 rounded ' + (d.status=="Resolved"?"bg-green-500/20 text-green-400":"bg-amber-500/20 text-amber-400") + '">' + (d.status||"") + '</span></div>';
        h += '<p class="text-sm text-slate-400">Type: ' + (d.type||"N/A") + ' | Owner: ' + (d.owner||"N/A") + '</p>';
        if (d.relatedTicketId) h += '<div class="text-xs text-slate-500">Related: ' + link(d.relatedTicketId) + '</div>';
        h += '</div>';
      });
      h += '</div>';
    }
    
    // Blockers
    if (a.blockers && a.blockers.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2 text-red-400">Blockers</h3>';
      a.blockers.forEach(function(b) {
        h += '<div class="bg-slate-700 rounded p-3 mb-2 border-l-4 border-red-500">';
        h += '<div class="font-medium">' + linkify(b.blocker) + '</div>';
        if (b.ticket) h += '<p class="text-sm text-slate-400">Ticket: ' + link(b.ticket) + '</p>';
        if (b.resolution) h += '<p class="text-sm text-green-400">Resolution: ' + b.resolution + '</p>';
        if (b.mentionedInComments) h += '<div class="text-xs text-amber-400">Mentioned in comments</div>';
        h += '</div>';
      });
      h += '</div>';
    }
    
    // Open Questions
    if (a.openQuestions && a.openQuestions.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Open Questions</h3>';
      a.openQuestions.forEach(function(q) {
        h += '<div class="bg-slate-700 rounded p-3 mb-2 border-l-4 border-yellow-500">';
        h += '<div class="text-yellow-400">' + linkify(q.question) + '</div>';
        h += '<div class="text-xs text-slate-400">Asked by: ' + (q.askedBy||"N/A") + ' | Ticket: ' + (q.ticketId ? link(q.ticketId) : "N/A") + '</div></div>';
      });
      h += '</div>';
    }
    
    // Recommendations
    if (a.recommendations && a.recommendations.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Recommendations</h3>';
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
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Next Steps</h3>';
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
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">All Comments (' + stats.totalComments + ')</h3>';
      d.tickets.allComments.forEach(function(wc) {
        h += '<div class="bg-slate-700 rounded p-3 mb-3">';
        h += '<div class="font-medium text-blue-400 mb-2">' + link(wc.workItemId) + ' - ' + wc.workItemTitle + '</div>';
        wc.comments.forEach(function(c) {
          h += '<div class="bg-slate-800 rounded p-2 mb-2 ml-4 border-l-2 border-slate-600">';
          h += '<div class="flex justify-between text-xs text-slate-400 mb-1"><span class="font-medium text-slate-300">' + c.author + '</span>';
          h += '<span>' + new Date(c.createdDate).toLocaleDateString() + '</span></div>';
          h += '<div class="text-sm text-slate-300">' + stripHtml(c.text) + '</div></div>';
        });
        h += '</div>';
      });
      h += '</div>';
    }
    
    // Related Items Section
    if (d.tickets.relatedItems && d.tickets.relatedItems.length) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Related Items (' + d.tickets.relatedItems.length + ')</h3>';
      h += '<table class="w-full text-sm"><tr class="text-left text-slate-400 border-b border-slate-700"><th class="p-2">ID</th><th class="p-2">Title</th><th class="p-2">Relation</th><th class="p-2">Type</th><th class="p-2">State</th><th class="p-2">Assignee</th></tr>';
      d.tickets.relatedItems.forEach(function(t) {
        var relTypes = (t.relationToParent||["Related"]).join(", ");
        h += '<tr class="border-b border-slate-700"><td class="p-2">' + link(t.id) + '</td><td class="p-2">' + t.title + '</td><td class="p-2 text-cyan-400">' + relTypes + '</td><td class="p-2">' + t.type + '</td><td class="p-2 ' + (t.state=="Closed"?"text-green-400":"") + '">' + t.state + '</td><td class="p-2">' + t.assignee + '</td></tr>';
      });
      h += '</table></div>';
    }
    
    // All Tickets Table
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">All Tickets</h3>';
    h += '<table class="w-full text-sm"><tr class="text-left text-slate-400 border-b border-slate-700"><th class="p-2">ID</th><th class="p-2">Title</th><th class="p-2">Type</th><th class="p-2">State</th><th class="p-2">Assignee</th><th class="p-2">Comments</th></tr>';
    var parentCommentCount = (d.tickets.parent.comments||[]).length;
    h += '<tr class="border-b border-slate-700 bg-slate-700/30"><td class="p-2">' + link(d.tickets.parent.id) + '</td><td class="p-2">' + d.tickets.parent.title + '</td><td class="p-2">' + d.tickets.parent.type + '</td><td class="p-2">' + d.tickets.parent.state + '</td><td class="p-2">' + d.tickets.parent.assignee + '</td><td class="p-2 text-amber-400">' + parentCommentCount + '</td></tr>';
    d.tickets.children.forEach(function(t) {
      var commentCount = (t.comments||[]).length;
      h += '<tr class="border-b border-slate-700"><td class="p-2">' + link(t.id) + '</td><td class="p-2">' + t.title + '</td><td class="p-2">' + t.type + '</td><td class="p-2 ' + (t.state=="Closed"?"text-green-400":"") + '">' + t.state + '</td><td class="p-2">' + t.assignee + '</td><td class="p-2 text-amber-400">' + commentCount + '</td></tr>';
    });
    h += '</table></div>';
    
    // Raw JSON
    h += '<div class="bg-slate-800 rounded-xl p-4"><h3 class="text-xl font-bold mb-2">Raw JSON</h3>';
    h += '<pre class="text-xs overflow-auto max-h-64 bg-slate-900 p-3 rounded">' + JSON.stringify(a,null,2) + '</pre></div>';
    
    document.getElementById("results").innerHTML = h;
  } catch(e) {
    document.getElementById("status").textContent = "Error: " + e.message;
  }
  document.getElementById("btn").disabled = false;
  document.getElementById("btn").textContent = "Crawl and Generate Report";
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
    BASE = "https://dev.azure.com/" + d.tickets.org + "/" + d.tickets.project + "/_workitems/edit/";
    var stats = d.tickets.stats || {};
    document.getElementById("status").textContent = "Done! " + (d.tickets.children.length + 1) + " tickets, " + (stats.totalComments || 0) + " comments, " + (stats.totalRelated || 0) + " related items";
    document.getElementById("chatBox").classList.remove("hidden");
    
    renderAnalysis(d);
    loadHistory();
  } catch(e) {
    document.getElementById("status").textContent = "Error: " + e.message;
  }
  document.getElementById("btn").disabled = false;
  document.getElementById("btn").textContent = "Crawl and Generate Report";
}
`;

app.get("/", function(req, res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>PM Intelligence Assistant</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-white min-h-screen p-6">
  <div class="flex gap-4 max-w-7xl mx-auto">
    <!-- History Sidebar -->
    <div id="historySidebar" class="w-80 flex-shrink-0">
      <div class="bg-slate-800 rounded-xl p-4 sticky top-6">
        <div class="flex justify-between items-center mb-3">
          <h2 class="text-lg font-bold">History</h2>
          <button onclick="loadHistory()" class="text-xs text-blue-400 hover:text-blue-300">Refresh</button>
        </div>
        <div id="historyList" class="space-y-2 max-h-[calc(100vh-200px)] overflow-y-auto">
          <div class="text-sm text-slate-500 text-center py-8">No history yet</div>
        </div>
      </div>
    </div>
    
    <!-- Main Content -->
    <div class="flex-1 min-w-0">
    <h1 class="text-3xl font-bold text-center mb-2">PM Intelligence Assistant</h1>
    <p class="text-slate-400 text-center mb-6">ADO Crawler + Comments + Related Items + AI Analysis</p>
    
    <div class="bg-slate-800 rounded-xl p-4 mb-4">
      <input type="text" id="url" placeholder="https://dev.azure.com/org/project/_workitems/edit/12345" class="w-full bg-slate-700 rounded-lg p-3 mb-3 border border-slate-600">
      <button onclick="run()" id="btn" class="w-full py-3 bg-blue-600 hover:bg-blue-500 rounded-lg font-medium">Crawl and Generate Report</button>
      <div id="status" class="mt-3 text-sm text-slate-400"></div>
    </div>
    
    <div id="chatBox" class="hidden bg-slate-800 rounded-xl p-4 mb-4">
      <h3 class="text-lg font-bold mb-3">Ask Questions</h3>
      <div id="chatLog" class="bg-slate-900 rounded-lg p-3 h-48 overflow-y-auto mb-3"></div>
      <div class="flex gap-2">
        <input type="text" id="chatIn" placeholder="Ask anything about this project..." class="flex-1 bg-slate-700 rounded-lg p-3 border border-slate-600" onkeypress="if(event.key==='Enter')chat()">
        <button onclick="chat()" id="chatBtn" class="px-6 py-3 bg-green-600 hover:bg-green-500 rounded-lg">Send</button>
      </div>
      <div class="mt-2 flex flex-wrap gap-2">
        <button onclick="ask('Draft a status email for leadership')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">Status email</button>
        <button onclick="ask('What are the blockers?')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">Blockers</button>
        <button onclick="ask('Summarize the risks')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">Risks</button>
        <button onclick="ask('Who contributed the most?')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">Team</button>
        <button onclick="ask('Create a 1-page executive summary')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">1-pager</button>
        <button onclick="ask('What decisions were made in the comments?')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">Decisions</button>
        <button onclick="ask('What are the dependencies?')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">Dependencies</button>
        <button onclick="ask('Summarize the key discussions')" class="text-xs bg-slate-700 px-3 py-1 rounded-full">Discussions</button>
      </div>
    </div>
    
    <div id="results"></div>
    </div>
  </div>
  
<script>
${clientScript}
</script>
</body>
</html>`);
});

app.listen(3000, function() {
  console.log("========================================");
  console.log("  PM Intelligence Assistant Running");
  console.log("  Open http://localhost:3000");
  console.log("========================================");
});