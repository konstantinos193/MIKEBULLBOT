require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { updateSheet, authorize } = require('./updateSheet');
const cron = require('node-cron');
const { Telegraf, Markup } = require('telegraf');
const { google } = require('googleapis');
const express = require('express');
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 3600 }); // Cache with a TTL of 1 hour
let userCache = {};

// Log environment variables to ensure they are loaded correctly
console.log('WIX_API_KEY:', process.env.WIX_API_KEY);
console.log('WIX_ACCOUNT_ID:', process.env.WIX_ACCOUNT_ID);
console.log('WIX_SITE_ID:', process.env.WIX_SITE_ID); // Check if this is undefined
console.log('TELEGRAM_CHANNEL_ID:', process.env.TELEGRAM_CHANNEL_ID);
console.log('TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN);
console.log('CLIENT_EMAIL:', process.env.CLIENT_EMAIL);
console.log('PRIVATE_KEY:', process.env.PRIVATE_KEY.slice(0, 30) + '...'); // Log only the start of the key for security

// Function to fetch all orders
async function fetchAllOrders() {
    let allOrders = [];
    let hasMore = true;
    let offset = 0;
    const limit = 50; // Number of items to fetch per request

    while (hasMore) {
        try {
            console.log(`Fetching orders with offset ${offset}...`);
            const response = await axios.get('https://www.wixapis.com/pricing-plans/v2/orders', {
                headers: {
                    'Authorization': `Bearer ${process.env.WIX_API_KEY}`,
                    'wix-account-id': process.env.WIX_ACCOUNT_ID,
                    'wix-site-id': process.env.WIX_SITE_ID
                },
                params: {
                    limit,
                    offset
                }
            });

            const orders = response.data.orders;
            console.log(`Fetched ${orders.length} orders with offset ${offset}.`);
            allOrders = allOrders.concat(orders);

            // Check if there are more pages
            hasMore = orders.length === limit;
            offset += limit;
        } catch (error) {
            console.error('Error fetching orders:', error);
            break;
        }
    }

    console.log(`Total orders fetched: ${allOrders.length}`);
    return allOrders;
}

// Function to fetch subscriber profile
async function fetchSubscriberProfile(memberId) {
    try {
        const cachedProfile = cache.get(memberId);
        if (cachedProfile) {
            return cachedProfile;
        }

        const response = await axios.get(`https://www.wixapis.com/members/v1/members/${memberId}?fieldsets=FULL`, {
            headers: {
                'Authorization': `Bearer ${process.env.WIX_API_KEY}`,
                'wix-account-id': process.env.WIX_ACCOUNT_ID,
                'wix-site-id': process.env.WIX_SITE_ID
            }
        });

        const profileData = response.data;
        cache.set(memberId, profileData); // Cache the profile data
        const telegramUsername = extractTelegramUsername(profileData);
        
        // Export profile data including Telegram username
        // exportResponseToFile({ ...profileData, telegramUsername }, `profile_${memberId}`);
        
        return profileData;
    } catch (error) {
        console.error(`Error fetching profile for memberId ${memberId}:`, error);
        return null;
    }
}

function extractTelegramUsername(profile) {
    let username = profile.member.contact.customFields?.['custom.telegram-username']?.value || 'Unknown';
    if (username !== 'Unknown' && !username.startsWith('@')) {
        username = `@${username}`;
    }
    console.log(`Extracted username: ${username}`);
    return username;
}

// Load user data from a file
let userDatabase = {};
try {
    userDatabase = JSON.parse(fs.readFileSync('userDatabase.json', 'utf8'));
    console.log('User database loaded successfully.');
} catch (error) {
    console.log('No existing user database found, starting fresh.');
}

// Middleware to register users automatically
bot.use((ctx, next) => {
    if (ctx.from) {
        const userId = ctx.from.id;
        const username = ctx.from.username || 'Unknown';
        if (!userDatabase[username]) {
            userDatabase[username] = userId;
            console.log(`User automatically registered: ${username} with ID: ${userId}`);
        }
    } else {
        console.log('ctx.from is undefined');
    }
    return next();
});

bot.command('testid', (ctx) => {
    const username = ctx.from.username || 'Unknown';
    const userId = userDatabase[username] || null;
    if (userId) {
        ctx.reply(`Your user ID is ${userId}.`);
    } else {
        ctx.reply(`User ID not found for ${username}.`);
    }
});

// Function to get Telegram user ID based on username
async function getTelegramUserId(username) {
    const userId = userDatabase[username] || null;
    if (userId) {
        console.log(`Successfully fetched user ID for ${username}: ${userId}`);
    } else {
        console.log(`User ID not found for ${username}`);
    }
    return userId;
}

// Function to check if a user has an active subscription
async function hasActiveSubscription(username) {
    try {
        const auth = await authorize();
        const sheets = google.sheets({ version: 'v4', auth });

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: 'Φύλλο1!A2:G',
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('No data found in the sheet.');
            return false;
        }

        let activeEntry = null;

        // Normalize the input username to include '@'
        const normalizedUsername = username.startsWith('@') ? username : `@${username}`;

        for (const row of rows) {
            const sheetUsername = row[1]?.trim();
            const status = row[3]?.trim();
            const planEndDate = new Date(row[5]?.trim());

            console.log(`Checking username: ${sheetUsername}, status: ${status}`);

            if (sheetUsername && sheetUsername.toLowerCase() === normalizedUsername.toLowerCase()) {
                if (status === 'ACTIVE') {
                    if (!activeEntry || planEndDate > new Date(activeEntry.planEndDate)) {
                        activeEntry = { status, planEndDate };
                    }
                }
            }
        }

        return activeEntry !== null;
    } catch (error) {
        console.error('Error checking subscription:', error);
        return false;
    }
}

// Ensure webhook is deleted before starting polling
bot.telegram.deleteWebhook().then(() => {
    bot.launch()
        .then(() => {
            console.log('Bot started successfully in polling mode');
        })
        .catch((error) => {
            console.error('Error starting bot:', error);
        });
});

// Start command with image and buttons
bot.start((ctx) => {
    console.log('Start command received');
    ctx.replyWithPhoto(
        { url: 'https://static.wixstatic.com/media/nsplsh_6d7a774d4246554f454351~mv2_d_3437_2071_s_2.jpg/v1/fill/w_1861,h_721,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/nsplsh_6d7a774d4246554f454351~mv2_d_3437_2071_s_2.jpg' }, // Replace with your image URL
        {
            caption: 'Καλώς ήρθατε! Πατήστε το κουμπί παρακάτω για να γίνετε μέλος του καναλιού.',
            ...Markup.inlineKeyboard([ 
                Markup.button.callback('Γίνετε μέλος του καναλιού', 'join_channel')
            ])
        }
    );
});

// Handle button press
bot.action('join_channel', async (ctx) => {
    try {
        const username = ctx.from.username || 'Unknown';
        const hasSubscription = await hasActiveSubscription(username);

        if (!hasSubscription) {
            await ctx.reply('Λυπούμαστε, αλλά δεν έχετε ενεργή συνδρομή.');
            return;
        }

        const inviteLink = await generateChannelInviteLink(ctx);
        if (inviteLink) {
            await ctx.reply(`Here's your invite link: ${inviteLink}\nThis link will expire in 1 hour.`);
        } else {
            await ctx.reply('Sorry, there was an error generating the invite link. Please try again later.');
        }
    } catch (error) {
        console.error('Error processing join request:', error);
        await ctx.reply('Sorry, there was an error processing your request. Please try again later.');
    }
});

// Function to generate a new invite link
async function generateChannelInviteLink(ctx) {
    try {
        const username = ctx.from.username || 'Unknown';
        const hasSubscription = await hasActiveSubscription(username);

        if (!hasSubscription) {
            await ctx.reply('Λυπούμαστε, αλλά δεν έχετε ενεργή συνδρομή.');
            return null;
        }

        const link = await bot.telegram.createChatInviteLink(process.env.TELEGRAM_CHANNEL_ID, {
            member_limit: 1,
            expires_in: 30 // Link expires in 30 seconds
        });
        console.log('Invite link:', link.invite_link);
        await ctx.reply(`Ορίστε ο σύνδεσμος πρόσκλησής σας: ${link.invite_link}\nΑυτός ο σύνδεσμος θα λήξει σε 30 δευτερόλεπτα.`);
        return link.invite_link;
    } catch (error) {
        console.error('Error generating invite link:', error);
        await ctx.reply('Συγγνώμη, υπήρξε σφάλμα κατά τη δημιουργία του συνδέσμου πρόσκλησης.');
        return null;
    }
}

// Main function to get Telegram usernames from orders and update the sheet
async function getTelegramUsernamesFromOrders() {
    try {
        console.log('Fetching all orders...');
        const orders = await fetchAllOrders();

        console.log('Total orders fetched:', orders.length);

        // Filter active subscriptions
        const activeOrders = orders.filter(order => order.status === 'ACTIVE');
        console.log(`Active orders: ${activeOrders.length}`);

        // Process orders and prepare data for the sheet
        const telegramUsernames = await Promise.all(activeOrders.map(async order => {
            const memberId = order.buyer.memberId;
            const profile = await fetchSubscriberProfile(memberId);
            const telegramUsername = extractTelegramUsername(profile);
            const email = profile.member.loginEmail;
            const planEndDate = order.currentCycle?.endedDate || 'N/A';
            const telegramId = await getTelegramUserId(telegramUsername);

            // Log missing user IDs for future updates
            if (!userDatabase[telegramUsername]) {
                console.log(`User ID not found for ${telegramUsername}`);
            }

            return [
                memberId,
                telegramUsername,
                order.planName,
                order.status,
                email,
                planEndDate,
                telegramId || 'Unknown'
            ];
        }));

        console.log('Updating Google Sheet...');
        await updateSheet(telegramUsernames);

        console.log('Process completed successfully.');
    } catch (error) {
        console.error('Error processing orders:', error);
    }
}

// Run the initial scan
getTelegramUsernamesFromOrders().catch(console.error);

// Schedule the task to run every 24 hours
cron.schedule('0 0 * * *', () => {
    console.log('Running scheduled task...');
    getTelegramUsernamesFromOrders().catch(console.error);
});

// Define your bot commands and middleware here
bot.command('start', (ctx) => ctx.reply('Hello!'));

bot.command('check_members', async (ctx) => {
    try {
        await checkAndUpdateGroupMemberships();
        ctx.reply('Group membership check completed.');
    } catch (error) {
        ctx.reply('Error checking group memberships.');
        console.error(error);
    }
});

async function testInviteLink() {
    try {
        const link = await bot.telegram.createChatInviteLink(process.env.TELEGRAM_CHANNEL_ID, {
            member_limit: 1,
            expires_in: 3600
        });
        console.log('Invite link:', link.invite_link);
    } catch (error) {
        console.error('Error generating invite link:', error);
    }
}

testInviteLink();

// Example command to generate invite link
bot.command('get_invite', (ctx) => {
    generateChannelInviteLink(ctx);
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchAllOrdersAndUpdateSheet() {
    let allOrders = [];
    let hasMore = true;
    let page = 0;
    const pageSize = 50;
    const batchData = [];

    while (hasMore) {
        try {
            console.log(`Fetching page ${page}...`);
            const response = await axios.get('https://www.wixapis.com/pricing-plans/v2/orders', {
                headers: {
                    'Authorization': `Bearer ${process.env.WIX_API_KEY}`,
                    'wix-account-id': process.env.WIX_ACCOUNT_ID,
                    'wix-site-id': process.env.WIX_SITE_ID
                },
                params: {
                    page,
                    pageSize
                }
            });

            const orders = response.data.orders || [];
            console.log(`Fetched ${orders.length} orders from page ${page}.`);
            allOrders = allOrders.concat(orders);

            for (const order of orders) {
                const memberId = order.buyer?.memberId;
                if (!memberId) {
                    console.log('Order missing memberId');
                    continue;
                }

                const profile = await fetchSubscriberProfile(memberId);
                if (!profile) {
                    continue;
                }

                const telegramUsername = extractTelegramUsername(profile) || 'Unknown';
                const email = profile.member?.loginEmail || 'Unknown';
                const planEndDate = order.currentCycle?.endedDate || 'N/A';
                const status = order.status || 'Unknown';
                const telegramId = await getTelegramUserId(telegramUsername);

                console.log(`Processing order for ${telegramUsername}: Status - ${status}`);

                batchData.push([
                    memberId,
                    telegramUsername,
                    order.planName,
                    status,
                    email,
                    planEndDate,
                    telegramId || 'Unknown'
                ]);
            }

            hasMore = orders.length === pageSize;
            page += 1;

            // Delay to avoid hitting rate limits
            await delay(1000);
        } catch (error) {
            console.error('Error fetching orders:', error);
            break;
        }
    }

    console.log(`Total orders fetched: ${allOrders.length}`);
    console.log('Batch data to update:', batchData);

    // Update the sheet in a single batch
    try {
        await updateSheet(batchData);
    } catch (error) {
        console.error('Error updating sheet:', error);
    }
}

// Schedule the task to run every 24 hours
cron.schedule('0 0 * * *', () => {
    console.log('Running scheduled task...');
    fetchAllOrdersAndUpdateSheet().catch(console.error);
});

// Run the initial scan
fetchAllOrdersAndUpdateSheet().catch(console.error);

async function checkAndUpdateGroupMemberships() {
    try {
        const auth = await authorize();
        const sheets = google.sheets({ version: 'v4', auth });

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: 'Φύλλο1!A2:G',
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('No data found in the sheet.');
            return;
        }

        for (const row of rows) {
            const telegramUsername = row[1]?.trim();
            const status = row[3]?.trim();

            if (telegramUsername && status !== 'ACTIVE') {
                const telegramId = await getTelegramUserId(telegramUsername);
                if (telegramId) {
                    try {
                        await bot.telegram.kickChatMember(process.env.TELEGRAM_CHANNEL_ID, telegramId);
                        console.log(`Kicked user: ${telegramUsername}`);
                    } catch (error) {
                        console.error(`Error kicking user ${telegramUsername}:`, error);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error checking and updating group memberships:', error);
    }
}

function updateUserCache(memberId, data) {
    userCache[memberId] = data;
}

function getUserFromCache(memberId) {
    return userCache[memberId];
}

// Function to fetch and update Telegram usernames
async function fetchAndUpdateUsernames() {
    try {
        console.log('Checking for updated Telegram usernames...');
        const response = await axios.get('https://www.wixapis.com/pricing-plans/v2/orders', {
            headers: {
                'Authorization': `Bearer ${process.env.WIX_API_KEY}`,
                'wix-account-id': process.env.WIX_ACCOUNT_ID,
                'wix-site-id': process.env.WIX_SITE_ID
            }
        });

        const orders = response.data.orders || [];
        for (const order of orders) {
            const memberId = order.buyer?.memberId;
            if (!memberId) continue;

            const profile = await fetchSubscriberProfile(memberId);
            if (!profile) continue;

            const newTelegramUsername = extractTelegramUsername(profile);
            if (newTelegramUsername) {
                // Update Google Sheets
                await updateSheetWithNewUsername(memberId, newTelegramUsername);

                // Update bot cache
                updateUserCache(memberId, { telegramUsername: newTelegramUsername });
            }
        }
    } catch (error) {
        console.error('Error fetching or updating usernames:', error);
    }
}

// Schedule the task to run every hour
cron.schedule('0 * * * *', fetchAndUpdateUsernames);

// Function to fetch all orders and update the bot and sheets
async function fetchAllOrdersAndUpdate() {
    try {
        console.log('Fetching orders from Wix...');
        const response = await axios.get('https://www.wixapis.com/pricing-plans/v2/orders', {
            headers: {
                'Authorization': `Bearer ${process.env.WIX_API_KEY}`,
                'wix-account-id': process.env.WIX_ACCOUNT_ID,
                'wix-site-id': process.env.WIX_SITE_ID
            }
        });

        const orders = response.data.orders || [];
        for (const order of orders) {
            const memberId = order.buyer?.memberId;
            if (!memberId) continue;

            const profile = await fetchSubscriberProfile(memberId);
            if (!profile) continue;

            const newTelegramUsername = extractTelegramUsername(profile);
            if (newTelegramUsername) {
                // Update Google Sheets
                await updateSheetWithNewUsername(memberId, newTelegramUsername);

                // Update bot cache
                updateUserCache(memberId, { telegramUsername: newTelegramUsername });
            }
        }
    } catch (error) {
        console.error('Error fetching or updating orders:', error);
    }
}

// Schedule the task to run every hour
cron.schedule('0 * * * *', fetchAllOrdersAndUpdate);
