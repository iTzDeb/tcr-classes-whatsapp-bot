import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import axios from 'axios';

// 1. Your Google Apps Script Web App URL
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzjhoxJDCZvDDre0v1-4Pfpe7y4F4VR7Pw6EtFeNCZIXqwu_Q5FDKf4Vg9FDnFXXWMUlg/exec';

// 2. Map Center + Course to specific WhatsApp Group IDs
const GROUP_DIRECTORY = {
  'Hauz Khas_CLAT': '917065777086@s.whatsapp.net', // Currently mapped to your test number
  'Hauz Khas_CUET': '1234567890-222222@g.us',
  'Laxmi Nagar_CLAT': '1234567890-333333@g.us',
  'Laxmi Nagar_CUET': '1234567890-444444@g.us',
  'IP Extension_CLAT': '1234567890-555555@g.us'
};

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  
  const sock = makeWASocket({ 
    auth: state,
    printQRInTerminal: false 
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;
    
    if (qr) {
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('Connected to WhatsApp Web! Processing tomorrow\'s schedules...');
      
      await processDailySchedules(sock);
      
      // Cleanly shut down the GitHub Actions runner
      setTimeout(() => {
          console.log('Finished sending messages. Shutting down process.');
          process.exit(0);
      }, 5000); 
    }
  });
}

async function processDailySchedules(sock) {
  try {
    const res = await axios.get(APPS_SCRIPT_URL);
    const allClasses = res.data;

    if (!allClasses || allClasses.length === 0) {
      console.log('No pending classes found in the sheet.');
      return;
    }

    // --- STEP 1: Calculate "Tomorrow" in IST ---
    // GitHub Actions servers run in UTC. We offset by +5:30 for India Standard Time.
    const currentUTC = new Date();
    const istNow = new Date(currentUTC.getTime() + (5.5 * 60 * 60 * 1000));
    
    // Add 1 day to get tomorrow in IST
    const istTomorrow = new Date(istNow);
    istTomorrow.setDate(istTomorrow.getDate() + 1);
    
    const tomYear = istTomorrow.getFullYear();
    const tomMonth = istTomorrow.getMonth();
    const tomDate = istTomorrow.getDate();

    // --- STEP 2: Filter for Tomorrow's Classes ---
    const tomorrowsClasses = allClasses.filter(item => {
      const rowDate = new Date(item.date);
      if (isNaN(rowDate)) return false;
      return rowDate.getFullYear() === tomYear &&
             rowDate.getMonth() === tomMonth &&
             rowDate.getDate() === tomDate;
    });

    if (tomorrowsClasses.length === 0) {
      console.log('No classes scheduled for tomorrow.');
      return;
    }

    // --- STEP 3: Group the Rows by Center and Course ---
    const groupedClasses = {};
    
    for (const item of tomorrowsClasses) {
      const key = `${item.center}_${item.course}`; // e.g., "Hauz Khas_CLAT"
      
      if (!groupedClasses[key]) {
        groupedClasses[key] = {
          date: item.date, 
          course: item.course,
          center: item.center,
          sessions: []
        };
      }
      groupedClasses[key].sessions.push(item);
    }

    // --- STEP 4: Build and Send the Message ---
    for (const key in groupedClasses) {
      const group = groupedClasses[key];
      const groupId = GROUP_DIRECTORY[key];

      if (groupId) {
        // Header matching the screenshot
        let message = `*TCR – ${group.course.toUpperCase()} CLASS FLOW*\n\n` +
                      `*Class Schedule*\n\n` +
                      `📌 ${group.date}\n\n`;

        // Append each class in the group
        for (const session of group.sessions) {
          message += `${session.time}\n` +
                     `Subject: *${session.subject}*\n` +
                     `Faculty: *${session.faculty}*\n\n`;
        }

        // Footer
        message += `Regards,\n*TEAM TCR*`;

        await sock.sendMessage(groupId, { text: message });
        console.log(`Sent bundled schedule for ${key}`);

        // Mark these specific rows as SENT in the Google Sheet
        for (const session of group.sessions) {
          await axios.post(APPS_SCRIPT_URL, { rowIndex: session.rowIndex });
        }
      } else {
        console.log(`No group ID routing found for: ${key}`);
      }
    }
  } catch (err) {
    console.error('Error processing schedule:', err.message);
  }
}

startBot();
