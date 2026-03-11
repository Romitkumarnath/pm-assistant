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

function parseGoogleChatUrl(url) {
  // Parse Google Chat API URL
  // Format: https://chat.googleapis.com/v1/spaces/SPACE_ID/messages?key=API_KEY&token=TOKEN
  try {
    const urlObj = new URL(url);
    const pathMatch = urlObj.pathname.match(/\/spaces\/([^\/]+)/);
    const apiKey = urlObj.searchParams.get('key');
    const token = urlObj.searchParams.get('token');
    
    if (pathMatch && apiKey) {
      return {
        spaceId: pathMatch[1],
        apiKey: apiKey,
        token: token,
        baseUrl: url.split('?')[0]
      };
    }
  } catch (e) {
    console.log('Error parsing Google Chat URL:', e.message);
  }
  return null;
}

async function fetchGoogleChatMessages(chatUrl) {
  console.log('Fetching Google Chat messages...');
  
  const parsed = parseGoogleChatUrl(chatUrl);
  if (!parsed) {
    console.log('Invalid Google Chat URL');
    return null;
  }

  try {
    const messages = [];
    let pageToken = null;
    let pageCount = 0;
    const maxPages = 10;

    do {
      let url = parsed.baseUrl + '?key=' + parsed.apiKey;
      if (parsed.token) url += '&token=' + parsed.token;
      if (pageToken) url += '&pageToken=' + pageToken;
      url += '&pageSize=100';

      console.log('  Fetching page', pageCount + 1);
      const response = await axios.get(url);
      
      if (response.data.messages) {
        messages.push(...response.data.messages);
      }
      
      pageToken = response.data.nextPageToken;
      pageCount++;
      
      if (pageCount >= maxPages) {
        console.log('  Reached maximum page limit');
        break;
      }
    } while (pageToken);

    console.log('Fetched', messages.length, 'Google Chat messages');

    const parsedMessages = messages.map(function(msg) {
      const sender = msg.sender?.displayName || msg.sender?.name || 'Unknown';
      const text = msg.text || '';
      const createTime = msg.createTime || null;
      const thread = msg.thread?.name || null;
      
      const ticketIds = [];
      const ticketRegex = /\b([A-Z]+-\d+)\b/g;
      let match;
      while ((match = ticketRegex.exec(text)) !== null) {
        ticketIds.push(match[1]);
      }

      return {
        name: msg.name,
        sender: sender,
        text: text,
        createTime: createTime,
        thread: thread,
        ticketIds: ticketIds,
        source: 'google_chat'
      };
    });

    const threads = {};
    parsedMessages.forEach(function(msg) {
      const threadId = msg.thread || 'no_thread';
      if (!threads[threadId]) {
        threads[threadId] = [];
      }
      threads[threadId].push(msg);
    });

    const participants = [...new Set(parsedMessages.map(function(m) { return m.sender; }))];

    const ticketMentions = {};
    parsedMessages.forEach(function(msg) {
      msg.ticketIds.forEach(function(ticketId) {
        if (!ticketMentions[ticketId]) {
          ticketMentions[ticketId] = [];
        }
        ticketMentions[ticketId].push({
          sender: msg.sender,
          text: msg.text,
          createTime: msg.createTime
        });
      });
    });

    return {
      spaceId: parsed.spaceId,
      messages: parsedMessages,
      threads: threads,
      participants: participants,
      ticketMentions: ticketMentions,
      totalMessages: parsedMessages.length,
      totalThreads: Object.keys(threads).length
    };
  } catch (e) {
    console.log('Error fetching Google Chat messages:', e.response?.data || e.message);
    return null;
  }
}

function parseGoogleChatExport(chatText) {
  console.log('Parsing Google Chat export...');
  
  // Parse Google Chat export text
  // Expected format: lines with timestamps, sender names, and messages
  const lines = chatText.split('\n');
  const messages = [];
  
  let currentMessage = null;
  
  lines.forEach(function(line) {
    line = line.trim();
    if (!line) return;
    
    // Try to match timestamp and sender pattern
    // More flexible pattern to handle formats like:
    // "Sender Name, Nov 24, 2:24 PM"
    // "Sender Name, Nov 24, 2:24 PM, Edited"
    // "You, Nov 24, 2:24 PM"
    // "12:34 PM Sender Name: message text"
    // "Jan 1, 2024, 12:34 PM Sender Name: message text"
    const timePattern = /^([^,]+),\s+(\w+\s+\d{1,2}(?:,\s+\d{4})?,\s+\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?(?:,\s*Edited)?)\s*$/;
    const legacyPattern = /^(\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?|\w+\s+\d{1,2},\s+\d{4},?\s+\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)\s+(.+?):\s*(.+)$/;
    
    let match = line.match(timePattern);
    if (match) {
      // Google Chat format: "Sender Name, Nov 24, 2:24 PM" or "Sender Name, Nov 24, 2:24 PM, Edited"
      if (currentMessage && currentMessage.text) {
        messages.push(currentMessage);
      }
      
      const sender = match[1].trim();
      const timestamp = match[2].replace(/, Edited$/, '').trim();
      
      currentMessage = {
        sender: sender,
        text: '',
        timestamp: timestamp,
        ticketIds: [],
        source: 'google_chat_export'
      };
      return;
    }
    
    match = line.match(legacyPattern);
    
    if (match) {
      // Legacy format: "12:34 PM Sender Name: message text"
      if (currentMessage) {
        messages.push(currentMessage);
      }
      
      const timestamp = match[1];
      const sender = match[2].trim();
      const text = match[3].trim();
      
      // Extract ticket IDs
      const ticketIds = [];
      const ticketRegex = /\b([A-Z]+-\d+)\b/g;
      let ticketMatch;
      while ((ticketMatch = ticketRegex.exec(text)) !== null) {
        ticketIds.push(ticketMatch[1]);
      }
      
      currentMessage = {
        sender: sender,
        text: text,
        timestamp: timestamp,
        ticketIds: ticketIds,
        source: 'google_chat_export'
      };
    } else if (currentMessage) {
      // Continuation of previous message (actual message content)
      if (currentMessage.text) {
        currentMessage.text += '\n' + line;
      } else {
        currentMessage.text = line;
      }
      
      // Re-extract ticket IDs
      const ticketRegex = /\b([A-Z]+-\d+)\b/g;
      let ticketMatch;
      while ((ticketMatch = ticketRegex.exec(line)) !== null) {
        if (!currentMessage.ticketIds.includes(ticketMatch[1])) {
          currentMessage.ticketIds.push(ticketMatch[1]);
        }
      }
    }
  });
  
  // Save last message
  if (currentMessage) {
    messages.push(currentMessage);
  }
  
  console.log('Parsed', messages.length, 'messages from chat export');
  
  // Group by threads (approximate based on time proximity)
  const threads = { 'main_thread': messages };
  
  // Extract participants
  const participants = [...new Set(messages.map(function(m) { return m.sender; }))];
  
  // Create ticket mentions map
  const ticketMentions = {};
  messages.forEach(function(msg) {
    msg.ticketIds.forEach(function(ticketId) {
      if (!ticketMentions[ticketId]) {
        ticketMentions[ticketId] = [];
      }
      ticketMentions[ticketId].push({
        sender: msg.sender,
        text: msg.text,
        timestamp: msg.timestamp
      });
    });
  });
  
  return {
    spaceId: 'exported',
    messages: messages,
    threads: threads,
    participants: participants,
    ticketMentions: ticketMentions,
    totalMessages: messages.length,
    totalThreads: 1
  };
}

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
- workBreakdown (array: category, description, status, tickets array with id/title/state/assignee)
- teamContributions (array: person, ticketsCompleted as ID array, keyContributions, commentCount${hasChat ? ', chatMessageCount' : ''})
- dependencies (array: dependency, type, status, owner, impact, relatedTicketId)
- blockers (array: blocker, ticket, severity, status, resolution, mentionedInComments${hasChat ? ', mentionedInChat' : ''})
- risks (array: risk, likelihood, impact, mitigation, owner, sourceTicketId)
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

app.post('/api/chat', async function(req, res) {
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

app.post('/api/analyze', async function(req, res) {
  try {
    console.log('\n=== NEW ANALYSIS REQUEST ===');
    console.log('Has chatExport in request:', !!req.body.chatExport);
    if (req.body.chatExport) {
      console.log('ChatExport length:', req.body.chatExport.length, 'characters');
    }
    
    const parsed = parseYouTrackUrl(req.body.url);
    if (!parsed) return res.status(400).json({ error: 'Invalid YouTrack URL' });
    
    const data = await crawlYouTrack(parsed.baseUrl, parsed.issueId);
    
    // Process Google Chat data - either from export text or URL
    if (req.body.chatExport && req.body.chatExport.trim()) {
      // Parse exported chat text
      const chatData = parseGoogleChatExport(req.body.chatExport);
      if (chatData) {
        data.chatMessages = chatData;
        data.correlations = correlateChatsWithTickets(data, chatData);
        
        // Update stats
        data.stats.totalChatMessages = chatData.totalMessages;
        data.stats.chatParticipants = chatData.participants.length;
        data.stats.ticketMentionsInChat = Object.keys(chatData.ticketMentions).length;
      }
    } else if (req.body.chatUrl) {
      // Fetch from API URL
      const chatData = await fetchGoogleChatMessages(req.body.chatUrl);
      if (chatData) {
        data.chatMessages = chatData;
        data.correlations = correlateChatsWithTickets(data, chatData);
        
        // Update stats
        data.stats.totalChatMessages = chatData.totalMessages;
        data.stats.chatParticipants = chatData.participants.length;
        data.stats.ticketMentionsInChat = Object.keys(chatData.ticketMentions).length;
      }
    }
    
    const analysis = await analyze(data);
    
    // Add to history
    const historyId = addToHistory(parsed.issueId, req.body.url, data, analysis);
    
    res.json({ tickets: data, analysis: analysis, historyId: historyId });
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

// Client-side JavaScript
const clientScript = `
console.log('PM Intelligence Assistant - YouTrack - Script Loaded');
console.log('Page loaded at:', new Date().toISOString());

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
      
      return '<div class="bg-slate-700 rounded-lg p-3 hover:bg-slate-600 cursor-pointer transition" onclick="loadFromHistory(\\'' + item.id + '\\')">' +
        '<div class="flex justify-between items-start mb-1">' +
        '<div class="font-medium text-sm truncate flex-1">' + item.projectName + '</div>' +
        '<button onclick="event.stopPropagation(); deleteHistory(\\'' + item.id + '\\')" class="text-red-400 hover:text-red-300 text-xs ml-2">X</button>' +
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
  loadHistory();
});

function renderAnalysis(d) {
  var a = d.analysis;
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
  
  // Key Decisions
  if (a.keyDecisions && a.keyDecisions.length) {
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Key Decisions</h3>';
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
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Work Breakdown</h3>';
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
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">Dependencies</h3>';
    a.dependencies.forEach(function(dep) {
      h += '<div class="bg-slate-700 rounded p-3 mb-2"><div class="flex justify-between"><span class="font-medium">' + linkify(dep.dependency) + '</span>';
      h += '<span class="text-xs px-2 py-1 rounded ' + (dep.status=="Resolved"?"bg-green-500/20 text-green-400":"bg-amber-500/20 text-amber-400") + '">' + (dep.status||"") + '</span></div>';
      h += '<p class="text-sm text-slate-400">Type: ' + (dep.type||"N/A") + ' | Owner: ' + (dep.owner||"N/A") + '</p>';
      if (dep.relatedTicketId) h += '<div class="text-xs text-slate-500">Related: ' + link(dep.relatedTicketId) + '</div>';
      h += '</div>';
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
      var sourceIcon = q.source === 'chat' ? '[Chat]' : '[Ticket]';
      h += '<div class="bg-slate-700 rounded p-3 mb-2 border-l-4 border-yellow-500">';
      h += '<div class="text-yellow-400">' + linkify(q.question) + ' <span class="text-xs">' + sourceIcon + '</span></div>';
      h += '<div class="text-xs text-slate-400">Asked by: ' + (q.askedBy||"N/A") + ' | Ticket: ' + (q.ticketId ? link(q.ticketId) : "N/A");
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
  
  // YouTrack Dependencies
  if (d.tickets.dependencies && d.tickets.dependencies.length) {
    h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">YouTrack Dependencies (' + d.tickets.dependencies.length + ')</h3>';
    h += '<table class="w-full text-sm"><tr class="text-left text-slate-400 border-b border-slate-700"><th class="p-2">ID</th><th class="p-2">Title</th><th class="p-2">Type</th><th class="p-2">State</th><th class="p-2">Assignee</th></tr>';
    d.tickets.dependencies.forEach(function(t) {
      h += '<tr class="border-b border-slate-700"><td class="p-2">' + link(t.id) + '</td><td class="p-2">' + t.title + '</td><td class="p-2 text-amber-400">' + (t.dependencyType||t.linkType) + '</td><td class="p-2 ' + (t.state=="Done"||t.state=="Closed"?"text-green-400":"") + '">' + t.state + '</td><td class="p-2">' + t.assignee + '</td></tr>';
    });
    h += '</table></div>';
  }
  
  // All Tickets Table
  h += '<div class="bg-slate-800 rounded-xl p-4 mb-4"><h3 class="text-xl font-bold mb-2">All Tickets</h3>';
  h += '<table class="w-full text-sm"><tr class="text-left text-slate-400 border-b border-slate-700"><th class="p-2">ID</th><th class="p-2">Title</th><th class="p-2">Type</th><th class="p-2">State</th><th class="p-2">Assignee</th><th class="p-2">Comments</th></tr>';
  var p = d.tickets.parent;
  var parentCommentCount = (p.comments||[]).length;
  h += '<tr class="border-b border-slate-700 bg-slate-700/30"><td class="p-2">' + link(p.id) + '</td><td class="p-2">' + (p.title||'') + '</td><td class="p-2">' + (p.type||'') + '</td><td class="p-2">' + (p.state||'Unknown') + '</td><td class="p-2">' + (p.assignee||'Unassigned') + '</td><td class="p-2 text-amber-400">' + parentCommentCount + '</td></tr>';
  d.tickets.children.forEach(function(t) {
    var commentCount = (t.comments||[]).length;
    var state = t.state || 'Unknown';
    var assignee = t.assignee || 'Unassigned';
    var type = t.type || 'Issue';
    h += '<tr class="border-b border-slate-700"><td class="p-2">' + link(t.id) + '</td><td class="p-2">' + (t.title||'') + '</td><td class="p-2">' + type + '</td><td class="p-2 ' + (state=="Done"||state=="Closed"||state=="Resolved"?"text-green-400":"") + '">' + state + '</td><td class="p-2">' + assignee + '</td><td class="p-2 text-amber-400">' + commentCount + '</td></tr>';
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
  var url = document.getElementById("url").value;
  if (!url) return alert("Enter YouTrack URL");
  
  var chatExport = document.getElementById("chatExport").value.trim();
  
  console.log('=== BROWSER DEBUG ===');
  console.log('URL:', url);
  console.log('Chat export length:', chatExport.length, 'characters');
  console.log('First 100 chars of chat:', chatExport.substring(0, 100));
  console.log('=====================');
  
  document.getElementById("btn").disabled = true;
  document.getElementById("btn").textContent = "Crawling...";
  document.getElementById("status").textContent = "Fetching tickets, comments" + (chatExport ? ", and parsing Google Chat export" : "") + "...";
  document.getElementById("results").innerHTML = "";
  document.getElementById("chatBox").classList.add("hidden");
  document.getElementById("chatLog").innerHTML = "";
  DATA = null;
  
  try {
    var res = await fetch("/api/analyze", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ url: url, chatExport: chatExport || undefined })
    });
    var d = await res.json();
    if (d.error) throw new Error(d.error);
    
    DATA = d;
    BASE = d.tickets.baseUrl;
    var stats = d.tickets.stats || {};
    document.getElementById("status").textContent = "Done! " + (d.tickets.children.length + 1) + " tickets, " + (stats.totalComments || 0) + " comments, " + (stats.totalRelated || 0) + " related, " + (stats.totalDependencies || 0) + " dependencies";
    document.getElementById("chatBox").classList.remove("hidden");
    
    renderAnalysis(d);
  } catch(e) {
    document.getElementById("status").textContent = "Error: " + e.message;
    console.error(e);
  }
  document.getElementById("btn").disabled = false;
  document.getElementById("btn").textContent = "Crawl and Generate Report";
}
`;

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
          <label class="block text-sm font-medium mb-2 text-slate-300">Google Chat Export (optional)</label>
          <textarea id="chatExport" placeholder="Paste your Google Chat export here..." class="w-full bg-slate-700 rounded-lg p-3 border border-slate-600 h-32 text-sm font-mono" style="resize: vertical;"></textarea>
          <div class="text-xs text-slate-500 mt-1">Tip: Export your chat conversation and paste it here. The tool will automatically detect ticket IDs and correlate discussions with tickets.</div>
        </div>
        <button onclick="run()" id="btn" class="w-full py-3 bg-purple-600 hover:bg-purple-500 rounded-lg font-medium">Crawl and Generate Report</button>
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

const PORT = process.env.YOUTRACK_PORT || 3001;
app.listen(PORT, function() {
  console.log("========================================");
  console.log("  PM Intelligence Assistant - YouTrack");
  console.log("  Open http://localhost:" + PORT);
  console.log("========================================");
});