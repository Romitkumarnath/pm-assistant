# PM Intelligence Assistant

A powerful project management intelligence tool that crawls ADO (Azure DevOps) and YouTrack tickets, analyzes them with AI, and generates comprehensive executive briefings.

## Features

- **ADO Integration**: Crawl Azure DevOps work items, comments, and related tickets
- **YouTrack Integration**: Crawl YouTrack issues, comments, and dependencies
- **Google Chat Integration**: Parse and correlate Google Chat conversations with tickets
- **AI Analysis**: Generate executive summaries, identify risks, blockers, and dependencies
- **Interactive Chat**: Ask questions about your project data
- **History Tracking**: Save and revisit previous analyses

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file in the root directory with the following variables:

For ADO (server.js):
```
ADO_PAT=your_azure_devops_personal_access_token
ANTHROPIC_API_KEY=your_anthropic_api_key
```

For YouTrack (youtrack.js):
```
YOUTRACK_TOKEN=your_youtrack_token
YOUTRACK_BASE_URL=https://youtrack.internetbrands.com
ANTHROPIC_API_KEY=your_anthropic_api_key
```

3. Run the server:
```bash
# For ADO
npm run start:ado
# or
node server.js

# For YouTrack
npm run start:youtrack
# or
node youtrack.js
```

4. Open your browser:
- ADO: http://localhost:3000
- YouTrack: http://localhost:3001

### Bi-Weekly Executive Report (biweekly-report.js)

Generates a formatted Word (.docx) bi-weekly status update for the Q1 Bundle Premium Profiles & Network Footprint workstream by aggregating multiple YouTrack and ADO tickets (including child tickets, comments, and descriptions).

**Prerequisites:** Start both `server.js` (ADO) and `youtrack.js` (YouTrack) first.

1. Run the report server:
```bash
npm run start:report
# or
node biweekly-report.js
```

2. Open http://localhost:3002

3. Enter the report date (e.g. 2/2/2026).

4. Enter **YouTrack ticket IDs or URLs** (one per line), e.g.:
   - `UNSER-1141`
   - `CSMR-15266`
   - or full URL: `https://youtrack.internetbrands.com/issue/UNSER-1141`

5. Enter **ADO ticket URLs** (one per line), e.g.:
   - `https://dev.azure.com/org/project/_workitems/edit/12345`

6. Click **Fetch tickets only** to preview fetched data, or **Generate report (.docx)** to generate and download the Word report.

The report follows the Q1 Bundle bi-weekly template: Executive Summary, Overall Health, Key Milestones, Scope, Schedules, Project Status, Up Next, Decisions Pending, Appendix (Project Completion Summary, Key Technical Decisions, Team Updates).

## Usage

1. Paste a work item/issue URL into the input field
2. Optionally paste Google Chat export text (YouTrack only)
3. Click "Crawl and Generate Report"
4. Review the AI-generated analysis
5. Use the chat feature to ask questions about your project

## Environment Variables

**Important**: Never commit your `.env` file to version control. It's already excluded in `.gitignore`.

## License

ISC
