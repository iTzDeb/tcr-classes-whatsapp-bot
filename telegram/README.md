# TCR Telegram Schedule Bot

This app provides Telegram commands for viewing and editing the shared TCR class schedule. It runs as a Vercel serverless webhook, independently of the separately maintained WhatsApp daemon (not included in this repository).

## Commands

- `/help` or `/start` — show command help and refresh the Telegram command menu.
- `/today`, `/tomorrow` — list classes for that date (Asia/Kolkata).
- `/list [date or search text]` — list all classes or filter by date, center, course, subject, or faculty.
- `/preview` — preview only tomorrow’s complete, unsent classes. Message headings append `(LN)` for Laxmi Nagar and `(HK)` for Hauz Khas (center matching is case-insensitive and tolerates a trailing `Centre`/`Center`/`Campus`); only eligible Laxmi Nagar classes get Zoom links. Before sending, a stored Laxmi Nagar Zoom link is verified: a meeting that already matches the row is kept as-is, a drifted meeting is updated in place (same link), and a meeting Zoom cannot verify (HTTP 404 / code 2300) is replaced with a newly created meeting whose link is written back to column I. Each group message carries inline buttons: `Open WhatsApp (no Zoom)` (the same flow formatted with no Zoom lines, for groups that must not get links), `Generate Zoom & Prepare Send` when a link is still missing, and after generation `Open WhatsApp (with Zoom)`, `Open WhatsApp (no Zoom)`, and `Mark as sent`. Tapping Generate sends the updated message to the chat that requested it.
- `/resend <row>` — clear G (status) and I (Zoom URL) so `/preview` can re-prepare the row.
- `/undo <row>` — clear `SENT` in G but keep the Zoom URL in I.
- `/chat add <chat-id>`, `/chat remove <chat-id>`, or `/chat list` — manage authorized Telegram chats from the administrator’s private chat; IDs are stored in the `AuthorizedChats` tab of the schedule spreadsheet.
- `/create` or `/add` — add a class using comma-separated, pipe-separated, multiline, or key-value input. It inserts a row and writes explicitly to A:H (G is left blank for the dispatch status; the Calendar `iCalUID` is stored in H). Class date/time input is treated as Asia/Kolkata (IST) when creating Calendar events.
- Voice note (audio message) — describe one or more classes; the bot transcribes and extracts them, then creates the rows after a confirmation button. See [Voice notes](#voice-notes).
- `/update <row> <field> <value>` — update one field, or provide a complete row. Supported fields are Date, Time, Center, Course, Subject, Faculty, and Status; changing a detail field clears G and the stored Zoom URL in I.
- `/delete <row>` — delete its linked Calendar event from column H, then delete the schedule row. If deleting the Calendar event fails, the row is retained.

`/preview` buttons carry a short signature over the group and its rows. If the sheet changes between sending the preview and tapping a button, the callback is rejected with “This preview is out of date. Run /preview again.”

`/start` and `/help` register Telegram's command menu, which includes `/help`. Command failures are reported in the chat with a safe error summary and a reference ID for Vercel logs. If Calendar event creation fails, `/create` reports that it saved the row without the event. Deleting a row directly in Google Sheets does not run bot cleanup; use `/delete` when the linked Calendar event should also be removed.

## Voice notes

Send an audio message instead of typing `/create`. The bot downloads the Telegram voice file, transcribes it with Groq (`whisper-large-v3-turbo`), and asks the extraction model (`openai/gpt-oss-20b`) for one object per class described, so a single voice note can create several classes.

1. The transcript is always echoed back to the chat.
2. Every extracted class is trimmed and validated with the same date/time parsers as `/create`; it must carry date, time, center, course, subject, and faculty. Incomplete classes are listed as skipped, with the reason.
3. If at least one class is complete, a preview lists the classes to create and stores a one-time draft in the spreadsheet's `Drafts` tab (header `Draft ID | Chat ID | User ID | Expires At | Payload`). Tapping **✅ Create N class(es)** inserts the rows in chronological order and replies with one summary; **❌ Cancel** consumes the draft without creating anything.
4. Drafts belong to the chat and user that created them, are single-use, and expire after 30 minutes. Voice files larger than 20MB are rejected. Without `GROQ_API_KEY` the bot replies that voice input is not configured; text commands keep working.

Audio is uploaded to Groq for transcription, so it leaves this system — do not send voice notes containing information that must stay inside the deployment's trust boundary. The configured free-tier limits are `whisper-large-v3-turbo`: 7,200 audio-seconds per hour and 28,800 per day, and `openai/gpt-oss-20b`: 1,000 requests per day. Rate-limited requests are reported as "Voice service is busy, try again in a minute."

## Vercel configuration

Deploy this directory as the Vercel project's **Root Directory**. Configure these environment variables for Production (and Preview only if desired):

| Variable | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | A current token from Telegram BotFather. Do not commit it. |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | Random secret (1-256 letters, digits, `_`, or `-`) sent by Telegram with each webhook update. Must match the secret used with `setWebhook`. |
| `AUTHORIZED_CHAT_ID` | Yes | Initial authorized chat (seeded into `AuthorizedChats` when that tab is created) and recipient for the daily Vercel cron preview. |
| `SPREADSHEET_ID` | Yes | ID of the Google spreadsheet containing the schedule. |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Yes | Google service-account JSON, either raw JSON or base64-encoded JSON. |
| `GOOGLE_CALENDAR_ID` | No | Calendar ID for class events; defaults to `primary`. |
| `ZOOM_ACCOUNT_ID` | Yes for Zoom links | Zoom Server-to-Server OAuth account ID. |
| `ZOOM_CLIENT_ID` | Yes for Zoom links | Zoom Server-to-Server OAuth client ID. |
| `ZOOM_CLIENT_SECRET` | Yes for Zoom links | Zoom Server-to-Server OAuth client secret. |
| `CRON_SECRET` | Yes | Bearer token used to authenticate Vercel's scheduled `/api/cron` request. |
| `GROQ_API_KEY` | No | Groq API key for voice notes (speech-to-text and class extraction). Without it voice messages are refused with a configuration message; text commands are unaffected. |

Share the spreadsheet with the service account email as an Editor. If calendar event creation is required, enable the Google Calendar API and share the target calendar with that service account with permission to make changes to events. Enable the Google Sheets API in the service account's Google Cloud project as well.

The webhook accepts Telegram `POST` updates at `/` only when the `X-Telegram-Bot-Api-Secret-Token` header matches `TELEGRAM_WEBHOOK_SECRET`; `GET /` is a health check. Configure this value as a Vercel Production environment variable, then set Telegram's webhook to the deployed root URL with the same secret:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<YOUR_VERCEL_DOMAIN>/&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

Check the result with Telegram's `getWebhookInfo` endpoint. Register with `"allowed_updates": ["message", "callback_query"]` (or omit the field): the `/preview` buttons arrive as callback queries, so a webhook limited to `message` leaves the buttons non-functional. Do not include either secret in shell history, chat messages, or repository files. Since Telegram webhooks cannot add a Vercel SSO login, the Vercel production endpoint must be publicly reachable; the webhook-secret validation protects POST updates. A POST is also refused with HTTP 500 when any required variable is empty; the response lists the missing names.

The Vercel cron sends `/preview` results to `AUTHORIZED_CHAT_ID` every day at 16:28 Asia/Kolkata (10:58 UTC), hitting `GET /api/cron` as configured in `vercel.json`. Vercel authenticates cron requests with `Authorization: Bearer <CRON_SECRET>`; a missing `CRON_SECRET` returns 500 and a wrong/missing bearer token returns 401. The preview reads and writes Zoom URLs in column I; add `Zoom URL` to cell I1 before using `/preview`. Zoom links are generated and refreshed only for eligible Laxmi Nagar classes; Hauz Khas messages omit Zoom links. Preview headings identify Laxmi Nagar with `(LN)` and Hauz Khas with `(HK)`. Existing eligible Zoom meetings are refreshed with the row’s current title, date, time, and duration, so direct spreadsheet edits are reflected in the meeting. Marking a row sent writes `SENT` to column G directly through the Sheets API. Telegram `/update` clears the stored link when class details change. Any non-POST request other than `/api/cron` returns the plain-text health message.

The `/chat` commands create the `AuthorizedChats` tab automatically if it does not exist. The fixed administrator is Telegram user ID `499900380`; access management is accepted only in that account’s private chat, and the administrator cannot be removed. Cell A1 is the `Chat ID` header; one authorized Telegram chat ID is stored per row below it. Positive private-chat IDs and negative group-chat IDs are accepted. The existing `AUTHORIZED_CHAT_ID` is copied into the list when the tab is first initialized and can later be removed with `/chat remove`.

## Local checks

From this directory, run:

```sh
npm ci
npm test
```

The tests exercise schedule parsing, filtering, insertion ordering, configuration validation, webhook-secret and cron-auth checks, Zoom start-time/sync behavior, preview grouping and keyboard construction, chat-ID normalization, voice transcription/extraction/validation (with stubbed fetch calls), one-time Drafts handling, and the health endpoint without modifying the live spreadsheet or sending Telegram messages.

The old create path used Sheets `values.append`, which could place a newly-created record to the right of the schedule table. The explicit insert-and-write path prevents future row shifts; it does not automatically repair an entry created by the old behavior. Back up the sheet and move that entry's six class fields into A:F, leaving G empty and preserving its verified Calendar event ID in H.

## Google Apps Script interaction

The webhook writes schedule rows directly through the Google Sheets API. Those API writes do **not** fire Google Apps Script `onEdit` triggers. If the Apps Script also needs to create Calendar events or publish announcements for Telegram-created rows, configure its own time-driven reconciliation trigger; the webhook cannot activate an edit trigger on its behalf.

## Credentials

The Telegram token that was previously present as a source-code fallback must be revoked in BotFather and replaced in Vercel. Removing a token from the current source does not remove it from prior Git history. Keep all new credentials exclusively in Vercel environment variables.
