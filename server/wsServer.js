/**
 * WebSocket — live Telegram messages per browser session / deck profile.
 */

const WebSocket = require('ws');
const tg        = require('./telegramClient');
const state     = require('./state');
const wsAuth    = require('./wsAuth');
const { translateToEnglish } = require('./translate');

let wss = null;
let unsubscribeTg = null;

function init(server) {
  wss = new WebSocket.Server({ server, path: '/ws' });

  console.log('🔌  WebSocket server listening on /ws');

  wss.on('connection', (ws, req) => {
    let profileId = null;
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      profileId = wsAuth.consume(u.searchParams.get('t'));
    } catch (_) {}

    if (!profileId) {
      ws.close(4001, 'unauthorized');
      return;
    }

    ws.telegramProfileId = profileId;
    console.log('🌐  WebSocket client connected (profile ' + profileId + ')');
    safeSend(ws, { type: 'connected', message: 'TelegramDeck WebSocket ready' });

    tg.ensureConnected(profileId).catch((err) => {
      console.warn('WS profile connect:', err.message);
    });

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw);
        if (data.type === 'ping') safeSend(ws, { type: 'pong' });
      } catch (_) {}
    });

    ws.on('close', () => console.log('🔌  WebSocket client disconnected'));
    ws.on('error', (err) => console.warn('WS client error:', err.message));
  });

  if (!unsubscribeTg) {
    unsubscribeTg = tg.onLiveMessage(async ({ profileId, message }) => {
      const senderHandle = message.sender?.handle;
      if (!senderHandle || !isTrackedForProfile(profileId, senderHandle)) return;

      if (state.getSettings(profileId).autoTranslate && message.text) {
        try {
          const result = await translateToEnglish(message.text);
          if (result) {
            message.originalText  = message.text;
            message.text          = result.translatedText;
            message.sourceLang    = result.sourceLang;
            message.wasTranslated = true;
          }
        } catch (_) {}
      }

      broadcastToProfile(profileId, { type: 'new_message', message });
    });
  }
}

function isTrackedForProfile(profileId, handle) {
  const norm = handle.toLowerCase();
  if (state.getFollowing(profileId).some(h => h.toLowerCase() === norm)) return true;
  return state.getLists().some(l => l.accounts.some(h => h.toLowerCase() === norm));
}

function broadcastToProfile(profileId, payload) {
  if (!wss) return;
  const str = JSON.stringify(payload);
  wss.clients.forEach((ws) => {
    if (ws.telegramProfileId === profileId && ws.readyState === WebSocket.OPEN) {
      try { ws.send(str); } catch (_) {}
    }
  });
}

function safeSend(ws, payload) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  } catch (_) {}
}

module.exports = { init, broadcastToProfile };
