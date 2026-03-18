require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

// Persistent history storage
const HISTORY_FILE = path.join(__dirname, 'youtrack-history.json');
const MAX_HISTORY = 20;

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
console.log('Loaded ' + analysisHistory.length + ' history items from file');

function addToHistory(issueId, url, data, analysis) {
  const historyItem = {
    id: Date.now().toString(),
    issueId: issueId,
    url: url,
    timestamp: new Date().toISOString(),
    projectName: analysis.projectOverview?.name || data.parent?.title || 'Issue ' + issueId,
    status: analysis.projectOverview?.status || data.parent?.state || 'N/A',
    totalTickets: (data.children?.length || 0) + 1,
    totalComments: data.stats?.totalComments || 0,
    hasChatData: !!(data.chatMessages && data.chatMessages.messages && data.chatMessages.messages.length > 0),
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

const { fetchGoogleChatSpaces } = require('./gchat-utils');

function correlateChatsWithTickets(ticketData, chatData) {
  if (!chatData) return null;

  console.log('Correlating chat messages with tickets...');

  const correlations = {
    ticketToChats: {},
    chatToTickets: {},
    unlinkedChats: []
  };

  Object.keys(chatData.ticketMentions).forEach(function(ticketId) {
    correlations.ticketToChats[ticketId] = chatData.ticketMentions[ticketId];
  });

  chatData.messages.forEach(function(msg) {
    if (msg.ticketIds.length > 0) {
      const msgId = msg.name || msg.timestamp || Math.random().toString();
      if (!correlations.chatToTickets[msgId]) {
        correlations.chatToTickets[msgId] = msg.ticketIds;
      }
    } else {
      correlations.unlinkedChats.push(msg);
    }
  });

  console.log('Found', Object.keys(correlations.ticketToChats).length, 'tickets mentioned in chats');
  console.log('Found', correlations.unlinkedChats.length, 'unlinked chat messages');

  return correlations;
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
      .filter(function(c) { return !c.deleted; })
      .map(function(c) {
        return {
          id: c.id,
          text: c.text || '',
          author: c.author ? (c.author.fullName || c.author.login) : 'Unknown',
          createdDate: c.created,
          modifiedDate: c.updated
        };
      });
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

  // DEBUG: Log raw issue data structure
  console.log('DEBUG - Raw issue data for', issue.idReadable, ':', {
    hasState: !!issue.state,
    stateValue: issue.state,
    hasAssignee: !!issue.assignee,
    assigneeValue: issue.assignee,
    hasCustomFields: !!issue.customFields,
    customFieldsCount: (issue.customFields || []).length
  });

  // Extract custom fields and find State and Assignee
  const customFields = {};
  let stateFromCustomFields = null;
  let assigneeFromCustomFields = null;
  
  (issue.customFields || []).forEach(function(cf) {
    const name = cf.name;
    let value = cf.value;
    
    // Check if this is the State field
    if (name === 'State' && value) {
      if (Array.isArray(value)) {
        stateFromCustomFields = value[0]?.name || value[0];
      } else if (typeof value === 'object') {
        stateFromCustomFields = value.name || value;
      } else {
        stateFromCustomFields = value;
      }
    }
    
    // Check if this is the Assignee field
    if (name === 'Assignee' && value) {
      if (Array.isArray(value)) {
        assigneeFromCustomFields = value[0]?.fullName || value[0]?.login || value[0];
      } else if (typeof value === 'object') {
        assigneeFromCustomFields = value.fullName || value.login || value.name || value;
      } else {
        assigneeFromCustomFields = value;
      }
    }
    
    if (value) {
      if (Array.isArray(value)) {
        value = value.map(function(v) { return v.name || v.text || v.presentation || v.fullName || v; }).join(', ');
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

  (issue.links || []).forEach(function(link) {
    const linkType = link.linkType?.name || 'Related';
    const direction = link.direction;
    
    (link.issues || []).forEach(function(linkedIssue) {
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
    state: issue.state?.name || stateFromCustomFields || customFields['State'] || 'Unknown',
    priority: issue.priority?.name || customFields['Priority'] || 'Normal',
    assignee: issue.assignee?.fullName || assigneeFromCustomFields || customFields['Assignee'] || 'Unassigned',
    assigneeEmail: issue.assignee?.email || '',
    reporter: issue.reporter?.fullName || 'Unknown',
    reporterEmail: issue.reporter?.email || '',
    project: issue.project?.name || '',
    projectKey: issue.project?.shortName || '',
    estimation: issue.estimation?.presentation || customFields['Estimation'] || '',
    spentTime: issue.spent?.presentation || '',
    tags: (issue.tags || []).map(function(t) { return t.name; }),
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
  
  console.log('DEBUG - Parent ticket:', parent.id, 'State:', parent.state, 'Assignee:', parent.assignee);
  
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
    ...parent.children.map(function(c) { return Object.assign({}, c, { linkType: 'Subtask' }); }),
    ...parent.relatedItems.map(function(r) { return Object.assign({}, r, { linkType: r.relationType || 'Related' }); })
  ];
  
  // Deduplicate by ID
  const uniqueLinkedItems = [];
  const seenIds = new Set();
  allLinkedItems.forEach(function(item) {
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
        console.log('DEBUG - Child ticket:', linked.id, 'State:', linked.state, 'Assignee:', linked.assignee);
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
          linked.dependencies.forEach(function(dep) {
            if (!result.dependencies.find(function(d) { return d.id === dep.id; }) && dep.id !== parent.id) {
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
    totalComments: result.allComments.reduce(function(sum, ic) { return sum + ic.comments.length; }, 0),
    childrenByState: {},
    childrenByType: {},
    childrenByAssignee: {}
  };

  result.children.forEach(function(c) {
    const state = c.state || 'Unknown';
    const type = c.type || 'Issue';
    const assignee = c.assignee || 'Unassigned';
    result.stats.childrenByState[state] = (result.stats.childrenByState[state] || 0) + 1;
    result.stats.childrenByType[type] = (result.stats.childrenByType[type] || 0) + 1;
    result.stats.childrenByAssignee[assignee] = (result.stats.childrenByAssignee[assignee] || 0) + 1;
  });

  return result;
}

// Trim data to reduce token usage and avoid rate limits (429)
const MAX_COMMENT_CHARS = 600;
const MAX_DESCRIPTION_CHARS = 1500;
const MAX_CHAT_MSG_CHARS = 400;
const MAX_COMMENTS_PER_TICKET = 30;

function trimDataForAnalysis(data) {
  const out = JSON.parse(JSON.stringify(data));
  function trunc(s, max) {
    if (typeof s !== 'string') return s;
    return s.length <= max ? s : s.slice(0, max) + '...[truncated]';
  }
  if (out.parent) {
    if (out.parent.description) out.parent.description = trunc(out.parent.description, MAX_DESCRIPTION_CHARS);
    if (Array.isArray(out.parent.comments)) {
      out.parent.comments = out.parent.comments.slice(-MAX_COMMENTS_PER_TICKET).map(function (c) {
        if (c.text) c.text = trunc(c.text, MAX_COMMENT_CHARS);
        return c;
      });
    }
  }
  if (Array.isArray(out.children)) {
    out.children = out.children.map(function (t) {
      if (t.description) t.description = trunc(t.description, MAX_DESCRIPTION_CHARS);
      if (Array.isArray(t.comments)) {
        t.comments = t.comments.slice(-MAX_COMMENTS_PER_TICKET).map(function (c) {
          if (c.text) c.text = trunc(c.text, MAX_COMMENT_CHARS);
          return c;
        });
      }
      return t;
    });
  }
  if (out.allComments && Array.isArray(out.allComments)) {
    out.allComments = out.allComments.map(function (ic) {
      if (Array.isArray(ic.comments)) {
        ic.comments = ic.comments.slice(-MAX_COMMENTS_PER_TICKET).map(function (c) {
          if (c.text) c.text = trunc(c.text, MAX_COMMENT_CHARS);
          return c;
        });
      }
      return ic;
    });
  }
  if (out.chatMessages && out.chatMessages.messages && Array.isArray(out.chatMessages.messages)) {
    out.chatMessages.messages = out.chatMessages.messages.map(function (m) {
      if (m.text) m.text = trunc(m.text, MAX_CHAT_MSG_CHARS);
      return m;
    });
  }
  return out;
}

async function analyze(data) {
  const hasChat = data.chatMessages && data.chatMessages.messages && data.chatMessages.messages.length > 0;
  
  console.log('=== CHAT ANALYSIS DEBUG ===');
  console.log('Has chat messages:', hasChat);
  if (hasChat) {
    console.log('Total chat messages:', data.chatMessages.messages.length);
    console.log('Chat participants:', data.chatMessages.participants);
    console.log('Ticket mentions in chat:', Object.keys(data.chatMessages.ticketMentions || {}).length);
  }
  console.log('===========================');
  
  const trimmed = trimDataForAnalysis(data);
  
  const prompt = `You are a Senior TPM creating an executive briefing. Analyze these YouTrack tickets${hasChat ? ' and Google Chat conversations' : ''} including their comments and related items.

IMPORTANT: Pay close attention to:
1. Comments on tickets - they contain discussion, decisions, blockers, and context
2. Related tickets and dependencies - they show connected work
3. Custom fields that may contain sprint, story points, or other metadata
${hasChat ? `4. Google Chat messages - informal discussions, decisions, and context not captured in tickets
5. Ticket mentions in chats - correlate chat discussions with formal ticket work
6. Unlinked chat discussions - important context that may not be recorded in tickets

MANDATORY CHAT ANALYSIS - YOU MUST GENERATE THESE SECTIONS:
- REQUIRED: chatDiscussions array - Group chat messages into discussion topics and map to tickets
- REQUIRED: inferredMappings array - Map unlinked chat discussions to tickets using semantic/team/temporal matching
- REQUIRED: teamCrossAnalysis array - Show each person's activity in BOTH chat and tickets
- REQUIRED: mvpAnalysis object - Categorize discussions into MVP vs Post-MVP

CHAT CORRELATION METHODS (use ALL of these):
1. EXPLICIT MATCHING: Find ticket IDs mentioned in chat (TICKET-123 format)
2. SEMANTIC MATCHING: Match chat topics to ticket titles/descriptions by meaning and context
3. TEAM MATCHING: Link discussions where chat participants match ticket assignees/reporters/commenters
4. TEMPORAL MATCHING: Connect discussions near ticket creation/update dates
5. KEYWORD MATCHING: Match technical terms, feature names, problems between chat and tickets

FOR EVERY CHAT MESSAGE GROUP:
- Assign confidence: "high", "medium", or "low" based on matching strength
- Provide reasoning explaining WHY this chat maps to these tickets
- List matched participants (people in both chat and ticket)
- List shared keywords between chat and tickets
- Mark MVP category: "MVP", "Post-MVP", or "Undefined"
- Flag if needs new ticket creation

TEAM CROSS ANALYSIS (REQUIRED if chat exists):
- For EACH person in chat OR tickets, show:
  * activeInChat: boolean (did they write chat messages?)
  * chatMessageCount: number
  * activeInTickets: boolean (assigned to or commented on tickets?)
  * ticketsInvolved: array of ticket IDs
  * commentCount: number
  * engagementPattern: "chat-heavy" or "ticket-heavy" or "balanced"
` : ''}

${hasChat ? `
CRITICAL: If chat data exists, you MUST include these 4 additional top-level fields in your JSON response:
1. chatDiscussions: [...array of discussion objects...]
2. inferredMappings: [...array of mapping objects...]
3. teamCrossAnalysis: [...array of person objects...]
4. mvpAnalysis: {...object with mvpItems, postMvpItems, unmappedDiscussions...}

Example structure when chat exists:
{
  "projectOverview": {...},
  "executiveSummary": [...],
  "chatDiscussions": [
    {
      "topic": "Review summarization requirements discussion",
      "summary": "Team discussed MVP scope for review summaries...",
      "participants": ["Myranda Karlovich", "Wai Yan Yoon"],
      "relatedTickets": [
        {
          "ticketId": "UNSER-1141",
          "matchType": "explicit",
          "confidence": "high",
          "reasoning": "Ticket ID explicitly mentioned in chat"
        }
      ],
      "mvpCategory": "MVP",
      "needsTicket": false
    }
  ],
  "inferredMappings": [...],
  "teamCrossAnalysis": [...],
  "mvpAnalysis": {...},
  "metrics": {...}
}
` : ''}

Return JSON with:
- projectOverview (name, description, businessImpact, owner, status, completion, startDate, completionDate, totalDuration)
- executiveSummary (comprehensive 5 paragraphs incorporating insights from comments${hasChat ? ' and chats' : ''})
- keyAccomplishments (array: accomplishment, ticketIds, impact, team)
- keyDecisions (array: decision, context, madeBy, ticketId, date, source: "chat" or "ticket") - extracted from comments${hasChat ? ' AND chats' : ''}
- discussionHighlights (array: topic, summary, participants, ticketId, source: "chat" or "ticket") - key discussion threads from comments${hasChat ? ' AND chats' : ''}
- workBreakdown (array: category, description, status, tickets array with id/title/state/assignee, date - when category was completed or last updated)
- teamContributions (array: person, ticketsCompleted as ID array, keyContributions, commentCount${hasChat ? ', chatMessageCount' : ''})
- dependencies (array: dependency, type, status, owner, impact, relatedTicketId, date - when dependency was identified or last updated)
- blockers (array: blocker, ticket, severity, status, resolution, mentionedInComments${hasChat ? ', mentionedInChat' : ''}, date - when blocker was identified or resolved)
- risks (array: risk, likelihood, impact, mitigation, owner, sourceTicketId, date - when risk was identified or highlighted)
- relatedWork (array: ticketId, title, relationTypes, status, relevance) - from related items
- openQuestions (array: question, ticketId, askedBy, source: "chat" or "ticket") - unresolved questions from comments${hasChat ? ' AND chats' : ''}
${hasChat ? `- chatDiscussions (array: topic, summary, participants, relatedTickets array with objects {ticketId, matchType: "explicit" or "semantic" or "team" or "temporal" or "topic", confidence: "high" or "medium" or "low", reasoning: string}, mvpCategory: "MVP" or "Post-MVP" or "Undefined", needsTicket: boolean, ticketSuggestion: string if needsTicket is true)
- inferredMappings (array: chatTopic, suggestedTickets array with {ticketId, title, confidence, reasoning, matchedParticipants array, sharedKeywords array})
- teamCrossAnalysis (array: person, activeInChat: boolean, chatMessageCount, activeInTickets: boolean, ticketsInvolved array with ticket IDs, commentCount, engagementPattern: "chat-heavy" or "ticket-heavy" or "balanced")
- mvpAnalysis (object: mvpItems array with discussion/ticketIds/status, postMvpItems array with discussion/ticketIds/status, unmappedDiscussions array with topic/summary/needsTicket)
` : ''}- metrics (total, completed, inProgress, notStarted, blocked, completionRate, totalComments${hasChat ? ', totalChatMessages, chatToTicketMappingRate, inferredMappingsCount' : ''}, relatedItemsCount)
- recommendations (array: priority, recommendation, rationale, owner, category)
- nextSteps (array: action, owner, priority)

Use ticket IDs (like UNSER-1141). Extract insights from comments${hasChat ? ' and chats' : ''}.

DATA: ${JSON.stringify(trimmed)}`;

  console.log('Analyzing with Claude...');
  let lastErr;
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const r = await anthropic.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }]
      });
      const txt = r.content[0].text;
      const parsed = extractAnalysisJson(txt);
      if (parsed) return parsed;
      console.log('Analysis JSON parse failed. Raw response length:', txt.length);
      return { raw: txt };
    } catch (e) {
      lastErr = e;
      const is429 = e.status === 429 || (e.message && e.message.includes('429'));
      if (is429 && attempt < maxRetries) {
        const waitMs = Math.min(60000, 5000 * Math.pow(2, attempt));
        console.warn('Rate limit (429). Waiting ' + (waitMs / 1000) + 's before retry ' + (attempt + 1) + '/' + maxRetries + '...');
        await new Promise(function (resolve) { setTimeout(resolve, waitMs); });
      } else {
        throw e;
      }
    }
  }
  throw lastErr;
}

// Robust extraction of JSON from AI response (handles markdown blocks and minor invalid JSON)
function extractAnalysisJson(txt) {
  if (!txt || typeof txt !== 'string') return null;
  let jsonStr = '';
  const jsonBlockMatch = txt.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch) {
    jsonStr = jsonBlockMatch[1].trim();
  } else {
    const jsonStart = txt.indexOf('{');
    const jsonEnd = txt.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
      jsonStr = txt.substring(jsonStart, jsonEnd + 1);
    }
  }
  if (!jsonStr) return null;
  // Try parse as-is
  try {
    return JSON.parse(jsonStr);
  } catch (_) {}
  // Fix common issues: trailing commas before } or ]
  try {
    const fixed = jsonStr.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(fixed);
  } catch (_) {}
  // Try with truncated content in case of cut-off response
  try {
    let depth = 0;
    let end = -1;
    for (let i = 0; i < jsonStr.length; i++) {
      const c = jsonStr[i];
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end > 0) {
      return JSON.parse(jsonStr.substring(0, end + 1));
    }
  } catch (_) {}
  return null;
}

app.post('/api/chat', async function(req, res) {
  try {
    const prompt = `You are a PM assistant with full project data including all comments and related tickets from YouTrack.
Answer questions using ticket IDs and specifics. Reference comments and discussions when relevant.
When asked about decisions, context, or discussions, look at the comments.
When asked about dependencies or related work, look at relatedItems and dependencies.

DATA: ${JSON.stringify(req.body.context)}

QUESTION: ${req.body.question}`;
    
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ response: r.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper function to check if a date is within the last 2 weeks
function isRecentActivity(dateString) {
  if (!dateString) return false;
  const date = new Date(dateString);
  const twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  return date >= twoWeeksAgo;
}

// Helper function to format date and add recent indicator
function formatWithRecent(dateString, label) {
  if (!dateString) return label;
  const isRecent = isRecentActivity(dateString);
  const date = new Date(dateString);
  const formatted = date.toLocaleDateString();
  return isRecent ? `🆕 ${label} (${formatted})` : `${label} (${formatted})`;
}

// Function to format analysis as Google Chat card message
function formatGoogleChatMessage(analysis, data, issueId, baseUrl) {
  const overview = analysis.projectOverview || {};
  const analysisMetrics = analysis.metrics || {};
  const dataStats = data.stats || {};
  const issueUrl = `${baseUrl}/issue/${issueId}`;
  
  // Calculate actual stats from data
  const totalTickets = (data.children?.length || 0) + 1; // parent + children
  const totalComments = dataStats.totalComments || 0;
  const totalRelated = dataStats.totalRelated || 0;
  
  // Count tickets by state
  const childrenByState = dataStats.childrenByState || {};
  const parentState = data.parent?.state || '';
  let completed = 0;
  let inProgress = 0;
  let notStarted = 0;
  let blocked = 0;
  
  // Count parent
  if (parentState) {
    const stateLower = parentState.toLowerCase();
    if (stateLower.includes('done') || stateLower.includes('closed') || stateLower.includes('resolved') || stateLower.includes('completed')) {
      completed++;
    } else if (stateLower.includes('progress') || stateLower.includes('in work')) {
      inProgress++;
    } else if (stateLower.includes('blocked')) {
      blocked++;
    } else {
      notStarted++;
    }
  }
  
  // Count children
  Object.keys(childrenByState).forEach(state => {
    const stateLower = state.toLowerCase();
    const count = childrenByState[state] || 0;
    if (stateLower.includes('done') || stateLower.includes('closed') || stateLower.includes('resolved') || stateLower.includes('completed')) {
      completed += count;
    } else if (stateLower.includes('progress') || stateLower.includes('in work')) {
      inProgress += count;
    } else if (stateLower.includes('blocked')) {
      blocked += count;
    } else {
      notStarted += count;
    }
  });
  
  // Calculate completion rate
  const completionRate = totalTickets > 0 ? ((completed / totalTickets) * 100).toFixed(2) + '%' : 'N/A';
  
  // Use calculated stats or fall back to analysis metrics
  const metrics = {
    total: totalTickets,
    completed: completed,
    inProgress: inProgress,
    notStarted: notStarted,
    blocked: blocked,
    completionRate: completionRate,
    totalComments: totalComments,
    relatedItemsCount: totalRelated
  };
  
  // Google Chat has size limits, so we'll create multiple cards
  const cards = [];
  
  // Card 1: Header, Stats, and Executive Summary
  const card1Sections = [];
  
  // Header section
  card1Sections.push({
    widgets: [
      {
        keyValue: {
          topLabel: 'Project',
          content: overview.name || `Issue ${issueId}`,
          contentMultiline: false,
          icon: 'DESCRIPTION',
          button: {
            textButton: {
              text: 'VIEW ISSUE',
              onClick: {
                openLink: {
                  url: issueUrl
                }
              }
            }
          }
        }
      },
      ...(overview.status ? [{
        keyValue: {
          topLabel: 'Status',
          content: overview.status,
          contentMultiline: false,
          icon: 'STAR'
        }
      }] : [])
    ]
  });
  
  // Calculate recent activity stats
  let recentResolved = 0;
  let recentUpdated = 0;
  let recentComments = 0;
  
  // Check parent
  if (data.parent) {
    if (data.parent.resolvedDate && isRecentActivity(data.parent.resolvedDate)) recentResolved++;
    if (data.parent.updatedDate && isRecentActivity(data.parent.updatedDate) && !isRecentActivity(data.parent.resolvedDate)) recentUpdated++;
    if (data.parent.comments) {
      recentComments += data.parent.comments.filter(c => isRecentActivity(c.createdDate)).length;
    }
  }
  
  // Check children
  if (data.children) {
    data.children.forEach(child => {
      if (child.resolvedDate && isRecentActivity(child.resolvedDate)) recentResolved++;
      if (child.updatedDate && isRecentActivity(child.updatedDate) && !isRecentActivity(child.resolvedDate)) recentUpdated++;
      if (child.comments) {
        recentComments += child.comments.filter(c => isRecentActivity(c.createdDate)).length;
      }
    });
  }
  
  // Stats section
  const statsText = [
    `${metrics.total || 0} Total`,
    `${metrics.completed || 0} Done`,
    `${metrics.inProgress || 0} In Progress`,
    `${metrics.notStarted || 0} Not Started`,
    `${metrics.blocked || 0} Blocked`,
    `${metrics.completionRate || 'N/A'} Rate`,
    `${metrics.totalComments || 0} Comments`,
    `${metrics.relatedItemsCount || 0} Related`
  ].join(' | ');
  
  const recentActivityText = recentResolved > 0 || recentUpdated > 0 || recentComments > 0
    ? `\n🆕 Recent (last 2 weeks): ${recentResolved} resolved, ${recentUpdated} updated, ${recentComments} comments`
    : '';
  
  card1Sections.push({
    widgets: [{
      textParagraph: {
        text: '<b>📊 Stats</b>\n' + statsText + recentActivityText
      }
    }]
  });
  
  // Executive Summary
  if (analysis.executiveSummary) {
    // Handle both string and array formats
    let summaryText = '';
    if (typeof analysis.executiveSummary === 'string') {
      summaryText = analysis.executiveSummary;
    } else if (Array.isArray(analysis.executiveSummary)) {
      summaryText = analysis.executiveSummary.join('\n');
    } else {
      summaryText = String(analysis.executiveSummary);
    }
    
    // Clean up the text (keep newlines for readability)
    summaryText = summaryText.replace(/\n\n+/g, '\n');
    
    card1Sections.push({
      widgets: [{
        textParagraph: {
          text: '<b>📋 Executive Summary</b>\n' + summaryText
        }
      }]
    });
  }
  
  cards.push({
    header: {
      title: overview.name || `Project Analysis: ${issueId}`,
      subtitle: overview.status || 'Analysis Complete',
      imageUrl: 'https://www.gstatic.com/images/icons/material/system/1x/description_googblue_24dp.png',
      imageStyle: 'IMAGE'
    },
    sections: card1Sections
  });
  
  // Card 2: Key Decisions and Discussion Highlights - prioritize recent
  const card2Sections = [];
  
  if (analysis.keyDecisions && analysis.keyDecisions.length > 0) {
    // Sort decisions: recent first
    const sortedDecisions = [...analysis.keyDecisions].sort((a, b) => {
      const dateA = a.date ? new Date(a.date) : new Date(0);
      const dateB = b.date ? new Date(b.date) : new Date(0);
      const isRecentA = isRecentActivity(a.date);
      const isRecentB = isRecentActivity(b.date);
      if (isRecentA && !isRecentB) return -1;
      if (!isRecentA && isRecentB) return 1;
      return dateB - dateA;
    });
    
    const decisions = sortedDecisions.map((d, i) => {
      const recentBadge = isRecentActivity(d.date) ? ' 🆕' : '';
      const dateInfo = d.date ? ` (${new Date(d.date).toLocaleDateString()})` : '';
      return `${i + 1}. ${d.decision}${recentBadge}${d.madeBy ? ' (by ' + d.madeBy + ')' : ''}${d.ticketId ? ' - ' + d.ticketId : ''}${dateInfo}`;
    }).join('\n');
    
    card2Sections.push({
      widgets: [{
        textParagraph: {
          text: '<b>🎯 Key Decisions</b> (🆕 = last 2 weeks, sorted: recent first)\n' + decisions
        }
      }]
    });
  }
  
  if (analysis.discussionHighlights && analysis.discussionHighlights.length > 0) {
    // Get dates and sort
    const highlightsWithDates = analysis.discussionHighlights.map(h => {
      const ticket = data.parent?.id === h.ticketId ? data.parent : 
                    (data.children || []).find(c => c.id === h.ticketId);
      return {
        highlight: h,
        date: ticket ? (ticket.updatedDate || ticket.createdDate) : null
      };
    });
    
    highlightsWithDates.sort((a, b) => {
      const dateA = a.date ? new Date(a.date) : new Date(0);
      const dateB = b.date ? new Date(b.date) : new Date(0);
      const isRecentA = isRecentActivity(a.date);
      const isRecentB = isRecentActivity(b.date);
      if (isRecentA && !isRecentB) return -1;
      if (!isRecentA && isRecentB) return 1;
      return dateB - dateA;
    });
    
    const highlights = highlightsWithDates.map((item, i) => {
      const h = item.highlight;
      const recentBadge = isRecentActivity(item.date) ? ' 🆕' : '';
      const dateInfo = item.date ? ` (${new Date(item.date).toLocaleDateString()})` : '';
      return `${i + 1}. <b>${h.topic}</b>${recentBadge}: ${h.summary}${h.participants ? ' (Participants: ' + h.participants + ')' : ''}${h.ticketId ? ' - ' + h.ticketId : ''}${dateInfo}`;
    }).join('\n\n');
    
    card2Sections.push({
      widgets: [{
        textParagraph: {
          text: '<b>💭 Discussion Highlights</b> (🆕 = last 2 weeks, sorted: recent first)\n' + highlights
        }
      }]
    });
  }
  
  if (card2Sections.length > 0) {
    cards.push({
      header: {
        title: 'Decisions & Discussions',
        subtitle: `Issue ${issueId}`
      },
      sections: card2Sections
    });
  }
  
  // Card 3: Team Contributions and Work Breakdown
  const card3Sections = [];
  
  if (analysis.teamContributions && analysis.teamContributions.length > 0) {
    // Calculate recent activity and sort
    const teamWithActivity = analysis.teamContributions.map(t => {
      let recentTickets = 0;
      let recentComments = 0;
      
      (t.ticketsCompleted || []).forEach(ticketId => {
        const ticket = data.parent?.id === ticketId ? data.parent :
                      (data.children || []).find(c => c.id === ticketId);
        if (ticket && (isRecentActivity(ticket.resolvedDate) || isRecentActivity(ticket.updatedDate))) {
          recentTickets++;
        }
      });
      
      if (data.allComments) {
        data.allComments.forEach(ic => {
          ic.comments.forEach(c => {
            if (c.author === t.person && isRecentActivity(c.createdDate)) {
              recentComments++;
            }
          });
        });
      }
      
      return {
        person: t,
        recentTickets,
        recentComments,
        hasRecentActivity: recentTickets > 0 || recentComments > 0
      };
    });
    
    // Sort: people with recent activity first
    teamWithActivity.sort((a, b) => {
      if (a.hasRecentActivity && !b.hasRecentActivity) return -1;
      if (!a.hasRecentActivity && b.hasRecentActivity) return 1;
      return (b.recentTickets + b.recentComments) - (a.recentTickets + a.recentComments);
    });
    
    const teamContribs = teamWithActivity.map(item => {
      const t = item.person;
      const ticketCount = (t.ticketsCompleted || []).length;
      const commentCount = t.commentCount || 0;
      const tickets = (t.ticketsCompleted || []).join(', ');
      const recentBadge = item.hasRecentActivity ? ' 🆕' : '';
      const recentInfo = item.hasRecentActivity ? 
        ` (${item.recentTickets} recent tickets, ${item.recentComments} recent comments)` : '';
      return `<b>${t.person}</b>${recentBadge}: ${ticketCount} tickets, ${commentCount} comments${recentInfo}${tickets ? ' (' + tickets + ')' : ''}`;
    }).join('\n');
    
    card3Sections.push({
      widgets: [{
        textParagraph: {
          text: '<b>👥 Team Contributions</b> (🆕 = recent activity, sorted: recent first)\n' + teamContribs
        }
      }]
    });
  }
  
  if (analysis.workBreakdown && analysis.workBreakdown.length > 0) {
    const workBreakdown = analysis.workBreakdown.map(w => {
      // Sort tickets: recent first
      const ticketsWithDates = (w.tickets || []).map(t => {
        const searchId = String(t.id);
        const ticket = data.parent && String(data.parent.id) === searchId ? data.parent : 
                      (data.children || []).find(c => String(c.id) === searchId);
        return {
          ticket: t,
          ticketData: ticket,
          date: ticket ? (ticket.resolvedDate || ticket.updatedDate || ticket.createdDate) : null,
          isRecent: ticket ? (isRecentActivity(ticket.resolvedDate) || isRecentActivity(ticket.updatedDate)) : false
        };
      });
      
      ticketsWithDates.sort((a, b) => {
        const dateA = a.date ? new Date(a.date) : new Date(0);
        const dateB = b.date ? new Date(b.date) : new Date(0);
        if (a.isRecent && !b.isRecent) return -1;
        if (!a.isRecent && b.isRecent) return 1;
        return dateB - dateA;
      });
      
      const ticketList = ticketsWithDates.map(item => {
        const t = item.ticket;
        const recentIndicator = item.isRecent ? ' 🆕' : '';
        const dateInfo = item.date ? ` (${new Date(item.date).toLocaleDateString()})` : '';
        return `${t.id}: ${t.title}${recentIndicator}${dateInfo}`;
      }).join('\n  ');
      return `<b>${w.category}</b> (${w.status || 'N/A'})\n  ${ticketList}`;
    }).join('\n\n');
    
    card3Sections.push({
      widgets: [{
        textParagraph: {
          text: '<b>📁 Work Breakdown</b> (🆕 = resolved/updated in last 2 weeks, sorted: recent first)\n' + workBreakdown
        }
      }]
    });
  }
  
  if (card3Sections.length > 0) {
    cards.push({
      header: {
        title: 'Team & Work Breakdown',
        subtitle: `Issue ${issueId}`
      },
      sections: card3Sections
    });
  }
  
  // Card 4: Dependencies, Risks, Blockers
  const card4Sections = [];
  
  if (analysis.dependencies && analysis.dependencies.length > 0) {
    // Get dates - use explicit date if provided, otherwise infer from related tickets
    const depsWithDates = analysis.dependencies.map(d => {
      let date = d.date || null;
      let ticket = null;
      if (!date && d.relatedTicketId) {
        const searchId = String(d.relatedTicketId);
        ticket = data.parent && String(data.parent.id) === searchId ? data.parent :
         (data.children || []).find(c => String(c.id) === searchId);
        if (ticket) {
          date = ticket.createdDate || ticket.updatedDate || ticket.resolvedDate;
        }
      } else if (d.relatedTicketId) {
        const searchId = String(d.relatedTicketId);
        ticket = data.parent && String(data.parent.id) === searchId ? data.parent :
         (data.children || []).find(c => String(c.id) === searchId);
      }
      return {
        dep: d,
        date: date,
        isRecent: date ? isRecentActivity(date) : (ticket ? (isRecentActivity(ticket.resolvedDate) || isRecentActivity(ticket.updatedDate)) : false)
      };
    });
    
    depsWithDates.sort((a, b) => {
      const dateA = a.date ? new Date(a.date) : new Date(0);
      const dateB = b.date ? new Date(b.date) : new Date(0);
      if (a.isRecent && !b.isRecent) return -1;
      if (!a.isRecent && b.isRecent) return 1;
      return dateB - dateA;
    });
    
    const dependencies = depsWithDates.map(item => {
      const d = item.dep;
      const recentBadge = item.isRecent ? ' 🆕' : '';
      const dateInfo = item.date ? ` (${new Date(item.date).toLocaleDateString()})` : '';
      const ticketLink = d.relatedTicketId ? ` - ${d.relatedTicketId}` : '';
      return `• ${d.dependency}${recentBadge} (${d.type || 'N/A'}) - ${d.status || 'N/A'}${d.owner ? ' - ' + d.owner : ''}${ticketLink}${dateInfo}`;
    }).join('\n');
    
    card4Sections.push({
      widgets: [{
        textParagraph: {
          text: '<b>🔗 Dependencies</b> (🆕 = last 2 weeks, sorted: recent first)\n' + dependencies
        }
      }]
    });
  }
  
  if (analysis.risks && analysis.risks.length > 0) {
    // Get dates - use explicit date if provided, otherwise infer from source tickets
    const risksWithDates = analysis.risks.map(r => {
      let date = r.date || null;
      let ticket = null;
      if (!date && r.sourceTicketId) {
        const searchId = String(r.sourceTicketId);
        ticket = data.parent && String(data.parent.id) === searchId ? data.parent :
         (data.children || []).find(c => String(c.id) === searchId);
        if (ticket) {
          date = ticket.resolvedDate || ticket.updatedDate || ticket.createdDate;
        }
      } else if (r.sourceTicketId) {
        const searchId = String(r.sourceTicketId);
        ticket = data.parent && String(data.parent.id) === searchId ? data.parent :
         (data.children || []).find(c => String(c.id) === searchId);
      }
      return {
        risk: r,
        date: date,
        isRecent: date ? isRecentActivity(date) : (ticket ? (isRecentActivity(ticket.resolvedDate) || isRecentActivity(ticket.updatedDate)) : false)
      };
    });
    
    risksWithDates.sort((a, b) => {
      const dateA = a.date ? new Date(a.date) : new Date(0);
      const dateB = b.date ? new Date(b.date) : new Date(0);
      if (a.isRecent && !b.isRecent) return -1;
      if (!a.isRecent && b.isRecent) return 1;
      return dateB - dateA;
    });
    
    const risks = risksWithDates.map(item => {
      const r = item.risk;
      const recentBadge = item.isRecent ? ' 🆕' : '';
      const dateInfo = item.date ? ` (Highlighted: ${new Date(item.date).toLocaleDateString()})` : '';
      return `• <b>${r.risk}</b>${recentBadge} (${r.likelihood || 'Unknown'}, ${r.impact || 'Unknown'})${r.owner ? ' - ' + r.owner : ''}${r.sourceTicketId ? ' - ' + r.sourceTicketId : ''}${dateInfo}`;
    }).join('\n');
    
    card4Sections.push({
      widgets: [{
        textParagraph: {
          text: '<b>⚠️ Risks</b> (🆕 = last 2 weeks, sorted: recent first)\n' + risks
        }
      }]
    });
  }
  
  if (analysis.blockers && analysis.blockers.length > 0) {
    // Get dates - use explicit date if provided, otherwise infer from blocker tickets
    const blockersWithDates = analysis.blockers.map(b => {
      let date = b.date || null;
      let ticket = null;
      if (!date && b.ticket) {
        const searchId = String(b.ticket);
        ticket = data.parent && String(data.parent.id) === searchId ? data.parent :
         (data.children || []).find(c => String(c.id) === searchId);
        if (ticket) {
          date = ticket.resolvedDate || ticket.updatedDate || ticket.createdDate;
        }
      } else if (b.ticket) {
        const searchId = String(b.ticket);
        ticket = data.parent && String(data.parent.id) === searchId ? data.parent :
         (data.children || []).find(c => String(c.id) === searchId);
      }
      return {
        blocker: b,
        date: date,
        isRecent: date ? isRecentActivity(date) : (ticket ? (isRecentActivity(ticket.resolvedDate) || isRecentActivity(ticket.updatedDate)) : false)
      };
    });
    
    blockersWithDates.sort((a, b) => {
      const dateA = a.date ? new Date(a.date) : new Date(0);
      const dateB = b.date ? new Date(b.date) : new Date(0);
      if (a.isRecent && !b.isRecent) return -1;
      if (!a.isRecent && b.isRecent) return 1;
      return dateB - dateA;
    });
    
    const blockers = blockersWithDates.map(item => {
      const b = item.blocker;
      const recentBadge = item.isRecent ? ' 🆕' : '';
      const dateInfo = item.date ? ` (${new Date(item.date).toLocaleDateString()})` : '';
      const ticketInfo = b.ticket ? ` - ${b.ticket}` : '';
      const resolution = b.resolution ? `\n  ✓ ${b.resolution}` : '';
      return `• ${b.blocker}${recentBadge}${ticketInfo}${dateInfo}${resolution}`;
    }).join('\n');
    
    card4Sections.push({
      widgets: [{
        textParagraph: {
          text: '<b>🚫 Blockers</b> (🆕 = last 2 weeks, sorted: recent first)\n' + blockers
        }
      }]
    });
  }
  
  if (card4Sections.length > 0) {
    cards.push({
      header: {
        title: 'Dependencies, Risks & Blockers',
        subtitle: `Issue ${issueId}`
      },
      sections: card4Sections
    });
  }
  
  // Card 5: Next Steps and Tickets
  const card5Sections = [];
  
  if (analysis.nextSteps && analysis.nextSteps.length > 0) {
    const nextSteps = analysis.nextSteps.map((n, i) => {
      // Try to find date from ticket if action mentions a ticket ID
      let nextStepDate = null;
      if (n.ticketId) {
        const ticket = data.parent?.id === n.ticketId ? data.parent :
                      (data.children || []).find(c => c.id === n.ticketId);
        nextStepDate = ticket ? (ticket.createdDate || ticket.updatedDate) : null;
      } else if (n.action) {
        // Try to extract ticket ID from action text
        const ticketMatch = n.action.match(/\b[A-Z]+-\d+\b/);
        if (ticketMatch) {
          const ticket = data.parent?.id === ticketMatch[0] ? data.parent :
                        (data.children || []).find(c => c.id === ticketMatch[0]);
          nextStepDate = ticket ? (ticket.createdDate || ticket.updatedDate) : null;
        }
      }
      const dateInfo = nextStepDate ? ` (Identified: ${new Date(nextStepDate).toLocaleDateString()})` : '';
      return `${i + 1}. ${n.action} (${n.owner || 'Unassigned'}) - ${n.priority || 'Normal'}${dateInfo}`;
    }).join('\n');
    
    card5Sections.push({
      widgets: [{
        textParagraph: {
          text: '<b>➡️ Next Steps</b>\n' + nextSteps
        }
      }]
    });
  }
  
  // Tickets section - show all tickets sorted by date (recent first)
  const allTicketsForChat = [];
  if (data.parent) {
    const parentDate = data.parent.resolvedDate || data.parent.updatedDate || data.parent.createdDate;
    allTicketsForChat.push({
      ticket: data.parent,
      date: parentDate,
      isParent: true
    });
  }
  if (data.children) {
    data.children.forEach(child => {
      const childDate = child.resolvedDate || child.updatedDate || child.createdDate;
      allTicketsForChat.push({
        ticket: child,
        date: childDate,
        isParent: false
      });
    });
  }
  
  // Sort: recent first, then by date descending
  allTicketsForChat.sort((a, b) => {
    const dateA = a.date ? new Date(a.date) : new Date(0);
    const dateB = b.date ? new Date(b.date) : new Date(0);
    const isRecentA = isRecentActivity(a.ticket.resolvedDate) || isRecentActivity(a.ticket.updatedDate);
    const isRecentB = isRecentActivity(b.ticket.resolvedDate) || isRecentActivity(b.ticket.updatedDate);
    if (isRecentA && !isRecentB) return -1;
    if (!isRecentA && isRecentB) return 1;
    return dateB - dateA;
  });
  
  const ticketWidgets = [];
  allTicketsForChat.forEach(item => {
    const t = item.ticket;
    const isRecentResolved = t.resolvedDate && isRecentActivity(t.resolvedDate);
    const isRecentUpdated = t.updatedDate && isRecentActivity(t.updatedDate);
    const recentIndicator = (isRecentResolved || isRecentUpdated) ? ' 🆕' : '';
    const resolvedInfo = isRecentResolved ? ` (Resolved: ${new Date(t.resolvedDate).toLocaleDateString()})` : '';
    const updatedInfo = isRecentUpdated && !isRecentResolved ? ` (Updated: ${new Date(t.updatedDate).toLocaleDateString()})` : '';
    const dateInfo = !isRecentResolved && !isRecentUpdated && item.date ? ` (${new Date(item.date).toLocaleDateString()})` : '';
    
    ticketWidgets.push({
      keyValue: {
        topLabel: (item.isParent ? 'Parent' : (t.state || 'Open')) + recentIndicator,
        content: `${t.id}: ${t.title}${resolvedInfo}${updatedInfo}${dateInfo}`,
        contentMultiline: false,
        button: {
          textButton: {
            text: 'VIEW',
            onClick: {
              openLink: {
                url: `${baseUrl}/issue/${t.id}`
              }
            }
          }
        }
      }
    });
  });
  
  if (ticketWidgets.length > 0) {
    card5Sections.push({
      widgets: [
        {
          textParagraph: {
            text: '<b>📄 All Tickets</b> (🆕 = resolved/updated in last 2 weeks)'
          }
        },
        ...ticketWidgets
      ]
    });
  }
  
  // Footer button
  card5Sections.push({
    widgets: [{
      buttons: [{
        textButton: {
          text: 'View Full Analysis in YouTrack',
          onClick: {
            openLink: {
              url: issueUrl
            }
          }
        }
      }]
    }]
  });
  
  if (card5Sections.length > 0) {
    cards.push({
      header: {
        title: 'Next Steps & Tickets',
        subtitle: `Issue ${issueId}`
      },
      sections: card5Sections
    });
  }
  
  return { cards: cards };
}

// Function to send message to Google Chat webhook
async function sendToGoogleChat(webhookUrl, message) {
  try {
    console.log('Sending message to Google Chat webhook...');
    const response = await axios.post(webhookUrl, message, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    console.log('Message sent successfully to Google Chat');
    return { success: true, response: response.data };
  } catch (error) {
    console.error('Error sending to Google Chat:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

app.post('/api/analyze', async function(req, res) {
  try {
    console.log('\n=== NEW ANALYSIS REQUEST ===');
    console.log('Chat spaces in request:', req.body.chatSpaces || '(none)');
    console.log('Chat after date:', req.body.chatAfterDate || '(none)');
    
    const parsed = parseYouTrackUrl(req.body.url);
    if (!parsed) return res.status(400).json({ error: 'Invalid YouTrack URL' });
    
    const data = await crawlYouTrack(parsed.baseUrl, parsed.issueId);
    
    // Process Google Chat data - either from export text or URL
    if (req.body.chatSpaces && req.body.chatSpaces.trim()) {
      const spaceNames = req.body.chatSpaces.split(/[\n,]+/).map(function(s) { return s.trim(); }).filter(Boolean);
      const chatData = await fetchGoogleChatSpaces(spaceNames, req.body.chatAfterDate || null);
      if (chatData) {
        data.chatMessages = chatData;
        data.correlations = correlateChatsWithTickets(data, chatData);
        data.stats.totalChatMessages = chatData.totalMessages;
        data.stats.chatParticipants = chatData.participants.length;
        data.stats.ticketMentionsInChat = Object.keys(chatData.ticketMentions).length;
      }
    }
    
    const analysis = await analyze(data);
    
    // Add to history
    const historyId = addToHistory(parsed.issueId, req.body.url, data, analysis);
    
    // Send to Google Chat if webhook URL provided
    let chatResult = null;
    if (req.body.webhookUrl && req.body.webhookUrl.trim()) {
      const chatMessage = formatGoogleChatMessage(analysis, data, parsed.issueId, parsed.baseUrl);
      chatResult = await sendToGoogleChat(req.body.webhookUrl.trim(), chatMessage);
    }
    
    res.json({ 
      tickets: data, 
      analysis: analysis, 
      historyId: historyId,
      chatSent: chatResult ? chatResult.success : false,
      chatError: chatResult && !chatResult.success ? chatResult.error : null
    });
  } catch (e) {
    console.error('Analysis error:', e);
    res.status(500).json({ error: e.message });
  }
});

// History API endpoints
app.get('/api/history', function(req, res) {
  const summary = analysisHistory.map(function(item) {
    return {
      id: item.id,
      issueId: item.issueId,
      projectName: item.projectName,
      status: item.status,
      timestamp: item.timestamp,
      totalTickets: item.totalTickets,
      totalComments: item.totalComments,
      hasChatData: item.hasChatData
    };
  });
  res.json({ history: summary });
});

app.get('/api/history/:id', function(req, res) {
  const item = analysisHistory.find(function(h) { return h.id === req.params.id; });
  if (!item) return res.status(404).json({ error: 'History item not found' });
  res.json({ tickets: item.data, analysis: item.analysis, url: item.url });
});

app.delete('/api/history/:id', function(req, res) {
  const index = analysisHistory.findIndex(function(h) { return h.id === req.params.id; });
  if (index === -1) return res.status(404).json({ error: 'History item not found' });
  analysisHistory.splice(index, 1);
  saveHistoryToFile(analysisHistory);
  res.json({ success: true });
});

// Client-side JavaScript (String.raw prevents escape processing so regex patterns work as-written)
const clientScript = String.raw`
console.log('PM Intelligence Assistant - YouTrack - Script Loaded');
console.log('Page loaded at:', new Date().toISOString());

var DATA = null;
var _scriptLoaded = true;
var BASE = "";

// Helper function to check if a date is within the last 2 weeks
function isRecentActivity(dateString) {
  if (!dateString) return false;
  var date = new Date(dateString);
  var twoWeeksAgo = new Date();
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  return date >= twoWeeksAgo;
}

function link(id) {
  return '<a href="' + BASE + '/issue/' + id + '" target="_blank" class="text-purple-400 underline">' + id + '</a>';
}

function linkify(txt) {
  if (!txt || !BASE) return txt || "";
  return String(txt).replace(/\b([A-Z]+-\d+)\b/g, function(m) {
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

// Helper to get date from ticket by ID (handles both string and numeric IDs)
function getTicketDate(ticketId, d, preferResolved) {
  if (!ticketId || !d || !d.tickets) return null;
  // Normalize ticket ID for comparison (convert to string)
  var searchId = String(ticketId);
  var ticket = null;
  
  // Check parent
  if (d.tickets.parent && String(d.tickets.parent.id) === searchId) {
    ticket = d.tickets.parent;
  } else {
    // Check children
    ticket = (d.tickets.children || []).find(function(c) { 
      return String(c.id) === searchId; 
    });
  }
  
  if (!ticket) return null;
  if (preferResolved && ticket.resolvedDate) {
    return ticket.resolvedDate;
  }
  return ticket.resolvedDate || ticket.updatedDate || ticket.createdDate;
}

// Helper to get comment date for a decision/discussion from a ticket (handles both string and numeric IDs)
function getCommentDate(ticketId, d, searchText) {
  if (!ticketId || !d || !d.tickets) return null;
  // Normalize ticket ID for comparison
  var searchId = String(ticketId);
  var ticket = null;
  
  // Check parent
  if (d.tickets.parent && String(d.tickets.parent.id) === searchId) {
    ticket = d.tickets.parent;
  } else {
    // Check children
    ticket = (d.tickets.children || []).find(function(c) { 
      return String(c.id) === searchId; 
    });
  }
  
  if (!ticket || !ticket.comments || !ticket.comments.length) return null;
  // Find comment that might contain the decision/discussion
  var matchingComment = ticket.comments.find(function(c) {
    return searchText && c.text && c.text.toLowerCase().includes(searchText.toLowerCase().substring(0, 20));
  });
  if (matchingComment && matchingComment.createdDate) return matchingComment.createdDate;
  // Return most recent comment date if no match
  var sorted = ticket.comments.slice().sort(function(a, b) {
    return new Date(b.createdDate || 0) - new Date(a.createdDate || 0);
  });
  return sorted[0] && sorted[0].createdDate ? sorted[0].createdDate : null;
}

// Helper to get latest resolved date from multiple ticket IDs (handles both string and numeric IDs)
function getLatestResolvedDate(ticketIds, d) {
  if (!ticketIds || !Array.isArray(ticketIds) || !d) return null;
  var dates = ticketIds.map(function(id) {
    // Normalize ticket ID for comparison
    var searchId = String(id);
    var ticket = null;
    
    // Check parent
    if (d.tickets.parent && String(d.tickets.parent.id) === searchId) {
      ticket = d.tickets.parent;
    } else {
      // Check children
      ticket = (d.tickets.children || []).find(function(c) { 
        return String(c.id) === searchId; 
      });
    }
    
    if (!ticket) return null;
    if (ticket.resolvedDate) {
      return ticket.resolvedDate;
    }
    return null;
  }).filter(function(d) { return d !== null; });
  if (dates.length === 0) return null;
  dates.sort(function(a, b) { return new Date(b) - new Date(a); });
  return dates[0];
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
      var statusColor = item.status === "Done" || item.status === "Closed" || item.status === "Resolved" ? "text-green-400" : 
                       item.status === "In Progress" ? "text-blue-400" : "text-slate-400";
      var chatBadge = item.hasChatData ? '<span class="text-xs bg-cyan-500/20 text-cyan-400 px-1 rounded">Chat</span>' : '';
      var id = String(item.id).replace(/"/g, '&quot;');
      return '<div class="bg-slate-700 rounded-lg p-3 hover:bg-slate-600 cursor-pointer transition history-item" data-history-id="' + id + '">' +
        '<div class="flex justify-between items-start mb-1">' +
        '<div class="font-medium text-sm truncate flex-1">' + item.projectName + '</div>' +
        '<button type="button" class="history-delete text-red-400 hover:text-red-300 text-xs ml-2" data-history-id="' + id + '">X</button>' +
        '</div>' +
        '<div class="text-xs text-slate-400">' + item.issueId + ' ' + chatBadge + '</div>' +
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
    if (!list._historyClickBound) {
      list._historyClickBound = true;
      list.addEventListener("click", function(e) {
        var id = e.target.getAttribute("data-history-id") || (e.target.closest && e.target.closest(".history-item") && e.target.closest(".history-item").getAttribute("data-history-id"));
        if (e.target.classList.contains("history-delete")) {
          e.stopPropagation();
          if (id) deleteHistory(id);
        } else if (id) loadFromHistory(id);
      });
    }
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
    BASE = d.tickets.baseUrl;
    document.getElementById("url").value = d.url || "";
    
    var stats = d.tickets.stats || {};
    document.getElementById("status").textContent = "Loaded from history! " + (d.tickets.children.length + 1) + " tickets, " + (stats.totalComments || 0) + " comments";
    document.getElementById("chatBox").classList.remove("hidden");
    document.getElementById("chatLog").innerHTML = "";
    
    renderAnalysis(d);
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

window.addEventListener('DOMContentLoaded', function() {
  if (location.protocol === "file:") {
    document.getElementById("status").textContent = "This page must be opened at http://localhost:3001. Start the server with: node youtrack.js";
    document.getElementById("status").classList.add("text-amber-400");
    return;
  }
  loadHistory();
});

function renderAnalysis(d) {
  var a = d.analysis;
  if (!a) a = {};
  // If server returned only { raw: "..." } (parse failed), try to extract JSON on the client
  if (a.raw && typeof a.raw === 'string' && !a.projectOverview) {
    try {
      var rawStr = a.raw;
      var tick = String.fromCharCode(96);
      var codeBlockRe = new RegExp(tick + tick + tick + '(?:json)?\s*([\s\S]*?)\s*' + tick + tick + tick);
      var jsonMatch = rawStr.match(codeBlockRe);
      var jsonStr = jsonMatch ? jsonMatch[1].trim() : rawStr;
      var start = jsonStr.indexOf('{');
      if (start !== -1) {
        var end = jsonStr.lastIndexOf('}');
        if (end > start) jsonStr = jsonStr.substring(start, end + 1);
        jsonStr = jsonStr.replace(/,(\s*[}\\]])/g, '$1');
        var parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed === 'object') a = parsed;
      }
    } catch (e) { console.warn('Client-side analysis parse failed:', e.message); }
  }
  var stats = d.tickets.stats || {};
  var h = "";
  
  // Project Overview
  if (a.projectOverview) {
    var p = a.projectOverview;
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4">';
    h += '<div class="flex justify-between mb-2"><h2 class="text-2xl font-bold">' + (p.name||d.tickets.parent.title||"Project") + '</h2>';
    h += '<span class="px-3 py-1 rounded-full text-sm ' + (p.status=="Completed"||p.status=="Done"||p.status=="Closed"?"bg-green-500/20 text-green-400":"bg-purple-500/20 text-purple-400") + '">' + (p.status||d.tickets.parent.state||"") + '</span></div>';
    h += '<p class="text-slate-300 mb-2">' + (p.description||"") + '</p>';
    if (p.businessImpact) h += '<p class="text-slate-400 text-sm mb-2"><b>Impact:</b> ' + p.businessImpact + '</p>';
    h += '<div class="grid grid-cols-4 gap-2 text-center text-sm">';
    h += '<div class="bg-slate-700 rounded p-2"><div class="text-green-400 font-bold">' + (p.completion||"N/A") + '</div><div class="text-xs text-slate-400">Complete</div></div>';
    h += '<div class="bg-slate-700 rounded p-2"><div class="font-bold">' + (p.startDate||formatDate(d.tickets.parent.createdDate)) + '</div><div class="text-xs text-slate-400">Start</div></div>';
    h += '<div class="bg-slate-700 rounded p-2"><div class="font-bold">' + (p.completionDate||"N/A") + '</div><div class="text-xs text-slate-400">End</div></div>';
    h += '<div class="bg-slate-700 rounded p-2"><div class="font-bold">' + (p.totalDuration||"N/A") + '</div><div class="text-xs text-slate-400">Duration</div></div>';
    h += '</div></div>';
  }
  
  // Executive Summary (string or array of paragraphs)
  if (a.executiveSummary) {
    var summaryText = typeof a.executiveSummary === 'string' ? a.executiveSummary : (Array.isArray(a.executiveSummary) ? a.executiveSummary.join('\n\n') : String(a.executiveSummary));
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Executive Summary</h3>';
    h += '<div class="text-slate-300 whitespace-pre-wrap">' + linkify(summaryText) + '</div></div>';
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
      // Try to get date from tickets - check all ticket IDs
      var accomplishedDate = null;
      if (x.ticketIds && Array.isArray(x.ticketIds) && x.ticketIds.length > 0) {
        accomplishedDate = getLatestResolvedDate(x.ticketIds, d);
        // If no resolved date, try to get latest updatedDate or createdDate
        if (!accomplishedDate) {
          var allDates = x.ticketIds.map(function(id) {
            return getTicketDate(id, d, false);
          }).filter(function(d) { return d !== null; });
          if (allDates.length > 0) {
            allDates.sort(function(a, b) { return new Date(b) - new Date(a); });
            accomplishedDate = allDates[0];
          }
        }
      }
      var dateInfo = accomplishedDate ? '<div class="text-xs text-slate-400 mt-1"><span class="text-green-400">✓ Accomplished:</span> ' + formatDate(accomplishedDate) + '</div>' : '<div class="text-xs text-slate-400 mt-1">Date: N/A</div>';
      h += '<div class="bg-slate-700 rounded p-3 mb-2 border-l-4 border-green-500">';
      h += '<div class="text-green-400 font-medium">' + x.accomplishment + '</div>';
      h += '<p class="text-sm text-slate-300">' + (x.impact||"") + '</p>';
      h += '<div class="text-xs text-slate-400">Team: ' + (x.team||"N/A") + (links ? " | Tickets: " + links : "") + '</div>';
      h += dateInfo;
      h += '</div>';
    });
    h += '</div>';
  }
  
  // Key Decisions - sort by date (recent first)
  if (a.keyDecisions && a.keyDecisions.length) {
    // Sort decisions: recent first, then by date descending
    var sortedDecisions = a.keyDecisions.slice().sort(function(a, b) {
      var dateA = a.date ? new Date(a.date) : new Date(0);
      var dateB = b.date ? new Date(b.date) : new Date(0);
      var isRecentA = isRecentActivity(a.date);
      var isRecentB = isRecentActivity(b.date);
      // Recent items first
      if (isRecentA && !isRecentB) return -1;
      if (!isRecentA && isRecentB) return 1;
      // Then by date (newest first)
      return dateB - dateA;
    });
    
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Key Decisions <span class="text-xs text-green-400">🆕 = last 2 weeks</span></h3>';
    sortedDecisions.forEach(function(x) {
      // Get date from analysis or extract from comments/ticket
      var decisionDate = x.date || getCommentDate(x.ticketId, d, x.decision) || getTicketDate(x.ticketId, d, false);
      var isRecent = isRecentActivity(decisionDate);
      var recentBadge = isRecent ? '<span class="text-green-400 text-xs ml-2">🆕</span>' : '';
      var dateInfo = decisionDate ? ' | Date: ' + formatDate(decisionDate) : '';
      var recentBg = isRecent ? 'bg-green-900/20' : '';
      h += '<div class="bg-slate-700 rounded p-3 mb-2 border-l-4 ' + (isRecent ? 'border-green-500' : 'border-purple-500') + ' ' + recentBg + '">';
      h += '<div class="text-purple-400 font-medium">' + linkify(x.decision) + recentBadge + '</div>';
      h += '<p class="text-sm text-slate-300">' + (x.context||"") + '</p>';
      h += '<div class="text-xs text-slate-400">Made by: ' + (x.madeBy||"N/A") + ' | Ticket: ' + (x.ticketId ? link(x.ticketId) : "N/A") + dateInfo + '</div></div>';
    });
    h += '</div>';
  }
  
  // Discussion Highlights - sort by date (recent first)
  if (a.discussionHighlights && a.discussionHighlights.length) {
    // Try to get date from ticket data or comments
    var highlightsWithDates = a.discussionHighlights.map(function(x) {
      var ticket = d.tickets.parent && d.tickets.parent.id === x.ticketId ? d.tickets.parent : 
                    (d.tickets.children || []).find(function(c) { return c.id === x.ticketId; });
      var discussionDate = getCommentDate(x.ticketId, d, x.topic) || (ticket ? (ticket.updatedDate || ticket.createdDate) : null);
      return {
        highlight: x,
        date: discussionDate
      };
    });
    
    // Sort: recent first, then by date descending
    highlightsWithDates.sort(function(a, b) {
      var dateA = a.date ? new Date(a.date) : new Date(0);
      var dateB = b.date ? new Date(b.date) : new Date(0);
      var isRecentA = isRecentActivity(a.date);
      var isRecentB = isRecentActivity(b.date);
      if (isRecentA && !isRecentB) return -1;
      if (!isRecentA && isRecentB) return 1;
      return dateB - dateA;
    });
    
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Discussion Highlights <span class="text-xs text-green-400">🆕 = last 2 weeks</span></h3>';
    highlightsWithDates.forEach(function(item) {
      var x = item.highlight;
      var isRecent = isRecentActivity(item.date);
      var recentBadge = isRecent ? '<span class="text-green-400 text-xs ml-2">🆕</span>' : '';
      var dateInfo = item.date ? ' | Date: ' + formatDate(item.date) : '';
      var recentBg = isRecent ? 'bg-green-900/20' : '';
      h += '<div class="bg-slate-700 rounded p-3 mb-2 ' + recentBg + '">';
      h += '<div class="font-medium text-cyan-400">' + linkify(x.topic) + recentBadge + '</div>';
      h += '<p class="text-sm text-slate-300">' + (x.summary||"") + '</p>';
      h += '<div class="text-xs text-slate-400">Participants: ' + (x.participants||"N/A") + ' | Ticket: ' + (x.ticketId ? link(x.ticketId) : "N/A") + dateInfo + '</div></div>';
    });
    h += '</div>';
  }
  
  // Team Contributions - sort by recent activity
  if (a.teamContributions && a.teamContributions.length) {
    // Calculate recent activity for each team member
    var teamWithActivity = a.teamContributions.map(function(x) {
      var recentTickets = 0;
      var recentComments = 0;
      
      // Check tickets for recent activity
      (x.ticketsCompleted || []).forEach(function(ticketId) {
        var ticket = d.tickets.parent && d.tickets.parent.id === ticketId ? d.tickets.parent :
                      (d.tickets.children || []).find(function(c) { return c.id === ticketId; });
        if (ticket) {
          if (isRecentActivity(ticket.resolvedDate) || isRecentActivity(ticket.updatedDate)) {
            recentTickets++;
          }
        }
      });
      
      // Check comments for recent activity
      if (d.tickets.allComments) {
        d.tickets.allComments.forEach(function(ic) {
          ic.comments.forEach(function(c) {
            if (c.author === x.person && isRecentActivity(c.createdDate)) {
              recentComments++;
            }
          });
        });
      }
      
      return {
        person: x,
        recentTickets: recentTickets,
        recentComments: recentComments,
        hasRecentActivity: recentTickets > 0 || recentComments > 0
      };
    });
    
    // Sort: people with recent activity first
    teamWithActivity.sort(function(a, b) {
      if (a.hasRecentActivity && !b.hasRecentActivity) return -1;
      if (!a.hasRecentActivity && b.hasRecentActivity) return 1;
      return (b.recentTickets + b.recentComments) - (a.recentTickets + a.recentComments);
    });
    
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Team Contributions <span class="text-xs text-green-400">🆕 = recent activity</span></h3><div class="grid grid-cols-2 gap-2">';
    teamWithActivity.forEach(function(item) {
      var x = item.person;
      var links = (x.ticketsCompleted||[]).map(function(i){return link(i);}).join(", ");
      var recentBadge = item.hasRecentActivity ? '<span class="text-green-400 text-xs ml-2">🆕</span>' : '';
      var recentInfo = item.hasRecentActivity ? 
        '<span class="text-xs text-green-400">(' + item.recentTickets + ' recent tickets, ' + item.recentComments + ' recent comments)</span>' : '';
      var recentBg = item.hasRecentActivity ? 'bg-green-900/20' : '';
      h += '<div class="bg-slate-700 rounded p-3 ' + recentBg + '"><div class="flex justify-between"><span class="font-medium">' + x.person + recentBadge + '</span>';
      h += '<div><span class="text-purple-400 text-sm">' + (x.ticketsCompleted||[]).length + ' tickets</span>';
      if (x.commentCount) h += '<span class="text-amber-400 text-sm ml-2">' + x.commentCount + ' comments</span>';
      h += '</div></div>';
      if (recentInfo) h += '<div class="text-xs mb-1">' + recentInfo + '</div>';
      h += '<p class="text-sm text-slate-400">' + (x.keyContributions||"") + '</p>';
      if (links) h += '<div class="text-xs text-slate-500 mt-1">' + links + '</div>';
      h += '</div>';
    });
    h += '</div></div>';
  }
  
  // Work Breakdown - show ALL tickets, highlight recent ones
  if (a.workBreakdown && a.workBreakdown.length) {
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Work Breakdown <span class="text-xs text-green-400">🆕 = resolved/updated in last 2 weeks</span></h3>';
    a.workBreakdown.forEach(function(w) {
      // Get latest date for the category - use explicit date if provided, otherwise infer from tickets
      var categoryDate = w.date || null;
      if (!categoryDate && w.tickets && w.tickets.length) {
        var dates = w.tickets.map(function(t) {
          var ticket = d.tickets.parent && String(d.tickets.parent.id) === String(t.id) ? d.tickets.parent : 
                        (d.tickets.children || []).find(function(c) { return String(c.id) === String(t.id); });
          if (!ticket) return null;
          if (ticket.resolvedDate) {
            return ticket.resolvedDate;
          }
          return ticket.updatedDate || ticket.createdDate;
        }).filter(function(d) { return d !== null; });
        if (dates.length > 0) {
          dates.sort(function(a, b) { return new Date(b) - new Date(a); });
          categoryDate = dates[0];
        }
      }
      var categoryDateInfo = categoryDate ? ' | Latest: ' + formatDate(categoryDate) : '';
      h += '<div class="bg-slate-700 rounded p-3 mb-2"><div class="flex justify-between mb-1"><span class="font-medium">' + w.category + '</span>';
      h += '<span class="text-sm px-2 py-0.5 rounded ' + (w.status=="Complete"?"bg-green-500/20 text-green-400":"bg-purple-500/20 text-purple-400") + '">' + (w.status||"") + '</span></div>';
      h += '<p class="text-sm text-slate-400 mb-2">' + (w.description||"") + categoryDateInfo + '</p>';
      if (w.tickets && w.tickets.length) {
        h += '<div class="space-y-1">';
        // Show ALL tickets, not filtered - highlight recent ones
        w.tickets.forEach(function(t) {
          var ticket = d.tickets.parent && String(d.tickets.parent.id) === String(t.id) ? d.tickets.parent : 
                        (d.tickets.children || []).find(function(c) { return String(c.id) === String(t.id); });
          var isRecentResolved = ticket && ticket.resolvedDate && isRecentActivity(ticket.resolvedDate);
          var isRecentUpdated = ticket && ticket.updatedDate && isRecentActivity(ticket.updatedDate);
          var recentBadge = (isRecentResolved || isRecentUpdated) ? '<span class="text-green-400 ml-1">🆕</span>' : '';
          var recentBg = (isRecentResolved || isRecentUpdated) ? 'bg-green-900/20' : '';
          var dateInfo = '';
          if (ticket) {
            if (isRecentResolved && ticket.resolvedDate) {
              dateInfo = ' | Resolved: ' + formatDate(ticket.resolvedDate);
            } else if (isRecentUpdated && ticket.updatedDate) {
              dateInfo = ' | Updated: ' + formatDate(ticket.updatedDate);
            } else if (ticket.resolvedDate) {
              dateInfo = ' | Resolved: ' + formatDate(ticket.resolvedDate);
            } else if (ticket.updatedDate) {
              dateInfo = ' | Updated: ' + formatDate(ticket.updatedDate);
            } else if (ticket.createdDate) {
              dateInfo = ' | Created: ' + formatDate(ticket.createdDate);
            }
          }
          h += '<div class="bg-slate-800 rounded p-2 text-sm flex items-center gap-2 ' + recentBg + '">' + link(t.id) + recentBadge;
          h += '<span class="flex-1 truncate">' + t.title + '</span>';
          h += '<span class="text-xs text-slate-500">' + (t.assignee||"") + '</span>';
          h += '<span class="text-xs px-2 py-0.5 rounded ' + (t.state=="Done"||t.state=="Closed"||t.state=="Resolved"?"bg-green-500/20 text-green-400":"bg-slate-600") + '">' + (t.state||"") + '</span>';
          if (dateInfo) h += '<span class="text-xs text-slate-400">' + dateInfo + '</span>';
          h += '</div>';
        });
        h += '</div>';
      }
      h += '</div>';
    });
    h += '</div>';
  }
  
  // Dependencies - sort by date (recent first)
  if (a.dependencies && a.dependencies.length) {
    // Get dates - use explicit date if provided, otherwise infer from related tickets
    var depsWithDates = a.dependencies.map(function(dep) {
      var date = dep.date || null;
      var ticket = null;
      if (!date && dep.relatedTicketId) {
        var searchId = String(dep.relatedTicketId);
        ticket = d.tickets.parent && String(d.tickets.parent.id) === searchId ? d.tickets.parent :
         (d.tickets.children || []).find(function(c) { return String(c.id) === searchId; });
        if (ticket) {
          date = ticket.createdDate; // Use createdDate for when dependency was identified
        }
      } else if (dep.relatedTicketId) {
        var searchId = String(dep.relatedTicketId);
        ticket = d.tickets.parent && String(d.tickets.parent.id) === searchId ? d.tickets.parent :
         (d.tickets.children || []).find(function(c) { return String(c.id) === searchId; });
      }
      return {
        dep: dep,
        date: date,
        isRecent: date ? isRecentActivity(date) : (ticket ? (isRecentActivity(ticket.resolvedDate) || isRecentActivity(ticket.updatedDate)) : false)
      };
    });
    
    // Sort: recent first, then by date descending
    depsWithDates.sort(function(a, b) {
      var dateA = a.date ? new Date(a.date) : new Date(0);
      var dateB = b.date ? new Date(b.date) : new Date(0);
      if (a.isRecent && !b.isRecent) return -1;
      if (!a.isRecent && b.isRecent) return 1;
      return dateB - dateA;
    });
    
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Dependencies <span class="text-xs text-green-400">🆕 = last 2 weeks</span></h3>';
    depsWithDates.forEach(function(item) {
      var dep = item.dep;
      var recentBadge = item.isRecent ? '<span class="text-green-400 text-xs ml-2">🆕</span>' : '';
      var dateInfo = item.date ? '<div class="text-xs text-slate-400 mt-1"><span class="text-cyan-400">🔗 Identified:</span> ' + formatDate(item.date) + '</div>' : '';
      var recentBg = item.isRecent ? 'bg-green-900/20' : '';
      h += '<div class="bg-slate-700 rounded p-3 mb-2 ' + recentBg + '"><div class="flex justify-between"><span class="font-medium">' + linkify(dep.dependency) + recentBadge + '</span>';
      h += '<span class="text-xs px-2 py-1 rounded ' + (dep.status=="Resolved"?"bg-green-500/20 text-green-400":"bg-amber-500/20 text-amber-400") + '">' + (dep.status||"") + '</span></div>';
      h += '<p class="text-sm text-slate-400">Type: ' + (dep.type||"N/A") + ' | Owner: ' + (dep.owner||"N/A") + '</p>';
      if (dep.relatedTicketId) h += '<div class="text-xs text-slate-500">Related: ' + link(dep.relatedTicketId) + '</div>';
      h += dateInfo;
      h += '</div>';
    });
    h += '</div>';
  }
  
  // Risks - sort by date (recent first)
  if (a.risks && a.risks.length) {
    // Get dates - use explicit date if provided, otherwise infer from source tickets or comments
    var risksWithDates = a.risks.map(function(r) {
      var date = r.date || null;
      var ticket = null;
      if (!date && r.sourceTicketId) {
        var searchId = String(r.sourceTicketId);
        ticket = d.tickets.parent && String(d.tickets.parent.id) === searchId ? d.tickets.parent :
         (d.tickets.children || []).find(function(c) { return String(c.id) === searchId; });
        if (ticket) {
          date = ticket.resolvedDate || ticket.updatedDate || ticket.createdDate;
        }
      } else if (r.sourceTicketId) {
        var searchId = String(r.sourceTicketId);
        ticket = d.tickets.parent && String(d.tickets.parent.id) === searchId ? d.tickets.parent :
         (d.tickets.children || []).find(function(c) { return String(c.id) === searchId; });
      }
      // Try to get date from comment if still no date
      if (!date && r.sourceTicketId) {
        date = getCommentDate(r.sourceTicketId, d, r.risk);
      }
      return {
        risk: r,
        date: date,
        isRecent: date ? isRecentActivity(date) : (ticket ? (isRecentActivity(ticket.resolvedDate) || isRecentActivity(ticket.updatedDate)) : false)
      };
    });
    
    // Sort: recent first, then by date descending
    risksWithDates.sort(function(a, b) {
      var dateA = a.date ? new Date(a.date) : new Date(0);
      var dateB = b.date ? new Date(b.date) : new Date(0);
      if (a.isRecent && !b.isRecent) return -1;
      if (!a.isRecent && b.isRecent) return 1;
      return dateB - dateA;
    });
    
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2 text-amber-400">Risks <span class="text-xs text-green-400">🆕 = last 2 weeks</span></h3>';
    risksWithDates.forEach(function(item) {
      var r = item.risk;
      var recentBadge = item.isRecent ? '<span class="text-green-400 text-xs ml-2">🆕</span>' : '';
      // Get date from comment or ticket
      var riskDate = getCommentDate(r.sourceTicketId, d, r.risk) || item.date;
      var dateInfo = riskDate ? '<div class="text-xs text-slate-400 mt-1"><span class="text-amber-400">⚠ Highlighted:</span> ' + formatDate(riskDate) + '</div>' : '';
      var recentBg = item.isRecent ? 'bg-green-900/20' : '';
      h += '<div class="bg-slate-700 rounded p-3 mb-2 border-l-4 ' + (r.likelihood=="High"?"border-red-500":"border-amber-500") + ' ' + recentBg + '">';
      h += '<div class="flex justify-between"><span class="font-medium">' + r.risk + recentBadge + '</span>';
      h += '<span class="text-xs px-2 py-1 rounded ' + (r.likelihood=="High"?"bg-red-500/20 text-red-400":"bg-amber-500/20 text-amber-400") + '">' + (r.likelihood||"") + '</span></div>';
      h += '<p class="text-sm text-slate-400">Impact: ' + (r.impact||"N/A") + '</p>';
      h += '<p class="text-sm text-green-400">Mitigation: ' + (r.mitigation||"N/A") + '</p>';
      if (r.sourceTicketId) h += '<div class="text-xs text-slate-500">Source: ' + link(r.sourceTicketId) + '</div>';
      if (dateInfo) h += dateInfo;
      h += '</div>';
    });
    h += '</div>';
  }
  
  // Blockers - sort by date (recent first)
  if (a.blockers && a.blockers.length) {
    // Get dates - use explicit date if provided, otherwise infer from blocker tickets or comments
    var blockersWithDates = a.blockers.map(function(b) {
      var date = b.date || null;
      var ticket = null;
      if (!date && b.ticket) {
        var searchId = String(b.ticket);
        ticket = d.tickets.parent && String(d.tickets.parent.id) === searchId ? d.tickets.parent :
         (d.tickets.children || []).find(function(c) { return String(c.id) === searchId; });
        if (ticket) {
          date = ticket.resolvedDate || ticket.updatedDate || ticket.createdDate;
        }
      } else if (b.ticket) {
        var searchId = String(b.ticket);
        ticket = d.tickets.parent && String(d.tickets.parent.id) === searchId ? d.tickets.parent :
         (d.tickets.children || []).find(function(c) { return String(c.id) === searchId; });
      }
      // Try to get date from comment if still no date
      if (!date && b.ticket) {
        date = getCommentDate(b.ticket, d, b.blocker);
      }
      return {
        blocker: b,
        date: date,
        isRecent: date ? isRecentActivity(date) : (ticket ? (isRecentActivity(ticket.resolvedDate) || isRecentActivity(ticket.updatedDate)) : false)
      };
    });
    
    // Sort: recent first, then by date descending
    blockersWithDates.sort(function(a, b) {
      var dateA = a.date ? new Date(a.date) : new Date(0);
      var dateB = b.date ? new Date(b.date) : new Date(0);
      if (a.isRecent && !b.isRecent) return -1;
      if (!a.isRecent && b.isRecent) return 1;
      return dateB - dateA;
    });
    
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2 text-red-400">Blockers <span class="text-xs text-green-400">🆕 = last 2 weeks</span></h3>';
    blockersWithDates.forEach(function(item) {
      var b = item.blocker;
      var recentBadge = item.isRecent ? '<span class="text-green-400 text-xs ml-2">🆕</span>' : '';
      // Get date from comment or ticket
      var blockerDate = getCommentDate(b.ticket, d, b.blocker) || item.date;
      var dateInfo = blockerDate ? '<div class="text-xs text-slate-400 mt-1"><span class="text-red-400">🚫 Became blocker:</span> ' + formatDate(blockerDate) + '</div>' : '';
      var recentBg = item.isRecent ? 'bg-green-900/20' : '';
      h += '<div class="bg-slate-700 rounded p-3 mb-2 border-l-4 border-red-500 ' + recentBg + '">';
      h += '<div class="font-medium">' + linkify(b.blocker) + recentBadge + '</div>';
      if (b.ticket) h += '<p class="text-sm text-slate-400">Ticket: ' + link(b.ticket) + '</p>';
      if (dateInfo) h += dateInfo;
      if (b.resolution) h += '<p class="text-sm text-green-400">Resolution: ' + b.resolution + '</p>';
      if (b.mentionedInComments) h += '<div class="text-xs text-amber-400">Mentioned in comments</div>';
      h += '</div>';
    });
    h += '</div>';
  }
  
  // Open Questions - sort by date (recent first)
  if (a.openQuestions && a.openQuestions.length) {
    // Get dates from tickets
    var questionsWithDates = a.openQuestions.map(function(q) {
      var ticket = q.ticketId ? 
        (d.tickets.parent && d.tickets.parent.id === q.ticketId ? d.tickets.parent :
         (d.tickets.children || []).find(function(c) { return c.id === q.ticketId; })) : null;
      return {
        question: q,
        date: ticket ? (ticket.updatedDate || ticket.createdDate) : null,
        isRecent: ticket ? isRecentActivity(ticket.updatedDate || ticket.createdDate) : false
      };
    });
    
    // Sort: recent first, then by date descending
    questionsWithDates.sort(function(a, b) {
      var dateA = a.date ? new Date(a.date) : new Date(0);
      var dateB = b.date ? new Date(b.date) : new Date(0);
      if (a.isRecent && !b.isRecent) return -1;
      if (!a.isRecent && b.isRecent) return 1;
      return dateB - dateA;
    });
    
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Open Questions <span class="text-xs text-green-400">🆕 = last 2 weeks</span></h3>';
    questionsWithDates.forEach(function(item) {
      var q = item.question;
      var sourceIcon = q.source === 'chat' ? '[Chat]' : '[Ticket]';
      var recentBadge = item.isRecent ? '<span class="text-green-400 text-xs ml-2">🆕</span>' : '';
      // Get date from comment or ticket
      var questionDate = getCommentDate(q.ticketId, d, q.question) || item.date;
      var dateInfo = questionDate ? ' | Asked: ' + formatDate(questionDate) : '';
      var recentBg = item.isRecent ? 'bg-green-900/20' : '';
      h += '<div class="bg-slate-700 rounded p-3 mb-2 border-l-4 border-yellow-500 ' + recentBg + '">';
      h += '<div class="text-yellow-400">' + linkify(q.question) + ' <span class="text-xs">' + sourceIcon + '</span>' + recentBadge + '</div>';
      h += '<div class="text-xs text-slate-400">Asked by: ' + (q.askedBy||"N/A") + ' | Ticket: ' + (q.ticketId ? link(q.ticketId) : "N/A") + dateInfo;
      if (q.source) h += ' | Source: ' + q.source;
      h += '</div></div>';
    });
    h += '</div>';
  }
  
  // Chat Discussions
  if (a.chatDiscussions && a.chatDiscussions.length) {
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Chat Discussions & Ticket Mappings</h3>';
    a.chatDiscussions.forEach(function(disc) {
      var mvpColor = disc.mvpCategory === 'MVP' ? 'bg-green-500/20 text-green-400' : disc.mvpCategory === 'Post-MVP' ? 'bg-blue-500/20 text-blue-400' : 'bg-slate-600';
      h += '<div class="bg-slate-700 rounded p-3 mb-3">';
      h += '<div class="flex justify-between items-start mb-2">';
      h += '<div class="font-medium text-cyan-400 flex-1">' + disc.topic + '</div>';
      h += '<span class="text-xs px-2 py-1 rounded ml-2 ' + mvpColor + '">' + (disc.mvpCategory || 'Undefined') + '</span>';
      h += '</div>';
      h += '<p class="text-sm text-slate-300 mb-2">' + (disc.summary || '') + '</p>';
      h += '<div class="text-xs text-slate-400 mb-2">Participants: ' + (disc.participants || 'N/A') + '</div>';
      
      if (disc.relatedTickets && disc.relatedTickets.length) {
        h += '<div class="bg-slate-800 rounded p-2 mb-2"><div class="text-xs font-medium text-purple-300 mb-1">Related Tickets:</div>';
        disc.relatedTickets.forEach(function(rt) {
          var confidenceColor = rt.confidence === 'high' ? 'text-green-400' : rt.confidence === 'medium' ? 'text-amber-400' : 'text-slate-400';
          var matchIcon = rt.matchType === 'explicit' ? '[Link]' : rt.matchType === 'semantic' ? '[Semantic]' : rt.matchType === 'team' ? '[Team]' : rt.matchType === 'temporal' ? '[Time]' : '[Match]';
          h += '<div class="text-xs mb-1">';
          h += matchIcon + ' ' + link(rt.ticketId) + ' <span class="' + confidenceColor + '">(' + (rt.confidence || 'N/A') + ' confidence, ' + (rt.matchType || 'N/A') + ')</span>';
          if (rt.reasoning) h += '<div class="text-slate-500 ml-4 mt-1">' + rt.reasoning + '</div>';
          h += '</div>';
        });
        h += '</div>';
      }
      
      if (disc.needsTicket) {
        h += '<div class="bg-amber-500/10 border border-amber-500/30 rounded p-2 text-xs text-amber-300">';
        h += 'Needs New Ticket: ' + (disc.ticketSuggestion || 'Create ticket for this discussion');
        h += '</div>';
      }
      h += '</div>';
    });
    h += '</div>';
  }
  
  // Inferred Mappings
  if (a.inferredMappings && a.inferredMappings.length) {
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Inferred Chat-to-Ticket Mappings</h3>';
    h += '<p class="text-sm text-slate-400 mb-3">Chat discussions mapped to tickets using semantic analysis, team matching, and context correlation.</p>';
    a.inferredMappings.forEach(function(im) {
      h += '<div class="bg-slate-700 rounded p-3 mb-3">';
      h += '<div class="font-medium text-purple-400 mb-2">' + im.chatTopic + '</div>';
      if (im.suggestedTickets && im.suggestedTickets.length) {
        im.suggestedTickets.forEach(function(st) {
          var confidenceColor = st.confidence === 'high' ? 'bg-green-500/20 text-green-400' : st.confidence === 'medium' ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-600';
          h += '<div class="bg-slate-800 rounded p-2 mb-2">';
          h += '<div class="flex justify-between items-start mb-1">';
          h += '<div>' + link(st.ticketId) + ' <span class="text-slate-400 text-xs">- ' + (st.title || '') + '</span></div>';
          h += '<span class="text-xs px-2 py-0.5 rounded ml-2 ' + confidenceColor + '">' + (st.confidence || 'N/A') + '</span>';
          h += '</div>';
          if (st.reasoning) h += '<div class="text-xs text-slate-400 mb-1">' + st.reasoning + '</div>';
          if (st.matchedParticipants && st.matchedParticipants.length) {
            h += '<div class="text-xs text-cyan-400">Matched: ' + st.matchedParticipants.join(', ') + '</div>';
          }
          if (st.sharedKeywords && st.sharedKeywords.length) {
            h += '<div class="text-xs text-purple-400">Keywords: ' + st.sharedKeywords.join(', ') + '</div>';
          }
          h += '</div>';
        });
      }
      h += '</div>';
    });
    h += '</div>';
  }
  
  // Team Cross Analysis
  if (a.teamCrossAnalysis && a.teamCrossAnalysis.length) {
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Team Engagement: Chat vs Tickets</h3>';
    h += '<div class="grid grid-cols-2 gap-2">';
    a.teamCrossAnalysis.forEach(function(tm) {
      var patternColor = tm.engagementPattern === 'balanced' ? 'text-green-400' : tm.engagementPattern === 'chat-heavy' ? 'text-blue-400' : 'text-purple-400';
      h += '<div class="bg-slate-700 rounded p-3">';
      h += '<div class="flex justify-between items-start mb-2">';
      h += '<span class="font-medium">' + tm.person + '</span>';
      h += '<span class="text-xs px-2 py-1 rounded bg-slate-800 ' + patternColor + '">' + (tm.engagementPattern || 'N/A') + '</span>';
      h += '</div>';
      h += '<div class="grid grid-cols-2 gap-2 text-xs mb-2">';
      h += '<div class="bg-slate-800 rounded p-2">';
      h += '<div class="text-slate-400">Chat</div>';
      h += '<div class="' + (tm.activeInChat ? 'text-blue-400' : 'text-slate-500') + '">' + (tm.activeInChat ? 'Yes' : 'No') + ' ' + (tm.chatMessageCount || 0) + ' msgs</div>';
      h += '</div>';
      h += '<div class="bg-slate-800 rounded p-2">';
      h += '<div class="text-slate-400">Tickets</div>';
      h += '<div class="' + (tm.activeInTickets ? 'text-purple-400' : 'text-slate-500') + '">' + (tm.activeInTickets ? 'Yes' : 'No') + ' ' + (tm.commentCount || 0) + ' comments</div>';
      h += '</div>';
      h += '</div>';
      if (tm.ticketsInvolved && tm.ticketsInvolved.length) {
        h += '<div class="text-xs text-slate-500">Tickets: ' + tm.ticketsInvolved.map(function(tid){return link(tid);}).join(', ') + '</div>';
      }
      h += '</div>';
    });
    h += '</div></div>';
  }
  
  // MVP Analysis
  if (a.mvpAnalysis) {
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">MVP vs Post-MVP Analysis</h3>';
    
    if (a.mvpAnalysis.mvpItems && a.mvpAnalysis.mvpItems.length) {
      h += '<div class="mb-3"><h4 class="text-lg font-medium text-green-400 mb-2">MVP Items</h4>';
      a.mvpAnalysis.mvpItems.forEach(function(item) {
        h += '<div class="bg-slate-700 rounded p-2 mb-2">';
        h += '<div class="text-sm">' + item.discussion + '</div>';
        if (item.ticketIds && item.ticketIds.length) {
          h += '<div class="text-xs text-slate-400 mt-1">Tickets: ' + item.ticketIds.map(function(tid){return link(tid);}).join(', ') + ' | Status: ' + (item.status || 'N/A') + '</div>';
        }
        h += '</div>';
      });
      h += '</div>';
    }
    
    if (a.mvpAnalysis.postMvpItems && a.mvpAnalysis.postMvpItems.length) {
      h += '<div class="mb-3"><h4 class="text-lg font-medium text-blue-400 mb-2">Post-MVP Items</h4>';
      a.mvpAnalysis.postMvpItems.forEach(function(item) {
        h += '<div class="bg-slate-700 rounded p-2 mb-2">';
        h += '<div class="text-sm">' + item.discussion + '</div>';
        if (item.ticketIds && item.ticketIds.length) {
          h += '<div class="text-xs text-slate-400 mt-1">Tickets: ' + item.ticketIds.map(function(tid){return link(tid);}).join(', ') + ' | Status: ' + (item.status || 'N/A') + '</div>';
        }
        h += '</div>';
      });
      h += '</div>';
    }
    
    if (a.mvpAnalysis.unmappedDiscussions && a.mvpAnalysis.unmappedDiscussions.length) {
      h += '<div><h4 class="text-lg font-medium text-amber-400 mb-2">Unmapped Discussions</h4>';
      a.mvpAnalysis.unmappedDiscussions.forEach(function(item) {
        h += '<div class="bg-slate-700 rounded p-2 mb-2">';
        h += '<div class="text-sm"><strong>' + item.topic + '</strong></div>';
        h += '<div class="text-xs text-slate-400 mt-1">' + item.summary + '</div>';
        if (item.needsTicket) {
          h += '<div class="text-xs text-amber-300 mt-1">Needs ticket creation</div>';
        }
        h += '</div>';
      });
      h += '</div>';
    }
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
  
  // Next Steps - keep all, but prioritize by priority (High/Urgent first)
  if (a.nextSteps && a.nextSteps.length) {
    // Sort by priority: High/Urgent first, then others
    var sortedNextSteps = a.nextSteps.slice().sort(function(a, b) {
      var priorityA = (a.priority || '').toLowerCase();
      var priorityB = (b.priority || '').toLowerCase();
      var highA = priorityA.includes('high') || priorityA.includes('urgent') || priorityA.includes('critical');
      var highB = priorityB.includes('high') || priorityB.includes('urgent') || priorityB.includes('critical');
      if (highA && !highB) return -1;
      if (!highA && highB) return 1;
      return 0;
    });
    
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Next Steps</h3>';
    sortedNextSteps.forEach(function(n) {
      // Try to find date from ticket if action mentions a ticket ID
      var nextStepDate = null;
      if (n.ticketId) {
        nextStepDate = getTicketDate(n.ticketId, d, false);
      } else if (n.action) {
        // Try to extract ticket ID from action text
        var ticketMatch = n.action.match(/\b[A-Z]+-\d+\b/);
        if (ticketMatch) {
          nextStepDate = getTicketDate(ticketMatch[0], d, false);
        }
      }
      var dateInfo = nextStepDate ? ' | Identified: ' + formatDate(nextStepDate) : '';
      h += '<div class="bg-slate-700 rounded p-3 mb-2 flex justify-between"><div>';
      h += '<div class="font-medium">' + linkify(n.action) + '</div>';
      h += '<div class="text-sm text-slate-400">Owner: ' + (n.owner||"N/A") + dateInfo + '</div></div>';
      h += '<span class="text-purple-400">' + (n.priority||"") + '</span></div>';
    });
    h += '</div>';
  }
  
  // Comments Section - only show comments from last 2 weeks
  if (d.tickets.allComments && d.tickets.allComments.length) {
    // Filter to only recent comments
    var recentCommentsCount = 0;
    var recentCommentsByIssue = [];
    d.tickets.allComments.forEach(function(ic) {
      var recentComments = (ic.comments || []).filter(function(c) {
        return isRecentActivity(c.createdDate);
      });
      if (recentComments.length > 0) {
        recentCommentsCount += recentComments.length;
        recentCommentsByIssue.push({
          issueId: ic.issueId,
          issueTitle: ic.issueTitle,
          comments: recentComments
        });
      }
    });
    
    if (recentCommentsCount > 0) {
      h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">All Comments (' + recentCommentsCount + ' from last 2 weeks)</h3>';
      recentCommentsByIssue.forEach(function(ic) {
        h += '<div class="bg-slate-700 rounded p-3 mb-3">';
        h += '<div class="font-medium text-purple-400 mb-2">' + link(ic.issueId) + ' - ' + ic.issueTitle + '</div>';
        ic.comments.forEach(function(c) {
          var recentBadge = '<span class="text-green-400 text-xs ml-2">🆕</span>';
          h += '<div class="bg-slate-800 rounded p-2 mb-2 ml-4 border-l-2 border-green-500 bg-green-900/20">';
          h += '<div class="flex justify-between text-xs text-slate-400 mb-1"><span class="font-medium text-slate-300">' + c.author + recentBadge + '</span>';
          h += '<span>' + formatDate(c.createdDate) + '</span></div>';
          h += '<div class="text-sm text-slate-300">' + stripHtml(c.text) + '</div></div>';
        });
        h += '</div>';
      });
      h += '</div>';
    }
  }
  
  // YouTrack Dependencies
  if (d.tickets.dependencies && d.tickets.dependencies.length) {
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">YouTrack Dependencies (' + d.tickets.dependencies.length + ')</h3>';
    h += '<table class="w-full text-sm"><tr class="text-left text-slate-400 border-b border-slate-700"><th class="p-2">ID</th><th class="p-2">Title</th><th class="p-2">Type</th><th class="p-2">State</th><th class="p-2">Assignee</th></tr>';
    d.tickets.dependencies.forEach(function(t) {
      h += '<tr class="border-b border-slate-700"><td class="p-2">' + link(t.id) + '</td><td class="p-2">' + t.title + '</td><td class="p-2 text-amber-400">' + (t.dependencyType||t.linkType) + '</td><td class="p-2 ' + (t.state=="Done"||t.state=="Closed"?"text-green-400":"") + '">' + t.state + '</td><td class="p-2">' + t.assignee + '</td></tr>';
    });
    h += '</table></div>';
  }
  
  // All Tickets Table - sort by date (recent first)
  h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">All Tickets <span class="text-xs text-green-400">🆕 = resolved/updated in last 2 weeks</span></h3>';
  h += '<table class="w-full text-sm"><tr class="text-left text-slate-400 border-b border-slate-700"><th class="p-2">ID</th><th class="p-2">Title</th><th class="p-2">Type</th><th class="p-2">State</th><th class="p-2">Assignee</th><th class="p-2">Comments</th><th class="p-2">Activity</th></tr>';
  
  // Prepare all tickets with dates for sorting
  var allTickets = [];
  var p = d.tickets.parent;
  if (p) {
    var parentDate = p.resolvedDate || p.updatedDate || p.createdDate;
    var parentRecentResolved = isRecentActivity(p.resolvedDate);
    var parentRecentUpdated = !parentRecentResolved && isRecentActivity(p.updatedDate);
    allTickets.push({
      ticket: p,
      date: parentDate,
      isRecent: parentRecentResolved || parentRecentUpdated,
      isParent: true
    });
  }
  
  if (d.tickets.children) {
    d.tickets.children.forEach(function(t) {
      var ticketDate = t.resolvedDate || t.updatedDate || t.createdDate;
      var recentResolved = isRecentActivity(t.resolvedDate);
      var recentUpdated = !recentResolved && isRecentActivity(t.updatedDate);
      allTickets.push({
        ticket: t,
        date: ticketDate,
        isRecent: recentResolved || recentUpdated,
        isParent: false
      });
    });
  }
  
  // Sort: recent first, then by date descending
  allTickets.sort(function(a, b) {
    var dateA = a.date ? new Date(a.date) : new Date(0);
    var dateB = b.date ? new Date(b.date) : new Date(0);
    if (a.isRecent && !b.isRecent) return -1;
    if (!a.isRecent && b.isRecent) return 1;
    return dateB - dateA;
  });
  
  // Render sorted tickets
  allTickets.forEach(function(item) {
    var t = item.ticket;
    var commentCount = (t.comments||[]).length;
    var state = t.state || 'Unknown';
    var assignee = t.assignee || 'Unassigned';
    var type = t.type || 'Issue';
    var recentResolved = isRecentActivity(t.resolvedDate);
    var recentUpdated = !recentResolved && isRecentActivity(t.updatedDate);
    var recentBadge = (recentResolved || recentUpdated) ? '<span class="text-green-400">🆕</span>' : '';
    var activity = '';
    if (recentResolved && t.resolvedDate) {
      activity = 'Resolved: ' + formatDate(t.resolvedDate);
    } else if (recentUpdated && t.updatedDate) {
      activity = 'Updated: ' + formatDate(t.updatedDate);
    } else if (t.resolvedDate) {
      activity = 'Resolved: ' + formatDate(t.resolvedDate);
    } else if (t.updatedDate) {
      activity = 'Updated: ' + formatDate(t.updatedDate);
    } else if (t.createdDate) {
      activity = 'Created: ' + formatDate(t.createdDate);
    }
    var rowClass = item.isParent ? 'bg-slate-700/30' : '';
    if (recentResolved || recentUpdated) rowClass += ' bg-green-900/20';
    h += '<tr class="border-b border-slate-700 ' + rowClass + '"><td class="p-2">' + link(t.id) + recentBadge + '</td><td class="p-2">' + (t.title||'') + '</td><td class="p-2">' + type + '</td><td class="p-2 ' + (state=="Done"||state=="Closed"||state=="Resolved"?"text-green-400":"") + '">' + state + '</td><td class="p-2">' + assignee + '</td><td class="p-2 text-amber-400">' + commentCount + '</td><td class="p-2 text-xs text-slate-400">' + activity + '</td></tr>';
  });
  h += '</table></div>';
  
  // Raw JSON
  h += '<div class="bg-slate-800 rounded-xl p-4"><h3 class="text-xl font-bold mb-2">Raw JSON</h3>';
  h += '<pre class="text-xs overflow-auto max-h-64 bg-slate-900 p-3 rounded">' + JSON.stringify(a,null,2) + '</pre></div>';
  
  document.getElementById("results").innerHTML = h;
  document.getElementById("btn").disabled = false;
  document.getElementById("btn").textContent = "Crawl and Generate Report";
  
  loadHistory();
}

async function run() {
  var statusEl = document.getElementById("status");
  var btnEl = document.getElementById("btn");
  var url = (document.getElementById("url").value || "").trim();
  if (!url) {
    statusEl.textContent = "Please enter a YouTrack URL.";
    statusEl.classList.add("text-amber-400");
    return;
  }
  statusEl.classList.remove("text-amber-400", "text-red-400");
  statusEl.textContent = "Starting…";
  btnEl.disabled = true;
  btnEl.textContent = "Crawling…";
  document.getElementById("results").innerHTML = "";
  document.getElementById("chatBox").classList.add("hidden");
  document.getElementById("chatLog").innerHTML = "";
  DATA = null;
  
  var chatSpaces = document.getElementById("chatSpaces").value.trim();
  var chatAfterDate = document.getElementById("chatAfterDate").value.trim();
  var statusMsg = "Fetching tickets and comments…";
  if (chatSpaces) statusMsg += " (pulling Google Chat messages…)";
  statusEl.textContent = statusMsg;

  try {
    var res = await fetch("/api/analyze", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        url: url,
        chatSpaces: chatSpaces || undefined,
        chatAfterDate: chatAfterDate || undefined
      })
    });
    var d = await res.json();
    if (!res.ok) {
      throw new Error(d.error || "Server error: " + res.status + " " + res.statusText);
    }
    if (d.error) throw new Error(d.error);
    
    DATA = d;
    BASE = (d.tickets && d.tickets.baseUrl) || "";
    var stats = (d.tickets && d.tickets.stats) || {};
    var statusText = "Done! " + ((d.tickets && d.tickets.children && d.tickets.children.length + 1) || 0) + " tickets, " + (stats.totalComments || 0) + " comments, " + (stats.totalRelated || 0) + " related, " + (stats.totalDependencies || 0) + " dependencies";
    if (d.tickets && d.tickets.stats && d.tickets.stats.totalChatMessages) {
      statusText += ", " + d.tickets.stats.totalChatMessages + " chat messages";
    }
    statusEl.textContent = statusText;
    document.getElementById("chatBox").classList.remove("hidden");
    
    renderAnalysis(d);
  } catch(e) {
    statusEl.textContent = "Error: " + e.message;
    statusEl.classList.add("text-red-400");
    console.error("run() error:", e);
  }
  btnEl.disabled = false;
  btnEl.textContent = "Crawl and Generate Report";
}
`;

app.get('/youtrack-app.js', function(req, res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.send(clientScript);
});

app.get('/', function(req, res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>PM Intelligence Assistant - YouTrack</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-900 text-white min-h-screen p-6">
  <div class="flex gap-4 max-w-7xl mx-auto">
    <!-- History Sidebar -->
    <div id="historySidebar" class="w-80 flex-shrink-0">
      <div class="bg-slate-800 rounded-xl p-4 sticky top-6">
        <div class="flex justify-between items-center mb-3">
          <h2 class="text-lg font-bold">History</h2>
          <button onclick="loadHistory()" class="text-xs text-purple-400 hover:text-purple-300">Refresh</button>
        </div>
        <div id="historyList" class="space-y-2 max-h-[calc(100vh-200px)] overflow-y-auto">
          <div class="text-sm text-slate-500 text-center py-8">No history yet</div>
        </div>
      </div>
    </div>
    
    <!-- Main Content -->
    <div class="flex-1 min-w-0">
      <h1 class="text-3xl font-bold text-center mb-2">PM Intelligence Assistant</h1>
      <p class="text-slate-400 text-center mb-6">YouTrack Crawler + Comments + Related Items + AI Analysis</p>
      
      <div class="bg-slate-800 rounded-xl p-4 mb-4">
        <input type="text" id="url" placeholder="YouTrack URL: https://youtrack.internetbrands.com/issue/UNSER-1141" class="w-full bg-slate-700 rounded-lg p-3 mb-3 border border-slate-600" value="https://youtrack.internetbrands.com/issue/UNSER-1141">
        <div class="mb-3">
          <label class="block text-sm font-medium mb-2 text-slate-300">Google Chat spaces (optional — name or ID, one per line)</label>
          <textarea id="chatSpaces" rows="3" placeholder="MAC Review Aggregation Service (RAS)&#10;avvo-consumer-club&#10;spaces/AAAAerqkeoI" class="w-full bg-slate-700 rounded-lg p-3 border border-slate-600 text-sm font-mono"></textarea>
          <div class="text-xs text-slate-500 mt-1">Enter space names exactly as they appear in Google Chat, or paste space IDs.</div>
        </div>
        <div class="mb-3">
          <label class="block text-sm font-medium mb-2 text-slate-300">Chat messages after date (optional)</label>
          <input type="text" id="chatAfterDate" placeholder="e.g. 2026-03-01" class="w-full bg-slate-700 rounded-lg p-3 border border-slate-600 text-sm font-mono">
        </div>
        <button type="button" id="btn" class="w-full py-3 bg-purple-600 hover:bg-purple-500 rounded-lg font-medium">Crawl and Generate Report</button>
        <div id="status" class="mt-3 text-sm text-slate-400"></div>
        <p class="mt-2 text-xs text-slate-500">Use this page at <strong>http://localhost:3001</strong> (start the server with <code class="bg-slate-700 px-1 rounded">node youtrack.js</code> first).</p>
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
    document.getElementById("status").textContent = "Loading...";
    document.getElementById("btn").addEventListener("click", function() {
      if (typeof run === "function") run();
      else document.getElementById("status").textContent = "App not loaded yet. Check console (F12) for errors.";
    });
  </script>
  <script src="/youtrack-app.js"></script>
  <script>
    if (document.getElementById("status").textContent === "Loading...") document.getElementById("status").textContent = "";
  </script>
</body>
</html>`);
});

const PORT = process.env.YOUTRACK_PORT || 3001;
app.listen(PORT, function() {
  console.log("========================================");
  console.log("  PM Intelligence Assistant - YouTrack");
  console.log("  Open http://localhost:" + PORT);
  console.log("========================================");
});