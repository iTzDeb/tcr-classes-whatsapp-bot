# TCR Telegram Schedule Bot

This app provides Telegram commands for viewing and editing the shared TCR class schedule. It runs as a Vercel serverless webhook, independently of the always-on WhatsApp daemon in the repository root.

## Commands

- `/help` or `/start` — show command help.
- `/check` — show the number of unsent schedule rows.
- `/list [date or search text]` — list all classes or filter by date, center, course, subject, or faculty.
- `/create` or `/add` — add a class using comma-separated, pipe-separated, multiline, or key-value input. It inserts a row and writes explicitly to A:H (G is left blank for the dispatch status; the Calendar `iCalUID` is stored in H). Class date/time input is treated as Asia/Kolkata (IST) when creating Calendar events.
- `/update <row> <field> <value>` — update one field, or provide a complete row.
- `/delete <row>` — delete its linked Calendar event from column H, then delete the schedule row. If deleting the Calendar event fails, the row is retained.

`/start` and `/help` register Telegram's command menu, which includes `/help`. Command failures are reported in the chat with a safe error summary and a reference ID for Vercel logs. If Calendar event creation fails, `/create` reports that it saved the row without the event. Deleting a row directly in Google Sheets does not run bot cleanup; use `/delete` when the linked Calendar event should also be removed.

## Vercel configuration

Deploy this directory as the Vercel project's **Root Directory**. Configure these environment variables for Production (and Preview only if desired):

| Variable | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | A current token from Telegram BotFather. Do not commit it. |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | Random secret (1-256 letters, digits, `_`, or `-`) sent by Telegram with each webhook update. Must match the secret used with `setWebhook`. |
| `AUTHORIZED_CHAT_ID` | Yes | Telegram chat or user ID allowed to use commands. |
| `SPREADSHEET_ID` | Yes | ID of the Google spreadsheet containing the schedule. |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Yes | Google service-account JSON, either raw JSON or base64-encoded JSON. |
| `GOOGLE_CALENDAR_ID` | No | Calendar ID for class events; defaults to `primary`. |

Share the spreadsheet with the service account email as an Editor. If calendar event creation is required, enable the Google Calendar API and share the target calendar with that service account with permission to make changes to events. Enable the Google Sheets API in the service account's Google Cloud project as well.

The webhook accepts Telegram `POST` updates at `/` only when the `X-Telegram-Bot-Api-Secret-Token` header matches `TELEGRAM_WEBHOOK_SECRET`; `GET /` is a health check. Configure this value as a Vercel Production environment variable, then set Telegram's webhook to the deployed root URL with the same secret:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<YOUR_VERCEL_DOMAIN>/&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

Check the result with Telegram's `getWebhookInfo` endpoint. Do not include either secret in shell history, chat messages, or repository files. Since Telegram webhooks cannot add a Vercel SSO login, the Vercel production endpoint must be publicly reachable; the webhook-secret validation protects POST updates.

## Local checks

From this directory, run:

```sh
npm ci
npm test
```

The tests exercise schedule parsing, filtering, insertion ordering, configuration validation, and the health endpoint without modifying the live spreadsheet or sending Telegram messages.

The old create path used Sheets `values.append`, which could place a newly-created record to the right of the schedule table. The explicit insert-and-write path prevents future row shifts; it does not automatically repair an entry created by the old behavior. Back up the sheet and move that entry's six class fields into A:F, leaving G empty and preserving its verified Calendar event ID in H.

## Google Apps Script interaction

The webhook writes schedule rows directly through the Google Sheets API. Those API writes do **not** fire Google Apps Script `onEdit` triggers. If the Apps Script also needs to create Calendar events or publish announcements for Telegram-created rows, configure its own time-driven reconciliation trigger; the webhook cannot activate an edit trigger on its behalf.

## Credentials

The Telegram token that was previously present as a source-code fallback must be revoked in BotFather and replaced in Vercel. Removing a token from the current source does not remove it from prior Git history. Keep all new credentials exclusively in Vercel environment variables.
