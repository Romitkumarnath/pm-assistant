# AGENTS.md

## Cursor Cloud specific instructions

This is a simple Node.js project (no build step, no TypeScript, no linting, no automated tests). See `README.md` for full setup and usage.

### Services

| Service | Command | Port | Notes |
|---------|---------|------|-------|
| ADO Server | `npm run dev:ado` | 3000 | Requires `ADO_PAT` + `ANTHROPIC_API_KEY` in `.env` |
| YouTrack Server | `npm run dev:youtrack` | 3001 | Requires `YOUTRACK_TOKEN` + `ANTHROPIC_API_KEY` in `.env` |

### Key caveats

- Both servers call `process.exit(1)` on startup if their required env vars are missing. A `.env` file **must** exist with at least placeholder values for the server to start.
- There is no lint or test suite configured (`npm test` exits with error by design).
- No build step — plain JavaScript served directly by Express with inline HTML + Tailwind CSS via CDN.
- The two servers are fully independent and can be started individually or together.
- Dev mode uses `node --watch` for auto-reload on file changes.
