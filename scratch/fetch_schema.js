require('dotenv').config();
const https = require('https');

const baseId = 'appq6NWOEqbz4eRN9';
const tableId = 'tblXoVF2kUUYL5tFd';
const pat = process.env.AIRTABLE_PAT;

const options = {
    hostname: 'api.airtable.com',
    path: `/v0/${baseId}/${tableId}?maxRecords=1`,
    method: 'GET',
    headers: {
        'Authorization': `Bearer ${pat}`
    }
};

const req = https.request(options, res => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            if (json.records && json.records.length > 0) {
                console.log("Fields found in the table:");
                console.log(Object.keys(json.records[0].fields));
            } else {
                console.log("No records found.", json);
            }
        } catch (e) {
            console.error("Error parsing JSON:", e);
        }
    });
});
req.on('error', error => { console.error(error); });
req.end();
