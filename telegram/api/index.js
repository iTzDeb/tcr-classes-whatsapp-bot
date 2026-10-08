const { google } = require('googleapis');
const https = require('https');

// Configuration Constants
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AUTHORIZED_CHAT_ID = process.env.AUTHORIZED_CHAT_ID;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const DEFAULT_SHEET_TAB = 'Schedule';
const crypto = require('crypto');
const TELEGRAM_COMMANDS = [
  { command: 'start', description: 'Open the bot help menu' },
  { command: 'help', description: 'Show available commands and examples' },
  { command: 'check', description: 'Check pending classes and bot access' },
  { command: 'list', description: 'View or search the class schedule' },
  { command: 'create', description: 'Add a class to the schedule' },
  { command: 'update', description: 'Update a schedule row' },
  { command: 'delete', description: 'Delete a class and its linked event' },
  { command: 'reauth', description: 'Manually trigger WhatsApp re-authentication' }
];

function getMissingConfiguration(env = process.env) {
  return [
    'TELEGRAM_BOT_TOKEN',
    'AUTHORIZED_CHAT_ID',
    'SPREADSHEET_ID',
    'GOOGLE_SERVICE_ACCOUNT_KEY',
    'TELEGRAM_WEBHOOK_SECRET'
  ].filter(name => !env[name] || !env[name].trim());
}

function isValidWebhookSecret(suppliedSecret, expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET || TELEGRAM_WEBHOOK_SECRET) {
  if (typeof suppliedSecret !== 'string' || !expectedSecret) return false;

  const supplied = Buffer.from(suppliedSecret);
  const expected = Buffer.from(expectedSecret);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function hasCompleteScheduleDetails(details) {
  return ['date', 'time', 'center', 'course', 'subject', 'faculty']
    .every(field => String(details[field] || '').trim().length > 0);
}

// --- Utility & Date Parsing Helpers (Defined at Top Level) ---

function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/\bseptember\b|\bsept\b/g, 'sep')
    .replace(/\boctober\b/g, 'oct')
    .replace(/\bjanuary\b/g, 'jan')
    .replace(/\bfebruary\b/g, 'feb')
    .replace(/\bmarch\b/g, 'mar')
    .replace(/\bapril\b/g, 'apr')
    .replace(/\bjune\b/g, 'jun')
    .replace(/\bjuly\b/g, 'jul')
    .replace(/\baugust\b/g, 'aug')
    .replace(/\bnovember\b/g, 'nov')
    .replace(/\bdecember\b/g, 'dec')
    // Strip leading zeros from day numbers / numeric tokens (e.g., "01" -> "1", "06" -> "6")
    .replace(/\b0([1-9])\b/g, '$1');
}

function matchesFilter(dateStr, fullRowText, filterText) {
  const normDate = normalizeText(dateStr);
  const normFilter = normalizeText(filterText);
  if (!normFilter) return true;

  const tokens = normFilter.split(/\s+/).filter(Boolean);
  const monthTokens = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const hasMonthToken = tokens.some(t => monthTokens.includes(t));

  // If filter contains month name (e.g. "oct"), match date strictly against dateStr
  if (hasMonthToken) {
    return tokens.every(token => {
      const escaped = token.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp('\\b' + escaped + '\\b', 'i');
      return regex.test(normDate);
    });
  }

  // General query (e.g. "Laxmi Nagar" or "CLAT")
  const normRow = normalizeText(fullRowText);
  if (normRow.includes(normFilter)) return true;

  return tokens.every(token => {
    const escaped = token.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    if (/^[a-z0-9]+$/i.test(token)) {
      const regex = new RegExp('\\b' + escaped + '\\b', 'i');
      return regex.test(normRow);
    }
    return normRow.includes(token);
  });
}

function parseDateStrToVal(dateStr) {
  if (!dateStr) return 0;
  // Clean string and strip ordinal suffixes like 1st, 2nd, 3rd, 4th
  const str = String(dateStr).trim().toLowerCase().replace(/(\d+)(st|nd|rd|th)/g, '$1');
  const months = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11
  };

  const defaultYear = new Date().getFullYear();

  // Pattern 1: "06 Sept 2026", "6 Oct", "1 Oct 2026"
  const dayMonthMatch = str.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{2,4}))?$/i);
  if (dayMonthMatch) {
    const day = parseInt(dayMonthMatch[1], 10);
    const mStr = dayMonthMatch[2].toLowerCase();
    let year = dayMonthMatch[3] ? parseInt(dayMonthMatch[3], 10) : defaultYear;
    if (year < 100) year += 2000;
    if (months[mStr] !== undefined) {
      return new Date(Date.UTC(year, months[mStr], day)).getTime();
    }
  }

  // Pattern 2: "Sept 06 2026", "Oct 6"
  const monthDayMatch = str.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{2,4}))?$/i);
  if (monthDayMatch) {
    const mStr = monthDayMatch[1].toLowerCase();
    const day = parseInt(monthDayMatch[2], 10);
    let year = monthDayMatch[3] ? parseInt(monthDayMatch[3], 10) : defaultYear;
    if (year < 100) year += 2000;
    if (months[mStr] !== undefined) {
      return new Date(Date.UTC(year, months[mStr], day)).getTime();
    }
  }

  // Pattern 3: Slash / Dash / Dot formats like "01/10/2026", "06/09", "2026-10-01"
  const parts = str.split(/[\/\-\.]/);
  if (parts.length >= 2) {
    if (parts[0].length === 4) {
      // YYYY-MM-DD
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      return new Date(Date.UTC(year, month, day)).getTime();
    } else {
      // DD/MM/YYYY or DD/MM
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      let year = parts[2] ? parseInt(parts[2], 10) : defaultYear;
      if (year < 100) year += 2000;
      if (!isNaN(day) && !isNaN(month)) {
        return new Date(Date.UTC(year, month, day)).getTime();
      }
    }
  }

  const d = new Date(str);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function parseStartTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const str = String(timeStr).trim().toLowerCase();
  const match = str.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  let ampm = match[3] ? match[3].toLowerCase() : null;

  if (!ampm) {
    if (str.includes('pm')) ampm = 'pm';
    else if (str.includes('am')) ampm = 'am';
  }

  if (minutes > 59) return null;
  if (ampm) {
    if (hours < 1 || hours > 12) return null;
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
  } else if (hours > 23) {
    return null;
  }

  return hours * 60 + minutes;
}

function createCalendarStartDate(dateStr, timeStr) {
  const dateValue = parseDateStrToVal(dateStr);
  const startMinutes = parseStartTimeToMinutes(timeStr);
  if (!dateValue || startMinutes === null) return null;

  const istOffsetMinutes = 5 * 60 + 30;
  return new Date(dateValue + (startMinutes - istOffsetMinutes) * 60 * 1000);
}

async function writeScheduleRow(sheets, sheetDetails, targetRowIndex, rowValues) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        insertDimension: {
          range: {
            sheetId: sheetDetails.sheetId,
            dimension: 'ROWS',
            startIndex: targetRowIndex - 1,
            endIndex: targetRowIndex
          },
          inheritFromBefore: true
        }
      }]
    }
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetDetails.title}'!A${targetRowIndex}:H${targetRowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowValues] }
  });
}

function findInsertionRowIndex(existingRows, newDateVal, newTimeVal) {
  if (!newDateVal) return existingRows.length + 1; // Append at end if date unparseable

  for (let i = 1; i < existingRows.length; i++) {
    const row = existingRows[i];
    const rDateStr = String(row[0] || '').trim();
    if (!rDateStr) continue;

    const rDateVal = parseDateStrToVal(rDateStr);
    if (!rDateVal) continue;

    const rTimeVal = parseStartTimeToMinutes(String(row[1] || ''));

    if (rDateVal > newDateVal) {
      return i + 1; // 1-based row index for Google Sheets
    } else if (rDateVal === newDateVal && rTimeVal > newTimeVal) {
      return i + 1;
    }
  }

  return existingRows.length + 1; // Append at end if after all existing dates
}

function createScheduleRowValues({ date, time, center, course, subject, faculty }, calendarEventId = '') {
  return [date, time, center, course, subject, faculty, '', calendarEventId];
}

function parseCreateArgs(argsStr) {
  if (!argsStr) return null;

  // 1. Pipe separated
  if (argsStr.includes('|')) {
    const parts = argsStr.split('|').map(s => s.trim());
    if (parts.length >= 6) {
      return {
        date: parts[0],
        time: parts[1],
        center: parts[2],
        course: parts[3],
        subject: parts[4],
        faculty: parts[5]
      };
    }
  }

  // 2. Multi-line (newlines)
  if (argsStr.includes('\n')) {
    const lines = argsStr.split('\n').map(s => s.trim()).filter(Boolean);

    // Check Key-Value syntax (e.g. "Date: 06 Sept 2026")
    const kv = {};
    lines.forEach(line => {
      const idx = line.indexOf(':');
      if (idx !== -1) {
        const key = line.substring(0, idx).trim().toLowerCase();
        const val = line.substring(idx + 1).trim();
        kv[key] = val;
      }
    });

    if (kv.date || kv.time || kv.center || kv.course || kv.subject || kv.faculty) {
      return {
        date: kv.date || kv.dt || '',
        time: kv.time || kv.tm || '',
        center: kv.center || kv.centre || kv.loc || kv.location || '',
        course: kv.course || kv.batch || '',
        subject: kv.subject || kv.sub || '',
        faculty: kv.faculty || kv.teacher || kv.sir || kv.maam || ''
      };
    }

    if (lines.length >= 6) {
      return {
        date: lines[0],
        time: lines[1],
        center: lines[2],
        course: lines[3],
        subject: lines[4],
        faculty: lines[5]
      };
    }
  }

  // 3. Comma separated
  if (argsStr.includes(',')) {
    const parts = argsStr.split(',').map(s => s.trim());
    if (parts.length >= 6) {
      return {
        date: parts[0],
        time: parts[1],
        center: parts[2],
        course: parts[3],
        subject: parts[4],
        faculty: parts[5]
      };
    }
  }

  return null;
}

// Helper to authenticate with Google Auth (Sheets & Calendar)
function getGoogleAuth() {
  let auth;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    let rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY.trim();

    // Step 1: Base64 decode if passed as base64 string
    if (!rawKey.startsWith('{') && !rawKey.startsWith('"') && !rawKey.startsWith("'")) {
      try {
        const decoded = Buffer.from(rawKey, 'base64').toString('utf8');
        if (decoded.includes('{')) {
          rawKey = decoded.trim();
        }
      } catch (e) {
        console.error('Base64 decode attempt failed:', e.message);
      }
    }

    // Step 2: Strip surrounding quotes if present
    if ((rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))) {
      rawKey = rawKey.substring(1, rawKey.length - 1).trim();
    }

    // Step 3: Extract valid JSON substring from first '{' to last '}'
    const firstBrace = rawKey.indexOf('{');
    const lastBrace = rawKey.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      rawKey = rawKey.substring(firstBrace, lastBrace + 1);
    }

    // Step 4: Parse JSON
    let credentials = JSON.parse(rawKey);

    // Step 5: Format newlines in private_key
    if (credentials.private_key && typeof credentials.private_key === 'string') {
      credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    }

    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/calendar'
      ]
    });
  } else {
    auth = new google.auth.GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/calendar'
      ]
    });
  }
  return auth;
}

function getSheetsClient() {
  const auth = getGoogleAuth();
  return google.sheets({ version: 'v4', auth });
}

function getCalendarClient() {
  const auth = getGoogleAuth();
  return google.calendar({ version: 'v3', auth });
}

function isGoogleNotFoundError(error) {
  return error.code === 404 || error.response?.status === 404;
}

async function deleteCalendarEvent(calendar, calendarId, storedEventId) {
  if (!storedEventId) return 'not-linked';

  try {
    await calendar.events.get({ calendarId, eventId: storedEventId });
    await calendar.events.delete({ calendarId, eventId: storedEventId });
    return 'deleted';
  } catch (error) {
    if (!isGoogleNotFoundError(error)) throw error;
  }

  const matchingEvents = await calendar.events.list({
    calendarId,
    iCalUID: storedEventId,
    maxResults: 2
  });
  const events = matchingEvents.data.items || [];

  if (events.length > 1) {
    throw new Error('More than one Calendar event matches the identifier in column H. No event or row was deleted.');
  }

  const eventId = events.length === 1 ? events[0].id : null;
  if (!eventId) return 'not-found';

  try {
    await calendar.events.delete({ calendarId, eventId });
    return 'deleted';
  } catch (error) {
    if (isGoogleNotFoundError(error)) return 'not-found';
    throw error;
  }
}

async function deleteScheduleRow(sheets, calendar, sheetDetails, rowNum, calendarId) {
  const rowResponse = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetDetails.title}'!A${rowNum}:H${rowNum}`
  });
  const rowValues = rowResponse.data.values?.[0] || [];
  if (!rowValues.some(value => String(value || '').trim())) {
    throw new Error(`Schedule row ${rowNum} is empty. Nothing was deleted.`);
  }

  let calendarDeleteResult = 'not-linked';
  const storedEventId = String(rowValues[7] || '').trim();
  if (storedEventId) {
    try {
      calendarDeleteResult = await deleteCalendarEvent(calendar, calendarId, storedEventId);
    } catch (error) {
      error.userMessage = `Calendar deletion failed, so schedule row ${rowNum} was kept. Check Calendar access and the event identifier in column H, then retry.`;
      throw error;
    }
  }

  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId: sheetDetails.sheetId,
              dimension: 'ROWS',
              startIndex: rowNum - 1,
              endIndex: rowNum
            }
          }
        }]
      }
    });
  } catch (error) {
    error.userMessage = calendarDeleteResult === 'deleted'
      ? `The Calendar event was deleted, but schedule row ${rowNum} could not be removed. The row remains; remove it manually after checking the event is gone.`
      : `Schedule row ${rowNum} could not be removed. Check Google Sheets access and retry.`;
    throw error;
  }

  return calendarDeleteResult;
}

// Function to automatically sync class to Google Calendar
async function createCalendarEvent({ dateStr, timeStr, center, course, subject, faculty }) {
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  const calendar = getCalendarClient();
  const startDate = createCalendarStartDate(dateStr, timeStr);
  if (!startDate) return null;

  // Default duration 2 hours
  const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000);

  const summary = `${course} - ${subject} (${faculty}) @ ${center}`;
  const description = `Class Schedule: ${course} - ${subject}\nFaculty: ${faculty}\nCenter: ${center}\nTime: ${timeStr}`;

  const res = await calendar.events.insert({
    calendarId: calendarId,
    requestBody: {
      summary: summary,
      location: center,
      description: description,
      start: {
        dateTime: startDate.toISOString(),
      },
      end: {
        dateTime: endDate.toISOString(),
      },
    },
  });

  return res.data;
}

// Dynamically resolve target sheet tab name and sheet ID
async function resolveSheetDetails(sheets) {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetList = spreadsheet.data.sheets || [];

  // Match 'Schedule' or fall back to the first sheet tab.
  const matchedSheet = sheetList.find(s => s.properties.title.trim().toLowerCase() === DEFAULT_SHEET_TAB.toLowerCase()) || sheetList[0];
  if (!matchedSheet || !matchedSheet.properties || !Number.isInteger(matchedSheet.properties.sheetId)) {
    throw new Error('The spreadsheet does not contain a usable sheet tab.');
  }

  return {
    title: matchedSheet.properties.title,
    sheetId: matchedSheet.properties.sheetId
  };
}

// Telegram Message Sender Helper
function sendTelegramMessage(chatId, text, parseMode = 'Markdown') {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: parseMode
    });

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let response;
        try {
          response = JSON.parse(body);
        } catch {
          reject(new Error('Telegram API returned an invalid response.'));
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300 || response.ok !== true) {
          reject(new Error(`Telegram API request failed: ${response.description || res.statusCode}`));
          return;
        }

        resolve(response.result);
      });
    });

    req.on('error', (e) => reject(e));
    req.setTimeout(10000, () => req.destroy(new Error('Telegram API request timed out.')));
    req.write(data);
    req.end();
  });
}

function setTelegramCommandMenu() {
  const data = JSON.stringify({ commands: TELEGRAM_COMMANDS });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TELEGRAM_BOT_TOKEN}/setMyCommands`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, response => {
      let body = '';
      response.on('data', chunk => body += chunk);
      response.on('end', () => {
        let result;
        try {
          result = JSON.parse(body);
        } catch {
          reject(new Error('Telegram returned an invalid response while setting the command menu.'));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300 || result.ok !== true) {
          reject(new Error(`Telegram command menu setup failed: ${result.description || response.statusCode}`));
          return;
        }
        resolve(result.result);
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Telegram command menu setup timed out.')));
    req.write(data);
    req.end();
  });
}

function getSafeErrorDetails(error) {
  const status = error.code || error.response?.status;
  const message = String(error.message || 'Unknown error').replace(/[\r\n`]/g, ' ').slice(0, 240);
  const safeMessage = message.replace(/([_*[\]()])/g, '\\$1');
  return status ? `${safeMessage} (code ${status})` : safeMessage;
}

function isAuthorized(chatId, userId) {
  const strChatId = String(chatId);
  const strUserId = String(userId || '');
  return strChatId === String(AUTHORIZED_CHAT_ID) || strUserId === String(AUTHORIZED_CHAT_ID);
}

// Vercel Serverless Entry Point
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).send('TCR Telegram Bot Webhook API is running.');
    return;
  }

  const missingConfiguration = getMissingConfiguration();
  if (missingConfiguration.length > 0) {
    res.status(500).json({
      ok: false,
      error: 'Bot configuration is incomplete.',
      missingEnvironmentVariables: missingConfiguration
    });
    return;
  }

  if (!isValidWebhookSecret(req.headers?.['x-telegram-bot-api-secret-token'])) {
    res.status(401).json({ ok: false, error: 'Invalid Telegram webhook secret.' });
    return;
  }

  try {
    const payload = req.body || {};

    if (payload.message && payload.message.text) {
      const message = payload.message;
      const text = message.text.trim();
      const chatId = message.chat.id;
      const userId = message.from ? message.from.id : null;

      // Access Authorization Check
      if (!isAuthorized(chatId, userId)) {
        await sendTelegramMessage(chatId, `🚫 *Access Denied.* Your Chat ID (\`${chatId}\`) is not authorized to interact with this bot.`);
        res.status(200).json({ ok: true });
        return;
      }

      await handleTelegramCommand(chatId, text);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Webhook Handler Error:', err);
    res.status(200).json({ ok: true });
  }
};

// Slash Command Routing Logic
async function handleTelegramCommand(chatId, text) {
  const parts = text.split(/\s+/);
  const command = parts[0].toLowerCase();
  const argsStr = text.substring(parts[0].length).trim();

  if (command === '/start' || command === '/help') {
    const helpMsg =
      `🤖 *TCR Class Scheduler Bot*\n\n` +
      `Here are the available commands:\n\n` +
      `📌 */list* _[date or filter]_\n` +
      `View schedule. Examples:\n` +
      `• \`/list\` - List all upcoming classes\n` +
      `• \`/list 4 Oct 2026\` - List classes for date\n` +
      `• \`/list Laxmi Nagar\` - List classes by center\n\n` +
      `📌 */create* _Class Details_\n` +
      `Add a new class row chronologically. Flexible formats supported:\n\n` +
      `• *Comma / Pipe / Newline:* \n` +
      `  \`/create 06 Sept 2026, 4:00 - 6:00PM, Laxmi Nagar, CLAT, Legal, Shivam Sir\`\n\n` +
      `• *Key-Value:* \n` +
      `  \`/create\`\n` +
      `  \`Date: 06 Sept 2026\`\n` +
      `  \`Time: 4:00 - 6:00PM\`\n` +
      `  \`Center: Laxmi Nagar\`\n` +
      `  \`Course: CLAT\`\n` +
      `  \`Subject: Legal\`\n` +
      `  \`Faculty: Shivam Sir\`\n\n` +
      `📌 */update* _RowNumber Field NewValue_\n` +
      `Update row. Example: \`/update 15 Time 5:00 - 7:00PM\`\n\n` +
      `📌 */delete* _RowNumber_\n` +
      `Delete row. Example: \`/delete 15\`\n\n` +
      `📌 */check*\n` +
      `Check bot online status and pending dispatches.\n\n` +
      `📌 */reauth*\n` +
      `Manually trigger WhatsApp re-authentication. Use this if you logged out WhatsApp or need to reconnect.\n\n` +
      `🗑️ When you use */delete*, the bot also deletes the linked Calendar event stored in column H. Deleting a row directly in Sheets does not trigger this cleanup.`;

    try {
      await setTelegramCommandMenu();
    } catch (error) {
      const referenceId = crypto.randomUUID();
      console.error('Telegram command menu setup error:', { referenceId, message: error.message });
      await sendTelegramMessage(chatId, `⚠️ The help text is available, but Telegram could not refresh its command menu. Try /help again later. Reference: \`${referenceId}\``);
    }
    await sendTelegramMessage(chatId, helpMsg);
    return;
  }

  try {
    if (command === '/check') {
      const sheets = getSheetsClient();
      const sheetDetails = await resolveSheetDetails(sheets);
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetDetails.title}'!A1:G`
      });

      const rows = response.data.values || [];
      let pendingCount = 0;

      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0] && String(rows[i][6] || '').trim() !== 'SENT') {
          pendingCount++;
        }
      }

      const msg = `📊 *TCR Class Scheduler Bot*\n\n*System is online.* There are *${pendingCount}* pending classes in tab \`${sheetDetails.title}\` waiting for dispatch.`;
      await sendTelegramMessage(chatId, msg);
      return;
    }

    if (command === '/list') {
      await handleListCommand(chatId, argsStr);
      return;
    }

    if (command === '/create' || command === '/add') {
      await handleCreateCommand(chatId, argsStr);
      return;
    }

    if (command === '/update') {
      await handleUpdateCommand(chatId, argsStr);
      return;
    }

    if (command === '/delete') {
      await handleDeleteCommand(chatId, argsStr);
      return;
    }

    if (command === '/reauth') {
      await handleReauthCommand(chatId);
      return;
    }

    await sendTelegramMessage(chatId, `⚠️ Unknown command. Type /help to see all available commands.`);
  } catch (err) {
    const referenceId = crypto.randomUUID();
    console.error('Command Execution Error:', {
      referenceId,
      command,
      message: err.message,
      code: err.code || err.response?.status
    });
    const report = err.userMessage || `The command failed: ${getSafeErrorDetails(err)}.`;
    await sendTelegramMessage(chatId, `⚠️ ${report}\nReference: \`${referenceId}\``);
  }
}

async function handleListCommand(chatId, filterText) {
  const sheets = getSheetsClient();
  const sheetDetails = await resolveSheetDetails(sheets);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetDetails.title}'!A1:G`
  });

  const rows = response.data.values || [];
  if (rows.length <= 1) {
    await sendTelegramMessage(chatId, `📅 No classes found in the schedule.`);
    return;
  }

  const matchingRows = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const dateStr = String(row[0] || '').trim();
    if (!dateStr) continue;

    const timeStr = String(row[1] || '').trim();
    const centerStr = String(row[2] || '').trim();
    const courseStr = String(row[3] || '').trim();
    const subjectStr = String(row[4] || '').trim();
    const facultyStr = String(row[5] || '').trim();
    const statusStr = String(row[6] || '').trim();

    const fullRowText = `${dateStr} ${timeStr} ${centerStr} ${courseStr} ${subjectStr} ${facultyStr} ${statusStr}`;

    if (!filterText || matchesFilter(dateStr, fullRowText, filterText)) {
      matchingRows.push({
        rowNum: i + 1,
        date: dateStr,
        time: timeStr,
        center: centerStr,
        course: courseStr,
        subject: subjectStr,
        faculty: facultyStr,
        status: statusStr
      });
    }
  }

  if (matchingRows.length === 0) {
    await sendTelegramMessage(chatId, `📅 No classes found matching filter: \`${filterText}\``);
    return;
  }

  let message = filterText ? `📅 *Classes matching "${filterText}"* (${matchingRows.length}):\n\n` : `📅 *Master Class Schedule* (${matchingRows.length} classes):\n\n`;

  matchingRows.forEach((item, index) => {
    const statusBadge = item.status === 'SENT' ? ' ✅ `SENT`' : '';
    message += `📍 *Row ${item.rowNum}* ${statusBadge}\n` +
               `🗓 *Date:* ${item.date}\n` +
               `⏰ *Time:* ${item.time}\n` +
               `🏛 *Center:* ${item.center}\n` +
               `📚 *Course:* ${item.course} | *Subject:* ${item.subject}\n` +
               `👨‍🏫 *Faculty:* ${item.faculty}\n`;

    if (index < matchingRows.length - 1) {
      message += `───────────────\n`;
    }
  });

  if (message.length > 4000) {
    message = message.substring(0, 3900) + `\n\n⚠️ _Output truncated due to length limits. Refine your query with /list <date> or /list <center>._`;
  }

  await sendTelegramMessage(chatId, message);
}

async function handleCreateCommand(chatId, argsStr) {
  const parsed = parseCreateArgs(argsStr);

  if (!hasCompleteScheduleDetails(parsed || {})) {
    const usageMsg =
      `⚠️ *How to create a class:* You can use commas, newlines, or key-value format!\n\n` +
      `*1. Natural / Comma Separated:* (easiest on mobile)\n` +
      `\`/create 06 Sept 2026, 4:00 - 6:00PM, Laxmi Nagar, CLAT, Legal, Shivam Sir\`\n\n` +
      `*2. Key-Value format:*\n` +
      `\`/create\`\n` +
      `\`Date: 06 Sept 2026\`\n` +
      `\`Time: 4:00 - 6:00PM\`\n` +
      `\`Center: Laxmi Nagar\`\n` +
      `\`Course: CLAT\`\n` +
      `\`Subject: Legal\`\n` +
      `\`Faculty: Shivam Sir\`\n\n` +
      `*3. Pipe Separated:*\n` +
      `\`/create 06 Sept 2026 | 4:00 - 6:00PM | Laxmi Nagar | CLAT | Legal | Shivam Sir\``;

    await sendTelegramMessage(chatId, usageMsg);
    return;
  }

  const { date: dateVal, time: timeVal, center: centerVal, course: courseVal, subject: subjectVal, faculty: facultyVal } = parsed;
  const startTimeMinutes = parseStartTimeToMinutes(timeVal);
  if (!parseDateStrToVal(dateVal) || startTimeMinutes === null) {
    await sendTelegramMessage(chatId, `⚠️ Invalid date or start time. Use a valid date and time, for example \`31 Dec 2026, 01:00PM - 03:00PM\`.`);
    return;
  }

  // 1. Sync to Google Calendar
  let calendarEventId = '';
  let calSyncText = '⏳ Pending';
  let calendarSyncFailure = '';
  try {
    const calResult = await createCalendarEvent({
      dateStr: dateVal,
      timeStr: timeVal,
      center: centerVal,
      course: courseVal,
      subject: subjectVal,
      faculty: facultyVal
    });

    if (calResult) {
      calendarEventId = calResult.iCalUID || '';
      calSyncText = '✅ Synced to Google Calendar';
    }
  } catch (err) {
    const referenceId = crypto.randomUUID();
    console.error('Calendar auto-sync error:', { referenceId, message: err.message, code: err.code || err.response?.status });
    calendarSyncFailure = `\n\n⚠️ Calendar event was not created. The schedule row was saved without a linked event. Reference: \`${referenceId}\``;
    calSyncText = '⚠️ Not synced';
  }

  const sheets = getSheetsClient();
  const sheetDetails = await resolveSheetDetails(sheets);

  // Read existing schedule rows to determine chronological insertion position
  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetDetails.title}'!A1:H`
  });

  const existingRows = readRes.data.values || [];
  const newDateVal = parseDateStrToVal(dateVal);
  const newTimeVal = parseStartTimeToMinutes(timeVal);

  const targetRowIndex = findInsertionRowIndex(existingRows, newDateVal, newTimeVal);
  await writeScheduleRow(
    sheets,
    sheetDetails,
    targetRowIndex,
    createScheduleRowValues(parsed, calendarEventId)
  );

  const confirmMsg =
    `✅ *Class Created Successfully! (Sorted Chronologically)*\n\n` +
    `📍 *Row:* ${targetRowIndex}\n` +
    `🗓 *Date:* ${dateVal}\n` +
    `⏰ *Time:* ${timeVal}\n` +
    `🏛 *Center:* ${centerVal}\n` +
    `📚 *Course:* ${courseVal} - ${subjectVal}\n` +
    `👨‍🏫 *Faculty:* ${facultyVal}\n` +
    `📅 *Calendar:* ${calSyncText}${calendarSyncFailure}`;

  await sendTelegramMessage(chatId, confirmMsg);
}

async function handleUpdateCommand(chatId, argsStr) {
  if (!argsStr) {
    await sendTelegramMessage(chatId, `⚠️ *Usage:* \`/update RowNumber Field NewValue\` OR \`/update RowNumber Date, Time, Center, Course, Subject, Faculty\`\n\n*Examples:*\n• \`/update 15 Time 5:00 - 7:00PM\`\n• \`/update 15 Faculty Anand Sir\``);
    return;
  }

  const spaceIndex = argsStr.indexOf(' ');
  if (spaceIndex === -1) {
    await sendTelegramMessage(chatId, `⚠️ Invalid syntax. Must specify row number followed by field and new value or row parameters.`);
    return;
  }

  const rowNumStr = argsStr.substring(0, spaceIndex).trim();
  const rowNum = parseInt(rowNumStr, 10);
  const restStr = argsStr.substring(spaceIndex).trim();

  const sheets = getSheetsClient();
  const sheetDetails = await resolveSheetDetails(sheets);

  if (isNaN(rowNum) || rowNum <= 1) {
    await sendTelegramMessage(chatId, `❌ Invalid Row Number \`${rowNumStr}\`. Must be row index 2 or higher.`);
    return;
  }

  // Check if pipe or comma separated full row update
  const parsed = parseCreateArgs(restStr);
  if (parsed && hasCompleteScheduleDetails(parsed)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetDetails.title}'!A${rowNum}:G${rowNum}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[parsed.date, parsed.time, parsed.center, parsed.course, parsed.subject, parsed.faculty, '']]
      }
    });
    await sendTelegramMessage(chatId, `✅ *Row ${rowNum} updated completely!*`);
    return;
  }
  if (parsed) {
    await sendTelegramMessage(chatId, `⚠️ A full-row update must include Date, Time, Center, Course, Subject, and Faculty.`);
    return;
  }

  // Single field update
  const fieldSpaceIndex = restStr.indexOf(' ');
  if (fieldSpaceIndex === -1) {
    await sendTelegramMessage(chatId, `⚠️ Please specify the field to update and its new value.`);
    return;
  }

  const fieldName = restStr.substring(0, fieldSpaceIndex).trim().toLowerCase();
  const newValue = restStr.substring(fieldSpaceIndex).trim();

  const fieldColMap = {
    'date': 'A',
    'time': 'B',
    'center': 'C',
    'course': 'D',
    'subject': 'E',
    'faculty': 'F',
    'status': 'G'
  };

  const colLetter = fieldColMap[fieldName];
  if (!colLetter) {
    await sendTelegramMessage(chatId, `❌ Unknown field \`${fieldName}\`. Valid fields are: \`Date\`, \`Time\`, \`Center\`, \`Course\`, \`Subject\`, \`Faculty\`, \`Status\`.`);
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetDetails.title}'!${colLetter}${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[newValue]]
    }
  });

  // Clear SENT status if details were modified
  if (fieldName !== 'status') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetDetails.title}'!G${rowNum}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [['']]
      }
    });
  }

  await sendTelegramMessage(chatId, `✅ *Row ${rowNum} updated!*\nField *${fieldName.toUpperCase()}* set to: \`${newValue}\``);
}

async function handleDeleteCommand(chatId, argsStr) {
  if (!argsStr) {
    await sendTelegramMessage(chatId, `⚠️ *Usage:* \`/delete RowNumber\`\n\n*Example:* \`/delete 15\``);
    return;
  }

  const rowNum = parseInt(argsStr.trim(), 10);
  if (isNaN(rowNum) || rowNum <= 1) {
    await sendTelegramMessage(chatId, `❌ Invalid Row Number \`${argsStr}\`. Must be row index 2 or higher.`);
    return;
  }

  const sheets = getSheetsClient();
  const calendar = getCalendarClient();
  const sheetDetails = await resolveSheetDetails(sheets);
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  const calendarDeleteResult = await deleteScheduleRow(sheets, calendar, sheetDetails, rowNum, calendarId);

  const calendarStatus = {
    deleted: 'The linked Calendar event was deleted.',
    'not-found': 'The linked Calendar event was already missing; the schedule row was deleted.',
    'not-linked': 'No Calendar event ID was present in column H; only the schedule row was deleted.'
  }[calendarDeleteResult];
  await sendTelegramMessage(chatId, `🗑️ *Class Row ${rowNum} Deleted Successfully!*\n${calendarStatus}`);
}

async function handleReauthCommand(chatId) {
  const msg = `🔐 *WhatsApp Re-authentication Triggered*\n\n` +
              `If WhatsApp is currently disconnected, you should receive a QR code shortly.\n\n` +
              `📱 Steps:\n` +
              `1. Wait for the QR code to arrive in this chat\n` +
              `2. Open WhatsApp on your phone\n` +
              `3. Go to Settings → Linked Devices → Link a Device\n` +
              `4. Scan the QR code with your phone camera\n` +
              `5. Confirm linking on your phone\n\n` +
              `If you're already connected, no action is needed. Use /check to verify status.`;
  await sendTelegramMessage(chatId, msg);
}

// Export internal functions for unit testing
module.exports._normalizeText = normalizeText;
module.exports._matchesFilter = matchesFilter;
module.exports._parseCreateArgs = parseCreateArgs;
module.exports._parseDateStrToVal = parseDateStrToVal;
module.exports._parseStartTimeToMinutes = parseStartTimeToMinutes;
module.exports._findInsertionRowIndex = findInsertionRowIndex;
module.exports._createScheduleRowValues = createScheduleRowValues;
module.exports._createCalendarStartDate = createCalendarStartDate;
module.exports._getMissingConfiguration = getMissingConfiguration;
module.exports._hasCompleteScheduleDetails = hasCompleteScheduleDetails;
module.exports._resolveSheetDetails = resolveSheetDetails;
module.exports._isValidWebhookSecret = isValidWebhookSecret;
module.exports._writeScheduleRow = writeScheduleRow;
module.exports._deleteCalendarEvent = deleteCalendarEvent;
module.exports._deleteScheduleRow = deleteScheduleRow;
module.exports._setTelegramCommandMenu = setTelegramCommandMenu;
module.exports._telegramCommands = TELEGRAM_COMMANDS;
