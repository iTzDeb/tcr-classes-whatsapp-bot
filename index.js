import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import axios from 'axios';

// 1. Replace this with your deployed Google Apps Script Web App URL
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzjhoxJDCZvDDre0v1-4Pfpe7y4F4VR7Pw6EtFeNCZIXqwu_Q5FDKf4Vg9FDnFXXWMUlg/exec';

// 2. Map Center + Course to specific WhatsApp Group IDs
// Ensure these IDs exactly match your WhatsApp groups (format: 1234567890-123456@g.us)
const GROUP_DIRECTORY = {
  'Hauz Khas_CLAT': '1234567890-111111@g.us',
  'Hauz Khas_CUET': '1234567890-222222@g.us',
  'Laxmi Nagar_CLAT': '1234567890-333333@g.us',
  'Laxmi Nagar_CUET': '1234567890-444444@g.us',
  'IP Extension_CLAT': '1234567890-555555@g.us'
  // 'Hauz Khas_AIBE': '1234567890-666666@g.us', // Add this when AIBE classes begin
};

async function startBot() {
  // This manages the WhatsApp Web session keys so you only scan the QR code once
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  
  const sock = makeWASocket({ 
    auth: state,
    printQRInTerminal: false 
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;
    
    if (qr) {
      // Renders the QR code in your Ubuntu terminal for scanning
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('Connected to WhatsApp Web! Processing schedules...');
      await processDailySchedules(sock);
      
      // Explicitly exit the Node process so the GitHub Actions cloud runner 
      // cleanly shuts down and saves your free monthly minutes.
      setTimeout(() => {
          console.log('Finished sending messages. Shutting down process.');
          process.exit(0);
      }, 5000); 
    }
  });
}

async function processDailySchedules(sock) {
  try {
    // Fetch today's pending classes from your Google Sheet
    const res = await axios.get(APPS_SCRIPT_URL);
    const classes = res.data;

    if (!classes || classes.length === 0) {
      console.log('No pending classes for today.');
      return;
    }

    // Loop through each class and send the exact message format
    for (const item of classes) {
      const key = `${item.center}_${item.course}`;
      const groupId = GROUP_DIRECTORY[key];

      if (groupId) {
        const message = `TCR – ${item.course.toUpperCase()} CLASS FLOW\n\n` +
                        `Class Schedule\n\n` +
                        `Center: ${item.center}\n` +
                        `${item.time}\n` +
                        `Subject: ${item.subject}\n` +
                        `Faculty: ${item.faculty}\n\n` +
                        `Regards,\nTEAM TCR`;

        await sock.sendMessage(groupId, { text: message });
        console.log(`Sent schedule for ${key}`);

        // Tell Google Apps Script to mark this specific row as "SENT"
        await axios.post(APPS_SCRIPT_URL, { rowIndex: item.rowIndex });
      } else {
        console.log(`No group ID routing found for: ${key}`);
      }
    }
  } catch (err) {
    console.error('Error processing schedule:', err.message);
  }
}

startBot();
