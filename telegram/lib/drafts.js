const crypto = require('crypto');
const TAB_TITLE = 'Drafts';
const HEADER = ['Draft ID', 'Chat ID', 'User ID', 'Expires At', 'Payload'];
const DRAFT_TTL_MS = 30 * 60 * 1000;

function validate({ sheets, spreadsheetId }) {
  if (!sheets || !spreadsheetId) throw new Error('Google Sheets client and spreadsheet ID are required.');
}

function findTab(data) {
  return (data.sheets || []).find(sheet => sheet.properties?.title === TAB_TITLE)?.properties;
}

async function getOrCreateTab({ sheets, spreadsheetId }) {
  validate({ sheets, spreadsheetId });
  let book = await sheets.spreadsheets.get({ spreadsheetId });
  let tab = findTab(book.data);
  if (tab) return { title: TAB_TITLE, sheetId: tab.sheetId };
  let created;
  try {
    const result = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: TAB_TITLE } } }] }
    });
    created = result.data.replies?.[0]?.addSheet?.properties;
  } catch (error) {
    book = await sheets.spreadsheets.get({ spreadsheetId });
    tab = findTab(book.data);
    if (!tab) throw error;
    return { title: TAB_TITLE, sheetId: tab.sheetId };
  }
  if (!created || !Number.isInteger(created.sheetId)) throw new Error('Google Sheets did not return the created Drafts tab.');
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${TAB_TITLE}'!A1:E1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER] }
  });
  return { title: TAB_TITLE, sheetId: created.sheetId };
}

async function readTab({ sheets, spreadsheetId }) {
  const tab = await getOrCreateTab({ sheets, spreadsheetId });
  const result = await sheets.spreadsheets.values.get({ spreadsheetId, range: `'${tab.title}'!A1:E` });
  const rows = result.data.values || [];
  const header = (rows[0] || []).map(value => String(value || '').trim());
  if (header.length < HEADER.length || HEADER.some((value, index) => header[index] !== value)) {
    throw new Error('Drafts tab must have the header "Draft ID | Chat ID | User ID | Expires At | Payload" in row 1.');
  }
  return { tab, rows };
}

async function deleteRows(sheets, spreadsheetId, tab, indexes) {
  const requests = indexes
    .sort((a, b) => b - a)
    .map(index => ({
      deleteDimension: { range: { sheetId: tab.sheetId, dimension: 'ROWS', startIndex: index, endIndex: index + 1 } }
    }));
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

async function deleteExpiredDrafts({ sheets, spreadsheetId }) {
  try {
    const { tab, rows } = await readTab({ sheets, spreadsheetId });
    const expired = rows.slice(1)
      .map((row, index) => index + 1)
      .filter(index => !(Date.parse(rows[index][3]) > Date.now()));
    if (expired.length) await deleteRows(sheets, spreadsheetId, tab, expired);
  } catch (error) {
    console.error('Expired draft cleanup failed:', error.message);
  }
}

async function saveDraft({ sheets, spreadsheetId, chatId, userId, classes }) {
  validate({ sheets, spreadsheetId });
  const tab = await getOrCreateTab({ sheets, spreadsheetId });
  const draftId = crypto.randomBytes(4).toString('hex');
  const expiresAt = new Date(Date.now() + DRAFT_TTL_MS).toISOString();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tab.title}'!A:E`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[draftId, String(chatId), String(userId), expiresAt, JSON.stringify(classes)]]
    }
  });
  await deleteExpiredDrafts({ sheets, spreadsheetId });
  return draftId;
}

async function takeDraft({ sheets, spreadsheetId, chatId, userId, draftId }) {
  const { tab, rows } = await readTab({ sheets, spreadsheetId });
  const index = rows.slice(1).findIndex(row => String(row[0] || '').trim() === draftId);
  if (index === -1) return null;
  const rowIndex = index + 1;
  const row = rows[rowIndex];
  if (String(row[1] || '').trim() !== String(chatId) || String(row[2] || '').trim() !== String(userId)) return null;
  if (!(Date.parse(row[3]) > Date.now())) return null;
  await deleteRows(sheets, spreadsheetId, tab, [rowIndex]);
  try {
    return JSON.parse(String(row[4] || '[]'));
  } catch {
    throw new Error('Draft payload is invalid.');
  }
}

module.exports = { saveDraft, takeDraft, deleteExpiredDrafts };
