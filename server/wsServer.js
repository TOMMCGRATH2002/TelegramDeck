/**
 * WebSocket — live Telegram messages per browser session / deck user.
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
    let deckUserId = null;
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      deckUserId = wsAuth.consume(u.searchParams.get('t'));
    } catch (_) {}

    if (!deckUserId) {
      ws.close(4001, 'unauthorized');
      return;
    }

    ws.deckUserId = deckUserId;
    console.log('🌐  WebSocket client connected (deck user ' + deckUserId + ')');
    safeSend(ws, { type: 'connected', message: 'TelegramDeck WebSocket ready' });

    tg.ensureConnected(deckUserId).catch((err) => {
      console.warn('WS Telegram connect:', err.message);
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
    unsubscribeTg = tg.onLiveMessage((message) => {
      const senderHandle = message.sender?.handle;
      if (!senderHandle || !wss) return;

      wss.clients.forEach((ws) => {
        if (ws.readyState !== WebSocket.OPEN || !ws.deckUserId) return;
        if (!isTrackedForDeckUser(ws.deckUserId, senderHandle)) return;

        (async () => {
          let out = message;
          if (state.getSettings(ws.deckUserId).autoTranslate && message.text) {
            try {
              const result = await translateToEnglish(message.text);
              if (result) {
                out = {
                  ...message,
                  originalText: message.text,
                  text: result.translatedText,
                  sourceLang: result.sourceLang,
                  wasTranslated: true,
                };
              }
            } catch (_) {}
          }
          safeSend(ws, { type: 'new_message', message: out });
        })();
      });
    });
  }
}

function isTrackedForDeckUser(deckUserId, handle) {
  const norm = handle.toLowerCase();
  if (state.getFollowing(deckUserId).some(h => h.toLowerCase() === norm)) return true;
  return state.getLists().some(l => l.accounts.some(h => h.toLowerCase() === norm));
}

function broadcastToDeckUser(deckUserId, payload) {
  if (!wss) return;
  const str = JSON.stringify(payload);
  wss.clients.forEach((ws) => {
    if (ws.deckUserId === deckUserId && ws.readyState === WebSocket.OPEN) {
      try { ws.send(str); } catch (_) {}
    }
  });
}

function safeSend(ws, payload) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  } catch (_) {}
}

module.exports = { init, broadcastToDeckUser };
