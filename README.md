# TCR Classes WhatsApp Bot Daemon

This repository contains an **Always-On WhatsApp Bot Daemon** built with Baileys and Express.

## Why Always-On?
WhatsApp multi-device encryption (Signal Protocol) requires a persistent WebSocket connection. When sending group broadcasts, participant devices send retry receipts back to the bot. Maintaining a 24/7 connection guarantees that recipient devices complete their key exchange handshakes, eliminating the **"Waiting for this message. This may take a while"** error.

---

## 0-Cost Hosting Setup Instructions

You can host this bot continuously for **$0 cost** on free tier hosting services such as **Koyeb**, **Render**, **Render Free**, or on a local device/Android phone (via Termux).

### Option 1: Koyeb (100% Free - Recommended)
1. Sign up at [koyeb.com](https://www.koyeb.com/).
2. Click **Create App** and select **GitHub**.
3. Choose this repository (`tcr-classes-whatsapp-bot`).
4. Set Environment Variables in Koyeb App Settings:
   - `ZOOM_ACCOUNT_ID`
   - `ZOOM_CLIENT_ID`
   - `ZOOM_CLIENT_SECRET`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
5. Deploy! Koyeb will assign a public URL (e.g. `https://your-app-name.koyeb.app`).

### Triggering Dispatches
- **Google Apps Script**: You can update `triggerBotExactlyOnTime()` in GAS to call `https://your-app-name.koyeb.app/dispatch` directly.
- **GitHub Actions**: Set a GitHub Secret `BOT_SERVER_URL` in your repository pointing to `https://your-app-name.koyeb.app`. The `daily.yml` workflow will ping `/dispatch`.

---

## QR Code Scanning
If the WhatsApp session ever logs out, the bot will automatically render and send a QR code photo directly to your configured **Telegram Chat ID** via Telegram Bot API! Simply scan the QR code from Telegram to link your phone without touching terminal commands.
