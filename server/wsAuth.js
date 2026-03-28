/**
 * Short-lived WebSocket handshake tokens (bound to HTTP session deck user).
 */

const crypto = require('crypto');

const tokens = new Map();

function mint(deckUserId) {
  const t = crypto.randomBytes(20).toString('base64url');
  tokens.set(t, { deckUserId, exp: Date.now() + 90_000 });
  return t;
}

function consume(t) {
  if (!t || typeof t !== 'string') return null;
  const r = tokens.get(t);
  tokens.delete(t);
  if (!r || r.exp < Date.now()) return null;
  return r.deckUserId;
}

module.exports = { mint, consume };
