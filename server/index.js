/**
 * index.js — TelegramDeck server entry point
 *
 * Starts:
 *   1. Express HTTP server (REST API + static file serving)
 *   2. WebSocket server (live message push)
 *   3. Telegram MTProto connection
 */

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors    = require('cors');
const helmet  = require('helmet');
const http    = require('http');
const path    = require('path');

const tg       = require('./telegramClient');
const routes   = require('./routes');
const wsServer = require('./wsServer');
const state    = require('./state');

// ─── Validate env ────────────────────────────────────────────
const { TELEGRAM_API_ID, TELEGRAM_API_HASH } = process.env;

if (!TELEGRAM_API_ID || TELEGRAM_API_ID === 'your_api_id_here') {
  console.error('\n❌  TELEGRAM_API_ID is not set in .env');
  console.error('    Get your API credentials from: https://my.telegram.org/apps\n');
  process.exit(1);
}
if (!TELEGRAM_API_HASH || TELEGRAM_API_HASH === 'your_api_hash_here') {
  console.error('\n❌  TELEGRAM_API_HASH is not set in .env\n');
  process.exit(1);
}

// ─── App setup ───────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const PORT   = parseInt(process.env.PORT, 10) || 3000;

if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

if (process.env.NODE_ENV === 'production') {
  if (!process.env.SESSION_SECRET || String(process.env.SESSION_SECRET).length < 32) {
    console.error('\n❌  Production requires SESSION_SECRET (≥32 random characters). See .env.example.\n');
    process.exit(1);
  }
}

const sessionSecret = process.env.SESSION_SECRET || 'telegramdeck-dev-insecure-do-not-use-in-prod';
if (process.env.NODE_ENV !== 'production' && !process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET unset — using dev default (never deploy this way).\n');
}

function allowedCorsOrigins() {
  const fromEnv = (process.env.APP_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (fromEnv.length) return fromEnv;
  return [
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    `http://telegramdeck.local:${PORT}`,
  ];
}

function buildCspConnectSrc() {
  const list = ["'self'"];
  list.push(
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    `http://telegramdeck.local:${PORT}`,
    `ws://127.0.0.1:${PORT}`,
    `ws://localhost:${PORT}`,
    `ws://telegramdeck.local:${PORT}`
  );
  (process.env.APP_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((o) => {
      try {
        const u = new URL(o);
        list.push(`${u.protocol}//${u.host}`);
        list.push(u.protocol === 'https:' ? `wss://${u.host}` : `ws://${u.host}`);
      } catch (_) {}
    });
  return list;
}

const enableCsp = process.env.TELEGRAMDECK_CSP !== '0';

app.use(helmet({
  contentSecurityPolicy: enableCsp ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: buildCspConnectSrc(),
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  } : false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  permissionsPolicy: {
    camera: [],
    microphone: [],
    geolocation: [],
  },
}));
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowedCorsOrigins().includes(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false, limit: '512kb' }));
app.use(session({
  secret:            sessionSecret,
  resave:            false,
  saveUninitialized: false,
  name:              'telegramdeck.sid',
  cookie:            {
    secure: process.env.SESSION_COOKIE_SECURE === '1',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

function apiOriginGuard(req, res, next) {
  const method = req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  const allowed = allowedCorsOrigins();
  const origin = req.headers.origin;
  if (origin) {
    if (!allowed.includes(origin)) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    return next();
  }
  const referer = req.headers.referer;
  if (!referer) return next();
  let refO;
  try {
    refO = new URL(referer).origin;
  } catch (_) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  const okRef = allowed.some((a) => {
    try {
      return new URL(a).origin === refO;
    } catch (_) {
      return false;
    }
  });
  if (!okRef) return res.status(403).json({ ok: false, error: 'Forbidden' });
  next();
}

// Serve the frontend from /public
app.use(express.static(path.join(__dirname, '..', 'public')));

// REST API
app.use('/api', apiOriginGuard);
app.use('/api', routes);

// Catch-all — serve index.html for SPA navigation
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
});

// ─── Start everything ────────────────────────────────────────
(async () => {
  console.log('\n🚀  TelegramDeck starting...\n');

  if (!state.isTelegramConfigured()) {
    console.warn('⚠️  TELEGRAM_SESSION is not set (or too short).');
    console.warn('    Set it in .env on the server (output of npm run auth), then restart.\n');
  }

  if (process.env.TELEGRAMDECK_TRACE !== '0') {
    const st = state.get();
    const listSlots = st.lists.reduce((n, l) => n + l.accounts.length, 0);
    const deckN = Object.keys(st.deckUsers || {}).length;
    console.log(
      '[TelegramDeck trace] deck storage:',
      deckN, 'deck username(s), shared lists:', st.lists.length, `(${listSlots} list slots)`
    );
  }

  // Start HTTP + WebSocket servers
  server.listen(PORT, () => {
    console.log(`\n✅  TelegramDeck running at http://localhost:${PORT}`);
    console.log(`   Also: http://127.0.0.1:${PORT}  ·  optional host: http://telegramdeck.local:${PORT} (add to your hosts file)\n`);
    // Init WS after server is listening
    wsServer.init(server);
  });

  // Graceful shutdown
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
})();

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n👋  Shutting down TelegramDeck...');
  // disconnect() does not set GramJS _destroyed, so the background ping loop keeps
  // running, hits TIMEOUT on a closing socket, and may call reconnect — use destroy().
  try {
    await tg.destroyAllClients();
  } catch (_) {}
  server.close(() => process.exit(0));
}
