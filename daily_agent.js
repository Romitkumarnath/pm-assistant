require('dotenv').config();
const { getActiveProjects } = require('./fetch_airtable_active');
const { GoogleGenAI } = require('@google/genai');
const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs');

const YOUTRACK_TOKEN = process.env.YOUTRACK_TOKEN;
const YOUTRACK_BASE_URL = process.env.YOUTRACK_BASE_URL || 'https://youtrack.internetbrands.com';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
    console.error("Please add GEMINI_API_KEY to your .env file.");
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const headers = {
    'Authorization': 'Bearer ' + YOUTRACK_TOKEN,
    'Accept': 'application/json'
};

async function fetchYoutrackIssue(issueId) {
    try {
        const fields = 'id,summary,description,state(name),comments(text,author(fullName))';
        const url = `${YOUTRACK_BASE_URL}/api/issues/${issueId}?fields=${encodeURIComponent(fields)}`;
        const res = await axios.get(url, { headers });
        return res.data;
    } catch (e) {
        return { error: `Failed to fetch ${issueId}` };
    }
}

function fetchGChatTranscripts() {
    console.log("Locating GChat spaces...");
    let output = "";
    try {
        const listSpaces = execSync('python gchat_pull.py --list-spaces', { encoding: 'utf-8' });
        const targetSpaces = ['MAC-Service', 'avvo-consumer-slackup', 'avvo-monitoring-prod', 'avvo-consumer-club'];
        
        let spaceMappings = {};
        listSpaces.split('\n').forEach(line => {
            targetSpaces.forEach(name => {
                if (line.includes(name)) {
                    const id = line.split(' ')[0]; // usually starts with spaces/XXXX
                    spaceMappings[name] = id;
                }
            });
        });

        // Pull from past 2 days
        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
        const afterDate = twoDaysAgo.toISOString().split('T')[0];

        for (const [name, id] of Object.entries(spaceMappings)) {
            console.log(`Pulling chat for ${name}...`);
            const chatOut = execSync(`python gchat_pull.py --space "${id}" --after "${afterDate}"`, { encoding: 'utf-8' });
            output += `\n--- Chat from ${name} ---\n${chatOut}\n`;
        }
    } catch (e) {
        console.error("Warning: Failed to fetch recent GChat transcripts.");
        output += "No recent chat transcripts available.";
    }
    return output;
}

async function run() {
    console.log("Fetching active projects from Airtable...");
    const projects = await getActiveProjects();
    console.log(`Found ${projects.length} active projects.`);

    const reportData = [];

    for (const proj of projects) {
        console.log(`Processing project: ${proj.name}`);
        const projData = {
            name: proj.name,
            stage: proj.stage,
            tickets: []
        };
        
        if (proj.ytId) {
            console.log(`  --> Fetching YouTrack: ${proj.ytId}`);
            const issueData = await fetchYoutrackIssue(proj.ytId);
            projData.tickets.push(issueData);
        }
        reportData.push(projData);
    }

    const chats = fetchGChatTranscripts();

    const prompt = `You are an executive Project Manager assigned to provide a daily task-level status update for a portfolio of in-flight and approved projects. 

Below is the structured data of all currently active projects, their associated YouTrack Epic/Ticket summaries & comments, along with the recent developer Google Chat transcripts.

For EACH project, provide a detailed task-level update with exactly three headers:
1. Accomplishments
2. Upcoming
3. Risks

Use specific tool constraints:
- Do not make up any details. Only extrapolate from the Youtrack tickets and Chat logs.
- Identify blocked tasks or missing designs as risks.

--- PROJECT TICKET DATA ---
${JSON.stringify(reportData, null, 2)}

--- GOOGLE CHAT ACTIVITY (LAST 2 DAYS) ---
${chats.substring(0, 50000) /* safeguard against context limit */}
`;

    console.log("Sending data to Gemini Pro...");
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: prompt
        });

        const reportText = response.text;
        
        if (!fs.existsSync('daily_reports')) {
            fs.mkdirSync('daily_reports');
        }
        const filename = `daily_reports/Status_Report_${new Date().toISOString().split('T')[0]}.md`;
        fs.writeFileSync(filename, reportText);
        
        console.log(`\nDaily report successfully generated and saved to ${filename}!`);
    } catch (e) {
        console.error("AI Error:", e.message);
    }
}

run();
