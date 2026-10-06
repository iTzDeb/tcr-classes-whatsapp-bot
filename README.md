# TCR Classes WhatsApp Schedule Dispatch Bot

An **Always-On WhatsApp Bot Daemon** built with Node.js, `@whiskeysockets/baileys`, Express, Zoom REST API, Telegram Bot API, and Google Apps Script integration.

This bot automates the daily schedule dispatch process for TCR Classes by fetching schedules from Google Sheets, generating Zoom meeting links, formatting schedule announcements, and broadcasting them to target WhatsApp groups.

---

## 🌟 Key Features

* **⚡ Always-On Daemon Architecture**
  - Maintains a persistent 24/7 WebSocket connection with WhatsApp Web via Baileys.
  - Keeps the linked device marked offline on connect (`markOnlineOnConnect: false`) so the primary phone can continue receiving message notifications.
  - Fixes WhatsApp Multi-Device (Signal Protocol encryption) key handshake delays and eliminates the *"Waiting for this message. This may take a while"* issue.

* **📅 Automated Schedule Formatting & Dispatch**
  - Fetches pending class schedules from a Google Apps Script endpoint.
  - Groups tomorrow's classes by Center and Course, formatting ordinal dates (e.g., `24th October`), time slots, subjects, and faculty names.
  - Marks dispatches as completed in Google Sheets upon successful delivery.

* **🎯 Dynamic WhatsApp Group Routing**
  - Resolves target WhatsApp Group JIDs based on normalized `center_course` lookup keys (e.g., `laxmi nagar_gs foundation`).
  - Supports broadcasting to multiple comma-separated WhatsApp Group JIDs simultaneously.

* **📹 Automatic Zoom Meeting Integration**
  - Connects to Zoom API via Server-to-Server OAuth.
  - Automatically creates Zoom meetings for designated centers (e.g., Laxmi Nagar) with IST timezone conversion (`Asia/Kolkata`).
  - Implements collision offsets for back-to-back classes starting at the same time.
  - Automatically detects offline events (e.g., "Mock", "Test") and skips Zoom link generation.
  - Includes decoupled fallbacks so message dispatch succeeds even if Zoom API is temporarily unavailable.

* **📱 Telegram Alerts & Remote QR Code Authentication**
  - Sends real-time alerts and error reports directly to a configured Telegram Chat.
  - When re-authentication or initial login is required, renders and sends the **WhatsApp QR Code photo** directly to Telegram, allowing easy scanning from a mobile phone without touching the server terminal.

* **🔌 Webhook API & Health Checks**
  - Provides a `/dispatch` endpoint for triggering schedule dispatches via Google Apps Script or CRON schedulers (e.g., GitHub Actions).
  - Includes a `/status` endpoint for system health monitoring.

* **🔍 Group ID Discovery Utility (`getgroups.js`)**
  - A helper script to scan and print all WhatsApp groups the bot account belongs to, along with their unique JIDs.

---

## 🛠️ Environment Variables Configuration

Configure the following environment variables in your server environment or `.env` file:

| Variable | Required | Description |
| :--- | :---: | :--- |
| `PORT` | Optional | Web server port (Default: `8080`). |
| `ZOOM_ACCOUNT_ID` | Optional | Zoom Server-to-Server OAuth Account ID. |
| `ZOOM_CLIENT_ID` | Optional | Zoom Server-to-Server OAuth Client ID. |
| `ZOOM_CLIENT_SECRET` | Optional | Zoom Server-to-Server OAuth Client Secret. |
| `TELEGRAM_BOT_TOKEN` | Optional | Telegram Bot API Token from @BotFather for alerts & QR code delivery. |
| `TELEGRAM_CHAT_ID` | Optional | Telegram Chat / Channel ID to receive alerts & QR code images. |

---

## 🏗️ Architecture & Workflow

1. **Trigger**: An automated schedule trigger (Google Apps Script or GitHub Actions) sends a request to `GET/POST /dispatch`.
2. **Fetch Schedule**: The bot fetches class data and group routing settings from the Google Apps Script Web App URL.
3. **Filter & Group**: Filters classes scheduled for tomorrow (IST timezone) and groups them by center and course.
4. **Zoom Link Generation**: For online sessions in designated centers, the bot requests a Zoom OAuth token and creates Zoom meetings.
5. **Broadcast**: Sends formatted schedule announcements to mapped WhatsApp groups via Baileys WebSocket with safety delays.
6. **Update Status**: Posts confirmation back to Google Apps Script to mark rows as dispatched.
7. **Telegram Monitoring**: If any failure occurs or re-authentication is required, notifications/QR codes are sent to Telegram.

---

## 🌐 API Webhook Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `GET /` | `GET` | Simple status message showing whether WhatsApp WebSocket is connected. |
| `GET /status` | `GET` | Detailed JSON status (connection status, processing flag, server timestamp). |
| `ALL /dispatch` | `GET/POST` | Webhook endpoint to trigger daily schedule processing and dispatch. |

---

## 🚀 Quick Start & Local Setup

### Prerequisites
* **Node.js**: v18 or higher
* **npm**: v9 or higher

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-username/tcr-classes-whatsapp-bot.git
   cd tcr-classes-whatsapp-bot
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the server**:
   ```bash
   node index.js
   ```

4. **Authenticate WhatsApp**:
   - On initial start, a QR code will display in the terminal (and send to Telegram if configured).
   - Scan the QR code using WhatsApp on your mobile phone (**Linked Devices** -> **Link a Device**).
   - Authentication credentials will be saved locally in the `auth_info/` directory.

---

## 🔍 Finding WhatsApp Group IDs (`getgroups.js`)

To route messages to specific WhatsApp groups, you need their group JIDs (e.g., `1203630XXXXX@g.us`).

1. Ensure you have authenticated WhatsApp at least once so `auth_info/` exists.
2. Run the discovery script:
   ```bash
   node getgroups.js
   ```
3. Copy the Group JIDs listed in the output and paste them into your Google Sheets Settings tab.

---

## 💡 Google Sheets Structure

The Google Apps Script connects to a spreadsheet with two main tabs:

### 1. Classes Tab
Contains daily scheduled classes with columns:
- `Date`: Date of class (e.g., `2025-10-25`)
- `Time`: Class time slot (e.g., `10:00 AM - 12:00 PM`)
- `Center`: Center name (e.g., `Laxmi Nagar`)
- `Course`: Course name (e.g., `GS Foundation`)
- `Subject`: Subject name (e.g., `Indian Polity`)
- `Faculty`: Faculty name (e.g., `Dr. Sharma`)

### 2. Settings Tab
Maps `center_course` keys to WhatsApp Group JIDs:
- **Key**: Combined center and course (e.g., `laxmi nagar_gs foundation`)
- **Value**: Comma-separated list of WhatsApp group JIDs (e.g., `12036301234567890@g.us, 12036309876543210@g.us`)

---

## ☁️ 0-Cost Hosting Setup Instructions

You can host this bot daemon continuously for **$0 cost**.

### Option 1: Koyeb (Recommended)
1. Sign up at [koyeb.com](https://www.koyeb.com/).
2. Create a new Web Service connected to your GitHub repository.
3. Configure environment variables (`ZOOM_*`, `TELEGRAM_*`).
4. Koyeb automatically builds and runs `node index.js` via `Procfile`.
5. Access your assigned public URL (e.g., `https://your-app.koyeb.app`).

### Option 2: Render Free / Termux / Local Server
- Deploy as a Background Web Service on Render or run on a dedicated local machine or Termux on Android.

### Triggering Automated Dispatches
- **Google Apps Script Time Trigger**: Set a daily time-driven trigger in Google Apps Script to execute `UrlFetchApp.fetch('https://your-app.koyeb.app/dispatch')`.
- **GitHub Actions Schedulers**: Use GitHub Actions (`.github/workflows/daily.yml`) with repository secrets (`BOT_SERVER_URL`) to ping `/dispatch` on a schedule.

---

## 📱 QR Code Re-authentication via Telegram

If the WhatsApp session disconnects or expires:
1. The daemon detects the disconnect and generates a new QR code.
2. An image of the QR code is posted directly to your Telegram chat via Telegram Bot API.
3. Scan the QR code image from Telegram using your WhatsApp mobile app—no terminal or server access required!

---

## 📄 License

ISC License.
