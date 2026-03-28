/**
 * Short-lived WebSocket handshake tokens (bound to HTTP session profile).
 */

const crypto = require('crypto');

const tokens = new Map();

function mint(profileId) {
  const t = crypto.randomBytes(20).toString('base64url');
  tokens.set(t, { profileId, exp: Date.now() + 90_000 });
  return t;
}

function consume(t) {
  if (!t || typeof t !== 'string') return null;
  const r = tokens.get(t);
  tokens.delete(t);
  if (!r || r.exp < Date.now()) return null;
  return r.profileId;
}

module.exports = { mint, consume };
