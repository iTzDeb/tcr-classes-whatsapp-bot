import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import axios from 'axios';
import express from 'express';
import { rm } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

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
  REAUTH_TOKEN: process.env.RENDER_REAUTH_TOKEN,
  AUTH_DIRECTORY: 'auth_info',

  TIMINGS: {
    MESSAGE_DELAY_MS: 5000,
    API_BREATHER_MS: 1000,
    ZOOM_RETRY_MS: 2000,
    QR_SCAN_TIMEOUT_MS: 2 * 60 * 1000
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
    throw new Error('Telegram credentials missing. Cannot send QR alert.');
  }

  const image = await QRCode.toBuffer(qrCodeData, { type: 'png', width: 400, margin: 2 });
  const form = new FormData();
  form.append('chat_id', String(CONFIG.TELEGRAM.CHAT_ID));
  form.append('caption', 'WhatsApp link required. Scan this current QR in WhatsApp → Linked Devices. The QR expires; use the newest image.');
  form.append('photo', new Blob([image], { type: 'image/png' }), 'whatsapp-login-qr.png');
  await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM.BOT_TOKEN}/sendPhoto`, form);
  console.log('Sent locally generated QR image to Telegram.');
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
      const alert = '⚠️ *Schedule Dispatch Pre-Check Failed*\nWhatsApp is not connected. Starting re-authentication...';
      console.warn(`[${new Date().toISOString()}] Pre-dispatch check failed: WhatsApp not connected.`);
      await sendTelegramAlert(alert);
      await beginReauthentication(true);
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
let botStartPromise = null;
let socketGeneration = 0;
let reconnectTimer = null;
let qrScanTimeout = null;
let reauthInProgress = false;

async function startBot() {
  if (botStartPromise) return botStartPromise;

  const generation = socketGeneration;
  botStartPromise = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(CONFIG.AUTH_DIRECTORY);
    const { version, isLatest } = await fetchLatestWaWebVersion();
    if (generation !== socketGeneration) return;
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
      version,
      auth: state,
      markOnlineOnConnect: false,
      browser: ['TCR Bot', 'Chrome', '120.0.0']
    });
    activeSocket = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
      if (sock !== activeSocket) return;

      const { connection, lastDisconnect, qr } = update;
      const timestamp = new Date().toISOString();

      if (qr) {
        console.log(`[${timestamp}] QR Code generated; sending directly to Telegram.`);
        if (!qrScanTimeout) {
          qrScanTimeout = setTimeout(async () => {
            const expiredSocket = activeSocket;
            activeSocket = null;
            isConnected = false;
            reauthInProgress = false;
            socketGeneration++;
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
            expiredSocket?.end(new Error('WhatsApp QR scan timed out'));
            qrScanTimeout = null;
            console.warn(`[${new Date().toISOString()}] WhatsApp QR scan window expired.`);
            await sendTelegramAlert('⏱️ WhatsApp was not linked within 2 minutes. The QR session expired. Send /reauth to try again.');
          }, CONFIG.TIMINGS.QR_SCAN_TIMEOUT_MS);
          qrScanTimeout.unref?.();
        }
        try {
          await sendTelegramQR(qr);
        } catch (error) {
          console.error(`[${timestamp}] Failed to deliver WhatsApp QR to Telegram:`, error.message);
          await sendTelegramAlert(`⚠️ Could not deliver the WhatsApp QR code to Telegram: ${error.message}`);
        }
      }

      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        const reason = shouldReconnect ? 'NETWORK_ERROR' : 'LOGGED_OUT';
        console.log(`[${timestamp}] Connection closed. Reason: ${reason}. Will reconnect: ${shouldReconnect || reauthInProgress}`);
        if (shouldReconnect || reauthInProgress) {
          if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              startBot().catch(async (error) => {
                console.error(`[${new Date().toISOString()}] WhatsApp reconnect failed:`, error.message);
                await sendTelegramAlert(`⚠️ WhatsApp reconnect failed: ${error.message}`);
              });
            }, 3000);
          }
        } else {
          await sendTelegramAlert('⚠️ WhatsApp logged out. Starting a fresh QR pairing session now.');
          beginReauthentication(true).catch(async (error) => {
            console.error(`[${new Date().toISOString()}] Automatic WhatsApp re-authentication failed:`, error.message);
            await sendTelegramAlert(`🚨 Automatic WhatsApp re-authentication failed: ${error.message}`);
          });
        }
      } else if (connection === 'open') {
        isConnected = true;
        const wasReauthenticating = reauthInProgress || Boolean(qrScanTimeout);
        clearTimeout(qrScanTimeout);
        qrScanTimeout = null;
        reauthInProgress = false;
        console.log(`[${timestamp}] Connected to WhatsApp Web.`);
        if (wasReauthenticating) {
          await sendTelegramAlert('✅ WhatsApp has been linked successfully and is ready for dispatch.');
        }
      } else if (connection === 'connecting') {
        console.log(`[${timestamp}] Connecting to WhatsApp...`);
      }
    });
  })();

  try {
    await botStartPromise;
  } finally {
    botStartPromise = null;
  }
}

function hasValidReauthToken(req) {
  const suppliedToken = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!CONFIG.REAUTH_TOKEN || !suppliedToken) return false;
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(CONFIG.REAUTH_TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function beginReauthentication(force = false) {
  if (isConnected) return { alreadyConnected: true };
  if (reauthInProgress) return { alreadyInProgress: true };
  if (isProcessing && !force) {
    const error = new Error('A schedule dispatch is in progress. Wait for it to finish before re-authenticating.');
    error.statusCode = 409;
    throw error;
  }

  reauthInProgress = true;
  clearTimeout(qrScanTimeout);
  qrScanTimeout = null;
  socketGeneration++;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  const previousSocket = activeSocket;
  activeSocket = null;
  isConnected = false;
  previousSocket?.end(new Error('Starting WhatsApp re-authentication'));

  try {
    if (botStartPromise) await botStartPromise;
    await rm(CONFIG.AUTH_DIRECTORY, { recursive: true, force: true });
    await sendTelegramAlert('🔐 WhatsApp re-authentication started. A fresh QR code will be sent here. Scan the latest QR within 2 minutes.');
    await startBot();
    return { started: true };
  } catch (error) {
    reauthInProgress = false;
    clearTimeout(qrScanTimeout);
    qrScanTimeout = null;
    throw error;
  }
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
    reauthInProgress,
    isProcessing: isProcessing,
    timestamp: new Date().toISOString()
  });
});

app.all('/dispatch', async (req, res) => {
  if (isProcessing) {
    return res.status(429).json({ success: false, message: 'Schedule processing is already in progress.' });
  }

  if (!activeSocket || !isConnected) {
    const timestamp = new Date().toISOString();
    console.warn(`[${timestamp}] Dispatch requested while WhatsApp is disconnected; starting re-authentication.`);
    beginReauthentication().catch(async (error) => {
      console.error(`[${new Date().toISOString()}] Dispatch-triggered re-authentication failed:`, error.message);
      await sendTelegramAlert(`🚨 Dispatch could not start WhatsApp re-authentication: ${error.message}`);
    });
    return res.status(503).json({
      success: false,
      message: 'WhatsApp is not connected. Re-authentication has been started; scan the QR sent to Telegram.'
    });
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

app.post('/reauth', async (req, res) => {
  const timestamp = new Date().toISOString();
  if (!CONFIG.REAUTH_TOKEN) {
    console.error(`[${timestamp}] RENDER_REAUTH_TOKEN is not configured.`);
    return res.status(503).json({ success: false, message: 'Re-authentication is not configured on this service.' });
  }
  if (!hasValidReauthToken(req)) {
    console.warn(`[${timestamp}] Rejected unauthorized /reauth request.`);
    return res.status(401).json({ success: false, message: 'Unauthorized.' });
  }

  console.log(`[${timestamp}] Authorized /reauth endpoint request. WhatsApp connected: ${isConnected}`);
  if (isConnected) {
    return res.json({ success: true, alreadyConnected: true, message: 'WhatsApp is already connected and ready to dispatch.' });
  }

  try {
    const result = await beginReauthentication();
    return res.status(202).json({
      success: true,
      ...result,
      message: 'WhatsApp re-authentication started. Scan the newest QR sent to Telegram within 2 minutes.'
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error(`[${timestamp}] Re-authentication start failed:`, error.message);
    return res.status(statusCode).json({ success: false, message: error.message });
  }
});

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 TCR Bot server running on port ${CONFIG.PORT}`);
  startBot().catch(async (error) => {
    console.error(`[${new Date().toISOString()}] WhatsApp startup failed:`, error.message);
    await sendTelegramAlert(`🚨 WhatsApp startup failed: ${error.message}`);
  });
});
