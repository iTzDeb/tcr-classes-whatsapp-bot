const https = require('https');
const crypto = require('crypto');
const { google } = require('googleapis');
const { getGoogleAuth } = require('./googleAuth');
const { createZoomMeeting } = require('./zoom');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AUTHORIZED_CHAT_ID = process.env.AUTHORIZED_CHAT_ID;
const DEFAULT_SHEET_TAB = 'Schedule';

function telegramRequest(method, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, response => {
      let body = '';
      response.on('data', chunk => body += chunk);
      response.on('end', () => {
        let result;
        try {
          result = JSON.parse(body);
        } catch {
          reject(new Error(`Telegram ${method} returned an invalid response.`));
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300 || result.ok !== true) {
          const error = new Error(`Telegram ${method} failed: ${result.description || response.statusCode}`);
          error.statusCode = response.statusCode;
          error.description = result.description;
          error.isTelegramError = true;
          reject(error);
          return;
        }
        resolve(result.result);
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error(`Telegram ${method} timed out.`)));
    req.write(data);
    req.end();
  });
}

function sendTelegramMessage(chatId, text, extra = {}) {
  const markdownPayload = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    ...extra
  };
  return telegramRequest('sendMessage', markdownPayload).catch(error => {
    if (
      !error.isTelegramError ||
      error.statusCode !== 400 ||
      !/can't parse entities/i.test(error.description || '')
    ) {
      throw error;
    }

    const plainTextPayload = { ...markdownPayload };
    delete plainTextPayload.parse_mode;
    return telegramRequest('sendMessage', plainTextPayload);
  });
}

function answerCallbackQuery(callbackQueryId, text) {
  return telegramRequest('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: String(text || '').slice(0, 180)
  });
}

function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getGoogleAuth() });
}

async function getSheetDetails(sheets) {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetList = spreadsheet.data.sheets || [];
  const matched = sheetList.find(sheet =>
    String(sheet.properties.title || '').trim().toLowerCase() === DEFAULT_SHEET_TAB.toLowerCase()
  ) || sheetList[0];
  if (!matched || !matched.properties || !Number.isInteger(matched.properties.sheetId)) {
    throw new Error('The spreadsheet does not contain a usable sheet tab.');
  }
  return { title: matched.properties.title, sheetId: matched.properties.sheetId };
}

function parseDateParts(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()];
  }

  const text = String(value || '').trim();
  let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return [Number(match[1]), Number(match[2]), Number(match[3])];

  const months = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9,
    sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
    dec: 12, december: 12
  };
  match = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s+(\d{2,4})$/i);
  if (match) {
    const month = months[match[2].toLowerCase()];
    const year = Number(match[3]) < 100 ? Number(match[3]) + 2000 : Number(match[3]);
    return month ? [year, month, Number(match[1])] : null;
  }
  match = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)$/i);
  if (match) {
    const month = months[match[2].toLowerCase()];
    return month ? [new Date().getFullYear(), month, Number(match[1])] : null;
  }
  match = text.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})$/i);
  if (match) {
    const month = months[match[1].toLowerCase()];
    const year = Number(match[3]) < 100 ? Number(match[3]) + 2000 : Number(match[3]);
    return month ? [year, month, Number(match[2])] : null;
  }
  match = text.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/i);
  if (match) {
    const month = months[match[1].toLowerCase()];
    return month ? [new Date().getFullYear(), month, Number(match[2])] : null;
  }
  match = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (match) {
    const year = Number(match[3]) < 100 ? Number(match[3]) + 2000 : Number(match[3]);
    return [year, Number(match[2]), Number(match[1])];
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime())
    ? null
    : [parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate()];
}

function scheduleDateKey(value) {
  const parts = parseDateParts(value);
  return parts ? parts.map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0')).join('-') : '';
}

function todayInIndia() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function rowNeedsZoom(row) {
  const center = String(row.center || '').trim().toLowerCase();
  const subject = String(row.subject || '').toLowerCase();
  return center === 'laxmi nagar' && !subject.includes('mock') && !subject.includes('test');
}

function hasAllZoomLinks(group) {
  return group.rows.every(row => !rowNeedsZoom(row) || /^https:\/\/\S+/i.test(String(row.zoomUrl || '').trim()));
}

function callbackSignature(group) {
  const rows = group.rows.map(row =>
    [row.rowIndex, row.date, row.time, row.center, row.course, row.subject, row.faculty].join(':')
  ).join('|');
  return crypto.createHash('sha256').update(`${group.key}|${rows}`).digest('hex').slice(0, 8);
}

async function fetchPendingRows() {
  if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID is not configured.');
  const sheets = getSheetsClient();
  const sheet = await getSheetDetails(sheets);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${sheet.title.replace(/'/g, "''")}'!A1:I`
  });
  const rows = response.data.values || [];
  const today = todayInIndia();
  return rows.slice(1).map((values, index) => ({
    rowIndex: index + 2,
    date: String(values[0] || '').trim(),
    time: String(values[1] || '').trim(),
    center: String(values[2] || '').trim(),
    course: String(values[3] || '').trim(),
    subject: String(values[4] || '').trim(),
    faculty: String(values[5] || '').trim(),
    status: String(values[6] || '').trim().toUpperCase(),
    zoomUrl: String(values[8] || '').trim()
  })).filter(row => {
    const dateKey = scheduleDateKey(row.date);
    const complete = [row.date, row.time, row.center, row.course, row.subject, row.faculty].every(Boolean);
    return complete && dateKey && dateKey >= today && row.status !== 'SENT';
  });
}

function groupPendingRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const dateKey = scheduleDateKey(row.date);
    const key = `${dateKey}|${row.center.trim().toLowerCase()}|${row.course.trim().toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        date: row.date,
        center: row.center,
        course: row.course,
        rows: []
      });
    }
    groups.get(key).rows.push(row);
  }
  return [...groups.values()]
    .map(group => {
      group.rows.sort((a, b) => a.rowIndex - b.rowIndex);
      group.rowIndices = group.rows.map(row => row.rowIndex);
      return group;
    })
    .sort((a, b) => scheduleDateKey(a.date).localeCompare(scheduleDateKey(b.date)) ||
      a.center.localeCompare(b.center) || a.course.localeCompare(b.course));
}

function formatScheduleDate(dateValue) {
  const parts = parseDateParts(dateValue);
  if (!parts) return String(dateValue || 'Date unavailable');
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const day = date.getUTCDate();
  const ordinalSuffix = day % 100 >= 11 && day % 100 <= 13
    ? 'th'
    : ({ 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th');
  const month = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    month: 'long'
  }).format(date);
  return `${day}${ordinalSuffix} ${month}`;
}

function formatGroupMessage(group) {
  const message = [
    `*TCR – ${group.course.toUpperCase()} CLASS FLOW*`,
    '',
    '*Class Schedule*',
    `📌 ${formatScheduleDate(group.date)}`,
    ''
  ];
  for (const row of group.rows) {
    message.push(
      `*${row.time}*`,
      `Subject: *${row.subject}*`,
      `Faculty: *${row.faculty.toUpperCase()}*`
    );
    if (row.zoomUrl) message.push(`🔗 *Zoom:* ${row.zoomUrl}`);
    else if (rowNeedsZoom(row)) message.push('🔗 *Zoom:* Link not prepared');
    message.push('');
  }
  message.push('Regards,', '*TEAM TCR*');
  return message.join('\n');
}

function buildKeyboard(group) {
  const signature = callbackSignature(group);
  const firstRow = group.rowIndices[0];
  const keyboard = [];
  if (hasAllZoomLinks(group)) {
    keyboard.push([{
      text: group.rows.some(row => row.status !== 'SENT') ? '📤 Open WhatsApp' : '📤 Send to WhatsApp',
      url: `https://wa.me/?text=${encodeURIComponent(formatGroupMessage(group))}`
    }]);
    if (group.rows.some(row => row.status !== 'SENT')) {
      keyboard.push([{
        text: '✅ Mark as sent',
        callback_data: `sent:${firstRow}:${signature}`
      }]);
    }
  } else {
    keyboard.push([{
      text: '🎥 Generate Zoom & Prepare Send',
      callback_data: `prepare:${firstRow}:${signature}`
    }]);
  }
  return { inline_keyboard: keyboard };
}

async function runPreview(chatId) {
  const groups = groupPendingRows(await fetchPendingRows());
  if (!groups.length) {
    await sendTelegramMessage(chatId, '📅 No upcoming pending or prepared classes were found.');
    return 0;
  }
  for (const group of groups) {
    await sendTelegramMessage(chatId, formatGroupMessage(group), {
      parse_mode: 'Markdown',
      reply_markup: buildKeyboard(group)
    });
  }
  return groups.length;
}

async function readRowsByIndex(rowIndices) {
  const sheets = getSheetsClient();
  const sheet = await getSheetDetails(sheets);
  const uniqueIndices = [...new Set(rowIndices)];
  if (!uniqueIndices.length || uniqueIndices.some(index => !Number.isInteger(index) || index < 2)) {
    throw new Error('Schedule row indices must be integers greater than or equal to 2.');
  }
  const result = await Promise.all(uniqueIndices.map(async rowIndex => {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheet.title.replace(/'/g, "''")}'!A${rowIndex}:I${rowIndex}`
    });
    const values = response.data.values?.[0] || [];
    if (!values.slice(0, 6).every(value => String(value || '').trim())) {
      throw new Error(`Schedule row ${rowIndex} is empty or incomplete.`);
    }
    return {
      rowIndex,
      date: String(values[0]).trim(),
      time: String(values[1]).trim(),
      center: String(values[2]).trim(),
      course: String(values[3]).trim(),
      subject: String(values[4]).trim(),
      faculty: String(values[5]).trim(),
      status: String(values[6] || '').trim().toUpperCase(),
      zoomUrl: String(values[8] || '').trim()
    };
  }));
  return { sheets, sheet, rows: result };
}

async function prepareZoomSend(rowIndices) {
  const { sheets, sheet, rows } = await readRowsByIndex(rowIndices);
  const values = [];
  for (const row of rows) {
    if (!rowNeedsZoom(row) || row.zoomUrl) continue;
    const zoomUrl = await createZoomMeeting(row);
    row.zoomUrl = zoomUrl;
    values.push({
      range: `'${sheet.title.replace(/'/g, "''")}'!I${row.rowIndex}`,
      values: [[zoomUrl]]
    });
  }
  if (values.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: values
      }
    });
  }
  const group = groupPendingRows(rows)[0];
  await sendTelegramMessage(AUTHORIZED_CHAT_ID, formatGroupMessage(group), {
    parse_mode: 'Markdown',
    reply_markup: buildKeyboard(group)
  });
  return rows.length;
}

async function markRowsSent(rowIndices) {
  const { sheets, sheet } = await readRowsByIndex(rowIndices);
  const data = [...new Set(rowIndices)].map(rowIndex => ({
    range: `'${sheet.title.replace(/'/g, "''")}'!G${rowIndex}`,
    values: [['SENT']]
  }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data
    }
  });
  return data.length;
}

module.exports = {
  runPreview,
  markRowsSent,
  prepareZoomSend,
  sendTelegramMessage,
  answerCallbackQuery,
  fetchPendingRows,
  groupPendingRows,
  callbackSignature,
  formatGroupMessage,
  formatScheduleDate,
  buildKeyboard
};
