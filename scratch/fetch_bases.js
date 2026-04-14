const https = require('https');
require('dotenv').config();

const pat = process.env.AIRTABLE_PAT;

if (!pat) {
    console.error("No AIRTABLE_PAT found in .env");
    process.exit(1);
}

const options = {
    hostname: 'api.airtable.com',
    path: '/v0/meta/bases',
    method: 'GET',
    headers: {
        'Authorization': `Bearer ${pat}`
    }
};

const req = https.request(options, res => {
    let data = '';
    res.on('data', chunk => {
        data += chunk;
    });
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            console.log(JSON.stringify(json, null, 2));
        } catch (e) {
            console.error("Error parsing JSON:", e);
            console.log("Raw response:", data);
        }
    });
});

req.on('error', error => {
    console.error(error);
});

req.end();
