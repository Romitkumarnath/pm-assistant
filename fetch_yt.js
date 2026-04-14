require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const YOUTRACK_TOKEN = process.env.YOUTRACK_TOKEN;
const YOUTRACK_BASE_URL = process.env.YOUTRACK_BASE_URL || 'https://youtrack.internetbrands.com';

const headers = {
  'Authorization': 'Bearer ' + YOUTRACK_TOKEN,
  'Accept': 'application/json'
};

async function fetchIssue(issueId) {
  try {
    const fields = [
      'idReadable', 'summary', 'description', 'state(name)', 'assignee(fullName)', 
      'comments(text,author(fullName))', 'links(direction,linkType(name),issues(idReadable,summary,state(name)))'
    ].join(',');
    const url = `${YOUTRACK_BASE_URL}/api/issues/${issueId}?fields=${encodeURIComponent(fields)}`;
    const res = await axios.get(url, { headers });
    return res.data;
  } catch (e) {
    console.error(`Error fetching issue ${issueId}:`, e.message);
    return null;
  }
}

async function main() {
  const tickets = [
    'CSMR-14283',
    'AVVOCTNT-3904',
    'AVVOCTNT-3952',
    'LGLMAC-203',
    'LGLMAC-213',
    'LGLMAC-206',
    'MHMDCD-11257',
    'MHLDCD-16272',
    'MHLDCD-16271',
    'MHLDCD-16254'
  ];

  const results = {};
  for (const t of tickets) {
    console.log("Fetching", t);
    const data = await fetchIssue(t);
    if (data) {
      if (data.description && data.description.length > 500) {
        data.description = data.description.substring(0, 500) + '...';
      }
      if (data.comments && data.comments.length > 5) {
        data.comments = data.comments.slice(-5); // last 5 comments
      }
      results[t] = data;
    }
  }

  fs.writeFileSync('tickets_dump.json', JSON.stringify(results, null, 2));
  console.log("Done");
}

main();
