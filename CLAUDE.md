# PM Assistant — Claude Code Project Config

This is Romit Nath's PM Intelligence Assistant directory. It contains scripts, credentials, and generated reports for managing projects across Internet Brands' legal technology platforms (FindLaw, Avvo, MAC, LDC, MDC).

## Quick Start

Use the `/generate-comm` slash command to generate any executive communication:

```
/generate-comm biweekly for Q1 bundles, pull from Airtable "all", include chat spaces/AAQAve0AYtw
/generate-comm e2e with ADO #247908, YouTrack CSMR-15953 MDCD-11237, chat E2E for Q1 Bundles
/generate-comm weekly from all Airtable projects, include area report
/generate-comm deep-dive on "Q1 Bundle Fulfillment" with ADO #247908 and YouTrack MAC-1968
```

## Infrastructure

| Component | File | Port | Purpose |
|-----------|------|------|---------|
| ADO Crawler | `server.js` | 3000 | Fetch Azure DevOps work items |
| YouTrack Crawler | `youtrack.js` | 3001 | Fetch YouTrack issues |
| Biweekly Report Gen | `biweekly-report.js` | 3002 | Aggregate + generate .docx |
| Weekly Area Report | `area-open-weekly-report.js` | — | ADO open items by area path |
| Google Chat Pull | `gchat_pull.py` | — | Pull Google Chat messages |
| Comm Generator | `generate-comm.js` | — | Backend comm generation script |
| Bug Report | `lawyer-directory-bug-report.js` | — | Lawyer directory bugs |

## Credentials (in this directory)

- `.env` — ADO_PAT, YOUTRACK_TOKEN, AIRTABLE_API_KEY, ANTHROPIC_API_KEY
- `oauth_credentials.json` — Google OAuth client config
- `token.json` — Google OAuth refresh token (auto-refreshes)

## Key IDs

**Airtable:** Base `appq6NWOEqbz4eRN9` / Projects `tblXoVF2kUYL5tFd` / Status Reports `tblRNAKuSGEdCtBMb`

**Google Chat Spaces:**
- `spaces/AAQAve0AYtw` — E2E for Q1 Bundles
- `spaces/AAQAdT8Zju4` — E2E Bug Triage
- `spaces/AAQARjk9mWY` — Q1 Bundles PMO

**Dashboards:**
- ADO E2E: `https://dev.azure.com/Findlaw/FindLawADO/_dashboards/dashboard/cba0b172-00b1-4700-9862-42016e6a5580`
- YouTrack E2E: `https://youtrack.internetbrands.com/dashboard?id=527-4556`

## Rules

1. **Always generate a source references document** alongside any communication
2. **Tag [FindLaw] for ADO data, [MAC] for YouTrack data**, use Airtable BU field otherwise
3. **Never fabricate data** — if a source is unavailable, say so
4. If Python Google libraries hang, use `curl` for direct API calls instead
5. All comms default to `romit.nath@internetbrands.com`
