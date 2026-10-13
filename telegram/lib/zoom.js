const ZOOM_API_BASE_URL = 'https://api.zoom.us/v2';

function parseDateParts(dateValue) {
  if (dateValue instanceof Date && !Number.isNaN(dateValue.getTime())) {
    return {
      year: dateValue.getUTCFullYear(),
      month: dateValue.getUTCMonth() + 1,
      day: dateValue.getUTCDate()
    };
  }

  const value = String(dateValue || '').trim();
  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  }

  match = value.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{2,4})$/i);
  if (!match) {
    match = value.match(/^(\d{1,2})\s+([a-z]+)$/i);
    if (match) {
      const month = monthIndex(match[2].toLowerCase());
      return month ? { year: new Date().getFullYear(), month, day: Number(match[1]) } : null;
    }
  }
  if (!match) {
    match = value.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{2,4})$/i);
    if (match) {
      const monthName = match[1].toLowerCase();
      const day = Number(match[2]);
      const year = Number(match[3]) < 100 ? Number(match[3]) + 2000 : Number(match[3]);
      const month = monthIndex(monthName);
      return month ? { year, month, day } : null;
    }
  }
  if (!match) {
    match = value.match(/^([a-z]+)\s+(\d{1,2})$/i);
    if (match) {
      const month = monthIndex(match[1].toLowerCase());
      return month ? { year: new Date().getFullYear(), month, day: Number(match[2]) } : null;
    }
  }
  if (match) {
    const month = monthIndex(match[2].toLowerCase());
    const year = Number(match[3]) < 100 ? Number(match[3]) + 2000 : Number(match[3]);
    return month ? { year, month, day: Number(match[1]) } : null;
  }

  match = value.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (match) {
    const year = Number(match[3]) < 100 ? Number(match[3]) + 2000 : Number(match[3]);
    return { year, month: Number(match[2]), day: Number(match[1]) };
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : {
    year: parsed.getUTCFullYear(),
    month: parsed.getUTCMonth() + 1,
    day: parsed.getUTCDate()
  };
}

function monthIndex(name) {
  const months = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10,
    october: 10, nov: 11, november: 11, dec: 12, december: 12
  };
  return months[name] || months[name.slice(0, 3)] || 0;
}

function parseScheduleTime(timeValue) {
  const segments = String(timeValue || '').split('-').map(segment => segment.trim());
  if (segments.length !== 2) return null;

  const start = segments[0].match(/(\d{1,2}):(\d{2})(AM|PM)?/i);
  const end = segments[1].match(/(\d{1,2}):(\d{2})(AM|PM)/i);
  if (!start || !end) return null;

  const toMinutes = (match, meridiem) => {
    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (meridiem.toUpperCase() === 'PM' && hours !== 12) hours += 12;
    if (meridiem.toUpperCase() === 'AM' && hours === 12) hours = 0;
    return hours * 60 + minutes;
  };
  const endMeridiem = end[3];
  const startMeridiem = start[3] || endMeridiem;
  const startMinutes = toMinutes(start, startMeridiem);
  const endMinutes = toMinutes(end, end[3]);
  return {
    startMinutes,
    endMinutes,
    durationMins: endMinutes - startMinutes
  };
}

function formatZoomStartTime(dateValue, timeValue) {
  const date = parseDateParts(dateValue);
  const scheduleTime = parseScheduleTime(timeValue);
  if (!date || !scheduleTime) return null;

  const adjusted = new Date(
    Date.UTC(date.year, date.month - 1, date.day) + scheduleTime.startMinutes * 60 * 1000
  );
  const year = adjusted.getUTCFullYear();
  const month = String(adjusted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(adjusted.getUTCDate()).padStart(2, '0');
  const hours = String(adjusted.getUTCHours()).padStart(2, '0');
  const minutes = String(adjusted.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}:00`;
}

async function createZoomMeeting(row) {
  const { ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET } = process.env;
  if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
    throw new Error('Zoom is not configured. Set ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, and ZOOM_CLIENT_SECRET in Vercel.');
  }

  const scheduleTime = parseScheduleTime(row.time);
  const startTime = formatZoomStartTime(row.date, row.time);
  if (!startTime) {
    throw new Error(`Could not parse the schedule date/time for row ${row.rowIndex}.`);
  }

  const credentials = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
  const tokenResponse = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(ZOOM_ACCOUNT_ID)}`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${credentials}` },
      signal: AbortSignal.timeout(10000)
    }
  );
  const tokenBody = await tokenResponse.json();
  if (!tokenResponse.ok || !tokenBody.access_token) {
    throw new Error(`Zoom token request failed: ${tokenBody.reason || tokenBody.message || tokenResponse.status}`);
  }

  const topic = `TCR ${row.center} ${row.course} - ${row.subject} (${row.faculty})`;
  const meetingResponse = await fetch(`${ZOOM_API_BASE_URL}/users/me/meetings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      'Content-Type': 'application/json'
    },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      topic,
      type: 2,
      start_time: startTime,
      duration: scheduleTime.durationMins,
      timezone: 'Asia/Kolkata',
      settings: {
        host_video: true,
        participant_video: false,
        join_before_host: false,
        mute_upon_entry: true,
        waiting_room: true
      }
    })
  });
  const meetingBody = await meetingResponse.json();
  if (!meetingResponse.ok || !meetingBody.join_url) {
    throw new Error(`Zoom meeting creation failed: ${meetingBody.message || meetingResponse.status}`);
  }
  return meetingBody.join_url;
}

module.exports = {
  createZoomMeeting,
  formatZoomStartTime,
  getZoomDurationMins: timeValue => parseScheduleTime(timeValue)?.durationMins || null
};
