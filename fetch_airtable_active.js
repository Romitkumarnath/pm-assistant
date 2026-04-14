require('dotenv').config();
const Airtable = require('airtable');

// Configure Airtable
Airtable.configure({
    apiKey: process.env.AIRTABLE_PAT,
});

const baseId = 'appq6NWOEqbz4eRN9';
const tableId = 'tblXoVF2kUUYL5tFd';
const viewId = 'viwYHDxJc4HYwy0aF';

const base = Airtable.base(baseId);

async function getActiveProjects() {
    return new Promise((resolve, reject) => {
        const activeProjects = [];
        base(tableId).select({
            view: viewId
        }).eachPage(function page(records, fetchNextPage) {
            records.forEach(function(record) {
                const stage = record.get('Project stage');
                // The user requested In flight, Approved, or Complete (recent).
                // Assuming view viwYHDxJc4HYwy0aF mostly handles it, but let's double filter:
                if (stage === 'In flight' || stage === 'Approved' || stage === 'Complete') {
                    const youtrackLink = record.get('YouTrack / ADO Link');
                    
                    let ytId = null;
                    if (youtrackLink) {
                        // Extract Youtrack ID from "https://youtrack.../issue/XYZ-123"
                        const match = youtrackLink.match(/issue\/([A-Z0-9\-]+)/i);
                        if (match) ytId = match[1];
                    }

                    activeProjects.push({
                        id: record.id,
                        name: record.get('Name') || record.get('Project Name') || 'Unnamed Project',
                        stage: stage,
                        youtrackLink: youtrackLink,
                        ytId: ytId
                    });
                }
            });

            fetchNextPage();
        }, function done(err) {
            if (err) {
                console.error("Error connecting to Airtable:", err);
                reject(err);
                return;
            }
            resolve(activeProjects);
        });
    });
}

module.exports = { getActiveProjects };

if (require.main === module) {
    getActiveProjects().then(res => console.log(`Found ${res.length} active projects`, res));
}
