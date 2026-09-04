import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import axios from 'axios';

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzjhoxJDCZvDDre0v1-4Pfpe7y4F4VR7Pw6EtFeNCZIXqwu_Q5FDKf4Vg9FDnFXXWMUlg/exec';

// Zoom Environment Variables
const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET;

async function getZoomAccessToken() {
  if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
      console.warn("Zoom credentials missing! Proceeding without Zoom links.");
      return null;
  }
  
  const authHeader = Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64');
  
  try {
    const response = await axios.post(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`, 
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

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  
  const sock = makeWASocket({ 
    auth: state,
    printQRInTerminal: false 
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('Connected to WhatsApp Web! Processing tomorrow\'s schedules...');
      await processDailySchedules(sock);
      
      setTimeout(() => {
          console.log('Finished sending messages. Shutting down process.');
          process.exit(0);
      }, 20000); 
    }
  });
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
          if (startHours >= 7 && startHours <= 11) {
             startAmPm = 'AM';
          } else {
             startAmPm = 'PM'; 
          }
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

async function processDailySchedules(sock) {
  try {
    const res = await axios.get(APPS_SCRIPT_URL);
    const allClasses = res.data.classes;
    const groupDirectory = res.data.settings; 

    if (!allClasses || allClasses.length === 0) {
      console.log('No pending classes found in the sheet.');
      return;
    }

    const currentUTC = new Date();
    const istNow = new Date(currentUTC.getTime() + (5.5 * 60 * 60 * 1000));
    
    const istTomorrow = new Date(istNow);
    istTomorrow.setDate(istTomorrow.getDate() + 1);
    
    const tomYear = istTomorrow.getFullYear();
    const tomMonth = istTomorrow.getMonth();
    const tomDate = istTomorrow.getDate();

    const tomorrowsClasses = allClasses.filter(item => {
      const rawDateUTC = new Date(item.date);
      if (isNaN(rawDateUTC)) return false;
      const rowDateIST = new Date(rawDateUTC.getTime() + (5.5 * 60 * 60 * 1000));
      return rowDateIST.getFullYear() === tomYear &&
             rowDateIST.getMonth() === tomMonth &&
             rowDateIST.getDate() === tomDate;
    });

    if (tomorrowsClasses.length === 0) {
      console.log('No classes scheduled for tomorrow.');
      return;
    }

    const groupedClasses = {};
    for (const item of tomorrowsClasses) {
      const key = `${item.center}_${item.course}`; 
      if (!groupedClasses[key]) {
        groupedClasses[key] = { date: item.date, course: item.course, center: item.center, sessions: [] };
      }
      groupedClasses[key].sessions.push(item);
    }

    function getOrdinalSuffix(d) {
      if (d > 3 && d < 21) return 'th';
      switch (d % 10) {
        case 1: return "st"; case 2: return "nd"; case 3: return "rd"; default: return "th";
      }
    }

    const zoomToken = await getZoomAccessToken();
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    
    let zoomCollisionOffset = 1;

    for (const key in groupedClasses) {
      const group = groupedClasses[key];
      const groupId = groupDirectory[key];

      if (groupId) {
        const rawDate = new Date(group.date);
        const istDate = new Date(rawDate.getTime() + (5.5 * 60 * 60 * 1000));
        
        const day = istDate.getDate();
        const month = istDate.toLocaleString('en-US', { month: 'long' });
        const formattedDate = `${day}${getOrdinalSuffix(day)} ${month}`;

        let message = `*TCR – ${group.course.toUpperCase()} CLASS FLOW*\n\n` +
                      `*Class Schedule*\n` +
                      `📌 ${formattedDate}\n\n`;

        for (const session of group.sessions) {
          message += `*${session.time}*\n` +
                     `Subject: *${session.subject}*\n` +
                     `Faculty: *${session.faculty.toUpperCase()}*\n`;
          
          const subjectLower = session.subject.toLowerCase();
          const isOfflineEvent = subjectLower.includes('mock') || subjectLower.includes('test');
                     
          if (zoomToken && !isOfflineEvent) {
             let exactZoomStartTime = formatZoomStartTime(group.date, session.time);
             const duration = session.zoomDuration || 120;
             
             if (exactZoomStartTime) {
                 const meetingTitle = `TCR ${group.center} ${session.course} - ${session.subject} (${session.faculty})`;

                 const secondOffset = String(zoomCollisionOffset % 60).padStart(2, '0');
                 exactZoomStartTime = exactZoomStartTime.substring(0, 17) + secondOffset;
                 zoomCollisionOffset++;

                 await delay(1000); 
                 let joinUrl = await createZoomMeeting(zoomToken, meetingTitle, exactZoomStartTime, duration);
                 
                 if (!joinUrl) {
                     console.log(`Retrying Zoom link for ${meetingTitle}...`);
                     await delay(2000);
                     joinUrl = await createZoomMeeting(zoomToken, meetingTitle, exactZoomStartTime, duration);
                 }

                 if (joinUrl) {
                    message += `🔗 *Zoom:* ${joinUrl}\n`;
                 }
             }
          }
          message += `\n`; 
        }

        message += `Regards,\n*TEAM TCR*`;

        await sock.sendMessage(groupId, { text: message.trim() });
        console.log(`Sent bundled schedule for ${key}`);

        await delay(5000); 

        for (const session of group.sessions) {
          await axios.post(APPS_SCRIPT_URL, { rowIndex: session.rowIndex });
        }
      } else {
        console.log(`No group ID routing found in Settings tab for: ${key}`);
      }
    }
  } catch (err) {
    console.error('Error processing schedule:', err.message);
  }
}

startBot();
