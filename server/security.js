/**
 * Input validation for public Telegram usernames, message ids, and deck user ids.
 */

const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{3,30}$/;
const MSG_ID_RE   = /^\d{1,15}$/;
const DECK_USER_ID_RE = /^(d_|p_)[a-zA-Z0-9_]{2,128}$/;
const DECK_USERNAME_RE = /^[a-zA-Z0-9_]{2,32}$/;
const MAX_SESSION_STRING = 20000;
const MAX_DECK_USERNAME_LEN = 32;

function isValidPublicUsername(raw) {
  const u = String(raw || '').replace(/^@/, '').toLowerCase();
  return USERNAME_RE.test(u);
}

function isValidMessageId(raw) {
  return MSG_ID_RE.test(String(raw || '').trim());
}

function isValidDeckUserId(raw) {
  return typeof raw === 'string' && DECK_USER_ID_RE.test(raw);
}

function isValidDeckUsername(raw) {
  if (raw == null || typeof raw !== 'string') return false;
  const t = raw.trim();
  return t.length >= 2 && t.length <= MAX_DECK_USERNAME_LEN && DECK_USERNAME_RE.test(t);
}

function sanitizeDeckUsername(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  return raw.trim().slice(0, MAX_DECK_USERNAME_LEN).replace(/[\x00-\x1f\x7f]/g, '');
}

/** Telegram StringSession paste; reject absurd sizes and null bytes */
function isValidSessionString(s) {
  if (typeof s !== 'string') return false;
  if (s.length < 20 || s.length > MAX_SESSION_STRING) return false;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)) return false;
  return true;
}

module.exports = {
  isValidPublicUsername,
  isValidMessageId,
  isValidDeckUserId,
  isValidDeckUsername,
  sanitizeDeckUsername,
  isValidSessionString,
};
