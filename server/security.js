/**
 * Input validation for public Telegram usernames, message ids, and deck profile ids.
 */

const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{3,30}$/;
const MSG_ID_RE   = /^\d{1,15}$/;
const PROFILE_ID_RE = /^p_[a-zA-Z0-9_]{4,128}$/;
const MAX_SESSION_STRING = 20000;
const MAX_PROFILE_LABEL = 120;

function isValidPublicUsername(raw) {
  const u = String(raw || '').replace(/^@/, '').toLowerCase();
  return USERNAME_RE.test(u);
}

function isValidMessageId(raw) {
  return MSG_ID_RE.test(String(raw || '').trim());
}

function isValidProfileId(raw) {
  return typeof raw === 'string' && PROFILE_ID_RE.test(raw);
}

/** Telegram StringSession paste; reject absurd sizes and null bytes */
function isValidSessionString(s) {
  if (typeof s !== 'string') return false;
  if (s.length < 20 || s.length > MAX_SESSION_STRING) return false;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)) return false;
  return true;
}

function sanitizeProfileLabel(raw) {
  if (raw == null || typeof raw !== 'string') return '';
  const t = raw.trim().slice(0, MAX_PROFILE_LABEL);
  return t.replace(/[\x00-\x1f\x7f]/g, '');
}

module.exports = {
  isValidPublicUsername,
  isValidMessageId,
  isValidProfileId,
  isValidSessionString,
  sanitizeProfileLabel,
};
