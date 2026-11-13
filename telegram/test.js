const assert = require('assert');
const telegramWebhook = require('./api/index');
const preview = require('./lib/preview');
const { formatZoomStartTime, getZoomDurationMins, extractZoomMeetingId, syncZoomMeeting, meetingMatches } = require('./lib/zoom');
const chatAccess = require('./lib/chatAccess');
const voice = require('./lib/voice');
const drafts = require('./lib/drafts');

const {
  _getMissingConfiguration: getMissingConfiguration,
  _hasCompleteScheduleDetails: hasCompleteScheduleDetails,
  _isValidWebhookSecret: isValidWebhookSecret,
  _normalizeText: normalizeText,
  _matchesFilter: matchesFilter,
  _parseCreateArgs: parseCreateArgs,
  _parseDateStrToVal: parseDateStrToVal,
  _parseStartTimeToMinutes: parseStartTimeToMinutes,
  _findInsertionRowIndex: findInsertionRowIndex,
  _createScheduleRowValues: createScheduleRowValues,
  _createCalendarStartDate: createCalendarStartDate,
  _resolveSheetDetails: resolveSheetDetails,
  _writeScheduleRow: writeScheduleRow,
  _deleteCalendarEvent: deleteCalendarEvent,
  _deleteScheduleRow: deleteScheduleRow,
  _telegramCommands: telegramCommands,
  _isValidCronAuthorization: isValidCronAuthorization
} = telegramWebhook;

const {
  groupPendingRows,
  isPendingPreviewRow,
  callbackSignature,
  formatGroupMessage,
  formatScheduleDate,
  buildKeyboard,
  reconcileStoredZoomLinks
} = preview;

console.log('Running search/filter, natural input & chronological sorting tests...');

const tomorrowClass = {
  date: '05 Nov 2026', time: '04:00PM - 06:00PM', center: 'Laxmi Nagar',
  course: 'CLAT', subject: 'Legal', faculty: 'Shivam Sir', status: ''
};
assert.strictEqual(isPendingPreviewRow({ ...tomorrowClass, date: '04 Nov 2026' }, '2026-11-05'), false,
  'Preview must not include today’s classes');
assert.strictEqual(isPendingPreviewRow(tomorrowClass, '2026-11-05'), true,
  'Preview should include complete pending classes for tomorrow');
assert.strictEqual(isPendingPreviewRow({ ...tomorrowClass, status: 'SENT' }, '2026-11-05'), false,
  'Preview must not include classes already marked sent');
assert.strictEqual(isPendingPreviewRow({ ...tomorrowClass, faculty: '' }, '2026-11-05'), false,
  'Preview must not include incomplete schedule rows');

assert.strictEqual(extractZoomMeetingId('https://us02web.zoom.us/j/123456789?pwd=abc'), '123456789');
assert.strictEqual(extractZoomMeetingId('https://evil.example/j/123456789'), null,
  'Only Zoom meeting URLs should be accepted');

async function testZoomMeetingSyncUsesCurrentSchedule() {
  const env = { ZOOM_ACCOUNT_ID: process.env.ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID: process.env.ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET: process.env.ZOOM_CLIENT_SECRET };
  process.env.ZOOM_ACCOUNT_ID = 'account';
  process.env.ZOOM_CLIENT_ID = 'client';
  process.env.ZOOM_CLIENT_SECRET = 'secret';
  const row = {
    rowIndex: 7, date: '05 Nov 2026', time: '04:00PM - 06:00PM',
    center: 'Laxmi Nagar', course: 'CLAT', subject: 'Updated Legal', faculty: 'New Faculty',
    zoomUrl: 'https://zoom.us/j/123456789?pwd=abc'
  };
  const matchingMeeting = {
    topic: 'TCR Laxmi Nagar CLAT - Updated Legal (New Faculty)',
    duration: 120,
    start_time: '2026-11-05T10:30:00Z',
    timezone: 'Asia/Kolkata'
  };
  try {
    assert.strictEqual(meetingMatches(row, matchingMeeting), true, 'A meeting with the same topic, duration and IST start must match');
    assert.strictEqual(meetingMatches(row, { ...matchingMeeting, topic: 'old topic' }), false, 'A different topic must not match');

    const matchCalls = [];
    const matchFetch = async (url, options) => {
      matchCalls.push({ url, options });
      if (url.includes('/oauth/token')) return { ok: true, json: async () => ({ access_token: 'access-token' }) };
      return { ok: true, json: async () => matchingMeeting };
    };
    assert.strictEqual(await syncZoomMeeting(row, matchFetch), 'unchanged', 'A matching meeting must not be updated');
    assert.strictEqual(matchCalls.length, 2, 'Only the token and the meeting lookup should be requested');
    assert.strictEqual(matchCalls[1].options.method, 'GET');

    const updateCalls = [];
    const updateFetch = async (url, options) => {
      updateCalls.push({ url, options });
      if (url.includes('/oauth/token')) return { ok: true, json: async () => ({ access_token: 'access-token' }) };
      if (options.method === 'GET') return { ok: true, json: async () => ({ ...matchingMeeting, duration: 30 }) };
      return { ok: true, json: async () => ({}) };
    };
    assert.strictEqual(await syncZoomMeeting(row, updateFetch), 'updated');
    const put = updateCalls.find(call => call.options.method === 'PUT');
    assert.ok(put, 'A drifted meeting must be updated in place');
    assert.match(put.url, /\/meetings\/123456789$/);
    assert.deepStrictEqual(JSON.parse(put.options.body), {
      topic: 'TCR Laxmi Nagar CLAT - Updated Legal (New Faculty)',
      type: 2,
      start_time: '2026-11-05T16:00:00',
      duration: 120,
      timezone: 'Asia/Kolkata'
    });
  } finally {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function testReconcileStoredZoomLinksUpdatesMismatchedMeetings() {
  const env = { ZOOM_ACCOUNT_ID: process.env.ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID: process.env.ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET: process.env.ZOOM_CLIENT_SECRET };
  process.env.ZOOM_ACCOUNT_ID = 'account';
  process.env.ZOOM_CLIENT_ID = 'client';
  process.env.ZOOM_CLIENT_SECRET = 'secret';
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/oauth/token')) return { ok: true, json: async () => ({ access_token: 'access-token' }) };
    if (options.method === 'GET') return { ok: true, json: async () => ({ topic: 'stale', duration: 30, start_time: '2020-01-01T00:00:00Z' }) };
    return { ok: true, json: async () => ({}) };
  };
  try {
    const { failures, replaced } = await reconcileStoredZoomLinks([
      { rowIndex: 7, date: '05 Nov 2026', time: '04:00PM - 06:00PM', center: 'Laxmi Nagar', course: 'CLAT', subject: 'Legal', faculty: 'Shivam Sir', zoomUrl: 'https://zoom.us/j/123456789' },
      { rowIndex: 8, date: '05 Nov 2026', time: '06:00PM - 08:00PM', center: 'Laxmi Nagar', course: 'CLAT', subject: 'English', faculty: 'Anand Sir', zoomUrl: 'https://zoom.us/j/987654321' }
    ], { fetchImpl });
    assert.deepStrictEqual(failures, []);
    assert.deepStrictEqual(replaced, [], 'Drifted meetings are updated in place, not replaced');
    assert.deepStrictEqual(
      calls.filter(call => call.options.method === 'PUT').map(call => call.url).sort(),
      ['https://api.zoom.us/v2/meetings/123456789', 'https://api.zoom.us/v2/meetings/987654321'],
      'Both stored meetings must be updated'
    );
  } finally {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function testReconcileStoredZoomLinksSkipsRowsWithoutStoredLink() {
  const env = { ZOOM_ACCOUNT_ID: process.env.ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID: process.env.ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET: process.env.ZOOM_CLIENT_SECRET };
  process.env.ZOOM_ACCOUNT_ID = 'account';
  process.env.ZOOM_CLIENT_ID = 'client';
  process.env.ZOOM_CLIENT_SECRET = 'secret';
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({}) }; };
  try {
    const { failures } = await reconcileStoredZoomLinks([
      { rowIndex: 9, date: '05 Nov 2026', time: '04:00 - 06:00PM', center: 'Laxmi Nagar', course: 'CLAT', subject: 'Legal', faculty: 'S', zoomUrl: '' },
      { rowIndex: 10, date: '05 Nov 2026', time: '04:00 - 06:00PM', center: 'Hauz Khas', course: 'CLAT', subject: 'Legal', faculty: 'S', zoomUrl: 'https://zoom.us/j/987654321' }
    ], { fetchImpl });
    assert.deepStrictEqual(failures, []);
    assert.strictEqual(calls.length, 0, 'Rows without a link, or that need no Zoom, must not be checked');
  } finally {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function testReconcileStoredZoomLinksRegeneratesUnverifiableLink() {
  const env = { ZOOM_ACCOUNT_ID: process.env.ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID: process.env.ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET: process.env.ZOOM_CLIENT_SECRET };
  process.env.ZOOM_ACCOUNT_ID = 'account';
  process.env.ZOOM_CLIENT_ID = 'client';
  process.env.ZOOM_CLIENT_SECRET = 'secret';
  const writes = [];
  const sheets = { spreadsheets: { values: { update: async request => { writes.push(request); return { data: {} }; } } } };
  const sheet = { title: 'Schedule', sheetId: 1 };
  const fetchImpl = async (url, options) => {
    if (url.includes('/oauth/token')) return { ok: true, json: async () => ({ access_token: 'access-token' }) };
    if (options.method === 'GET') return { ok: false, status: 404, json: async () => ({ code: 2300, message: 'This API endpoint is not recognized.' }) };
    return { ok: true, json: async () => ({ join_url: 'https://zoom.us/j/555555555' }) };
  };
  const row = {
    rowIndex: 127, date: '14 Nov 2026', time: '11:00AM - 12:30PM', center: 'Laxmi Nagar',
    course: 'CUET', subject: 'Reasoning', faculty: 'Shobit Sir', zoomUrl: 'https://zoom.us/j/89533069786'
  };
  try {
    const { failures, replaced } = await reconcileStoredZoomLinks([row], { fetchImpl, sheets, sheet });
    assert.deepStrictEqual(failures, []);
    assert.deepStrictEqual(replaced, [127], 'An unverifiable meeting must be replaced with a new one');
    assert.strictEqual(row.zoomUrl, 'https://zoom.us/j/555555555');
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].range, "'Schedule'!I127");
    assert.deepStrictEqual(writes[0].requestBody.values, [['https://zoom.us/j/555555555']]);
  } finally {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function testReconcileStoredZoomLinksReportsFailuresWithoutSheets() {
  const env = { ZOOM_ACCOUNT_ID: process.env.ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID: process.env.ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET: process.env.ZOOM_CLIENT_SECRET };
  process.env.ZOOM_ACCOUNT_ID = 'account';
  process.env.ZOOM_CLIENT_ID = 'client';
  process.env.ZOOM_CLIENT_SECRET = 'secret';
  const fetchImpl = async (url) => {
    if (url.includes('/oauth/token')) return { ok: true, json: async () => ({ access_token: 'access-token' }) };
    return { ok: false, status: 404, json: async () => ({ code: 2300, message: 'This API endpoint is not recognized.' }) };
  };
  try {
    const { failures, replaced } = await reconcileStoredZoomLinks([{ rowIndex: 7, date: '05 Nov 2026', time: '04:00PM - 06:00PM', center: 'Laxmi Nagar', course: 'CLAT', subject: 'Legal', faculty: 'S', zoomUrl: 'https://zoom.us/j/123456789' }], { fetchImpl });
    assert.strictEqual(failures.length, 1);
    assert.deepStrictEqual(replaced, []);
    assert.match(failures[0].message, /row 7 \(HTTP 404, code 2300, meeting 123456789\)/);
  } finally {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function testZoomEnvSuite() {
  await testZoomMeetingSyncUsesCurrentSchedule();
  await testReconcileStoredZoomLinksUpdatesMismatchedMeetings();
  await testReconcileStoredZoomLinksSkipsRowsWithoutStoredLink();
  await testReconcileStoredZoomLinksRegeneratesUnverifiableLink();
  await testReconcileStoredZoomLinksReportsFailuresWithoutSheets();
}


assert.deepStrictEqual(Object.keys(preview).sort(), [
  'answerCallbackQuery',
  'buildKeyboard',
  'callbackSignature',
  'fetchAllRows',
  'fetchPendingRows',
  'formatGroupMessage',
  'formatScheduleDate',
  'groupPendingRows',
  'indiaDateKey',
  'isPendingPreviewRow',
  'markRowsSent',
  'prepareZoomSend',
  'reconcileStoredZoomLinks',
  'runPreview',
  'scheduleDateKey',
  'sendTelegramMessage'
]);

const previewRows = [
  {
    rowIndex: 4, date: '06 Sept 2026', time: '4:00 - 6:00PM', center: 'Laxmi Nagar',
    course: 'CLAT', subject: 'Legal', faculty: 'Shivam Sir', status: '', zoomUrl: ''
  },
  {
    rowIndex: 5, date: '06 Sept 2026', time: '6:00 - 8:00PM', center: 'Laxmi Nagar',
    course: 'CLAT', subject: 'English', faculty: 'Anand Sir', status: '', zoomUrl: ''
  }
];
const previewGroups = groupPendingRows(previewRows);
assert.strictEqual(formatScheduleDate('06 Sept 2026'), '6th September');
assert.strictEqual(formatScheduleDate('6 Sept'), '6th September');
assert.strictEqual(formatZoomStartTime('06 Sept 2026', '04:00PM - 05:00PM'), '2026-09-06T16:00:00');
assert.strictEqual(getZoomDurationMins('04:00PM - 05:00PM'), 60);
assert.strictEqual(formatZoomStartTime('06 Sept 2026', '11:00AM - 12:30PM'), '2026-09-06T11:00:00');
assert.strictEqual(getZoomDurationMins('11:00AM - 12:30PM'), 90);
assert.strictEqual(formatZoomStartTime('06 Sept 2026', '12:50PM - 02:20PM'), '2026-09-06T12:50:00');
assert.strictEqual(getZoomDurationMins('12:50PM - 02:20PM'), 90);
assert.strictEqual(formatZoomStartTime('06 Sept 2026', '04:00 - 05:00PM'), '2026-09-06T16:00:00');
assert.strictEqual(previewGroups.length, 1, 'Classes for the same date, center, and course should group together');
assert.deepStrictEqual(previewGroups[0].rowIndices, [4, 5]);
assert.match(formatGroupMessage(previewGroups[0]), /\*Zoom:\* Link not prepared/);
const pendingKeyboard = buildKeyboard(previewGroups[0]).inline_keyboard;
assert.strictEqual(pendingKeyboard[0][0].text, '📤 Open WhatsApp (no Zoom)');
assert.strictEqual(pendingKeyboard[1][0].text, '🎥 Generate Zoom & Prepare Send');
const noZoomMessage = formatGroupMessage(previewGroups[0], { includeZoom: false });
assert.doesNotMatch(noZoomMessage, /Zoom/,
  'The no-Zoom variant must not contain a Zoom line or placeholder');
assert.ok(noZoomMessage.startsWith('*TCR - CLAT CLASS FLOW (LN)*'));
assert.strictEqual(
  decodeURIComponent(pendingKeyboard[0][0].url.split('text=')[1]),
  noZoomMessage,
  'The no-Zoom WhatsApp button must carry the formatted message without Zoom'
);
previewRows.forEach(row => {
  row.zoomUrl = `https://zoom.us/j/${row.rowIndex}`;
});
const preparedGroup = groupPendingRows(previewRows)[0];
assert.strictEqual(
  formatGroupMessage(preparedGroup),
  [
    '*TCR - CLAT CLASS FLOW (LN)*',
    '',
    '*Class Schedule*',
    '📌 6th September',
    '',
    '*4:00 - 6:00PM*',
    'Subject: *Legal*',
    'Faculty: *SHIVAM SIR*',
    '🔗 *Zoom:* https://zoom.us/j/4',
    '',
    '*6:00 - 8:00PM*',
    'Subject: *English*',
    'Faculty: *ANAND SIR*',
    '🔗 *Zoom:* https://zoom.us/j/5',
    '',
    'Regards,',
    '*TEAM TCR*'
  ].join('\n')
);
const preparedKeyboard = buildKeyboard(preparedGroup).inline_keyboard;
assert.strictEqual(preparedKeyboard[0][0].text, '📤 Open WhatsApp (with Zoom)');
assert.ok(preparedKeyboard[0][0].url.startsWith('https://wa.me/?text='));
assert.match(decodeURIComponent(preparedKeyboard[0][0].url.split('text=')[1]), /\*Zoom:\* https:\/\/zoom\.us/);
assert.strictEqual(preparedKeyboard[1][0].text, '📤 Open WhatsApp (no Zoom)');
assert.doesNotMatch(decodeURIComponent(preparedKeyboard[1][0].url.split('text=')[1]), /Zoom/);
assert.strictEqual(preparedKeyboard[2][0].text, '✅ Mark as sent');
const hauzKhasGroup = groupPendingRows([{
  rowIndex: 6, date: '06 Sept 2026', time: '4:00 - 6:00PM', center: 'Hauz Khas',
  course: 'CLAT/CUET/CLAT 28', subject: 'Legal', faculty: 'Shivam Sir', status: '',
  zoomUrl: 'https://zoom.us/j/987654321'
}])[0];
const hauzKhasMessage = formatGroupMessage(hauzKhasGroup);
assert.ok(hauzKhasMessage.startsWith('*TCR - CLAT/CUET/CLAT 28 CLASS FLOW (HK)*'));
assert.doesNotMatch(hauzKhasMessage, /Zoom/,
  'Hauz Khas schedules must not show Zoom links, even if a stale link is stored in the sheet');
previewRows.forEach(row => {
  row.status = 'SENT';
});
const sentKeyboard = buildKeyboard(groupPendingRows(previewRows)[0]).inline_keyboard;
assert.strictEqual(sentKeyboard[0][0].text, '📤 Send to WhatsApp (with Zoom)');
assert.strictEqual(sentKeyboard[1][0].text, '📤 Send to WhatsApp (no Zoom)');
assert.strictEqual(sentKeyboard.length, 2, 'Already-sent rows should remain resendable without another mark action');

const laxmiAlias = groupPendingRows([{
  rowIndex: 20, date: '06 Sept 2026', time: '4:00 - 6:00PM', center: 'Laxmi Nagar Centre',
  course: 'CLAT', subject: 'Legal', faculty: 'Shivam Sir', status: '', zoomUrl: ''
}])[0];
assert.ok(formatGroupMessage(laxmiAlias).startsWith('*TCR - CLAT CLASS FLOW (LN)*'),
  'Center aliases with a trailing "Centre" must still be tagged LN');
const hauzKhasAlias = groupPendingRows([{
  rowIndex: 21, date: '06 Sept 2026', time: '4:00 - 6:00PM', center: 'hauz khas center',
  course: 'CLAT/CUET', subject: 'Legal', faculty: 'Shivam Sir', status: '', zoomUrl: ''
}])[0];
assert.ok(formatGroupMessage(hauzKhasAlias).startsWith('*TCR - CLAT/CUET CLASS FLOW (HK)*'),
  'Hauz Khas Center (any case/spelling) must be tagged HK');
assert.strictEqual(isValidCronAuthorization('Bearer cron-secret', 'cron-secret'), true);
assert.strictEqual(isValidCronAuthorization('Bearer wrong-secret', 'cron-secret'), false);

// 1. Date normalization tests (leading zero handling & month abbrev)
assert.strictEqual(normalizeText('01 Oct 2026'), '1 oct 2026');
assert.strictEqual(normalizeText('1 Oct 2026'), '1 oct 2026');
assert.strictEqual(normalizeText('06 September 2026'), '6 sep 2026');
assert.strictEqual(normalizeText('06 Sept 2026'), '6 sep 2026');
assert.strictEqual(normalizeText('21 Oct 2026'), '21 oct 2026');

// 2. Filter matching tests for "01 Oct 2026" & "4 Oct 2026"
const row1Date = '1 Oct 2026';
const row1 = '1 Oct 2026 04:30PM - 06:30PM Laxmi Nagar CLAT - English (Meenakshi Maam)';

const row21Date = '21 Oct 2026';
const row21 = '21 Oct 2026 05:00PM - 07:00PM Laxmi Nagar AIBE - IEA/BSA (SHIVAM SIR)';

const row73Date = '1 Oct 2026';
const row73 = '1 Oct 2026 04:30PM - 06:30PM Laxmi Nagar CLAT - English (Meenakshi Maam)';

const row80Date = '04 Oct 2026';
const row80 = '04 Oct 2026 02:30PM - 04:30PM Laxmi Nagar CLAT - TCR CLAT Alumnus MOCK';

assert.strictEqual(matchesFilter(row1Date, row1, '01 Oct 2026'), true, '01 Oct 2026 should match 1 Oct 2026 row');
assert.strictEqual(matchesFilter(row21Date, row21, '01 Oct 2026'), false, '01 Oct 2026 should NOT match 21 Oct 2026 row');
assert.strictEqual(matchesFilter(row80Date, row80, '4 oct 2026'), true, '4 oct 2026 should match 04 Oct 2026 row');
assert.strictEqual(matchesFilter(row73Date, row73, '4 oct 2026'), false, '4 oct 2026 should NOT match 1 Oct 2026 row with 04:30PM time');

// 3. Natural / Flexible /create input parsing
const expectedParsed = {
  date: '06 Sept 2026',
  time: '4:00 - 6:00PM',
  center: 'Laxmi Nagar',
  course: 'CLAT',
  subject: 'Legal',
  faculty: 'Shivam Sir'
};

assert.deepStrictEqual(
  parseCreateArgs('06 Sept 2026 | 4:00 - 6:00PM | Laxmi Nagar | CLAT | Legal | Shivam Sir'),
  expectedParsed
);

assert.deepStrictEqual(
  parseCreateArgs('06 Sept 2026, 4:00 - 6:00PM, Laxmi Nagar, CLAT, Legal, Shivam Sir'),
  expectedParsed
);

assert.deepStrictEqual(
  parseCreateArgs('06 Sept 2026\n4:00 - 6:00PM\nLaxmi Nagar\nCLAT\nLegal\nShivam Sir'),
  expectedParsed
);

assert.deepStrictEqual(
  parseCreateArgs('Date: 06 Sept 2026\nTime: 4:00 - 6:00PM\nCenter: Laxmi Nagar\nCourse: CLAT\nSubject: Legal\nFaculty: Shivam Sir'),
  expectedParsed
);

// 4. Test parseDateStrToVal with various date formats
assert.ok(parseDateStrToVal('06 Sept') > 0, '06 Sept without year should parse');
assert.ok(parseDateStrToVal('6 Oct') > 0, '6 Oct without year should parse');
assert.ok(parseDateStrToVal('Oct 6') > 0, 'Oct 6 reverse order should parse');
assert.ok(parseDateStrToVal('1st Oct 2026') > 0, '1st Oct with ordinal suffix should parse');
assert.strictEqual(
  new Date(parseDateStrToVal('06 Sept')).getUTCMonth(),
  8,
  '06 Sept month should be September (month index 8)'
);
assert.strictEqual(
  new Date(parseDateStrToVal('06 Sept')).getUTCDate(),
  6,
  '06 Sept date should be 6'
);
assert.strictEqual(
  parseStartTimeToMinutes('01:00PM - 03:00PM'),
  13 * 60,
  '12-hour PM input should parse as a 24-hour local time'
);
assert.strictEqual(parseStartTimeToMinutes('25:00'), null, 'Invalid 24-hour times should be rejected');

const istAfternoonStart = createCalendarStartDate('31 Dec 2026', '01:00PM - 03:00PM');
assert.strictEqual(
  istAfternoonStart.toISOString(),
  '2026-12-31T07:30:00.000Z',
  '1:00 PM IST should be sent to Google Calendar as 07:30 UTC'
);
const istEarlyMorningStart = createCalendarStartDate('31 Dec 2026', '01:00AM - 03:00AM');
assert.strictEqual(
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(istEarlyMorningStart),
  '31/12/2026, 01:00',
  'UTC conversion should preserve the requested IST date for early-morning classes'
);
assert.strictEqual(createCalendarStartDate('31 Dec 2026', 'invalid'), null);

// 5. Chronological Sorting & Insertion Tests
const existingRows = [
  ['Date', 'Time', 'Center', 'Course', 'Subject', 'Faculty'],
  ['04 Oct 2026', '02:30PM - 04:30PM', 'Laxmi Nagar', 'CLAT'],
  ['04 Oct 2026', '05:00PM - 07:00PM', 'Laxmi Nagar', 'CLAT'],
  ['05 Oct 2026', '11:00AM - 01:00PM', 'Laxmi Nagar', 'CLAT'],
  ['18 Nov 2026', '05:00PM - 07:00PM', 'Laxmi Nagar', 'AIBE'],
  ['20 Nov 2026', '05:00PM - 07:00PM', 'Laxmi Nagar', 'AIBE']
];

const insertIdx6Oct = findInsertionRowIndex(
  existingRows,
  parseDateStrToVal('6 Oct 2026'),
  parseStartTimeToMinutes('03:00PM - 05:00PM')
);
assert.strictEqual(insertIdx6Oct, 5, '6 Oct class should be inserted at Row 5');

const insertIdx5OctAfternoon = findInsertionRowIndex(
  existingRows,
  parseDateStrToVal('05 Oct 2026'),
  parseStartTimeToMinutes('03:00PM - 05:00PM')
);
assert.strictEqual(insertIdx5OctAfternoon, 5, '05 Oct 03:00PM class should be inserted at Row 5');

const insertIdx4OctMidday = findInsertionRowIndex(
  existingRows,
  parseDateStrToVal('04 Oct 2026'),
  parseStartTimeToMinutes('04:00PM - 06:00PM')
);
assert.strictEqual(insertIdx4OctMidday, 3, '04 Oct 04:00PM class should be inserted at Row 3');

const insertIdx25Nov = findInsertionRowIndex(
  existingRows,
  parseDateStrToVal('25 Nov 2026'),
  parseStartTimeToMinutes('05:00PM - 07:00PM')
);
assert.strictEqual(insertIdx25Nov, 7, '25 Nov class should be appended at Row 7');

// 6. Telegram-created rows keep GAS status in G and Calendar event ID in H
const scheduleRowValues = createScheduleRowValues({
  date: '07 Oct 2026',
  time: '03:00PM - 05:00PM',
  center: 'Laxmi Nagar',
  course: 'AIBE',
  subject: 'Legal',
  faculty: 'SHIVAM SIR'
}, 'calendar-event-icaluid');
assert.strictEqual(scheduleRowValues.length, 8, 'Schedule row should cover columns A-H');
assert.strictEqual(scheduleRowValues[6], '', 'Column G should remain available for GAS SENT status');
assert.strictEqual(scheduleRowValues[7], 'calendar-event-icaluid', 'Column H should store the Calendar event iCalUID');

async function testExplicitScheduleRowWrite() {
  const calls = [];
  const sheets = {
    spreadsheets: {
      batchUpdate: async request => calls.push({ method: 'batchUpdate', request }),
      values: {
        append: async () => { throw new Error('Append API must not be used'); },
        update: async request => calls.push({ method: 'update', request })
      }
    }
  };

  await writeScheduleRow(
    sheets,
    { title: 'Schedule', sheetId: 9 },
    112,
    scheduleRowValues
  );

  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].method, 'batchUpdate');
  assert.deepStrictEqual(
    calls[0].request.requestBody.requests[0].insertDimension.range,
    { sheetId: 9, dimension: 'ROWS', startIndex: 111, endIndex: 112 }
  );
  assert.strictEqual(calls[1].method, 'update');
  assert.strictEqual(calls[1].request.range, "'Schedule'!A112:H112");
  assert.deepStrictEqual(calls[1].request.requestBody.values, [scheduleRowValues]);
}

async function testCalendarAndRowDeletion() {
  const calls = [];
  const calendar = {
    events: {
      get: async () => { const error = new Error('Not found'); error.code = 404; throw error; },
      list: async request => {
        calls.push({ method: 'list', request });
        return { data: { items: [{ id: 'calendar-event-id' }] } };
      },
      delete: async request => calls.push({ method: 'calendar-delete', request })
    }
  };
  const sheets = {
    spreadsheets: {
      values: {
        get: async request => {
          calls.push({ method: 'get-row', request });
          return { data: { values: [['07 Oct 2026', '3PM', 'Center', 'Course', 'Subject', 'Faculty', '', 'class-ical-uid']] } };
        }
      },
      batchUpdate: async request => calls.push({ method: 'sheet-delete', request })
    }
  };

  const result = await deleteScheduleRow(sheets, calendar, { title: 'Schedule', sheetId: 9 }, 12, 'calendar-id');
  assert.strictEqual(result, 'deleted');
  assert.deepStrictEqual(
    calls.map(call => call.method),
    ['get-row', 'list', 'calendar-delete', 'sheet-delete'],
    'The event should be deleted before its linked row'
  );
  assert.strictEqual(calls[1].request.iCalUID, 'class-ical-uid');
  assert.deepStrictEqual(calls[2].request, { calendarId: 'calendar-id', eventId: 'calendar-event-id' });
  assert.strictEqual(calls[3].request.requestBody.requests[0].deleteDimension.range.startIndex, 11);

  const directIdCalls = [];
  assert.strictEqual(await deleteCalendarEvent({
    events: {
      get: async request => directIdCalls.push({ method: 'get', request }),
      delete: async request => directIdCalls.push({ method: 'delete', request }),
      list: async () => { throw new Error('iCalUID lookup should not be needed'); }
    }
  }, 'calendar-id', 'gas-event-id'), 'deleted');
  assert.deepStrictEqual(directIdCalls.map(call => call.method), ['get', 'delete']);

  let rowDeleted = false;
  await assert.rejects(
    () => deleteScheduleRow({
      spreadsheets: {
        values: { get: async () => ({ data: { values: [['date', 'time', 'center', 'course', 'subject', 'faculty', '', 'uid']] } }) },
        batchUpdate: async () => { rowDeleted = true; }
      }
    }, {
      events: {
        list: async () => { throw new Error('Calendar permission denied'); }
      }
    }, { title: 'Schedule', sheetId: 9 }, 12, 'calendar-id'),
    error => error.userMessage.includes('schedule row 12 was kept'),
    'Calendar failures should explain that the row was not removed'
  );
  assert.strictEqual(rowDeleted, false, 'Do not remove the row when event deletion fails');

  const notFoundCalendar = {
    events: {
      get: async () => { const error = new Error('Not found'); error.code = 404; throw error; },
      list: async () => ({ data: { items: [] } }),
      delete: async () => { const error = new Error('Not found'); error.code = 404; throw error; }
    }
  };
  assert.strictEqual(await deleteCalendarEvent(notFoundCalendar, 'calendar-id', 'stale-id'), 'not-found');
  assert.ok(telegramCommands.some(command => command.command === 'help'));
  assert.ok(telegramCommands.some(command => command.command === 'delete'));
}

assert.deepStrictEqual(
  getMissingConfiguration({}),
  ['TELEGRAM_BOT_TOKEN', 'AUTHORIZED_CHAT_ID', 'SPREADSHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_KEY', 'TELEGRAM_WEBHOOK_SECRET'],
  'All required deployment configuration should be reported when missing'
);
assert.deepStrictEqual(
  getMissingConfiguration({
    TELEGRAM_BOT_TOKEN: 'configured',
    AUTHORIZED_CHAT_ID: 'configured',
    SPREADSHEET_ID: 'configured',
    GOOGLE_SERVICE_ACCOUNT_KEY: 'configured',
    TELEGRAM_WEBHOOK_SECRET: 'configured'
  }),
  [],
  'A complete deployment configuration should pass validation'
);
assert.strictEqual(isValidWebhookSecret('expected-secret', 'expected-secret'), true);
assert.strictEqual(isValidWebhookSecret('wrong-secret', 'expected-secret'), false);
assert.strictEqual(isValidWebhookSecret(undefined, 'expected-secret'), false);
assert.strictEqual(
  hasCompleteScheduleDetails({ date: '1 Oct', time: '9AM', center: 'A', course: 'B', subject: 'C', faculty: 'D' }),
  true
);
assert.strictEqual(
  hasCompleteScheduleDetails({ date: '1 Oct', time: '9AM', center: 'A', course: 'B', subject: '', faculty: 'D' }),
  false,
  'Incomplete class data must not be accepted as a complete row'
);


function createAuthorizedChatsSheets(){
 let exists=false,rows=[]; const sheets={spreadsheets:{
  get:async()=>({data:{sheets:exists?[{properties:{title:'AuthorizedChats',sheetId:12}}]:[]}}),
  batchUpdate:async({requestBody})=>{if(requestBody.requests[0].addSheet){exists=true;return {data:{replies:[{addSheet:{properties:{title:'AuthorizedChats',sheetId:12}}}]}};}for(const q of requestBody.requests){const r=q.deleteDimension.range;rows.splice(r.startIndex,r.endIndex-r.startIndex);}return {data:{}};},
  values:{update:async({requestBody})=>{rows=requestBody.values.map(x=>[...x]);return {data:{}};},get:async()=>({data:{values:rows.map(x=>[...x])}}),append:async({requestBody})=>{rows.push(...requestBody.values.map(x=>[...x]));return {data:{}};}}
 }};return {sheets};
}
async function testChatAccess(){
 assert.strictEqual(chatAccess.normalizeChatId(' -1001234567890 '),'-1001234567890');
 assert.strictEqual(chatAccess.normalizeChatId('0'),null); assert.strictEqual(chatAccess.normalizeChatId('abc'),null);
 assert.deepStrictEqual(telegramCommands.filter(x=>['status','pending','faculty'].includes(x.command)),[]);
 const fixture=createAuthorizedChatsSheets(), opts={sheets:fixture.sheets,spreadsheetId:'sheet',initialChatId:'12345'};
 assert.deepStrictEqual(await chatAccess.listAuthorizedChatIds(opts),['12345']);
 assert.strictEqual(await chatAccess.addAuthorizedChatId({...opts,chatId:'-1001234567890'}),true);
 assert.strictEqual(await chatAccess.addAuthorizedChatId({...opts,chatId:'-1001234567890'}),false);
 assert.strictEqual(await chatAccess.isAuthorizedChat({...opts,chatId:'-1001234567890',userId:'77'}),true);
 assert.strictEqual(await chatAccess.isAuthorizedChat({...opts,chatId:'555',userId:'77'}),false);
 assert.strictEqual(await chatAccess.isAuthorizedChat({chatId:'555',userId:chatAccess.ADMIN_USER_ID}),true);
 await assert.rejects(()=>chatAccess.removeAuthorizedChatId({...opts,chatId:chatAccess.ADMIN_USER_ID}),/permanently authorized/);
 assert.strictEqual(await chatAccess.removeAuthorizedChatId({...opts,chatId:'-1001234567890'}),true);
 assert.strictEqual(await chatAccess.isAuthorizedChat({...opts,chatId:'-1001234567890',userId:'77'}),false);
}

function createMockResponse() {
  return {
    statusCode: 0,
    body: '',
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

async function testHealthEndpoint() {
  const response = createMockResponse();
  await telegramWebhook({ method: 'GET' }, response);
  assert.strictEqual(response.statusCode, 200, 'Health endpoint should respond successfully');
  assert.match(response.body, /Telegram Bot Webhook API is running/);
}

async function testOperationalGuards() {
  const configNames = [
    'TELEGRAM_BOT_TOKEN',
    'AUTHORIZED_CHAT_ID',
    'SPREADSHEET_ID',
    'GOOGLE_SERVICE_ACCOUNT_KEY',
    'TELEGRAM_WEBHOOK_SECRET'
  ];
  const originalValues = new Map(configNames.map(name => [name, process.env[name]]));
  try {
    configNames.forEach(name => delete process.env[name]);
    const response = createMockResponse();
    await telegramWebhook({ method: 'POST', body: {} }, response);
    assert.strictEqual(response.statusCode, 500, 'Webhook should reject missing server configuration');
    assert.deepStrictEqual(response.body.missingEnvironmentVariables, configNames);
  } finally {
    for (const [name, value] of originalValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const sheetDetails = await resolveSheetDetails({
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: [
            { properties: { title: 'Other', sheetId: 3 } },
            { properties: { title: 'Schedule', sheetId: 9 } }
          ]
        }
      })
    }
  });
  assert.deepStrictEqual(sheetDetails, { title: 'Schedule', sheetId: 9 });
  await assert.rejects(
    () => resolveSheetDetails({ spreadsheets: { get: async () => { throw new Error('Sheets API unavailable'); } } }),
    /Sheets API unavailable/,
    'Sheets API failures must not fall back to a fake sheet ID'
  );
  await assert.rejects(
    () => resolveSheetDetails({ spreadsheets: { get: async () => ({ data: { sheets: [] } }) } }),
    /does not contain a usable sheet tab/
  );

  const env = {
    TELEGRAM_BOT_TOKEN: 'configured',
    AUTHORIZED_CHAT_ID: 'configured',
    SPREADSHEET_ID: 'configured',
    GOOGLE_SERVICE_ACCOUNT_KEY: 'configured',
    TELEGRAM_WEBHOOK_SECRET: 'expected-secret'
  };
  const webhookOriginalValues = new Map(Object.entries(env).map(([name]) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(env)) process.env[name] = value;

    const rejectedResponse = createMockResponse();
    await telegramWebhook({ method: 'POST', headers: {}, body: {} }, rejectedResponse);
    assert.strictEqual(rejectedResponse.statusCode, 401, 'Webhook should reject missing Telegram secret header');

    const acceptedResponse = createMockResponse();
    await telegramWebhook({
      method: 'POST',
      headers: { 'x-telegram-bot-api-secret-token': 'expected-secret' },
      body: {}
    }, acceptedResponse);
    assert.strictEqual(acceptedResponse.statusCode, 200, 'Webhook should accept the configured Telegram secret');
  } finally {
    for (const [name, value] of webhookOriginalValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function testVoiceTranscription() {
  const originalKey = process.env.GROQ_API_KEY;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ text: '  create class tomorrow  ' }) };
  };
  try {
    delete process.env.GROQ_API_KEY;
    assert.strictEqual(voice.isVoiceConfigured(), false, 'Voice must report unconfigured without GROQ_API_KEY');
    await assert.rejects(
      () => voice.transcribeVoice(Buffer.from('audio'), { fetchImpl }),
      error => error.code === 'NOT_CONFIGURED',
      'A missing GROQ_API_KEY must surface as NOT_CONFIGURED'
    );
    assert.strictEqual(calls.length, 0, 'No request must be sent without an API key');

    process.env.GROQ_API_KEY = 'test-groq-key';
    assert.strictEqual(voice.isVoiceConfigured(), true);
    const transcript = await voice.transcribeVoice(Buffer.from('audio-bytes'), { mimeType: 'audio/ogg', fetchImpl });
    assert.strictEqual(transcript, 'create class tomorrow', 'The transcript should be trimmed');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.strictEqual(calls[0].options.method, 'POST');
    assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer test-groq-key');
    assert.ok(calls[0].options.body instanceof FormData, 'Transcription must use multipart form data');
    assert.strictEqual(calls[0].options.body.get('model'), 'whisper-large-v3-turbo');
    const uploadedFile = calls[0].options.body.get('file');
    assert.strictEqual(uploadedFile.name, 'voice.ogg');
    assert.strictEqual(uploadedFile.type, 'audio/ogg');
    assert.ok(calls[0].options.signal instanceof AbortSignal, 'The request must carry a timeout signal');

    const rateLimited = async () => ({ ok: false, status: 429, json: async () => ({}) });
    await assert.rejects(
      () => voice.transcribeVoice(Buffer.from('audio'), { fetchImpl: rateLimited }),
      error => error.code === 'RATE_LIMITED',
      'HTTP 429 must surface as RATE_LIMITED'
    );

    const emptySpeech = async () => ({ ok: true, status: 200, json: async () => ({ text: '   ' }) });
    await assert.rejects(
      () => voice.transcribeVoice(Buffer.from('audio'), { fetchImpl: emptySpeech }),
      error => error.code === 'TRANSCRIBE_FAILED',
      'An empty transcript must surface as TRANSCRIBE_FAILED'
    );
  } finally {
    if (originalKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalKey;
  }
}

async function testVoiceClassExtraction() {
  const originalKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-groq-key';
  const calls = [];
  const extractionResponse = classes => ({
    choices: [{ message: { content: JSON.stringify({ classes }) } }]
  });
  const twoClasses = [
    { date: '06 Sept 2026', time: '4:00 - 6:00PM', center: 'Laxmi Nagar', course: 'CLAT', subject: 'Legal', faculty: 'Shivam Sir' },
    { date: '07 Sept 2026', time: '6:00 - 8:00PM', center: 'Hauz Khas', course: 'CUET', subject: 'English', faculty: 'Anand Sir' }
  ];
  try {
    const fetchImpl = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => extractionResponse(twoClasses) };
    };
    const extracted = await voice.extractClasses('do classes on 6th and 7th', {
      todayKey: '13 Nov 2026',
      centers: ['Laxmi Nagar', 'Hauz Khas'],
      courses: ['CLAT'],
      fetchImpl
    });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.strictEqual(calls[0].body.model, 'openai/gpt-oss-20b');
    assert.strictEqual(calls[0].body.temperature, 0);
    assert.strictEqual(calls[0].body.response_format.type, 'json_schema');
    const schema = calls[0].body.response_format.json_schema.schema;
    assert.strictEqual(schema.properties.classes.minItems, 1);
    assert.strictEqual(schema.properties.classes.maxItems, 10);
    assert.deepStrictEqual(schema.properties.classes.items.required.slice().sort(), ['center', 'course', 'date', 'faculty', 'subject', 'time']);
    assert.match(calls[0].body.messages[0].content, /13 Nov 2026/, 'The prompt must carry the caller-provided today key');
    assert.match(calls[0].body.messages[0].content, /Laxmi Nagar/, 'The prompt must carry the allowed centers');
    assert.deepStrictEqual(extracted.classes.map(cls => cls.date), ['06 Sept 2026', '07 Sept 2026']);
    assert.strictEqual(extracted.classes[1].faculty, 'Anand Sir');

    calls.length = 0;
    const fallbackFetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (calls.length === 1) return { ok: false, status: 400, json: async () => ({ error: 'json_schema unsupported' }) };
      return { ok: true, status: 200, json: async () => extractionResponse([twoClasses[0]]) };
    };
    const fallback = await voice.extractClasses('one class', { todayKey: '13 Nov 2026', fetchImpl: fallbackFetch });
    assert.strictEqual(calls.length, 2, 'A rejected json_schema response must be retried once');
    assert.deepStrictEqual(calls[1].body.response_format, { type: 'json_object' });
    assert.strictEqual(fallback.classes.length, 1);

    const fencedJson = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '```json\n{"classes":[{"date":"06 Sept 2026","time":"4:00 - 6:00PM","center":"Laxmi Nagar","course":"CLAT","subject":"Legal","faculty":"Shivam Sir"}]}\n```' } }] })
    });
    const fenced = await voice.extractClasses('fenced', { todayKey: '13 Nov 2026', fetchImpl: fencedJson });
    assert.strictEqual(fenced.classes.length, 1, 'Fenced JSON should be parsed tolerantly');

    const malformed = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }) });
    await assert.rejects(
      () => voice.extractClasses('bad', { todayKey: '13 Nov 2026', fetchImpl: malformed }),
      error => error.code === 'EXTRACT_FAILED',
      'Malformed model output must surface as EXTRACT_FAILED'
    );

    const failing = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await assert.rejects(
      () => voice.extractClasses('down', { todayKey: '13 Nov 2026', fetchImpl: failing }),
      error => error.code === 'EXTRACT_FAILED',
      'A failing extraction service must surface as EXTRACT_FAILED'
    );
  } finally {
    if (originalKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalKey;
  }
}

async function testVoiceProviders() {
  await testVoiceTranscription();
  await testVoiceClassExtraction();
}

function testVoiceValidateClasses() {
  const spoken = {
    classes: [
      { date: '06 Sept 2026', time: '4:00 - 6:00PM', center: 'Laxmi Nagar', course: 'CLAT', subject: 'Legal', faculty: 'Shivam Sir' },
      { date: '07 Sept 2026', time: '6:00 - 8:00PM', center: 'Hauz Khas', course: 'CUET', subject: 'English', faculty: 'Anand Sir' },
      { date: '08 Sept 2026', time: '4:00 - 6:00PM', center: 'Laxmi Nagar', course: 'CLAT', subject: 'Legal', faculty: '   ' }
    ]
  };
  const deps = { parseDateStrToVal, parseStartTimeToMinutes, hasCompleteScheduleDetails };
  const { valid, skipped } = voice.validateClasses(spoken, deps);
  assert.strictEqual(valid.length, 2, 'Only complete classes should be kept');
  assert.strictEqual(skipped.length, 1, 'Incomplete classes should be reported as skipped');
  assert.match(skipped[0].reason, /faculty/, 'The skip reason should name the missing field');
  assert.strictEqual(skipped[0].class.faculty, '', 'Skipped classes should be trimmed strings');

  const kept = voice.validateClasses({ classes: [{
    date: '06 Sept 2026', time: '4 to 6 pm', center: 'Laxmi Nagar', course: 'CLAT', subject: 'Legal', faculty: 'Shivam Sir'
  }] }, deps);
  assert.strictEqual(kept.valid.length, 1, 'A spoken-format time that the app can parse must be accepted');
  assert.strictEqual(kept.valid[0].time, '4 to 6 pm', 'The spoken time string must be preserved for the sheet');

  const unresolved = voice.validateClasses({ classes: [{
    date: 'tomorrow', time: '4 to 6 pm', center: 'Laxmi Nagar', course: 'CLAT', subject: 'Legal', faculty: 'Shivam Sir'
  }] }, deps);
  assert.strictEqual(unresolved.valid.length, 0, 'An unparseable date must be skipped');
  assert.match(unresolved.skipped[0].reason, /date/, 'The skip reason should mention the date');

  assert.deepStrictEqual(voice.validateClasses({}).valid, [], 'An empty extraction should yield no valid classes');
}

function testLooksLikeCreateRequest() {
  for (const transcript of [
    'Create a class tomorrow at four',
    'add one lecture for CLAT',
    'schedule a session on 6 Sept',
    'please add another batch',
    'क्लास शेड्यूल करो',
    'नई क्लास जोड़ो'
  ]) {
    assert.strictEqual(voice.looksLikeCreateRequest(transcript), true, `Should look like a create request: ${transcript}`);
  }
  for (const transcript of ['hello', 'what is the weather today', 'thanks', '']) {
    assert.strictEqual(voice.looksLikeCreateRequest(transcript), false, `Should not look like a create request: ${transcript}`);
  }
}

function createDraftsSheets() {
  let exists = false;
  const rows = [];
  const sheets = { spreadsheets: {
    get: async () => ({ data: { sheets: exists ? [{ properties: { title: 'Drafts', sheetId: 22 } }] : [] } }),
    batchUpdate: async ({ requestBody }) => {
      if (requestBody.requests[0].addSheet) {
        exists = true;
        return { data: { replies: [{ addSheet: { properties: { title: 'Drafts', sheetId: 22 } } }] } };
      }
      for (const request of requestBody.requests) {
        const range = request.deleteDimension.range;
        rows.splice(range.startIndex, range.endIndex - range.startIndex);
      }
      return { data: {} };
    },
    values: {
      update: async ({ requestBody }) => { rows.splice(0, rows.length, ...requestBody.values.map(row => [...row])); return { data: {} }; },
      append: async ({ requestBody }) => { rows.push(...requestBody.values.map(row => [...row])); return { data: {} }; },
      get: async () => ({ data: { values: rows.map(row => [...row]) } })
    }
  } };
  return { sheets, rows };
}

async function testDraftsFlow() {
  const { sheets, rows } = createDraftsSheets();
  const options = { sheets, spreadsheetId: 'sheet' };
  const classes = [{
    date: '06 Sept 2026', time: '4:00 - 6:00PM', center: 'Laxmi Nagar',
    course: 'CLAT', subject: 'Legal', faculty: 'Shivam Sir'
  }];

  const before = Date.now();
  const draftId = await drafts.saveDraft({ ...options, chatId: '12345', userId: '77', classes });
  assert.match(draftId, /^[a-f0-9]{8}$/, 'A draft ID must be 8 lowercase hex characters');
  assert.deepStrictEqual(rows[0], ['Draft ID', 'Chat ID', 'User ID', 'Expires At', 'Payload'],
    'The Drafts tab must carry the documented header row');
  const expiry = Date.parse(rows[1][3]);
  assert.ok(expiry >= before + 29 * 60 * 1000 && expiry <= Date.now() + 30 * 60 * 1000,
    'A draft should expire 30 minutes after it is saved');
  assert.deepStrictEqual(JSON.parse(rows[1][4]), classes, 'The payload must store the parsed classes');

  assert.strictEqual(await drafts.takeDraft({ ...options, chatId: '999', userId: '77', draftId }), null,
    'Another chat must not consume the draft');
  assert.strictEqual(rows.length, 2, 'A rejected take must leave the draft row in place');
  assert.strictEqual(await drafts.takeDraft({ ...options, chatId: '12345', userId: '88', draftId }), null,
    'Another user must not consume the draft');

  assert.deepStrictEqual(await drafts.takeDraft({ ...options, chatId: '12345', userId: '77', draftId }), classes,
    'The owning chat should receive the stored classes');
  assert.strictEqual(rows.length, 1, 'Taking a draft must delete its row');
  assert.strictEqual(await drafts.takeDraft({ ...options, chatId: '12345', userId: '77', draftId }), null,
    'A draft is single-use');

  await drafts.saveDraft({ ...options, chatId: '12345', userId: '77', classes });
  rows[1][3] = new Date(Date.now() - 60 * 1000).toISOString();
  await drafts.deleteExpiredDrafts(options);
  assert.strictEqual(rows.length, 1, 'Expired drafts should be removed from the tab');

  await drafts.deleteExpiredDrafts({
    sheets: { spreadsheets: { get: async () => { throw new Error('Sheets unavailable'); } } },
    spreadsheetId: 'sheet'
  }); // Cleanup must stay best-effort and never throw to the caller.
}

function testDraftKeyboardCallbackData() {
  const keyboard = telegramWebhook._buildDraftKeyboard('abcdef12', 3);
  const buttons = keyboard.inline_keyboard.flat();
  assert.deepStrictEqual(buttons.map(button => button.callback_data), ['draft:abcdef12', 'draft-cancel:abcdef12']);
  buttons.forEach(button => assert.ok(
    Buffer.byteLength(button.callback_data, 'utf8') <= 64,
    `Callback data must fit Telegram's 64-byte limit: ${button.callback_data}`
  ));
  assert.match(buttons[0].text, /3/, 'The create button should name how many classes will be created');
}

Promise.all([
  testHealthEndpoint(),
  testOperationalGuards(),
  testExplicitScheduleRowWrite(),
  testCalendarAndRowDeletion(),
  testZoomEnvSuite(),
  testChatAccess(),
  testVoiceProviders(),
  testVoiceValidateClasses(),
  testLooksLikeCreateRequest(),
  testDraftsFlow(),
  testDraftKeyboardCallbackData()
])
  .then(() => console.log('All Telegram schedule bot tests passed successfully!'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
