# QA Evaluation Script Design

**Date:** 2026-04-10
**Goal:** Pull YouTrack tickets from CSMR, MHLDCD, MHMDCD projects, extract QA team activity, and produce a raw JSON dataset for evaluating QA operational patterns across teams — to inform unification under CSMR QA (Trey).

## Parameters

- **Projects:** CSMR, MHLDCD, MHMDCD
- **Date range:** 2025-10-10 to 2026-04-10 (6 months)
- **Output:** `qa-evaluation-output.json` (raw data, no AI analysis)
- **Script:** `qa-evaluation.js` (standalone, run with `node qa-evaluation.js`)

## QA Team Rosters

### CSMR QA
| Name | Email |
|------|-------|
| Trixie Zapanta | trixie.zapanta@internetbrands.com |
| Akshita Dave | akshita.dave@internetbrands.com |
| Saurabh Pawar | saurabh.pawar@internetbrands.com |
| Shraddha More | shraddha.more@internetbrands.com |
| Sheilamarie Macalalad | sheilamarie.macalalad@internetbrands.com |
| Raul Baturoni | raul.baturoni@internetbrands.com |
| Jesus Madrigal | jesus.madrigal@internetbrands.com |

### MHMDCD / MHLDCD QA
| Name | Email |
|------|-------|
| Nazmul Hussain | nazmul.hussain@internetbrands.com |
| Julio Meza | julio.meza@internetbrands.com |
| Ivan Gil | ivan.gil@internetbrands.com |
| Richard Echeverria | richard.echeverria@internetbrands.com |
| Victoria Martinez | victoria.martinez@internetbrands.com |
| Jenny Jing | jenny.jing@internetbrands.com |
| Vinoth Kannans | vinoth.kannans@martindale.com |
| Akshaya Maharajan | akshaya.maharajan@martindale.com |
| Ashika Vora | ashika.vora@internetbrands.com |

## Approach: Single-pass query per project

1. Search all issues in CSMR/MHLDCD/MHMDCD updated in the last 6 months
2. For each issue, fetch comments + activity items (state changes, assignments)
3. Filter for any involvement by the 16 QA team members
4. Compute per-person and per-team metrics
5. Output structured JSON

## Data Collection

### Search (net-new code — not in existing youtrack.js)
The existing `youtrack.js` only fetches by known issue ID. This script implements its own search using:
`GET /api/issues?query=project:{CSMR},{MHLDCD},{MHMDCD}+updated:2025-10-10..2026-04-10&$skip=N&$top=100&fields=...`

### Per-issue API calls (3 per ticket)
1. **Issue details** — id, summary, state, assignee, reporter, created/updated/resolved, custom fields
2. **Comments** — called with `author(login,fullName,email)` fields (NOT reusing existing `fetchComments` which flattens author to a string)
3. **Activity items** — state transitions, assignee changes; `added`/`removed` are parsed as objects (`added.name`, `removed.name` for state fields)

### Pagination
YouTrack search returns max 100 per call. Paginate with `$skip` and `$top` until exhausted.

### Rate Limiting
200ms delay between API calls. Retry with exponential backoff on 429/5xx (max 3 retries).

### Runtime Expectation
At ~2000 tickets with 3 calls each and 200ms delay, expect ~20-30 minutes. Progress logged every 50 tickets.

## QA Involvement Detection

A ticket is "QA-involved" if ANY of the following is true:
- A QA team member left a comment
- A QA team member was assigned at any point (from activity history)
- The ticket transitioned through a QA-related state (states containing "QA", "Test", "Verification")

### Matching Logic
Match author email/login against roster using the username portion before `@`. YouTrack may return `login` (e.g., `trixie.zapanta`) or full email — handle both. Normalize to lowercase for comparison.

### Edge Cases
- If a ticket never enters a QA state, turnaround is `null` (excluded from averages, but ticket still counted if QA member commented/was assigned)
- All timestamps treated as UTC for consistency
- QA members who had zero activity in the period still appear in output with zeroed metrics

## Metrics Computed Per Person

| Metric | How Computed |
|--------|-------------|
| Total tickets touched | Count of unique tickets where person appears in comments or activity |
| Comments made | Total comment count across all tickets |
| Comment text lengths | Array of character counts (depth of engagement) |
| Response turnaround | Time between ticket entering QA state and person's first comment/action |
| Comment types | Regex keyword categorization: `/pass(ed)?|approve/i` → pass, `/fail(ed)?|reject/i` → fail, `/bug|defect|issue found/i` → bug_found, `/retest|re-test/i` → retest, `/\?|question|clarif/i` → question, `/block(ed)?/i` → blocked, everything else → general |
| First response times | Time from ticket creation to their first comment |
| Projects covered | Which of CSMR/MHLDCD/MHMDCD they worked in |
| State transitions initiated | Count of state changes they triggered (ownership vs passive commenting) |
| Activity by day-of-week | Distribution of activity across weekdays |
| Activity by hour | Distribution of activity across hours |

## Output JSON Structure

```json
{
  "metadata": {
    "generated": "ISO timestamp",
    "dateRange": { "from": "2025-10-10", "to": "2026-04-10" },
    "projects": ["CSMR", "MHLDCD", "MHMDCD"],
    "totalTicketsFetched": "number",
    "qaInvolvedTickets": "number"
  },
  "teamRosters": {
    "CSMR_QA": ["array of emails"],
    "MH_QA": ["array of emails"]
  },
  "perPerson": {
    "<username>": {
      "team": "CSMR_QA | MH_QA",
      "email": "full email",
      "ticketsTouched": "number",
      "totalComments": "number",
      "avgCommentLength": "number",
      "avgFirstResponseHours": "number",
      "avgTurnaroundHours": "number",
      "commentTypes": { "pass": 0, "fail": 0, "question": 0, "..." : 0 },
      "stateTransitions": "number",
      "activityByDay": { "Mon": 0, "Tue": 0, "..." : 0 },
      "activityByHour": { "0": 0, "1": 0, "..." : 0 },
      "projectBreakdown": { "CSMR": 0, "MHLDCD": 0, "MHMDCD": 0 }
    }
  },
  "perTicket": [
    {
      "id": "CSMR-1234",
      "summary": "string",
      "project": "CSMR",
      "state": "Done",
      "type": "Bug",
      "priority": "Normal",
      "created": "ISO timestamp",
      "resolved": "ISO timestamp or null",
      "reporter": "string",
      "assignee": "string",
      "qaComments": [
        {
          "author": "username",
          "text": "comment text",
          "created": "ISO timestamp",
          "length": "number"
        }
      ],
      "qaActivityItems": [
        {
          "author": "username",
          "timestamp": "ISO timestamp",
          "field": "State",
          "added": "In QA",
          "removed": "In Progress"
        }
      ],
      "qaParticipants": ["username1", "username2"],
      "stateTransitions": [
        {
          "timestamp": "ISO timestamp",
          "from": "state",
          "to": "state",
          "author": "username"
        }
      ]
    }
  ],
  "teamComparison": {
    "CSMR_QA": {
      "avgTurnaroundHours": "number",
      "avgCommentsPerTicket": "number",
      "avgCommentLength": "number",
      "totalTickets": "number",
      "totalComments": "number",
      "totalStateTransitions": "number"
    },
    "MH_QA": { "..." : "same structure" }
  }
}
```

## Script Structure

Single file `qa-evaluation.js`:

1. **Config** — team rosters, date range, project list, API credentials from `.env`
2. **searchIssues(projects, dateRange)** — paginated search across all 3 projects
3. **fetchIssueDetails(issueId)** — reuses existing `fetchIssue` pattern
4. **fetchComments(issueId)** — reuses existing pattern, includes author email
5. **fetchActivityItems(issueId)** — reuses existing pattern, includes author email
6. **isQAInvolved(comments, activities)** — checks against rosters
7. **computePersonMetrics(qaTickets)** — aggregates per-person stats
8. **computeTeamComparison(personMetrics)** — rolls up to team level
9. **main()** — orchestrates flow, writes output JSON, prints summary
