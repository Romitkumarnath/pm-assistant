/**
 * gchat-utils.js — Shared Google Chat helpers used by server.js, youtrack.js, biweekly-report.js
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

// Run gchat_pull.py and return raw stdout/stderr/code
function runGchatScript(args, cwd) {
  cwd = cwd || __dirname;
  return new Promise(function(resolve) {
    const scriptPath = path.join(cwd, 'gchat_pull.py');
    const proc = spawn('python', [scriptPath].concat(args), { cwd: cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', function(d) { stdout += d; });
    proc.stderr.on('data', function(d) { stderr += d; });
    proc.on('close', function(code) { resolve({ stdout: stdout, stderr: stderr, code: code }); });
  });
}

// Parse the space listing output from gchat_pull.py --list-spaces into a map
// { "display name lowercase" -> "spaces/XXXX" }
function parseSpaceList(listOutput) {
  const spaceMap = {};
  listOutput.split('\n').forEach(function(line) {
    const m = line.match(/^(spaces\/\S+)\s+\w+\s+(.*)/);
    if (m) spaceMap[m[2].trim().toLowerCase()] = m[1].trim();
  });
  return spaceMap;
}

// Parse a gchat transcript line into a message object, or null if not parseable
function parseTranscriptLine(line) {
  const m = line.match(/^\s*(↳\s*)?\[(.+?)\]\s+(.+?):\s+(.+)$/);
  if (!m) return null;
  return {
    isReply: !!m[1],
    createTime: m[2],
    sender: m[3],
    text: m[4],
    ticketIds: extractTicketIds(m[4]),
    source: 'google_chat'
  };
}

function extractTicketIds(text) {
  const ids = [];
  const re = /\b([A-Z]+-\d+)\b/g;
  let match;
  while ((match = re.exec(text)) !== null) ids.push(match[1]);
  return ids;
}

// Resolve a list of space names/IDs to { id, label } objects.
// Names are matched partially and case-insensitively.
// Returns ALL matching spaces (not just the first).
// Accepts an optional spaceMap override (for testing).
async function resolveSpaceIds(namesOrIds, spaceMapOverride) {
  const results = [];
  const seen = new Set();
  const toResolve = namesOrIds.filter(function(n) { return !/^spaces\//i.test(n.trim()); });

  let spaceMap = spaceMapOverride || null;
  if (!spaceMap && toResolve.length > 0) {
    const r = await runGchatScript(['--list-spaces']);
    spaceMap = parseSpaceList(r.stdout);
  }

  namesOrIds.forEach(function(input) {
    const trimmed = input.trim();
    if (/^spaces\//i.test(trimmed)) {
      if (!seen.has(trimmed)) { seen.add(trimmed); results.push({ id: trimmed, label: trimmed }); }
    } else {
      const key = trimmed.toLowerCase();
      const allMatched = spaceMap ? Object.keys(spaceMap).filter(function(k) { return k.includes(key) || key.includes(k); }) : [];
      if (allMatched.length > 0) {
        allMatched.forEach(function(k) {
          const spaceId = spaceMap[k];
          if (!seen.has(spaceId)) {
            seen.add(spaceId);
            results.push({ id: spaceId, label: k });
            console.log('Resolved "' + trimmed + '" -> ' + spaceId + ' (' + k + ')');
          }
        });
      } else {
        console.log('Could not resolve space name: ' + trimmed);
      }
    }
  });
  return results;
}

// Fetch messages from one or more spaces (names or IDs) and return combined data.
// runFn can be overridden in tests.
async function fetchGoogleChatSpaces(spaceNamesOrIds, afterDate, runFn) {
  runFn = runFn || runGchatScript;
  const spaces = await resolveSpaceIds(spaceNamesOrIds);
  if (spaces.length === 0) return null;

  const allMessages = [];
  const allTicketMentions = {};
  const allParticipants = new Set();
  const transcriptParts = [];

  for (const space of spaces) {
    const args = ['--space', space.id];
    if (afterDate) args.push('--after', afterDate);
    const r = await runFn(args);
    if (r.code !== 0 || !r.stdout.trim()) {
      console.log('No messages from', space.id, r.stderr);
      continue;
    }
    transcriptParts.push('=== ' + space.label + ' ===\n' + r.stdout.trim());
    r.stdout.trim().split('\n').forEach(function(line) {
      const msg = parseTranscriptLine(line);
      if (!msg) return;
      allParticipants.add(msg.sender);
      allMessages.push(Object.assign({ spaceId: space.id }, msg));
      msg.ticketIds.forEach(function(id) {
        if (!allTicketMentions[id]) allTicketMentions[id] = [];
        allTicketMentions[id].push({ sender: msg.sender, text: msg.text, createTime: msg.createTime });
      });
    });
    console.log('Fetched messages from', space.label);
  }

  if (allMessages.length === 0) return null;
  return {
    messages: allMessages,
    participants: Array.from(allParticipants),
    ticketMentions: allTicketMentions,
    totalMessages: allMessages.length,
    transcript: transcriptParts.join('\n\n')
  };
}

module.exports = { runGchatScript, parseSpaceList, parseTranscriptLine, extractTicketIds, resolveSpaceIds, fetchGoogleChatSpaces };
