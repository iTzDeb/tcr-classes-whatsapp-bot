const GROQ_API_URL = 'https://api.groq.com/openai/v1';
const TRANSCRIBE_MODEL = 'whisper-large-v3-turbo';
const EXTRACT_MODEL = 'openai/gpt-oss-20b';
const REQUEST_TIMEOUT_MS = 20000;
const CLASS_FIELDS = ['date', 'time', 'center', 'course', 'subject', 'faculty'];
const CREATE_INTENT_PATTERN = /\b(?:create|add|schedule|class|classes|lecture|lectures|session|sessions|slot|timetable|batch|batches)\b|तारीख|क्लास|क्लासेस|शेड्यूल|व्याख्यान|जोड़|बनाओ/iu;

function voiceError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireApiKey() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw voiceError('GROQ_API_KEY is not configured.', 'NOT_CONFIGURED');
  return apiKey;
}

function isVoiceConfigured() {
  return Boolean(process.env.GROQ_API_KEY);
}

function authorizationHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

async function transcribeVoice(audioBuffer, { mimeType = 'audio/ogg', fetchImpl = fetch } = {}) {
  const apiKey = requireApiKey();
  const body = new FormData();
  body.append('file', new Blob([audioBuffer], { type: mimeType }), 'voice.ogg');
  body.append('model', TRANSCRIBE_MODEL);

  let response;
  try {
    response = await fetchImpl(`${GROQ_API_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: authorizationHeaders(apiKey),
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw voiceError('The voice transcription service could not be reached.', 'TRANSCRIBE_FAILED');
  }

  if (response.status === 429 || response.status === 413) {
    throw voiceError('The voice transcription service is rate limited.', 'RATE_LIMITED');
  }
  if (!response.ok) throw voiceError(`Voice transcription failed (${response.status}).`, 'TRANSCRIBE_FAILED');

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw voiceError('Voice transcription returned an invalid response.', 'TRANSCRIBE_FAILED');
  }
  const transcript = String(payload.text || '').trim();
  if (!transcript) throw voiceError('No speech was recognised in the voice note.', 'TRANSCRIBE_FAILED');
  return transcript;
}

function looksLikeCreateRequest(transcript) {
  return CREATE_INTENT_PATTERN.test(String(transcript || ''));
}

function defaultTodayKey() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.day} ${values.month} ${values.year}`;
}

function buildExtractionPrompt({ todayKey, centers, courses }) {
  return [
    'You extract class schedule details for a coaching centre from spoken notes.',
    `Today in India (IST) is ${todayKey}.`,
    `Allowed centers: ${centers.length ? centers.join(', ') : 'any named in the note'}.`,
    `Allowed courses: ${courses.length ? courses.join(', ') : 'any named in the note'}.`,
    'Return JSON of the shape {"classes":[{"date":"","time":"","center":"","course":"","subject":"","faculty":""}]}.',
    'Rules:',
    '- One object per class: split a note that describes several classes into separate objects.',
    '- Normalize dates to "DD Mon YYYY" (for example "06 Sept 2026") to match the schedule sheet. Resolve "today" and "tomorrow" against today\'s date.',
    '- Normalize times like "4 to 6 pm" to "4:00 - 6:00PM".',
    '- Use "" for anything not said. Never invent a value.',
    '- Spell Indian names in English transliteration.',
    '- The speech may be Hinglish or Hindi; understand it and return English values.'
  ].join('\n');
}

function extractionResponseFormat() {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'class_extraction',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          classes: {
            type: 'array',
            minItems: 1,
            maxItems: 10,
            items: {
              type: 'object',
              properties: {
                date: { type: 'string' },
                time: { type: 'string' },
                center: { type: 'string' },
                course: { type: 'string' },
                subject: { type: 'string' },
                faculty: { type: 'string' }
              },
              required: CLASS_FIELDS,
              additionalProperties: false
            }
          }
        },
        required: ['classes'],
        additionalProperties: false
      }
    }
  };
}

function requestExtraction(apiKey, messages, responseFormat, fetchImpl) {
  return fetchImpl(`${GROQ_API_URL}/chat/completions`, {
    method: 'POST',
    headers: { ...authorizationHeaders(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EXTRACT_MODEL,
      temperature: 0,
      response_format: responseFormat,
      messages
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
}

function parseExtractionContent(content) {
  const text = String(content || '').trim();
  try {
    return JSON.parse(text);
  } catch {}
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  throw voiceError('The class extraction service returned invalid JSON.', 'EXTRACT_FAILED');
}

function normalizeExtractedClasses(payload) {
  if (!payload || !Array.isArray(payload.classes) || !payload.classes.length) {
    throw voiceError('The class extraction service did not return any classes.', 'EXTRACT_FAILED');
  }
  return payload.classes.map(item => {
    const extracted = {};
    for (const field of CLASS_FIELDS) extracted[field] = String((item && item[field]) || '').trim();
    return extracted;
  });
}

async function extractClasses(transcript, {
  todayKey = defaultTodayKey(),
  centers = [],
  courses = [],
  fetchImpl = fetch
} = {}) {
  const apiKey = requireApiKey();
  const messages = [
    { role: 'system', content: buildExtractionPrompt({ todayKey, centers, courses }) },
    { role: 'user', content: String(transcript || '') }
  ];

  let response;
  try {
    response = await requestExtraction(apiKey, messages, extractionResponseFormat(), fetchImpl);
    if (!response.ok) {
      // Some models reject json_schema; retry once in plain JSON mode and validate locally.
      response = await requestExtraction(apiKey, messages, { type: 'json_object' }, fetchImpl);
    }
  } catch {
    throw voiceError('The class extraction service could not be reached.', 'EXTRACT_FAILED');
  }
  if (!response.ok) throw voiceError(`Class extraction failed (${response.status}).`, 'EXTRACT_FAILED');

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw voiceError('The class extraction service returned an invalid response.', 'EXTRACT_FAILED');
  }
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : '';
  return { classes: normalizeExtractedClasses(parseExtractionContent(content)) };
}

function validateClasses(raw, {
  parseDateStrToVal = null,
  parseStartTimeToMinutes = null,
  hasCompleteScheduleDetails = null
} = {}) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.classes) ? raw.classes : []);
  const valid = [];
  const skipped = [];

  for (const item of list) {
    const spoken = {};
    for (const field of CLASS_FIELDS) {
      spoken[field] = String((item && item[field] != null) ? item[field] : '').trim();
    }
    const missing = CLASS_FIELDS.filter(field => !spoken[field]);
    const complete = hasCompleteScheduleDetails ? hasCompleteScheduleDetails(spoken) : missing.length === 0;
    const dateOk = !spoken.date || !parseDateStrToVal || Boolean(parseDateStrToVal(spoken.date));
    const timeOk = !spoken.time || !parseStartTimeToMinutes || parseStartTimeToMinutes(spoken.time) !== null;

    if (complete && dateOk && timeOk) {
      valid.push(spoken);
      continue;
    }
    const reasons = [];
    if (missing.length) reasons.push(`missing ${missing.join(', ')}`);
    if (!dateOk) reasons.push(`unrecognised date "${spoken.date}"`);
    if (!timeOk) reasons.push(`unrecognised time "${spoken.time}"`);
    skipped.push({ class: spoken, reason: reasons.join('; ') });
  }
  return { valid, skipped };
}

module.exports = {
  isVoiceConfigured,
  transcribeVoice,
  looksLikeCreateRequest,
  extractClasses,
  validateClasses
};
