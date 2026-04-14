require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const YOUTRACK_TOKEN = process.env.YOUTRACK_TOKEN;
const YOUTRACK_BASE_URL = process.env.YOUTRACK_BASE_URL || 'https://youtrack.internetbrands.com';

if (!YOUTRACK_TOKEN) {
  console.error('Missing YOUTRACK_TOKEN in .env file');
  process.exit(1);
}

const headers = {
  'Authorization': 'Bearer ' + YOUTRACK_TOKEN,
  'Accept': 'application/json',
  'Content-Type': 'application/json'
};

const PROJECTS = ['CSMR', 'MHLDCD', 'MHMDCD'];
const DATE_FROM = '2025-10-10';
const DATE_TO = '2026-04-10';
const API_DELAY_MS = 200;
const MAX_RETRIES = 3;
const OUTPUT_FILE = path.join(__dirname, 'qa-evaluation-output.json');

// QA team rosters: YouTrack login -> { email, fullName, team }
// Logins verified via YouTrack /api/users endpoint
const QA_MEMBERS = {
  // CSMR QA
  tzapanta:     { email: 'trixie.zapanta@internetbrands.com',     fullName: 'Trixie Zapanta',         team: 'CSMR_QA' },
  adave:        { email: 'akshita.dave@internetbrands.com',       fullName: 'Akshita Dave',           team: 'CSMR_QA' },
  smpawar:      { email: 'saurabh.pawar@internetbrands.com',      fullName: 'Saurabh Pawar',          team: 'CSMR_QA' },
  shmore:       { email: 'shraddha.more@internetbrands.com',      fullName: 'Shraddha More',          team: 'CSMR_QA' },
  smacalalad:   { email: 'sheilamarie.macalalad@internetbrands.com', fullName: 'Sheilamarie Macalalad', team: 'CSMR_QA' },
  rbaturoni:    { email: 'raul.baturoni@internetbrands.com',      fullName: 'Raul Baturoni',          team: 'CSMR_QA' },
  jmadrigal:    { email: 'jesus.madrigal@internetbrands.com',     fullName: 'Jesus Madrigal',         team: 'CSMR_QA' },
  // MHMDCD / MHLDCD QA
  nhussain:     { email: 'nazmul.hussain@internetbrands.com',     fullName: 'Nazmul Hussain',         team: 'MH_QA' },
  jmeza:        { email: 'julio.meza@internetbrands.com',         fullName: 'Julio Meza',             team: 'MH_QA' },
  igil:         { email: 'ivan.gil@internetbrands.com',           fullName: 'Ivan Gil',               team: 'MH_QA' },
  recheverria:  { email: 'richard.echeverria@internetbrands.com', fullName: 'Richard Echeverria',     team: 'MH_QA' },
  vimartinez:   { email: 'victoria.martinez@internetbrands.com',  fullName: 'Victoria Martinez',      team: 'MH_QA' },
  jjing:        { email: 'jenny.jing@internetbrands.com',         fullName: 'Jenny Jing',             team: 'MH_QA' },
  vkannans:     { email: 'vinoth.kannans@martindale.com',         fullName: 'Vinoth Kannan S',        team: 'MH_QA' },
  amaharajan:   { email: 'akshaya.maharajan@martindale.com',      fullName: 'Akshaya Maharajan',      team: 'MH_QA' },
  avora:        { email: 'ashika.vora@internetbrands.com',        fullName: 'Ashika Vora',            team: 'MH_QA' }
};

// Build fullName -> login reverse lookup for fallback matching
const NAME_TO_LOGIN = {};
for (const login in QA_MEMBERS) {
  NAME_TO_LOGIN[QA_MEMBERS[login].fullName.toLowerCase()] = login;
}

const CSMR_QA_EMAILS = Object.values(QA_MEMBERS).filter(function(m) { return m.team === 'CSMR_QA'; }).map(function(m) { return m.email; });
const MH_QA_EMAILS = Object.values(QA_MEMBERS).filter(function(m) { return m.team === 'MH_QA'; }).map(function(m) { return m.email; });

// QA-related state keywords
const QA_STATE_PATTERNS = /qa|test|verification|verify/i;

// Comment type classifiers
const COMMENT_CLASSIFIERS = [
  { type: 'pass', pattern: /pass(ed)?|approve[d]?/i },
  { type: 'fail', pattern: /fail(ed)?|reject(ed)?/i },
  { type: 'bug_found', pattern: /bug|defect|issue found/i },
  { type: 'retest', pattern: /retest|re-test/i },
  { type: 'question', pattern: /\?|question|clarif/i },
  { type: 'blocked', pattern: /block(ed|er|ing)?/i }
];

// ─── API Helpers ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

async function apiGet(url, retries) {
  if (retries === undefined) retries = 0;
  try {
    const response = await axios.get(url, { headers, timeout: 30000 });
    return response.data;
  } catch (e) {
    const status = e.response?.status;
    if ((status === 429 || status >= 500) && retries < MAX_RETRIES) {
      const wait = Math.pow(2, retries) * 1000;
      console.log('  Retry ' + (retries + 1) + ' after ' + wait + 'ms (HTTP ' + status + ')');
      await sleep(wait);
      return apiGet(url, retries + 1);
    }
    throw e;
  }
}

// ─── YouTrack Data Fetchers ───────────────────────────────────────────────────

async function searchIssues() {
  const query = 'project: ' + PROJECTS.map(function(p) { return '{' + p + '}'; }).join(', ') +
    ' updated: ' + DATE_FROM + ' .. ' + DATE_TO;

  const issueFields = [
    'id', 'idReadable', 'summary', 'created', 'updated', 'resolved',
    'reporter(login,fullName,email)',
    'assignee(login,fullName,email)',
    'project(id,name,shortName)',
    'customFields(name,value(name,text,presentation,login,fullName,email,minutes))'
  ].join(',');

  console.log('Searching: ' + query);
  const allIssues = [];
  let skip = 0;
  const top = 100;

  while (true) {
    const url = YOUTRACK_BASE_URL + '/api/issues?query=' + encodeURIComponent(query) +
      '&fields=' + encodeURIComponent(issueFields) +
      '&$skip=' + skip + '&$top=' + top;

    const batch = await apiGet(url);
    if (!batch || batch.length === 0) break;

    allIssues.push(...batch);
    console.log('  Fetched ' + allIssues.length + ' issues so far...');
    skip += top;
    await sleep(API_DELAY_MS);
  }

  console.log('Total issues found: ' + allIssues.length);
  return allIssues;
}

async function fetchComments(issueId) {
  try {
    const fields = 'id,text,created,updated,author(login,fullName),deleted';
    const url = YOUTRACK_BASE_URL + '/api/issues/' + issueId + '/comments?fields=' + encodeURIComponent(fields);
    const data = await apiGet(url);
    return (data || []).filter(function(c) { return !c.deleted; }).map(function(c) {
      return {
        id: c.id,
        text: c.text || '',
        authorLogin: (c.author?.login || '').toLowerCase(),
        authorName: c.author?.fullName || c.author?.login || 'Unknown',
        created: c.created,
        updated: c.updated
      };
    });
  } catch (e) {
    console.log('  Could not fetch comments for ' + issueId + ': ' + e.message);
    return [];
  }
}

async function fetchActivityItems(issueId) {
  try {
    const fields = 'id,timestamp,author(login,fullName),added(name),removed(name),field(name)';
    const url = YOUTRACK_BASE_URL + '/api/issues/' + issueId +
      '/activities?fields=' + encodeURIComponent(fields) +
      '&categories=CommentsCategory,CustomFieldCategory';
    const data = await apiGet(url);
    return (data || []).map(function(a) {
      // added/removed can be objects, arrays, or primitives
      function extractName(val) {
        if (!val) return null;
        if (Array.isArray(val)) return val.map(function(v) { return v?.name || v; });
        if (typeof val === 'object') return val.name || JSON.stringify(val);
        return val;
      }
      return {
        id: a.id,
        timestamp: a.timestamp,
        authorLogin: (a.author?.login || '').toLowerCase(),
        authorName: a.author?.fullName || a.author?.login || 'Unknown',
        field: a.field?.name || null,
        added: extractName(a.added),
        removed: extractName(a.removed)
      };
    });
  } catch (e) {
    console.log('  Could not fetch activity for ' + issueId + ': ' + e.message);
    return [];
  }
}

// ─── Analysis Helpers ─────────────────────────────────────────────────────────

function matchQAPerson(login, fullName) {
  // Try direct login match
  const normalizedLogin = (login || '').toLowerCase();
  if (QA_MEMBERS[normalizedLogin]) return normalizedLogin;

  // Try fullName match as fallback
  const normalizedName = (fullName || '').toLowerCase();
  if (NAME_TO_LOGIN[normalizedName]) return NAME_TO_LOGIN[normalizedName];

  return null;
}

function classifyComment(text) {
  if (!text) return 'general';
  for (let i = 0; i < COMMENT_CLASSIFIERS.length; i++) {
    if (COMMENT_CLASSIFIERS[i].pattern.test(text)) {
      return COMMENT_CLASSIFIERS[i].type;
    }
  }
  return 'general';
}

function parseIssueCustomFields(issue) {
  const fields = {};
  let state = null;
  let type = null;
  let priority = null;
  let assigneeLogin = null;

  (issue.customFields || []).forEach(function(cf) {
    const name = cf.name;
    let value = cf.value;

    if (name === 'State' && value) {
      state = Array.isArray(value) ? (value[0]?.name || value[0]) : (value.name || value);
    }
    if (name === 'Type' && value) {
      type = Array.isArray(value) ? (value[0]?.name || value[0]) : (value.name || value);
    }
    if (name === 'Priority' && value) {
      priority = Array.isArray(value) ? (value[0]?.name || value[0]) : (value.name || value);
    }
    if (name === 'Assignee' && value) {
      if (Array.isArray(value)) {
        assigneeLogin = (value[0]?.login || '').toLowerCase();
      } else if (typeof value === 'object') {
        assigneeLogin = (value.login || '').toLowerCase();
      }
    }

    if (value) {
      if (Array.isArray(value)) {
        value = value.map(function(v) { return v.name || v.text || v.presentation || v.fullName || v; }).join(', ');
      } else if (typeof value === 'object') {
        value = value.name || value.text || value.presentation || value.fullName || JSON.stringify(value);
      }
    }
    fields[name] = value;
  });

  return { customFields: fields, state, type, priority, assigneeLogin };
}

function getProjectShortName(issue) {
  return issue.project?.shortName || issue.idReadable?.split('-')[0] || 'UNKNOWN';
}

function findQAStateEntryTime(activities) {
  // Find the earliest time the ticket entered a QA-related state
  for (let i = 0; i < activities.length; i++) {
    const a = activities[i];
    if (a.field === 'State') {
      const added = Array.isArray(a.added) ? a.added : [a.added];
      for (let j = 0; j < added.length; j++) {
        if (added[j] && QA_STATE_PATTERNS.test(String(added[j]))) {
          return a.timestamp;
        }
      }
    }
  }
  return null;
}

function getDayOfWeek(timestamp) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[new Date(timestamp).getUTCDay()];
}

function getHourUTC(timestamp) {
  return new Date(timestamp).getUTCHours();
}

// ─── Main Processing ──────────────────────────────────────────────────────────

async function main() {
  console.log('=== YouTrack QA Evaluation ===');
  console.log('Projects: ' + PROJECTS.join(', '));
  console.log('Date range: ' + DATE_FROM + ' to ' + DATE_TO);
  console.log('QA team members: ' + Object.keys(QA_MEMBERS).length);
  console.log('');

  // Step 1: Search all issues
  const issues = await searchIssues();

  // Initialize per-person accumulators
  const personData = {};
  for (const username in QA_MEMBERS) {
    personData[username] = {
      team: QA_MEMBERS[username].team,
      email: QA_MEMBERS[username].email,
      ticketsTouched: new Set(),
      totalComments: 0,
      commentLengths: [],
      firstResponseTimes: [],  // hours from ticket creation to first comment
      turnaroundTimes: [],     // hours from QA state entry to first QA action
      commentTypes: { pass: 0, fail: 0, bug_found: 0, retest: 0, question: 0, blocked: 0, general: 0 },
      stateTransitions: 0,
      activityByDay: { Sun: 0, Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0 },
      activityByHour: {},
      projectBreakdown: { CSMR: 0, MHLDCD: 0, MHMDCD: 0 }
    };
    for (let h = 0; h < 24; h++) {
      personData[username].activityByHour[h] = 0;
    }
  }

  // Step 2: Process each issue
  const perTicket = [];
  let qaInvolvedCount = 0;
  const startTime = Date.now();

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    const issueId = issue.idReadable;
    const project = getProjectShortName(issue);

    if (i > 0 && i % 50 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log('Processing ' + i + '/' + issues.length + ' (' + elapsed + 's elapsed, ' + qaInvolvedCount + ' QA-involved)');
    }

    // Fetch comments and activity
    const [comments, activities] = await Promise.all([
      fetchComments(issueId),
      fetchActivityItems(issueId)
    ]);
    await sleep(API_DELAY_MS);

    // Parse issue fields
    const parsed = parseIssueCustomFields(issue);

    // Check for QA involvement
    const qaComments = [];
    const qaActivityItems = [];
    const qaParticipants = new Set();

    // Check comments for QA authors
    comments.forEach(function(c) {
      const qaUser = matchQAPerson(c.authorLogin, c.authorName);
      if (qaUser) {
        qaComments.push({
          author: qaUser,
          authorName: c.authorName,
          text: c.text,
          created: c.created,
          length: c.text.length,
          type: classifyComment(c.text)
        });
        qaParticipants.add(qaUser);
      }
    });

    // Check activity for QA authors (state transitions, assignments)
    const stateTransitions = [];
    activities.forEach(function(a) {
      const qaUser = matchQAPerson(a.authorLogin, a.authorName);

      // Track all state transitions regardless of author
      if (a.field === 'State') {
        stateTransitions.push({
          timestamp: a.timestamp,
          from: a.removed,
          to: a.added,
          author: a.authorLogin,
          authorName: a.authorName
        });
      }

      if (qaUser) {
        qaActivityItems.push({
          author: qaUser,
          authorName: a.authorName,
          timestamp: a.timestamp,
          field: a.field,
          added: a.added,
          removed: a.removed
        });
        qaParticipants.add(qaUser);
      }
    });

    // Check if current assignee is QA
    if (parsed.assigneeLogin) {
      const qaAssignee = matchQAPerson(parsed.assigneeLogin, '');
      if (qaAssignee) qaParticipants.add(qaAssignee);
    }

    // Check if ticket went through a QA state
    let hasQAState = false;
    stateTransitions.forEach(function(st) {
      const added = Array.isArray(st.to) ? st.to : [st.to];
      added.forEach(function(s) {
        if (s && QA_STATE_PATTERNS.test(String(s))) hasQAState = true;
      });
    });

    const isQAInvolved = qaParticipants.size > 0 || hasQAState;
    if (!isQAInvolved) continue;

    qaInvolvedCount++;

    // Find when ticket entered QA state (for turnaround calc)
    const qaStateEntryTime = findQAStateEntryTime(activities);

    // Update per-person metrics
    qaParticipants.forEach(function(username) {
      const pd = personData[username];
      if (!pd) return;
      pd.ticketsTouched.add(issueId);
      pd.projectBreakdown[project] = (pd.projectBreakdown[project] || 0) + 1;
    });

    // Process QA comments for per-person metrics
    qaComments.forEach(function(c) {
      const pd = personData[c.author];
      if (!pd) return;
      pd.totalComments++;
      pd.commentLengths.push(c.length);
      pd.commentTypes[c.type]++;
      pd.activityByDay[getDayOfWeek(c.created)]++;
      pd.activityByHour[getHourUTC(c.created)]++;

      // First response time: hours from ticket creation
      if (issue.created) {
        const responseHours = (c.created - issue.created) / (1000 * 60 * 60);
        if (responseHours >= 0) pd.firstResponseTimes.push(responseHours);
      }

      // Turnaround: hours from QA state entry to this comment
      if (qaStateEntryTime) {
        const turnaroundHours = (c.created - qaStateEntryTime) / (1000 * 60 * 60);
        if (turnaroundHours >= 0) pd.turnaroundTimes.push(turnaroundHours);
      }
    });

    // Process QA activity items for per-person metrics
    qaActivityItems.forEach(function(a) {
      const pd = personData[a.author];
      if (!pd) return;
      if (a.field === 'State') pd.stateTransitions++;
      pd.activityByDay[getDayOfWeek(a.timestamp)]++;
      pd.activityByHour[getHourUTC(a.timestamp)]++;

      // Turnaround from QA state entry
      if (qaStateEntryTime && a.timestamp) {
        const turnaroundHours = (a.timestamp - qaStateEntryTime) / (1000 * 60 * 60);
        if (turnaroundHours >= 0) pd.turnaroundTimes.push(turnaroundHours);
      }
    });

    // Build per-ticket record
    perTicket.push({
      id: issueId,
      summary: issue.summary,
      project: project,
      state: parsed.state,
      type: parsed.type,
      priority: parsed.priority,
      created: issue.created ? new Date(issue.created).toISOString() : null,
      updated: issue.updated ? new Date(issue.updated).toISOString() : null,
      resolved: issue.resolved ? new Date(issue.resolved).toISOString() : null,
      reporter: issue.reporter?.fullName || issue.reporter?.login || 'Unknown',
      assignee: parsed.customFields['Assignee'] || 'Unassigned',
      qaStateEntryTime: qaStateEntryTime ? new Date(qaStateEntryTime).toISOString() : null,
      hasQAState: hasQAState,
      qaComments: qaComments.map(function(c) {
        return {
          author: c.author,
          authorName: c.authorName,
          text: c.text,
          created: new Date(c.created).toISOString(),
          length: c.length,
          type: c.type
        };
      }),
      qaActivityItems: qaActivityItems.map(function(a) {
        return {
          author: a.author,
          authorName: a.authorName,
          timestamp: new Date(a.timestamp).toISOString(),
          field: a.field,
          added: a.added,
          removed: a.removed
        };
      }),
      stateTransitions: stateTransitions.map(function(st) {
        return {
          timestamp: new Date(st.timestamp).toISOString(),
          from: st.from,
          to: st.to,
          author: st.author,
          authorName: st.authorName
        };
      }),
      qaParticipants: Array.from(qaParticipants)
    });
  }

  // Step 3: Build per-person summary
  function avg(arr) {
    if (arr.length === 0) return null;
    return arr.reduce(function(a, b) { return a + b; }, 0) / arr.length;
  }
  function median(arr) {
    if (arr.length === 0) return null;
    const sorted = arr.slice().sort(function(a, b) { return a - b; });
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  const perPerson = {};
  for (const username in personData) {
    const pd = personData[username];
    perPerson[username] = {
      team: pd.team,
      email: pd.email,
      ticketsTouched: pd.ticketsTouched.size,
      totalComments: pd.totalComments,
      avgCommentLength: Math.round(avg(pd.commentLengths) || 0),
      medianCommentLength: Math.round(median(pd.commentLengths) || 0),
      avgFirstResponseHours: avg(pd.firstResponseTimes) !== null ? Math.round(avg(pd.firstResponseTimes) * 10) / 10 : null,
      medianFirstResponseHours: median(pd.firstResponseTimes) !== null ? Math.round(median(pd.firstResponseTimes) * 10) / 10 : null,
      avgTurnaroundHours: avg(pd.turnaroundTimes) !== null ? Math.round(avg(pd.turnaroundTimes) * 10) / 10 : null,
      medianTurnaroundHours: median(pd.turnaroundTimes) !== null ? Math.round(median(pd.turnaroundTimes) * 10) / 10 : null,
      commentTypes: pd.commentTypes,
      stateTransitions: pd.stateTransitions,
      activityByDay: pd.activityByDay,
      activityByHour: pd.activityByHour,
      projectBreakdown: pd.projectBreakdown,
      // Raw arrays for further analysis
      _rawFirstResponseHours: pd.firstResponseTimes,
      _rawTurnaroundHours: pd.turnaroundTimes,
      _rawCommentLengths: pd.commentLengths
    };
  }

  // Step 4: Build team comparison
  function teamAgg(teamName) {
    const members = Object.keys(perPerson).filter(function(u) { return perPerson[u].team === teamName; });
    let totalTickets = 0, totalComments = 0, totalStateTransitions = 0;
    const allTurnarounds = [];
    const allFirstResponses = [];
    const allCommentLengths = [];

    members.forEach(function(u) {
      const p = perPerson[u];
      totalTickets += p.ticketsTouched;
      totalComments += p.totalComments;
      totalStateTransitions += p.stateTransitions;
      allTurnarounds.push(...(personData[u].turnaroundTimes || []));
      allFirstResponses.push(...(personData[u].firstResponseTimes || []));
      allCommentLengths.push(...(personData[u].commentLengths || []));
    });

    return {
      memberCount: members.length,
      totalTickets: totalTickets,
      totalComments: totalComments,
      totalStateTransitions: totalStateTransitions,
      avgCommentsPerTicket: totalTickets > 0 ? Math.round((totalComments / totalTickets) * 10) / 10 : 0,
      avgTurnaroundHours: avg(allTurnarounds) !== null ? Math.round(avg(allTurnarounds) * 10) / 10 : null,
      medianTurnaroundHours: median(allTurnarounds) !== null ? Math.round(median(allTurnarounds) * 10) / 10 : null,
      avgFirstResponseHours: avg(allFirstResponses) !== null ? Math.round(avg(allFirstResponses) * 10) / 10 : null,
      medianFirstResponseHours: median(allFirstResponses) !== null ? Math.round(median(allFirstResponses) * 10) / 10 : null,
      avgCommentLength: Math.round(avg(allCommentLengths) || 0)
    };
  }

  const teamComparison = {
    CSMR_QA: teamAgg('CSMR_QA'),
    MH_QA: teamAgg('MH_QA')
  };

  // Step 5: Build output
  const output = {
    metadata: {
      generated: new Date().toISOString(),
      dateRange: { from: DATE_FROM, to: DATE_TO },
      projects: PROJECTS,
      totalTicketsFetched: issues.length,
      qaInvolvedTickets: qaInvolvedCount
    },
    teamRosters: {
      CSMR_QA: CSMR_QA_EMAILS,
      MH_QA: MH_QA_EMAILS
    },
    perPerson: perPerson,
    perTicket: perTicket,
    teamComparison: teamComparison
  };

  // Step 6: Write output
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');

  // Step 7: Print summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log('=== Complete ===');
  console.log('Total issues searched: ' + issues.length);
  console.log('QA-involved tickets: ' + qaInvolvedCount);
  console.log('Runtime: ' + elapsed + 's');
  console.log('Output: ' + OUTPUT_FILE);
  console.log('');
  console.log('--- Per-Person Summary ---');
  Object.keys(perPerson).sort(function(a, b) {
    return perPerson[b].ticketsTouched - perPerson[a].ticketsTouched;
  }).forEach(function(u) {
    const p = perPerson[u];
    if (p.ticketsTouched === 0 && p.totalComments === 0) return;
    console.log(
      '  ' + u.padEnd(30) +
      ' [' + p.team.padEnd(7) + '] ' +
      'tickets=' + String(p.ticketsTouched).padStart(4) +
      '  comments=' + String(p.totalComments).padStart(4) +
      '  avgTurnaround=' + (p.avgTurnaroundHours !== null ? p.avgTurnaroundHours + 'h' : 'N/A').padStart(7) +
      '  stateChanges=' + String(p.stateTransitions).padStart(4)
    );
  });
  console.log('');
  console.log('--- Team Comparison ---');
  ['CSMR_QA', 'MH_QA'].forEach(function(team) {
    const t = teamComparison[team];
    console.log('  ' + team + ':');
    console.log('    Members: ' + t.memberCount);
    console.log('    Tickets: ' + t.totalTickets + '  Comments: ' + t.totalComments);
    console.log('    Avg turnaround: ' + (t.avgTurnaroundHours !== null ? t.avgTurnaroundHours + 'h' : 'N/A'));
    console.log('    Median turnaround: ' + (t.medianTurnaroundHours !== null ? t.medianTurnaroundHours + 'h' : 'N/A'));
    console.log('    Avg comments/ticket: ' + t.avgCommentsPerTicket);
  });
}

main().catch(function(e) {
  console.error('Fatal error:', e.message);
  console.error(e.stack);
  process.exit(1);
});
