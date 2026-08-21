import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import axios from 'axios';

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzjhoxJDCZvDDre0v1-4Pfpe7y4F4VR7Pw6EtFeNCZIXqwu_Q5FDKf4Vg9FDnFXXWMUlg/exec';

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
      console.log('Connected to WhatsApp Web!');
      
      // --- SILENTLY FETCH AND LOG ALL GROUP IDs ---
      const groups = await sock.groupFetchAllParticipating();
      console.log('\n--- YOUR WHATSAPP GROUP IDs ---');
      for (const id in groups) {
          console.log(`Group Name: ${groups[id].subject} | ID: ${id}`);
      }
      console.log('-------------------------------\n');

      console.log('Processing tomorrow\'s schedules...');
      await processDailySchedules(sock);
      
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
    
    // Deconstruct the response expecting both classes and settings
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
      
      // Shift the Google Sheet date explicitly back into IST (+5:30)
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
        groupedClasses[key] = {
          date: item.date, 
          course: item.course,
          center: item.center,
          sessions: []
        };
      }
      groupedClasses[key].sessions.push(item);
    }

    // --- Helper function for date formatting (st, nd, rd, th) ---
    function getOrdinalSuffix(d) {
      if (d > 3 && d < 21) return 'th';
      switch (d % 10) {
        case 1:  return "st";
        case 2:  return "nd";
        case 3:  return "rd";
        default: return "th";
      }
    }

    for (const key in groupedClasses) {
      const group = groupedClasses[key];
      const groupId = groupDirectory[key];

      if (groupId) {
        // 1. Grab the raw date and fix the timezone to IST
        const rawDate = new Date(group.date);
        const istDate = new Date(rawDate.getTime() + (5.5 * 60 * 60 * 1000));
        
        // 2. Format to "22nd August"
        const day = istDate.getDate();
        const month = istDate.toLocaleString('en-US', { month: 'long' });
        const formattedDate = `${day}${getOrdinalSuffix(day)} ${month}`;

        // 3. Build the message matching the exact spacing of the screenshot
        let message = `*TCR – ${group.course.toUpperCase()} CLASS FLOW*\n\n` +
                      `*Class Schedule*\n` +
                      `📌 ${formattedDate}\n\n`;

        for (const session of group.sessions) {
          // Time is now bolded, Faculty is forced to uppercase
          message += `*${session.time}*\n` +
                     `Subject: *${session.subject}*\n` +
                     `Faculty: *${session.faculty.toUpperCase()}*\n\n`;
        }

        message += `Regards,\n*TEAM TCR*`;

        await sock.sendMessage(groupId, { text: message });
        console.log(`Sent bundled schedule for ${key}`);

        // Mark these specific rows as SENT in the Google Sheet
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
