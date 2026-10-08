import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import axios from 'axios';
import express from 'express';

// ============================================================================
// 1. GLOBAL CONFIGURATION
// ============================================================================
const CONFIG = {
  PORT: process.env.PORT || 8080,
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbzjhoxJDCZvDDre0v1-4Pfpe7y4F4VR7Pw6EtFeNCZIXqwu_Q5FDKf4Vg9FDnFXXWMUlg/exec',
  
  ZOOM: {
    ACCOUNT_ID: process.env.ZOOM_ACCOUNT_ID,
    CLIENT_ID: process.env.ZOOM_CLIENT_ID,
    CLIENT_SECRET: process.env.ZOOM_CLIENT_SECRET,
    CENTERS_REQUIRING_ZOOM: ['laxmi nagar'],
    DEFAULT_DURATION_MINS: 120
  },

  TELEGRAM: {
    BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    CHAT_ID: process.env.TELEGRAM_CHAT_ID
  },

  TIMINGS: {
    MESSAGE_DELAY_MS: 5000,
    API_BREATHER_MS: 1000,
    ZOOM_RETRY_MS: 2000
  }
};

// ============================================================================
// 2. HELPER FUNCTIONS & TELEGRAM ALERTS
// ============================================================================
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getOrdinalSuffix(d) {
  if (d > 3 && d < 21) return 'th';
  switch (d % 10) {
    case 1: return "st"; case 2: return "nd"; case 3: return "rd"; default: return "th";
  }
}

async function sendTelegramAlert(text) {
  if (!CONFIG.TELEGRAM.BOT_TOKEN || !CONFIG.TELEGRAM.CHAT_ID) {
    console.warn("Telegram alert credentials missing. Skipping alert.");
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM.CHAT_ID,
      text: text,
      parse_mode: 'Markdown'
    });
  } catch (e) {
    console.error("Failed to send Telegram alert:", e?.response?.data || e.message);
  }
}

async function sendTelegramQR(qrCodeData) {
  if (!CONFIG.TELEGRAM.BOT_TOKEN || !CONFIG.TELEGRAM.CHAT_ID) {
    console.warn("Telegram credentials missing. Cannot send QR alert.");
    return;
  }
  try {
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qrCodeData)}`;
    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendPhoto`, {
      chat_id: CONFIG.TELEGRAM.CHAT_ID,
      photo: qrImageUrl,
      caption: '📱 *TCR Bot WhatsApp Re-authentication Required*\n\nPlease scan this QR code with your WhatsApp app to link the session.'
    });
    console.log("Sent QR Code image to Telegram successfully!");
  } catch (e) {
    console.error("Failed to send QR Code to Telegram:", e?.response?.data || e.message);
  }
}

function formatZoomStartTime(dateStr, timeStr) {
  try {
    const rawDate = new Date(dateStr);
    const istDate = new Date(rawDate.getTime() + (5.5 * 60 * 60 * 1000));
    const yyyy = istDate.getFullYear();
    const mm = String(istDate.getMonth() + 1).padStart(2, '0');
    const dd = String(istDate.getDate()).padStart(2, '0');

    const parts = String(timeStr).toUpperCase().split('-');
    let startStr = parts[0].trim();
    let endStr = parts[1] ? parts[1].trim() : '';

    let startMatch = startStr.match(/(\d+)(?::(\d+))?/);
    if (!startMatch) return null;
    let startHours = parseInt(startMatch[1], 10);
    let startMins = startMatch[2] ? parseInt(startMatch[2], 10) : 0;

    let startAmPm = startStr.includes('PM') ? 'PM' : (startStr.includes('AM') ? 'AM' : null);
    let endAmPm = endStr.includes('PM') ? 'PM' : (endStr.includes('AM') ? 'AM' : null);

    if (!startAmPm) {
       if (endAmPm === 'PM') {
          if (startHours >= 7 && startHours <= 11) startAmPm = 'AM';
          else startAmPm = 'PM'; 
       } else {
          startAmPm = 'AM'; 
       }
    }

    if (startAmPm === 'PM' && startHours !== 12) startHours += 12;
    if (startAmPm === 'AM' && startHours === 12) startHours = 0;

    const hh = String(startHours).padStart(2, '0');
    const min = String(startMins).padStart(2, '0');

    return `${yyyy}-${mm}-${dd}T${hh}:${min}:00`;
  } catch (e) {
    return null;
  }
}

// ============================================================================
// 3. ZOOM API SERVICES
// ============================================================================
async function getZoomAccessToken() {
  if (!CONFIG.ZOOM.ACCOUNT_ID || !CONFIG.ZOOM.CLIENT_ID || !CONFIG.ZOOM.CLIENT_SECRET) {
      console.warn("Zoom credentials missing! Proceeding without Zoom links.");
      return null;
  }
  
  const authHeader = Buffer.from(`${CONFIG.ZOOM.CLIENT_ID}:${CONFIG.ZOOM.CLIENT_SECRET}`).toString('base64');
  
  try {
    const response = await axios.post(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${CONFIG.ZOOM.ACCOUNT_ID}`, 
      {}, 
      {
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );
    return response.data.access_token;
  } catch (e) {
    console.error("Failed to fetch Zoom Token:", e?.response?.data || e.message);
    await sendTelegramAlert(`⚠️ *Zoom API Alert*\nFailed to fetch access token: ${e.message}`);
    return null;
  }
}

async function createZoomMeeting(accessToken, topic, startTime, durationMins) {
  try {
    const payload = {
      topic: topic,
      type: 2, 
      start_time: startTime, 
      duration: durationMins,
      timezone: 'Asia/Kolkata',
      settings: {
        host_video: true,
        participant_video: false,
        join_before_host: false,
        mute_upon_entry: true,
        waiting_room: true
      }
    };

    const response = await axios.post(
      'https://api.zoom.us/v2/users/me/meetings',
      payload,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data.join_url;
  } catch (e) {
    console.error(`Failed to create meeting for ${topic}:`, e?.response?.data || e.message);
    return null;
  }
}

// ============================================================================
// 4. CORE DATA PROCESSING
// ============================================================================
async function processDailySchedules(sock) {
  try {
    if (!isConnected) {
      const alert = '⚠️ *Schedule Dispatch Pre-Check Failed*\nWhatsApp is not connected. Sending QR code for re-authentication...';
      console.warn('Pre-dispatch check failed: WhatsApp not connected');
      await sendTelegramAlert(alert);
      return;
    }

    let scheduleRes;
    try {
      console.log(`[${new Date().toISOString()}] Fetching schedule from: ${CONFIG.APPS_SCRIPT_URL}`);
      scheduleRes = await axios.get(CONFIG.APPS_SCRIPT_URL);
    } catch (axiosErr) {
      const statusCode = axiosErr.response?.status || axiosErr.code;
      const responseData = axiosErr.response?.data;
      const errorMsg = `Failed to fetch schedule from Apps Script\nURL: ${CONFIG.APPS_SCRIPT_URL}\nStatus: ${statusCode}\nDetails: ${JSON.stringify(responseData || axiosErr.message)}`;
      console.error(`[ERROR] ${errorMsg}`);
      await sendTelegramAlert(`🚨 *CRITICAL: Schedule Fetch Failed*\n${errorMsg.substring(0, 300)}`);
      throw axiosErr;
    }

    const allClasses = scheduleRes.data.classes;
    const groupDirectory = scheduleRes.data.settings; 

    if (!allClasses || allClasses.length === 0) {
      console.log('No pending classes found in the sheet.');
      return;
    }

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    
    const istFormatter = new Intl.DateTimeFormat('en-US', { 
      timeZone: 'Asia/Kolkata', 
      year: 'numeric', 
      month: 'numeric', 
      day: 'numeric' 
    });
    
    const tomorrowISTStr = istFormatter.format(tomorrow);

    const tomorrowsClasses = allClasses.filter(item => {
      const rowDate = new Date(item.date);
      if (isNaN(rowDate)) return false;
      return istFormatter.format(rowDate) === tomorrowISTStr;
    });

    if (tomorrowsClasses.length === 0) {
      console.log('No classes scheduled for tomorrow.');
      return;
    }

    const normalizedDirectory = {};
    if (groupDirectory) {
      for (const rawKey in groupDirectory) {
        normalizedDirectory[rawKey.trim().toLowerCase()] = groupDirectory[rawKey];
      }
    }

    const groupedClasses = {};
    for (const item of tomorrowsClasses) {
      const centerClean = String(item.center || '').trim().toLowerCase();
      const courseClean = String(item.course || '').trim().toLowerCase();
      const key = `${centerClean}_${courseClean}`; 

      if (!groupedClasses[key]) {
        groupedClasses[key] = { date: item.date, course: item.course, center: item.center, sessions: [] };
      }
      groupedClasses[key].sessions.push(item);
    }

    const zoomToken = await getZoomAccessToken();
    let zoomCollisionOffset = 1;

    for (const key in groupedClasses) {
      const group = groupedClasses[key];
      const rawGroupIds = normalizedDirectory[key] || groupDirectory[key];

      if (!rawGroupIds) {
        const warnMsg = `⚠️ *Routing Warning*\nNo group ID found in Settings tab for key: \`${key}\``;
        console.log(warnMsg);
        await sendTelegramAlert(warnMsg);
        continue;
      }

      const targetGroups = rawGroupIds.split(',').map(id => id.trim()).filter(id => id.length > 0);

      const rawDate = new Date(group.date);
      const istDate = new Date(rawDate.getTime() + (5.5 * 60 * 60 * 1000));
      const day = istDate.getDate();
      const month = istDate.toLocaleString('en-US', { month: 'long' });
      const formattedDate = `${day}${getOrdinalSuffix(day)} ${month}`;

      let message = `*TCR – ${group.course.toUpperCase()} CLASS FLOW*\n\n` +
                    `*Class Schedule*\n` +
                    `📌 ${formattedDate}\n\n`;

      const centerNormalized = String(group.center || '').toLowerCase().trim();
      const centerRequiresZoom = CONFIG.ZOOM.CENTERS_REQUIRING_ZOOM.includes(centerNormalized);

      for (const session of group.sessions) {
        message += `*${session.time}*\n` +
                   `Subject: *${session.subject}*\n` +
                   `Faculty: *${session.faculty.toUpperCase()}*\n`;
        
        const subjectLower = String(session.subject || '').toLowerCase();
        const isOfflineEvent = subjectLower.includes('mock') || subjectLower.includes('test');
                    
        if (zoomToken && centerRequiresZoom && !isOfflineEvent) {
           let exactZoomStartTime = formatZoomStartTime(group.date, session.time);
           const duration = session.zoomDuration || CONFIG.ZOOM.DEFAULT_DURATION_MINS;
           
           if (exactZoomStartTime) {
               const meetingTitle = `TCR ${group.center} ${session.course} - ${session.subject} (${session.faculty})`;
               
               const secondOffset = String(zoomCollisionOffset % 60).padStart(2, '0');
               exactZoomStartTime = exactZoomStartTime.substring(0, 17) + secondOffset;
               zoomCollisionOffset++;

               await delay(CONFIG.TIMINGS.API_BREATHER_MS); 
               let joinUrl = await createZoomMeeting(zoomToken, meetingTitle, exactZoomStartTime, duration);
               
               if (!joinUrl) {
                   await delay(CONFIG.TIMINGS.ZOOM_RETRY_MS);
                   joinUrl = await createZoomMeeting(zoomToken, meetingTitle, exactZoomStartTime, duration);
               }

               if (joinUrl) {
                  message += `🔗 *Zoom:* ${joinUrl}\n`;
               } else {
                  // Decoupled Fallback so dispatch doesn't stop
                  message += `🔗 *Zoom:* Link pending (Will be shared shortly)\n`;
                  await sendTelegramAlert(`⚠️ *Zoom Failed*\nCould not generate Zoom link for: ${meetingTitle}`);
               }
           }
        }
        message += `\n`; 
      }

      message += `Regards,\n*TEAM TCR*`;

      let atLeastOneSuccess = false;
      for (const jid of targetGroups) {
        try {
          await sock.sendMessage(jid, { text: message.trim() });
          console.log(`Sent bundled schedule for ${key} to ${jid}`);
          atLeastOneSuccess = true;
          await delay(CONFIG.TIMINGS.MESSAGE_DELAY_MS);
        } catch (sendErr) {
          const sendErrMsg = `❌ *WhatsApp Dispatch Error*\nFailed to send message to group \`${jid}\`: ${sendErr.message}`;
          console.error(sendErrMsg);
          await sendTelegramAlert(sendErrMsg);
        }
      }

      if (atLeastOneSuccess) {
        for (const session of group.sessions) {
          await axios.post(CONFIG.APPS_SCRIPT_URL, { rowIndex: session.rowIndex });
        }
      }
    }
  } catch (err) {
    const timestamp = new Date().toISOString();
    const errorId = `ERR-${Date.now()}`;
    const statusCode = err.response?.status || err.code || 'UNKNOWN';
    const responseBody = err.response?.data ? JSON.stringify(err.response.data).substring(0, 200) : 'No response body';
    
    const criticalError = `🚨 *CRITICAL BOT SCRIPT ERROR* [${errorId}]\n` +
                          `Time: ${timestamp}\n` +
                          `Status: ${statusCode}\n` +
                          `Message: ${err.message}\n` +
                          `Details: ${responseBody}`;
    console.error(`[${timestamp}] ${criticalError}`);
    await sendTelegramAlert(criticalError);
  }
}

// ============================================================================
// 5. WHATSAPP CONNECTION & DAEMON INITIALIZATION
// ============================================================================
let activeSocket = null;
let isConnected = false;
let isProcessing = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  
  const { version, isLatest } = await fetchLatestWaWebVersion();
  console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);
  
  const sock = makeWASocket({ 
    version: version,
    auth: state,
    markOnlineOnConnect: false,
    browser: ["TCR Bot", "Chrome", "120.0.0"]
  });

  activeSocket = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const timestamp = new Date().toISOString();
    
    if (qr) {
        console.log(`[${timestamp}] 🔐 QR Code generated and sending to Telegram...`);
        qrcode.generate(qr, { small: true });
        await sendTelegramQR(qr);
    }
    
    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
      const reason = lastDisconnect.error?.output?.statusCode === DisconnectReason.loggedOut ? 'LOGGED_OUT' : 'NETWORK_ERROR';
      console.log(`[${timestamp}] ❌ Connection closed. Reason: ${reason}. Will reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        console.log(`[${timestamp}] ⏳ Attempting to reconnect in 3 seconds...`);
        setTimeout(startBot, 3000);
      } else {
        const logoutAlert = `[${timestamp}] ⚠️ *WhatsApp Session Logged Out*\nPlease scan the QR code sent separately to reconnect.`;
        console.warn(logoutAlert);
        await sendTelegramAlert('⚠️ *WhatsApp Disconnected*\nSession logged out. Scan QR code to reconnect.');
      }
    } else if (connection === 'open') {
      isConnected = true;
      console.log(`[${timestamp}] ✅ Connected to WhatsApp Web! Daemon is active and holding WebSocket 24/7.`);
    } else if (connection === 'connecting') {
      console.log(`[${timestamp}] 🔄 Connecting to WhatsApp...`);
    }
  });
}

// ============================================================================
// 6. EXPRESS SERVER & WEBHOOK ENDPOINTS
// ============================================================================
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send(`TCR Bot Daemon Online. Status: ${isConnected ? 'Connected' : 'Connecting/Disconnected'}`);
});

app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    whatsappConnected: isConnected,
    isProcessing: isProcessing,
    timestamp: new Date().toISOString()
  });
});

app.all('/dispatch', async (req, res) => {
  if (!activeSocket || !isConnected) {
    return res.status(503).json({ success: false, message: 'WhatsApp socket is not connected yet.' });
  }

  if (isProcessing) {
    return res.status(429).json({ success: false, message: 'Schedule processing is already in progress.' });
  }

  isProcessing = true;
  res.json({ success: true, message: 'Schedule dispatch triggered successfully.' });

  try {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] Triggering daily schedule dispatch...`);
    await processDailySchedules(activeSocket);
    console.log(`[${timestamp}] Daily schedule dispatch finished.`);
  } catch (err) {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] Error during dispatch trigger: ${err.message}`);
  } finally {
    isProcessing = false;
  }
});

app.all('/reauth', async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] /reauth endpoint called. Current connection state: ${isConnected ? 'connected' : 'disconnected'}`);
  
  if (isConnected) {
    const msg = '✅ WhatsApp is already connected and ready to dispatch.';
    console.log(`[${timestamp}] ${msg}`);
    return res.json({ success: true, message: msg });
  }

  const msg = `⏳ WhatsApp re-authentication in progress. Check your Telegram for a QR code. You have 2 minutes to scan it.`;
  console.log(`[${timestamp}] ${msg}`);
  await sendTelegramAlert(`🔐 *WhatsApp Re-authentication Initiated*\n${msg}\n\n📱 Scan the QR code with your WhatsApp app to reconnect.`);
  res.json({ success: true, message: msg });
});

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 TCR Bot server running on port ${CONFIG.PORT}`);
  startBot();
});
