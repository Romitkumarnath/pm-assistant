/**
 * gchat.test.js — Automated tests for Google Chat integration
 * Run with: node --test gchat.test.js
 */
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseSpaceList, parseTranscriptLine, extractTicketIds, resolveSpaceIds, fetchGoogleChatSpaces } = require('./gchat-utils');

// ─── parseSpaceList ───────────────────────────────────────────────────────────

describe('parseSpaceList', function() {
  const SAMPLE_LIST = `Space Name                     Type            Display Name
--------------------------------------------------------------------------------
spaces/AAAAmu6gs20             ROOM            MAC Review Aggregation Service (RAS)
spaces/AAAAerqkeoI             ROOM            avvo-consumer-club
spaces/AAQAwyGFY3o             ROOM            Invoca Double-Hop Daily Sync  - Mar 11
spaces/AAQAai_1fTc             ROOM            Invoca Double-Hop Daily Sync  - Mar 12
spaces/AAQAj6gDRpE             ROOM            Invoca Double-Hop Daily Sync  - Mar 10`;

  test('parses space IDs and display names', function() {
    const map = parseSpaceList(SAMPLE_LIST);
    assert.equal(map['mac review aggregation service (ras)'], 'spaces/AAAAmu6gs20');
    assert.equal(map['avvo-consumer-club'], 'spaces/AAAAerqkeoI');
  });

  test('keys are lowercased', function() {
    const map = parseSpaceList(SAMPLE_LIST);
    assert.ok(Object.keys(map).every(k => k === k.toLowerCase()));
  });

  test('ignores header/separator lines', function() {
    const map = parseSpaceList(SAMPLE_LIST);
    assert.ok(!Object.keys(map).some(k => k.startsWith('space name') || k.startsWith('---')));
  });

  test('returns empty map for empty input', function() {
    assert.deepEqual(parseSpaceList(''), {});
  });
});

// ─── extractTicketIds ────────────────────────────────────────────────────────

describe('extractTicketIds', function() {
  test('extracts single ticket ID', function() {
    assert.deepEqual(extractTicketIds('Working on CSMR-15947 today'), ['CSMR-15947']);
  });

  test('extracts multiple ticket IDs', function() {
    assert.deepEqual(extractTicketIds('UNSER-1141 relates to CSMR-15266 and DSARC-2447'), ['UNSER-1141', 'CSMR-15266', 'DSARC-2447']);
  });

  test('returns empty array when no ticket IDs', function() {
    assert.deepEqual(extractTicketIds('no tickets here'), []);
  });

  test('does not match lowercase patterns', function() {
    assert.deepEqual(extractTicketIds('unser-1141 is not a match'), []);
  });
});

// ─── parseTranscriptLine ─────────────────────────────────────────────────────

describe('parseTranscriptLine', function() {
  test('parses a standard message line', function() {
    const msg = parseTranscriptLine('[2026-03-10 14:22] Romit Nath: RAS reviews not displaying');
    assert.ok(msg);
    assert.equal(msg.sender, 'Romit Nath');
    assert.equal(msg.createTime, '2026-03-10 14:22');
    assert.equal(msg.text, 'RAS reviews not displaying');
    assert.equal(msg.isReply, false);
  });

  test('parses a thread reply line (↳ prefix)', function() {
    const msg = parseTranscriptLine('  ↳ [2026-03-10 14:35] Chen Chau: Fix deployed to staging');
    assert.ok(msg);
    assert.equal(msg.isReply, true);
    assert.equal(msg.sender, 'Chen Chau');
    assert.equal(msg.text, 'Fix deployed to staging');
  });

  test('extracts ticket IDs from message text', function() {
    const msg = parseTranscriptLine('[2026-03-10 09:00] Alice: See CSMR-15979 for details');
    assert.deepEqual(msg.ticketIds, ['CSMR-15979']);
  });

  test('returns null for non-message lines (headers, blanks, separators)', function() {
    assert.equal(parseTranscriptLine('--- Thread ---'), null);
    assert.equal(parseTranscriptLine(''), null);
    assert.equal(parseTranscriptLine('=== avvo-consumer-club ==='), null);
  });
});

// ─── resolveSpaceIds ─────────────────────────────────────────────────────────

describe('resolveSpaceIds', function() {
  const SPACE_MAP = {
    'mac review aggregation service (ras)': 'spaces/AAAAmu6gs20',
    'avvo-consumer-club': 'spaces/AAAAerqkeoI',
    'invoca double-hop daily sync  - mar 11': 'spaces/AAQAwyGFY3o',
    'invoca double-hop daily sync  - mar 12': 'spaces/AAQAai_1fTc',
    'invoca double-hop daily sync  - mar 10': 'spaces/AAQAj6gDRpE',
    'q1 bundles - pmo': 'spaces/AAQARjk9mWY'
  };

  test('passes through a direct space ID unchanged', async function() {
    const results = await resolveSpaceIds(['spaces/AAAAmu6gs20'], SPACE_MAP);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'spaces/AAAAmu6gs20');
  });

  test('resolves exact name to space ID', async function() {
    const results = await resolveSpaceIds(['avvo-consumer-club'], SPACE_MAP);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'spaces/AAAAerqkeoI');
  });

  test('partial match returns ALL matching spaces', async function() {
    const results = await resolveSpaceIds(['Invoca Double-Hop Daily Sync'], SPACE_MAP);
    assert.equal(results.length, 3);
    const ids = results.map(r => r.id);
    assert.ok(ids.includes('spaces/AAQAwyGFY3o'));
    assert.ok(ids.includes('spaces/AAQAai_1fTc'));
    assert.ok(ids.includes('spaces/AAQAj6gDRpE'));
  });

  test('case-insensitive matching', async function() {
    const results = await resolveSpaceIds(['MAC REVIEW AGGREGATION SERVICE'], SPACE_MAP);
    assert.equal(results.length, 1);
    assert.equal(results[0].id, 'spaces/AAAAmu6gs20');
  });

  test('deduplicates if same space matched multiple times', async function() {
    const results = await resolveSpaceIds(['spaces/AAAAerqkeoI', 'spaces/AAAAerqkeoI'], SPACE_MAP);
    assert.equal(results.length, 1);
  });

  test('returns empty array for unrecognised name', async function() {
    const results = await resolveSpaceIds(['nonexistent room xyz'], SPACE_MAP);
    assert.equal(results.length, 0);
  });

  test('handles mix of IDs and names', async function() {
    const results = await resolveSpaceIds(['spaces/AAQARjk9mWY', 'avvo-consumer-club'], SPACE_MAP);
    assert.equal(results.length, 2);
  });
});

// ─── fetchGoogleChatSpaces ───────────────────────────────────────────────────

describe('fetchGoogleChatSpaces', function() {
  const SPACE_MAP = {
    'avvo-consumer-club': 'spaces/AAAAerqkeoI',
    'mac review aggregation service (ras)': 'spaces/AAAAmu6gs20'
  };

  const SAMPLE_TRANSCRIPT = `--- Thread ---
[2026-03-10 14:22] Romit Nath: RAS reviews not displaying in prod — see UNSER-1293
  ↳ [2026-03-10 14:35] Chen Chau: Confirmed, checking RAS response ordering
  ↳ [2026-03-10 15:01] Joanne Koehler: Fix deployed to staging

[2026-03-11 09:15] Alice: Ngage provisioning question for Q1 bundles`;

  // Mock runGchatScript that returns preset data per space ID
  function makeMockRunner(responses) {
    return async function(args) {
      const spaceArg = args[args.indexOf('--space') + 1];
      const resp = responses[spaceArg];
      if (!resp) return { stdout: '', stderr: 'no data', code: 1 };
      return { stdout: resp, stderr: '', code: 0 };
    };
  }

  test('returns null when no spaces resolve', async function() {
    // pass an unknown name with empty space map
    const result = await fetchGoogleChatSpaces(['nonexistent'], null, makeMockRunner({}));
    assert.equal(result, null);
  });

  test('returns combined messages from a single space', async function() {
    const mockRun = makeMockRunner({ 'spaces/AAAAerqkeoI': SAMPLE_TRANSCRIPT });
    // Bypass name resolution by using direct ID
    const result = await fetchGoogleChatSpaces(['spaces/AAAAerqkeoI'], null, mockRun);
    assert.ok(result);
    assert.ok(result.totalMessages > 0);
  });

  test('combines messages from multiple spaces', async function() {
    const mockRun = makeMockRunner({
      'spaces/AAAAerqkeoI': '[2026-03-10 10:00] Alice: message in avvo',
      'spaces/AAAAmu6gs20': '[2026-03-10 11:00] Bob: message in RAS'
    });
    const result = await fetchGoogleChatSpaces(['spaces/AAAAerqkeoI', 'spaces/AAAAmu6gs20'], null, mockRun);
    assert.ok(result);
    assert.equal(result.totalMessages, 2);
    assert.ok(result.participants.includes('Alice'));
    assert.ok(result.participants.includes('Bob'));
  });

  test('extracts ticket mentions from messages', async function() {
    const mockRun = makeMockRunner({ 'spaces/AAAAerqkeoI': SAMPLE_TRANSCRIPT });
    const result = await fetchGoogleChatSpaces(['spaces/AAAAerqkeoI'], null, mockRun);
    assert.ok(result);
    assert.ok(result.ticketMentions['UNSER-1293']);
    assert.equal(result.ticketMentions['UNSER-1293'][0].sender, 'Romit Nath');
  });

  test('includes thread section headers and reply indentation in transcript', async function() {
    const mockRun = makeMockRunner({ 'spaces/AAAAerqkeoI': SAMPLE_TRANSCRIPT });
    const result = await fetchGoogleChatSpaces(['spaces/AAAAerqkeoI'], null, mockRun);
    assert.ok(result.transcript.includes('↳'));
    assert.ok(result.transcript.includes('--- Thread ---'));
  });

  test('returns null when space has no messages', async function() {
    const mockRun = makeMockRunner({ 'spaces/AAAAerqkeoI': '' });
    const result = await fetchGoogleChatSpaces(['spaces/AAAAerqkeoI'], null, mockRun);
    assert.equal(result, null);
  });

  test('skips unavailable spaces and returns data from available ones', async function() {
    const mockRun = makeMockRunner({
      'spaces/AAAAerqkeoI': '[2026-03-10 10:00] Alice: hello'
      // spaces/AAAAmu6gs20 intentionally missing — simulates fetch failure
    });
    const result = await fetchGoogleChatSpaces(['spaces/AAAAerqkeoI', 'spaces/AAAAmu6gs20'], null, mockRun);
    assert.ok(result);
    assert.equal(result.totalMessages, 1);
  });

  test('passes afterDate to the script args', async function() {
    let capturedArgs = null;
    const mockRun = async function(args) {
      capturedArgs = args;
      return { stdout: '[2026-03-10 10:00] Alice: hello', stderr: '', code: 0 };
    };
    await fetchGoogleChatSpaces(['spaces/AAAAerqkeoI'], '2026-03-01', mockRun);
    assert.ok(capturedArgs.includes('--after'));
    assert.ok(capturedArgs.includes('2026-03-01'));
  });
});
