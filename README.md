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
