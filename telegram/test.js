const assert = require('assert');
const telegramWebhook = require('./api/index');

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
  _resolveSheetDetails: resolveSheetDetails
} = telegramWebhook;

console.log('Running search/filter, natural input & chronological sorting tests...');

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

// 4. Test parseDateStrToVal with various date formats (including missing year, ordinal suffixes, reverse day/month)
const year = new Date().getFullYear();
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

// 5. Chronological Sorting & Insertion Tests
const existingRows = [
  ['Date', 'Time', 'Center', 'Course', 'Subject', 'Faculty'],
  ['04 Oct 2026', '02:30PM - 04:30PM', 'Laxmi Nagar', 'CLAT'],
  ['04 Oct 2026', '05:00PM - 07:00PM', 'Laxmi Nagar', 'CLAT'],
  ['05 Oct 2026', '11:00AM - 01:00PM', 'Laxmi Nagar', 'CLAT'],
  ['18 Nov 2026', '05:00PM - 07:00PM', 'Laxmi Nagar', 'AIBE'],
  ['20 Nov 2026', '05:00PM - 07:00PM', 'Laxmi Nagar', 'AIBE']
];

// Case A: Insert 6 Oct 2026 (between 05 Oct and 18 Nov) -> should insert before Row 5 (18 Nov), returning Row 5!
const insertIdx6Oct = findInsertionRowIndex(
  existingRows,
  parseDateStrToVal('6 Oct 2026'),
  parseStartTimeToMinutes('03:00PM - 05:00PM')
);
assert.strictEqual(insertIdx6Oct, 5, '6 Oct class should be inserted at Row 5');

// Case B: Insert 05 Oct 2026 @ 03:00PM (after 05 Oct 11:00AM and before 18 Nov) -> should insert before Row 5, returning Row 5!
const insertIdx5OctAfternoon = findInsertionRowIndex(
  existingRows,
  parseDateStrToVal('05 Oct 2026'),
  parseStartTimeToMinutes('03:00PM - 05:00PM')
);
assert.strictEqual(insertIdx5OctAfternoon, 5, '05 Oct 03:00PM class should be inserted at Row 5');

// Case C: Insert 04 Oct 2026 @ 04:00PM (between 02:30PM and 05:00PM) -> should insert before Row 3 (05:00PM), returning Row 3!
const insertIdx4OctMidday = findInsertionRowIndex(
  existingRows,
  parseDateStrToVal('04 Oct 2026'),
  parseStartTimeToMinutes('04:00PM - 06:00PM')
);
assert.strictEqual(insertIdx4OctMidday, 3, '04 Oct 04:00PM class should be inserted at Row 3');

// Case D: Insert 25 Nov 2026 (after all existing dates) -> should append at bottom (Row 7)
const insertIdx25Nov = findInsertionRowIndex(
  existingRows,
  parseDateStrToVal('25 Nov 2026'),
  parseStartTimeToMinutes('05:00PM - 07:00PM')
);
assert.strictEqual(insertIdx25Nov, 7, '25 Nov class should be appended at Row 7');

// 6. Telegram-created rows keep the GAS status in G and store the Calendar event ID in H
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

Promise.all([testHealthEndpoint(), testOperationalGuards()])
  .then(() => console.log('All Telegram schedule bot tests passed successfully!'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
