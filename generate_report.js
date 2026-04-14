require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const YOUTRACK_TOKEN = process.env.YOUTRACK_TOKEN;
const YOUTRACK_BASE_URL = process.env.YOUTRACK_BASE_URL || 'https://youtrack.internetbrands.com';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const headers = {
  'Authorization': 'Bearer ' + YOUTRACK_TOKEN,
  'Accept': 'application/json'
};

async function fetchIssue(issueId) {
  try {
    const fields = [
      'id', 'summary', 'description', 'state(name)', 'priority(name)',
      'assignee(fullName)', 'customFields(name,value(name,text))',
      'links(direction,linkType(name),issues(idReadable,summary,state(name),assignee(fullName)))'
    ].join(',');
    const url = `${YOUTRACK_BASE_URL}/api/issues/${issueId}?fields=${encodeURIComponent(fields)}`;
    const res = await axios.get(url, { headers });
    return res.data;
  } catch (e) {
    console.error(`Error fetching issue ${issueId}:`, e.response?.data?.error_description || e.message);
    return null;
  }
}

async function fetchComments(issueId) {
  try {
    const fields = 'text,created,author(fullName)';
    const url = `${YOUTRACK_BASE_URL}/api/issues/${issueId}/comments?fields=${encodeURIComponent(fields)}`;
    const res = await axios.get(url, { headers });
    return res.data;
  } catch (e) {
    return [];
  }
}

async function main() {
  const mainIssueId = 'LGLMAC-206';
  console.log(`Fetching ${mainIssueId}...`);
  const issue = await fetchIssue(mainIssueId);
  if (!issue) {
    console.log("Failed to fetch.");
    return;
  }
  const comments = await fetchComments(mainIssueId);
  issue.comments = comments;

  const related = [];
  if (issue.links) {
    for (const link of issue.links) {
      if (link.issues) {
        for (const linkedItem of link.issues) {
          console.log(`Fetching linked item: ${linkedItem.idReadable}`);
          const relIssue = await fetchIssue(linkedItem.idReadable);
          if (relIssue) {
            const relComments = await fetchComments(linkedItem.idReadable);
            relIssue.comments = relComments;
            related.push(relIssue);
          }
        }
      }
    }
  }

  const chatContent = fs.readFileSync('mac_service_chat.txt', 'utf-8');

  // Trim chat and data
  const dataToAnalyze = {
    mainTicket: issue,
    linkedTickets: related,
  };

  let maxChat = 12000;
  const chatContext = chatContent.length > maxChat ? chatContent.slice(-maxChat) : chatContent;

  const prompt = `You are a Senior Project Manager Assistant. I will provide you with the YouTrack ticket details for LGLMAC-206 (including its subtasks and linked tickets) and recent Google Chat history from the 'MAC-Service' space.

Your task is to give me a detailed report focusing on:
1. What's accomplished
2. What's coming up
3. What are the risks

Be highly specific and use names, ticket IDs, and project facts extracted from the provided comments and chat logs. Use Markdown formatting.

DATA:
Tickets:
${JSON.stringify(dataToAnalyze, null, 2).substring(0, 50000)}

Google Chat Space 'MAC-Service':
${chatContext}
`;

  console.log('Sending to Anthropic for analysis...');
  try {
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });
    fs.writeFileSync('report_output.md', r.content[0].text);
    console.log('Analysis saved to report_output.md');
  } catch (e) {
    console.error('AI Error:', e.message);
  }
}

main();
