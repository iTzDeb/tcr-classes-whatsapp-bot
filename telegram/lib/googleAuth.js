const { google } = require('googleapis');

function getGoogleAuth(env = process.env) {
  let auth;
  if (env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    let rawKey = env.GOOGLE_SERVICE_ACCOUNT_KEY.trim();

    if (!rawKey.startsWith('{') && !rawKey.startsWith('"') && !rawKey.startsWith("'")) {
      try {
        const decoded = Buffer.from(rawKey, 'base64').toString('utf8');
        if (decoded.includes('{')) {
          rawKey = decoded.trim();
        }
      } catch (error) {
        console.error('Base64 decode attempt failed:', error.message);
      }
    }

    if ((rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith("'") && rawKey.endsWith("'"))) {
      rawKey = rawKey.substring(1, rawKey.length - 1).trim();
    }

    const firstBrace = rawKey.indexOf('{');
    const lastBrace = rawKey.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      rawKey = rawKey.substring(firstBrace, lastBrace + 1);
    }

    const credentials = JSON.parse(rawKey);
    if (credentials.private_key && typeof credentials.private_key === 'string') {
      credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    }

    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/calendar'
      ]
    });
  } else {
    auth = new google.auth.GoogleAuth({
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/calendar'
      ]
    });
  }
  return auth;
}

module.exports = { getGoogleAuth };
