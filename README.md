# TelegramDeck

A TweetDeck-style client for Telegram — live feeds, multiple columns, lists, and auto-translation, built on the real Telegram MTProto API.

---

## Quick Start (5 steps)

### 1. Get Telegram API credentials

1. Go to **https://my.telegram.org/apps**
2. Log in with your Telegram phone number
3. Create a new application (any name, any platform)
4. Copy your **App api_id** and **App api_hash**

---

### 2. Install dependencies

```bash
cd telegramdeck_1.0.0
npm install
```

---

### 3. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in:

```env
TELEGRAM_API_ID=12345678          # your api_id (number)
TELEGRAM_API_HASH=abcdef1234...   # your api_hash (string)
TELEGRAM_SESSION=                 # leave blank for now
PORT=3000
SESSION_SECRET=some_random_string
```

---

### 4. Authenticate (one-time)

```bash
npm run auth
```

This will prompt you for:
- Your phone number (e.g. `+353861234567`)
- The verification code Telegram sends you
- Your 2FA password (if enabled)

On success it prints a `TELEGRAM_SESSION=...` line.  
**Copy that line into your `.env` file.**

---

### 5. Run

```bash
npm start
```

Open **http://localhost:3000** in your browser.

For development with auto-restart:
```bash
npm run dev   # requires: npm install -g nodemon (or it's in devDependencies)
```

---

## Release 1.0.0 & public hosting

This tree is **TelegramDeck v1.0.0**. To run on a VPS or any server with Docker:

1. Copy `.env.example` → `.env` and set production variables (see comments in `.env.example`).
2. **`docker compose up -d --build`**
3. Put **HTTPS + reverse proxy** in front (Caddy/nginx) and enable **WebSockets**.

Full checklist: **[DEPLOY.md](./DEPLOY.md)**.

---

## Features

| Feature | Details |
|---------|---------|
| **Real MTProto** | Uses `gramjs` — the same protocol as official Telegram clients |
| **Live updates** | WebSocket push — new messages appear in real time |
| **3-day history** | On first load, fetches last 3 days of posts from each tracked account |
| **Lists** | Group accounts by theme; each list gets its own column |
| **Following** | Track individual accounts outside of any list |
| **All Accounts** | Always-on column aggregating everything you track |
| **Auto-translate** | Detects non-English posts and translates via Google Translate (no key needed for free tier) |
| **Drag & drop** | Reorder columns by dragging the title bar |
| **Dark / Light mode** | Toggle in sidebar; preference saved server-side |
| **Persistent state** | Lists, following, columns, settings saved to `data/state.json` |

---

## Optional: Google Translate API key

The app uses Google's free (unofficial) translate endpoint by default — this works fine for personal use.

For higher volume, add your Cloud Translation API key to `.env`:
```env
GOOGLE_TRANSLATE_API_KEY=AIza...
```

Get a key at: https://console.cloud.google.com/apis/library/translate.googleapis.com

---

## Project Structure

```
telegramdeck_1.0.0/
├── server/
│   ├── index.js           # Express + HTTP server entry point
│   ├── auth.js            # One-time CLI auth script
│   ├── telegramClient.js  # MTProto client (gramjs wrapper)
│   ├── routes.js          # REST API endpoints
│   ├── wsServer.js        # WebSocket live push server
│   ├── state.js           # JSON file persistence
│   └── translate.js       # Google Translate helper
├── public/
│   └── index.html         # Full frontend SPA
├── data/
│   └── state.json         # Auto-created; stores your lists/following/columns
├── .env.example
├── .env                   # Your credentials (gitignored)
└── package.json
```

---

## API Reference

All endpoints are under `/api`:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/me` | Logged-in user profile |
| GET | `/api/entity/:handle` | Resolve a Telegram username to entity info |
| GET | `/api/messages/:handle` | Recent messages from an account |
| GET | `/api/messages/multi?handles[]=...` | Batch messages from multiple accounts |
| GET/POST/DELETE | `/api/following` | Manage individually followed accounts |
| GET/POST/DELETE | `/api/lists` | Manage lists |
| POST/DELETE | `/api/lists/:id/accounts` | Add/remove accounts from a list |
| GET/POST/PUT/DELETE | `/api/columns` | Manage deck columns |
| GET/PATCH | `/api/settings` | App settings (translate, theme, etc.) |

WebSocket endpoint: `ws://localhost:3000/ws`  
Receives `{ type: 'new_message', message: {...} }` for live posts.

---

## Notes & Limitations

- **Telegram ToS**: This uses your personal account via MTProto. Automating mass data collection or spamming may violate Telegram's ToS. This tool is intended for personal reading/monitoring only.
- **Public channels only**: You can track any public Telegram channel or bot. Private channels require your account to already be a member.
- **Rate limits**: Telegram enforces rate limits on the API. The app respects these; if you add many accounts at once you may see brief delays.
- **Session security**: Your session string in `.env` grants full access to your Telegram account. Keep it secret and never commit it to git. The `.gitignore` excludes `.env` by default.

---

## .gitignore

```
node_modules/
.env
data/
```
