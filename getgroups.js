import makeWASocket, { useMultiFileAuthState } from '@whiskeysockets/baileys';

async function fetchGroups() {
  console.log('Starting WhatsApp connection...');
  
  const { state } = await useMultiFileAuthState('auth_info');
  
  const sock = makeWASocket({ 
    auth: state,
    printQRInTerminal: true 
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection } = update;
    
    if (connection === 'open') {
      console.log('\n✅ Connected successfully!');
      console.log('Fetching your groups...\n');
      
      try {
        const groups = await sock.groupFetchAllParticipating();
        
        console.log('=========================================');
        console.log('       YOUR WHATSAPP GROUP IDs           ');
        console.log('=========================================');
        
        for (const id in groups) {
            console.log(`📌 Group Name : ${groups[id].subject}`);
            console.log(`🔑 Group ID   : ${id}`);
            console.log('-----------------------------------------');
        }
        
        console.log('\nDone! You can now copy the IDs you need.');
        process.exit(0); 
      } catch (error) {
        console.error('Error fetching groups:', error);
        process.exit(1);
      }
    }
  });
}

fetchGroups();