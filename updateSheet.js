const { google } = require('googleapis');
// const fs = require('fs'); // Comment out or remove this line
require('dotenv').config();

// Remove file loading and saving logic
let userDatabase = {}; // Initialize an empty object for in-memory storage

// Middleware to register users automatically
// This should be in bot.js, not here
// bot.use((ctx, next) => {
//     const userId = ctx.from.id;
//     const username = ctx.from.username || 'Unknown';
//     if (!userDatabase[username]) {
//         userDatabase[username] = userId;
//         saveUserDatabase();
//         console.log(`User automatically registered: ${username} with ID: ${userId}`);
//     }
//     return next();
// });

// Authorize a client with credentials
async function authorize() {
    const credentials = {
        client_email: process.env.CLIENT_EMAIL,
        private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'), // Ensure line breaks are correct
    };

    const auth = new google.auth.JWT(
        credentials.client_email,
        null,
        credentials.private_key,
        ['https://www.googleapis.com/auth/spreadsheets']
    );

    return auth;
}

// Update Google Sheet
async function updateSheet(data) {
    if (!data || !Array.isArray(data) || data.length === 0) {
        console.error('Invalid data provided to updateSheet:', data);
        return;
    }

    const auth = await authorize();
    const sheets = google.sheets({ version: 'v4', auth });

    // Calculate the number of rows and columns
    const numRows = data.length + 1; // +1 for the header row
    const numCols = data[0].length; // Adjusted to match the data structure

    // Convert column number to letter (e.g., 1 -> A, 2 -> B, ..., 7 -> G)
    const colLetter = String.fromCharCode('A'.charCodeAt(0) + numCols - 1);

    // Update the range with the correct sheet name
    const range = `Φύλλο1!A1:${colLetter}${numRows}`;

    const request = {
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: range,
        valueInputOption: 'RAW',
        resource: {
            values: [
                ['Member ID', 'Telegram Username', 'Plan Name', 'Status', 'Email', 'Plan End Date', 'Telegram ID'],
                ...data
            ],
        },
    };

    try {
        const response = await sheets.spreadsheets.values.update(request);
        console.log('Sheet updated:', response.data);
    } catch (err) {
        console.error('Error updating sheet:', err);
    }
}

module.exports = { updateSheet, authorize };
