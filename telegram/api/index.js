const { google } = require('googleapis');
const https = require('https');
const {
  runPreview,
  markRowsSent,
  prepareZoomSend,
  sendTelegramMessage,
  answerCallbackQuery,
  fetchPendingRows,
  fetchAllRows,
  groupPendingRows,
  callbackSignature,
  formatScheduleDate,
  scheduleDateKey,
  indiaDateKey
} = require('../lib/preview');
const { getGoogleAuth } = require('../lib/googleAuth');

// Configuration Constants
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AUTHORIZED_CHAT_ID = process.env.AUTHORIZED_CHAT_ID;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const DEFAULT_SHEET_TAB = 'Schedule';
const crypto = require('crypto');

const TELEGRAM_COMMANDS = [
  { command: 'start',    description: 'Open the bot help menu' },
  { command: 'help',     description: 'Show available commands and examples' },
  { command: 'status',   description: 'System status and pending counts' },
  { command: 'preview',  description: 'Prepare tomorrow\'s WhatsApp messages' },
  { command: 'today',    description: 'List today\'s classes' },
  { command: 'tomorrow', description: 'List tomorrow\'s classes' },
  { command: 'pending',  description: 'List all unsent classes (any date)' },
  { command: 'list',     description: 'Search the full schedule' },
  { command: 'faculty',  description: 'List classes by faculty name' },
  { command: 'create',   description: 'Add a class to the schedule' },
  { command: 'update',   description: 'Update a schedule row' },
  { command: 'resend',   description: 'Reset a row for resending' },
  { command: 'undo',     description: 'Unmark a row as sent' },
  { command: 'delete',   description: 'Delete a class and its linked event' }
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

// --- Utility & Date Parsing Helpers ---

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
    .replace(/\b0([1-9])\b/g, '$1');
}

function matchesFilter(dateStr, fullRowText, filterText) {
  const normDate = normalizeText(dateStr);
  const normFilter = normalizeText(filterText);
  if (!normFilter) return true;

  const tokens = normFilter.split(/\s+/).filter(Boolean);
  const monthTokens = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const hasMonthToken = tokens.some(t => monthTokens.includes(t));

  if (hasMonthToken) {
    return tokens.every(token => {
      const escaped = token.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const regex = new RegExp('\\b' + escaped + '\\b', 'i');
      return regex.test(normDate);
    });
  }

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
  const str = String(dateStr).trim().toLowerCase().replace(/(\d+)(st|nd|rd|th)/g, '$1');
  const months = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
    may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
    sep: 8, sept: 8, september: 8, oct: 9, october: 9,
    nov: 10, november: 10, dec: 11, december: 11
  };
  const defaultYear = new Date().getFullYear();

  const dayMonthMatch = str.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{2,4}))?$/i);
  if (dayMonthMatch) {
    const day = parseInt(dayMonthMatch[1], 10);
    const mStr = dayMonthMatch[2].toLowerCase();
    let year = dayMonthMatch[3] ? parseInt(dayMonthMatch[3], 10) : defaultYear;
    if (year < 100) year += 2000;
    if (months[mStr] !== undefined) return new Date(Date.UTC(year, months[mStr], day)).getTime();
  }

  const monthDayMatch = str.match(/^([a-z]+)\s+(\d{1,2})(?:\s+(\d{2,4}))?$/i);
  if (monthDayMatch) {
    const mStr = monthDayMatch[1].toLowerCase();
    const day = parseInt(monthDayMatch[2], 10);
    let year = monthDayMatch[3] ? parseInt(monthDayMatch[3], 10) : defaultYear;
    if (year < 100) year += 2000;
    if (months[mStr] !== undefined) return new Date(Date.UTC(year, months[mStr], day)).getTime();
  }

  const parts = str.split(/[\/\-\.]/);
  if (parts.length >= 2) {
    if (parts[0].length === 4) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);
      return new Date(Date.UTC(year, month, day)).getTime();
    } else {
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      let year = parts[2] ? parseInt(parts[2], 10) : defaultYear;
      if (year < 100) year += 2000;
      if (!isNaN(day) && !isNaN(month)) return new Date(Date.UTC(year, month, day)).getTime();
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
  if (!newDateVal) return existingRows.length + 1;
  for (let i = 1; i < existingRows.length; i++) {
    const row = existingRows[i];
    const rDateStr = String(row[0] || '').trim();
    if (!rDateStr) continue;
    const rDateVal = parseDateStrToVal(rDateStr);
    if (!rDateVal) continue;
    const rTimeVal = parseStartTimeToMinutes(String(row[1] || ''));
    if (rDateVal > newDateVal) return i + 1;
    else if (rDateVal === newDateVal && rTimeVal > newTimeVal) return i + 1;
  }
  return existingRows.length + 1;
}

function createScheduleRowValues({ date, time, center, course, subject, faculty }, calendarEventId = '') {
  return [date, time, center, course, subject, faculty, '', calendarEventId];
}

function parseCreateArgs(argsStr) {
  if (!argsStr) return null;

  if (argsStr.includes('|')) {
    const parts = argsStr.split('|').map(s => s.trim());
    if (parts.length >= 6) {
      return { date: parts[0], time: parts[1], center: parts[2], course: parts[3], subject: parts[4], faculty: parts[5] };
    }
  }

  if (argsStr.includes('\n')) {
    const lines = argsStr.split('\n').map(s => s.trim()).filter(Boolean);
    const kv = {};
    lines.forEach(line => {
      const idx = line.indexOf(':');
      if (idx !== -1) {
        kv[line.substring(0, idx).trim().toLowerCase()] = line.substring(idx + 1).trim();
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
      return { date: lines[0], time: lines[1], center: lines[2], course: lines[3], subject: lines[4], faculty: lines[5] };
    }
  }

  if (argsStr.includes(',')) {
    const parts = argsStr.split(',').map(s => s.trim());
    if (parts.length >= 6) {
      return { date: parts[0], time: parts[1], center: parts[2], course: parts[3], subject: parts[4], faculty: parts[5] };
    }
  }
  return null;
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getGoogleAuth() });
}

function getCalendarClient() {
  return google.calendar({ version: 'v3', auth: getGoogleAuth() });
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
  const matchingEvents = await calendar.events.list({ calendarId, iCalUID: storedEventId, maxResults: 2 });
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
            range: { sheetId: sheetDetails.sheetId, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum }
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

async function createCalendarEvent({ dateStr, timeStr, center, course, subject, faculty }) {
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  const calendar = getCalendarClient();
  const startDate = createCalendarStartDate(dateStr, timeStr);
  if (!startDate) return null;
  const endDate = new Date(startDate.getTime() + 2 * 60 * 60 * 1000);
  const summary = `${course} - ${subject} (${faculty}) @ ${center}`;
  const description = `Class Schedule: ${course} - ${subject}\nFaculty: ${faculty}\nCenter: ${center}\nTime: ${timeStr}`;

  const res = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary, location: center, description,
      start: { dateTime: startDate.toISOString() },
      end:   { dateTime: endDate.toISOString() }
    }
  });
  return res.data;
}

async function resolveSheetDetails(sheets) {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetList = spreadsheet.data.sheets || [];
  const matchedSheet = sheetList.find(s => s.properties.title.trim().toLowerCase() === DEFAULT_SHEET_TAB.toLowerCase()) || sheetList[0];
  if (!matchedSheet || !matchedSheet.properties || !Number.isInteger(matchedSheet.properties.sheetId)) {
    throw new Error('The spreadsheet does not contain a usable sheet tab.');
  }
  return { title: matchedSheet.properties.title, sheetId: matchedSheet.properties.sheetId };
}

function setTelegramCommandMenu() {
  const data = JSON.stringify({ commands: TELEGRAM_COMMANDS });
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.telegram.org', port: 443,
      path: `/bot${TELEGRAM_BOT_TOKEN}/setMyCommands`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = https.request(options, response => {
      let body = '';
      response.on('data', chunk => body += chunk);
      response.on('end', () => {
        let result;
        try { result = JSON.parse(body); } catch {
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

function setTelegramMenuButton() {
  const data = JSON.stringify({
    menu_button: { type: 'commands' }
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TELEGRAM_BOT_TOKEN}/setChatMenuButton`,
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
          reject(new Error('Telegram returned an invalid response while setting the menu button.'));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300 || result.ok !== true) {
          reject(new Error(`Telegram menu button setup failed: ${result.description || response.statusCode}`));
          return;
        }
        resolve(result.result);
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Telegram menu button setup timed out.')));
    req.write(data);
    req.end();
  });
}

function getSafeErrorDetails(error) {
  const status = error.code || error.statusCode || error.response?.status;
  const message = String(error.message || 'Unknown error').replace(/[\r\n`]/g, ' ').slice(0, 240);
  const safeMessage = message.replace(/([_*[\]()])/g, '\\$1');
  return status ? `${safeMessage} (code ${status})` : safeMessage;
}

function isAuthorized(chatId, userId) {
  const strChatId = String(chatId);
  const strUserId = String(userId || '');
  return strChatId === String(AUTHORIZED_CHAT_ID) || strUserId === String(AUTHORIZED_CHAT_ID);
}

function isValidCronAuthorization(authorization, expectedSecret = process.env.CRON_SECRET) {
  if (typeof authorization !== 'string' || !expectedSecret) return false;
  const suppliedSecret = authorization.match(/^Bearer (.+)$/i)?.[1];
  if (!suppliedSecret) return false;
  const supplied = Buffer.from(suppliedSecret);
  const expected = Buffer.from(expectedSecret);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

async function handlePreviewCallback(callbackQuery) {
  const data = String(callbackQuery.data || '');

  if (data === 'noop') {
    await answerCallbackQuery(callbackQuery.id, 'Message too long for one-tap sending. Copy the text manually.');
    return;
  }

  const match = data.match(/^(prepare|sent):(\d+):([a-f0-9]{8})$/);
  if (!match) {
    await answerCallbackQuery(callbackQuery.id, 'This preview action is invalid.');
    return;
  }

  const rows = await fetchPendingRows();
  const group = groupPendingRows(rows).find(candidate =>
    candidate.rowIndices.includes(Number(match[2]))
  );
  if (!group || callbackSignature(group) !== match[3]) {
    await answerCallbackQuery(callbackQuery.id, 'This preview is out of date. Run /preview again.');
    return;
  }

  const chatId = callbackQuery.message?.chat?.id;
  const originalMessageId = callbackQuery.message?.message_id;

  if (match[1] === 'prepare') {
    await prepareZoomSend(group.rowIndices);
    await answerCallbackQuery(callbackQuery.id, 'Zoom links prepared. The WhatsApp message is ready.');
    return;
  }

  await markRowsSent(group.rowIndices);
  await answerCallbackQuery(callbackQuery.id, 'Schedule rows marked as sent.');

  if (chatId) {
    const rowList = group.rowIndices.join(', ');
    const confirmation =
      `✅ *Marked as sent*\n` +
      `📚 *${group.course}* · ${formatScheduleDate(group.date)}\n` +
      `📍 Rows: \`${rowList}\``;
    try {
      await sendTelegramMessage(chatId, confirmation, {
        reply_to_message_id: originalMessageId,
        allow_sending_without_reply: true
      });
    } catch (err) {
      console.error('Mark-as-sent confirmation failed:', err.message);
    }
  }
}

// Vercel Serverless Entry Point
module.exports = async (req, res) => {
  const pathname = new URL(req.url || '/', 'https://vercel.invalid').pathname;
  if (pathname === '/api/cron') {
    if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'Method not allowed.' }); return; }
    if (!process.env.CRON_SECRET) { res.status(500).json({ ok: false, error: 'CRON_SECRET is not configured.' }); return; }
    if (!isValidCronAuthorization(req.headers?.authorization)) { res.status(401).json({ ok: false, error: 'Invalid cron authorization.' }); return; }
    try {
      const groupsSent = await runPreview(AUTHORIZED_CHAT_ID);
      res.status(200).json({ ok: true, groupsSent });
    } catch (error) {
      console.error('Scheduled preview failed:', error);
      res.status(500).json({ ok: false, error: 'Scheduled preview failed.' });
    }
    return;
  }

  if (req.method !== 'POST') { res.status(200).send('TCR Telegram Bot Webhook API is running.'); return; }

  const missingConfiguration = getMissingConfiguration();
  if (missingConfiguration.length > 0) {
    res.status(500).json({ ok: false, error: 'Bot configuration is incomplete.', missingEnvironmentVariables: missingConfiguration });
    return;
  }

  if (!isValidWebhookSecret(req.headers?.['x-telegram-bot-api-secret-token'])) {
    res.status(401).json({ ok: false, error: 'Invalid Telegram webhook secret.' });
    return;
  }

  try {
    const payload = req.body || {};

    if (payload.callback_query) {
      const callbackQuery = payload.callback_query;
      const chatId = callbackQuery.message?.chat?.id;
      const userId = callbackQuery.from?.id;
      if (!isAuthorized(chatId, userId)) {
        await answerCallbackQuery(callbackQuery.id, 'Access denied.');
        res.status(200).json({ ok: true });
        return;
      }
      try {
        await handlePreviewCallback(callbackQuery);
      } catch (error) {
        console.error('Preview callback failed:', error);
        await answerCallbackQuery(callbackQuery.id, `Action failed: ${error.message}`);
      }
    }

    if (payload.message && payload.message.text) {
      const message = payload.message;
      const text = message.text.trim();
      const chatId = message.chat.id;
      const userId = message.from ? message.from.id : null;

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

async function handleTelegramCommand(chatId, text) {
  const parts = text.split(/\s+/);
  const command = parts[0].toLowerCase();
  const argsStr = text.substring(parts[0].length).trim();

  if (command === '/start' || command === '/help') {
    const helpMsg =
      `🤖 *TCR Class Scheduler Bot*\n\n` +
      `*Broadcast*\n` +
      `📌 */preview* — Prepare tomorrow's WhatsApp messages\n` +
      `📌 */status* — System status and pending counts\n\n` +
      `*Schedule*\n` +
      `📌 */today* — List today's classes\n` +
      `📌 */tomorrow* — List tomorrow's classes\n` +
      `📌 */pending* — All unsent classes (any date)\n` +
      `📌 */list* _[filter]_ — Search schedule\n` +
      `   e.g. \`/list 4 Oct\`, \`/list Laxmi Nagar\`, \`/list CLAT\`\n` +
      `📌 */faculty* _Name_ — Classes by faculty\n` +
      `   e.g. \`/faculty Shivam\`\n\n` +
      `*Edit*\n` +
      `📌 */create* _Details_ — Add a class (comma/pipe/newline format)\n` +
      `📌 */update* _Row Field Value_ — Update one field\n` +
      `   e.g. \`/update 15 Faculty Anand Sir\`\n` +
      `📌 */resend* _Row_ — Reset a row for resending\n` +
      `📌 */undo* _Row_ — Unmark SENT (keep Zoom link)\n` +
      `📌 */delete* _Row_ — Delete row + linked Calendar event`;

    try {
      await setTelegramCommandMenu();
      await setTelegramMenuButton();
    } catch (error) {
      const referenceId = crypto.randomUUID();
      console.error('Telegram menu setup error:', { referenceId, message: error.message });
      await sendTelegramMessage(chatId, `⚠️ The help text is available, but Telegram could not refresh its menu. Try /help again later. Reference: \`${referenceId}\``);
    }
    await sendTelegramMessage(chatId, helpMsg);
    return;
  }

  try {
    if (command === '/status')   { await handleStatusCommand(chatId); return; }
    if (command === '/preview')  { await runPreview(chatId); return; }
    if (command === '/today')    { await handleDateCommand(chatId, 0); return; }
    if (command === '/tomorrow') { await handleDateCommand(chatId, 1); return; }
    if (command === '/pending')  { await handlePendingCommand(chatId); return; }
    if (command === '/list')     { await handleListCommand(chatId, argsStr); return; }
    if (command === '/faculty')  { await handleFacultyCommand(chatId, argsStr); return; }
    if (command === '/create' || command === '/add') { await handleCreateCommand(chatId, argsStr); return; }
    if (command === '/update')   { await handleUpdateCommand(chatId, argsStr); return; }
    if (command === '/resend')   { await handleResendCommand(chatId, argsStr); return; }
    if (command === '/undo')     { await handleUndoCommand(chatId, argsStr); return; }
    if (command === '/delete')   { await handleDeleteCommand(chatId, argsStr); return; }

    await sendTelegramMessage(chatId, `⚠️ Unknown command. Type /help to see all available commands.`);
  } catch (err) {
    const referenceId = crypto.randomUUID();
    console.error('Command Execution Error:', { referenceId, command, message: err.message, code: err.code || err.response?.status });
    const report = err.userMessage || `The command failed: ${getSafeErrorDetails(err)}.`;
    await sendTelegramMessage(chatId, `⚠️ ${report}\nReference: \`${referenceId}\``);
  }
}

// ---------- New command handlers ----------

async function handleStatusCommand(chatId) {
  const rows = await fetchAllRows();
  const todayKey = indiaDateKey(0);
  const tomorrowKey = indiaDateKey(1);

  const pending = rows.filter(r => r.status !== 'SENT');
  const todayRows = rows.filter(r => scheduleDateKey(r.date) === todayKey);
  const tomorrowRows = rows.filter(r => scheduleDateKey(r.date) === tomorrowKey);
  const prepared = pending.filter(r => r.zoomUrl);

  const now = new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
  });

  const msg =
    `🤖 *TCR Bot Status*\n\n` +
    `🕐 IST now: *${now}*\n` +
    `📊 Total rows: *${rows.length}*\n` +
    `⏳ Pending (G ≠ SENT): *${pending.length}*\n` +
    `🎥 Of those, Zoom prepared: *${prepared.length}*\n\n` +
    `📅 Today (${formatScheduleDate(todayKey)}): *${todayRows.length}* class(es)\n` +
    `📅 Tomorrow (${formatScheduleDate(tomorrowKey)}): *${tomorrowRows.length}* class(es)\n\n` +
    `💡 Run /preview to prepare WhatsApp messages.`;

  await sendTelegramMessage(chatId, msg);
}

async function handleDateCommand(chatId, offsetDays) {
  const rows = await fetchAllRows();
  const target = indiaDateKey(offsetDays);
  const filtered = rows.filter(r => scheduleDateKey(r.date) === target);
  const label = offsetDays === 0 ? 'Today' : 'Tomorrow';
  await sendRowList(chatId, `${label} · ${formatScheduleDate(target)}`, filtered);
}

async function handlePendingCommand(chatId) {
  const rows = await fetchAllRows();
  const pending = rows.filter(r => r.status !== 'SENT');
  await sendRowList(chatId, 'Pending classes (G ≠ SENT)', pending);
}

async function handleFacultyCommand(chatId, nameFilter) {
  if (!nameFilter) {
    await sendTelegramMessage(chatId, `⚠️ *Usage:* \`/faculty Shivam\`\nShows all classes taught by the matching faculty name.`);
    return;
  }
  const rows = await fetchAllRows();
  const norm = nameFilter.trim().toLowerCase();
  const filtered = rows.filter(r => r.faculty.toLowerCase().includes(norm));
  await sendRowList(chatId, `Classes for "${nameFilter}"`, filtered);
}

async function sendRowList(chatId, title, rows) {
  if (!rows.length) {
    await sendTelegramMessage(chatId, `📭 *${title}*\nNo matching classes.`);
    return;
  }

  let message = `📅 *${title}* (${rows.length}):\n\n`;
  rows.forEach((item, index) => {
    const statusBadge = item.status === 'SENT' ? ' ✅ `SENT`' : '';
    const zoomBadge = item.zoomUrl ? ' 🎥' : '';
    const facultyLine = item.faculty ? `👨‍🏫 *Faculty:* ${item.faculty}\n` : '';
    message += `📍 *Row ${item.rowIndex}* ${statusBadge}${zoomBadge}\n` +
               `🗓 *Date:* ${item.date}\n` +
               `⏰ *Time:* ${item.time}\n` +
               `🏛 *Center:* ${item.center}\n` +
               `📚 *Course:* ${item.course} | *Subject:* ${item.subject}\n` +
               facultyLine;
    if (index < rows.length - 1) message += `───────────────\n`;
  });

  if (message.length > 4000) {
    message = message.substring(0, 3900) + `\n\n⚠️ _Output truncated. Refine with a filter._`;
  }
  await sendTelegramMessage(chatId, message);
}

async function handleResendCommand(chatId, argsStr) {
  const rowNum = parseInt(argsStr.trim(), 10);
  if (!Number.isInteger(rowNum) || rowNum < 2) {
    await sendTelegramMessage(chatId, `⚠️ *Usage:* \`/resend 15\`\nClears G (status) and I (Zoom) so the row can be re-prepared.`);
    return;
  }

  const sheets = getSheetsClient();
  const sheetDetails = await resolveSheetDetails(sheets);

  const check = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetDetails.title}'!A${rowNum}:I${rowNum}`
  });
  const row = check.data.values?.[0] || [];
  if (!row.some(v => String(v || '').trim())) {
    await sendTelegramMessage(chatId, `❌ Row ${rowNum} is empty.`);
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `'${sheetDetails.title}'!G${rowNum}`, values: [['']] },
        { range: `'${sheetDetails.title}'!I${rowNum}`, values: [['']] }
      ]
    }
  });
  await sendTelegramMessage(chatId, `♻️ *Row ${rowNum} reset.*\nStatus (G) and Zoom link (I) cleared. Run /preview to re-prepare it.`);
}

async function handleUndoCommand(chatId, argsStr) {
  const rowNum = parseInt(argsStr.trim(), 10);
  if (!Number.isInteger(rowNum) || rowNum < 2) {
    await sendTelegramMessage(chatId, `⚠️ *Usage:* \`/undo 15\`\nUnmarks SENT but keeps the Zoom link in column I.`);
    return;
  }

  const sheets = getSheetsClient();
  const sheetDetails = await resolveSheetDetails(sheets);

  const check = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetDetails.title}'!G${rowNum}`
  });
  const currentStatus = String(check.data.values?.[0]?.[0] || '').trim().toUpperCase();
  if (currentStatus !== 'SENT') {
    await sendTelegramMessage(chatId, `ℹ️ Row ${rowNum} is not marked SENT (currently: ${currentStatus || 'empty'}). Nothing to undo.`);
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetDetails.title}'!G${rowNum}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['']] }
  });
  await sendTelegramMessage(chatId, `↩️ *Row ${rowNum} unmarked.*\nStatus (G) cleared. Zoom link (I) preserved.`);
}

// ---------- Existing command handlers ----------

async function handleListCommand(chatId, filterText) {
  const rows = await fetchAllRows();

  if (!rows.length) {
    await sendTelegramMessage(chatId, `📅 No classes found in the schedule.`);
    return;
  }

  const matchingRows = rows.filter(r => {
    if (!filterText) return true;
    const fullRowText = `${r.date} ${r.time} ${r.center} ${r.course} ${r.subject} ${r.faculty} ${r.status}`;
    return matchesFilter(r.date, fullRowText, filterText);
  });

  const title = filterText ? `Classes matching "${filterText}"` : 'Master Class Schedule';
  await sendRowList(chatId, title, matchingRows);
}

async function handleCreateCommand(chatId, argsStr) {
  const parsed = parseCreateArgs(argsStr);

  if (!hasCompleteScheduleDetails(parsed || {})) {
    const usageMsg =
      `⚠️ *How to create a class:*\n\n` +
      `*Comma separated:*\n` +
      `\`/create 06 Sept 2026, 4:00 - 6:00PM, Laxmi Nagar, CLAT, Legal, Shivam Sir\`\n\n` +
      `*Key-Value:*\n` +
      `\`/create\`\n` +
      `\`Date: 06 Sept 2026\`\n` +
      `\`Time: 4:00 - 6:00PM\`\n` +
      `\`Center: Laxmi Nagar\`\n` +
      `\`Course: CLAT\`\n` +
      `\`Subject: Legal\`\n` +
      `\`Faculty: Shivam Sir\``;
    await sendTelegramMessage(chatId, usageMsg);
    return;
  }

  const { date: dateVal, time: timeVal, center: centerVal, course: courseVal, subject: subjectVal, faculty: facultyVal } = parsed;
  const startTimeMinutes = parseStartTimeToMinutes(timeVal);
  if (!parseDateStrToVal(dateVal) || startTimeMinutes === null) {
    await sendTelegramMessage(chatId, `⚠️ Invalid date or start time. Use a valid date and time, for example \`31 Dec 2026, 01:00PM - 03:00PM\`.`);
    return;
  }

  let calendarEventId = '';
  let calSyncText = '⏳ Pending';
  let calendarSyncFailure = '';
  try {
    const calResult = await createCalendarEvent({
      dateStr: dateVal, timeStr: timeVal, center: centerVal,
      course: courseVal, subject: subjectVal, faculty: facultyVal
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

  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetDetails.title}'!A1:H`
  });

  const existingRows = readRes.data.values || [];
  const targetRowIndex = findInsertionRowIndex(existingRows, parseDateStrToVal(dateVal), parseStartTimeToMinutes(timeVal));
  await writeScheduleRow(sheets, sheetDetails, targetRowIndex, createScheduleRowValues(parsed, calendarEventId));

  const confirmMsg =
    `✅ *Class Created!*\n\n` +
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
    await sendTelegramMessage(chatId, `⚠️ *Usage:* \`/update Row Field Value\`\n\n*Examples:*\n• \`/update 15 Time 5:00 - 7:00PM\`\n• \`/update 15 Faculty Anand Sir\``);
    return;
  }

  const spaceIndex = argsStr.indexOf(' ');
  if (spaceIndex === -1) { await sendTelegramMessage(chatId, `⚠️ Invalid syntax.`); return; }

  const rowNum = parseInt(argsStr.substring(0, spaceIndex).trim(), 10);
  const restStr = argsStr.substring(spaceIndex).trim();

  const sheets = getSheetsClient();
  const sheetDetails = await resolveSheetDetails(sheets);

  if (isNaN(rowNum) || rowNum <= 1) { await sendTelegramMessage(chatId, `❌ Invalid Row Number. Must be 2 or higher.`); return; }

  const parsed = parseCreateArgs(restStr);
  if (parsed && hasCompleteScheduleDetails(parsed)) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `'${sheetDetails.title}'!A${rowNum}:G${rowNum}`,
            values: [[parsed.date, parsed.time, parsed.center, parsed.course, parsed.subject, parsed.faculty, '']] },
          { range: `'${sheetDetails.title}'!I${rowNum}`, values: [['']] }
        ]
      }
    });
    await sendTelegramMessage(chatId, `✅ *Row ${rowNum} updated completely!*`);
    return;
  }

  const fieldSpaceIndex = restStr.indexOf(' ');
  if (fieldSpaceIndex === -1) { await sendTelegramMessage(chatId, `⚠️ Specify field and value.`); return; }

  const fieldName = restStr.substring(0, fieldSpaceIndex).trim().toLowerCase();
  const newValue = restStr.substring(fieldSpaceIndex).trim();
  const fieldColMap = { date: 'A', time: 'B', center: 'C', course: 'D', subject: 'E', faculty: 'F', status: 'G' };
  const colLetter = fieldColMap[fieldName];
  if (!colLetter) { await sendTelegramMessage(chatId, `❌ Unknown field.`); return; }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheetDetails.title}'!${colLetter}${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[newValue]] }
  });

  if (fieldName !== 'status') {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `'${sheetDetails.title}'!G${rowNum}`, values: [['']] },
          { range: `'${sheetDetails.title}'!I${rowNum}`, values: [['']] }
        ]
      }
    });
  }

  await sendTelegramMessage(chatId, `✅ *Row ${rowNum} updated!*\nField *${fieldName.toUpperCase()}* set to: \`${newValue}\``);
}

async function handleDeleteCommand(chatId, argsStr) {
  if (!argsStr) { await sendTelegramMessage(chatId, `⚠️ *Usage:* \`/delete 15\``); return; }

  const rowNum = parseInt(argsStr.trim(), 10);
  if (isNaN(rowNum) || rowNum <= 1) { await sendTelegramMessage(chatId, `❌ Invalid Row Number. Must be 2 or higher.`); return; }

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
  await sendTelegramMessage(chatId, `🗑️ *Class Row ${rowNum} Deleted!*\n${calendarStatus}`);
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
module.exports._setTelegramMenuButton = setTelegramMenuButton;
module.exports._telegramCommands = TELEGRAM_COMMANDS;
module.exports._isValidCronAuthorization = isValidCronAuthorization;
