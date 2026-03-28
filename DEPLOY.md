# Deploy TelegramDeck 1.0.0 (public website)

This file matches the **1.0.0** release tree. For a full narrative guide, see the repository README “Hosting” section.

## Prerequisites

- A server or PaaS that runs **Node.js 18+** (or Docker).
- A **domain name** and DNS control (optional but recommended).
- **Telegram API ID & hash** from [my.telegram.org/apps](https://my.telegram.org/apps).
- **HTTPS** in production (Let’s Encrypt, or your host’s TLS).

## Environment variables (production)

| Variable | Required | Notes |
|----------|----------|--------|
| `TELEGRAM_API_ID` | Yes | From my.telegram.org |
| `TELEGRAM_API_HASH` | Yes | From my.telegram.org |
| `SESSION_SECRET` | Yes (prod) | ≥32 random characters |
| `NODE_ENV` | Recommended | `production` |
| `APP_ORIGINS` | Yes (public site) | `https://yourdomain.com` (comma-separated if several) |
| `SESSION_COOKIE_SECURE` | With HTTPS | `1` |
| `TRUST_PROXY` | Behind nginx/Caddy | `1` |
| `PORT` | Optional | Default `3000` inside container; map host port in Docker |

Optional: `TELEGRAM_SESSION` for first user migration; otherwise add users in the app.

## Option A — Docker (VPS)

1. Install Docker and Docker Compose on the server.
2. Clone this repo, `cd` into `telegramdeck_1.0.0` (or the repo root if that **is** this folder).
3. `cp .env.example .env` and edit `.env` with real values (including `SESSION_SECRET`, `APP_ORIGINS`).
4. `docker compose up -d --build`
5. Put **Caddy** or **nginx** in front with TLS, proxy to `http://127.0.0.1:3000`, enable **WebSocket** upgrade. See **`Caddyfile.example`** for a minimal Caddy v2 site block.
6. Set `APP_ORIGINS` to your public `https://` origin and restart the container.

## Option B — Node on a VPS (systemd)

1. Install Node 20 LTS.
2. Clone repo, `npm ci --omit=dev` (or `npm install --omit=dev`).
3. Create `.env` as above.
4. Run `node server/index.js` under **pm2** or **systemd**; bind to `127.0.0.1:3000`.
5. Reverse proxy + TLS + WebSockets as in Option A.

## WebSockets

The app uses **WebSockets** on the same host as the HTTP API. Your proxy must pass `Upgrade` and `Connection` headers (standard WebSocket config).

## Security checklist

- Never commit `.env` or `data/`.
- Restrict SSH; firewall everything except 80/443 (and SSH).
- Use a long random `SESSION_SECRET`.
- Keep `APP_ORIGINS` aligned with the URL users open in the browser.

## PWA / install

Icons and `manifest.webmanifest` are included; **HTTPS** is required for “install app” behavior in most browsers.
