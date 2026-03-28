/**
 * routes.js
 * All REST API endpoints for TelegramDeck.
 *
 * Base path: /api
 */

const express  = require('express');
const rateLimit = require('express-rate-limit');
const router   = express.Router();
const tg       = require('./telegramClient');
const state    = require('./state');
const wsAuth   = require('./wsAuth');
const { translateToEnglish } = require('./translate');
const {
  isValidPublicUsername,
  isValidMessageId,
  isValidProfileId,
  isValidSessionString,
  sanitizeProfileLabel,
} = require('./security');
const mediaCache = require('./mediaCache');
const { sendBufferWithRange } = require('./mediaResponse');

const SESSION_PROFILE_KEY = 'telegramProfileId';

const mediaRate = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 400,
  standardHeaders: true,
  legacyHeaders: false,
});

const profileCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'Too many profile creations from this IP — try again later' });
  },
});

const wsTokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
});

function ok(res, data)         { res.json({ ok: true,  ...data }); }
function fail(res, msg, code = 400) { res.status(code).json({ ok: false, error: msg }); }

function fail500(res, err) {
  const msg = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : (err && err.message) || 'Internal server error';
  fail(res, msg, 500);
}

function normaliseHandle(raw) {
  if (!raw) return null;
  return '@' + raw.replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '').toLowerCase().trim();
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

function trace(label, detail) {
  if (process.env.TELEGRAMDECK_TRACE === '0') return;
  if (detail !== undefined) console.log('[TelegramDeck trace]', label, detail);
  else console.log('[TelegramDeck trace]', label);
}

async function maybeTranslate(messages, autoTranslate) {
  if (!autoTranslate) return;
  await Promise.all(messages.map(async (msg) => {
    if (!msg.text) return;
    const result = await translateToEnglish(msg.text);
    if (result) {
      msg.originalText  = msg.text;
      msg.text          = result.translatedText;
      msg.sourceLang    = result.sourceLang;
      msg.wasTranslated = true;
    }
  }));
}

function pickProfile(req, res, next) {
  try {
    const profiles = state.listProfilesPublic();
    if (profiles.length && !req.session[SESSION_PROFILE_KEY]) {
      req.session[SESSION_PROFILE_KEY] = profiles[0].id;
    }
    req.telegramProfileId = req.session[SESSION_PROFILE_KEY] || null;
  } catch (_) {
    req.telegramProfileId = null;
  }
  next();
}

function requireProfile(req, res, next) {
  if (!req.telegramProfileId) {
    return fail(res, 'Add or select a Telegram user (Account → Telegram profiles).', 401);
  }
  next();
}

router.use(pickProfile);
router.use(apiLimiter);

// ─── Session & multi-user profiles ───────────────────────────

router.get('/session', (req, res) => {
  ok(res, {
    profiles:       state.listProfilesPublic(),
    activeProfileId: req.telegramProfileId,
  });
});

router.post('/profiles', async (req, res) => {
  const { sessionString, label } = req.body || {};
  if (!sessionString || typeof sessionString !== 'string') {
    return fail(res, 'sessionString is required (paste output from npm run auth)');
  }
  let meta;
  try {
    meta = await tg.testNewSession(sessionString.trim());
  } catch (err) {
    return fail(res, err.message || 'Invalid Telegram session', 400);
  }
  const id = state.addProfile({
    label: label || meta.label || 'User',
    session: sessionString.trim(),
  });
  if (!req.session[SESSION_PROFILE_KEY]) req.session[SESSION_PROFILE_KEY] = id;
  req.session.save((err) => {
    if (err) return fail500(res, err);
    ok(res, { profile: { id, label: cleanLabel || meta.label || 'User' } });
  });
});

router.post('/profile/active', (req, res) => {
  const { profileId } = req.body || {};
  if (!isValidProfileId(profileId)) return fail(res, 'Invalid profile id', 400);
  const profiles = state.get().profiles || {};
  if (!profiles[profileId]) return fail(res, 'Unknown profile', 400);
  req.session[SESSION_PROFILE_KEY] = profileId;
  req.session.save((err) => {
    if (err) return fail500(res, err);
    ok(res, { activeProfileId: profileId });
  });
});

router.delete('/profiles/:id', async (req, res) => {
  const id = req.params.id;
  if (!isValidProfileId(id)) return fail(res, 'Invalid profile id', 400);
  if (!state.get().profiles[id]) return fail(res, 'Unknown profile', 404);
  await tg.destroyClient(id);
  mediaCache.invalidateForProfile(id);
  state.removeProfile(id);
  if (req.session[SESSION_PROFILE_KEY] === id) {
    const rest = state.listProfilesPublic();
    req.session[SESSION_PROFILE_KEY] = rest[0] ? rest[0].id : null;
  }
  req.session.save((err) => {
    if (err) return fail500(res, err);
    ok(res, { removed: id, activeProfileId: req.session[SESSION_PROFILE_KEY] || null });
  });
});

router.get('/ws-token', wsTokenLimiter, requireProfile, (req, res) => {
  ok(res, { token: wsAuth.mint(req.telegramProfileId) });
});

// ─── Account / Telegram user ─────────────────────────────────

router.get('/me', requireProfile, async (req, res) => {
  try {
    const user = await tg.getMe(req.telegramProfileId);
    ok(res, { user });
  } catch (err) {
    fail500(res, err);
  }
});

router.get('/entity/:handle', requireProfile, async (req, res) => {
  try {
    const handle = normaliseHandle(req.params.handle);
    const info   = await tg.getEntityInfo(req.telegramProfileId, handle);
    ok(res, { entity: info });
  } catch (err) {
    fail(res, err.message);
  }
});

router.get('/avatar/:username', mediaRate, requireProfile, async (req, res) => {
  try {
    const u = req.params.username;
    if (!isValidPublicUsername(u)) return res.status(400).end();
    const handle = normaliseHandle(u);
    const { buffer, mime } = await tg.downloadProfilePhoto(req.telegramProfileId, handle);
    sendBufferWithRange(req, res, buffer, mime, 'public, max-age=604800');
  } catch (_) {
    res.status(404).end();
  }
});

router.get('/media/:username/:msgId', mediaRate, requireProfile, async (req, res) => {
  try {
    const u = req.params.username;
    const msgId = req.params.msgId;
    if (!isValidPublicUsername(u) || !isValidMessageId(msgId)) {
      return res.status(400).end();
    }
    const handle = normaliseHandle(u);
    const cacheKey = `${req.telegramProfileId}|${handle}|${msgId}`;
    const cached = mediaCache.get(cacheKey);
    if (cached) {
      sendBufferWithRange(req, res, cached.buffer, cached.mime, 'public, max-age=604800, immutable');
      return;
    }
    const ctx = await tg.loadMessageMediaContext(req.telegramProfileId, handle, msgId);
    const streamed = await tg.pipeVideoMessageToResponse(req, res, ctx.client, ctx.msg);
    if (streamed) return;
    const { buffer, mime } = await tg.downloadMessageMediaFromMessage(ctx.client, ctx.msg);
    mediaCache.set(cacheKey, buffer, mime);
    sendBufferWithRange(req, res, buffer, mime, 'public, max-age=604800, immutable');
  } catch (_) {
    res.status(404).end();
  }
});

// ─── Messages ────────────────────────────────────────────────

router.get('/messages/batch', requireProfile, async (req, res) => {
  const t0 = Date.now();
  const pid = req.telegramProfileId;
  try {
    let handles = req.query.handles;
    if (handles == null && req.query['handles[]'] != null) handles = req.query['handles[]'];
    handles = handles || [];
    if (typeof handles === 'string') handles = [handles];
    if (!handles.length) {
      trace('GET /messages/batch (empty handles)', {
        hint: 'Browser sent no handles[] — UI may have zero accounts for this column, or query parsing failed',
        rawQuery: req.query,
      });
      return ok(res, { messages: [] });
    }

    const sinceMs   = parseInt(req.query.since) || (Date.now() - THREE_DAYS_MS);
    const translate = req.query.translate === 'true' || state.getSettings(pid).autoTranslate;
    const normHandles = handles.map(h => normaliseHandle(h));

    trace('GET /messages/batch ←', {
      count: normHandles.length,
      handles: normHandles,
      sinceIso: new Date(sinceMs).toISOString(),
      translate,
    });

    const results = await Promise.allSettled(
      normHandles.map(h => tg.getMessages(pid, h, 20, sinceMs))
    );

    let messages = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') messages.push(...r.value);
      else {
        trace('GET /messages/batch per-handle ERR', {
          handle: normHandles[i],
          reason: r.reason?.message || String(r.reason),
        });
      }
    });

    const beforeT = messages.length;
    messages = messages
      .filter(m => m.timestamp >= sinceMs)
      .sort((a, b) => b.timestamp - a.timestamp);

    trace('GET /messages/batch →', {
      ms: Date.now() - t0,
      handlesOk: results.filter(r => r.status === 'fulfilled').length,
      handlesFailed: results.filter(r => r.status === 'rejected').length,
      mergedBeforeTimeFilter: beforeT,
      afterTimeFilter: messages.length,
    });

    await maybeTranslate(messages, translate);
    ok(res, { messages });
  } catch (err) {
    trace('GET /messages/batch ERR', { error: err.message, ms: Date.now() - t0 });
    fail500(res, err);
  }
});

router.get('/messages/:handle', requireProfile, async (req, res) => {
  const t0 = Date.now();
  const pid = req.telegramProfileId;
  try {
    const handle      = normaliseHandle(req.params.handle);
    const limit       = Math.min(parseInt(req.query.limit) || 30, 100);
    const sinceMs     = parseInt(req.query.since) || (Date.now() - THREE_DAYS_MS);
    const translate   = req.query.translate === 'true' || state.getSettings(pid).autoTranslate;

    trace('GET /messages ←', {
      handle,
      limit,
      sinceIso: new Date(sinceMs).toISOString(),
      translate,
    });

    const messages = await tg.getMessages(pid, handle, limit, sinceMs);
    const filtered = messages.filter(m => m.timestamp >= sinceMs);

    trace('GET /messages →', {
      handle,
      ms: Date.now() - t0,
      beforeTimeFilter: messages.length,
      afterTimeFilter: filtered.length,
    });
    if (messages.length && !filtered.length) {
      const ts = messages.map(m => m.timestamp);
      trace('GET /messages !', {
        handle,
        hint: 'all messages older than since',
        oldestMsgIso: new Date(Math.min(...ts)).toISOString(),
        newestMsgIso: new Date(Math.max(...ts)).toISOString(),
      });
    }

    await maybeTranslate(filtered, translate);
    ok(res, { messages: filtered });
  } catch (err) {
    trace('GET /messages ERR', { handle: req.params.handle, error: err.message, ms: Date.now() - t0 });
    fail(res, err.message);
  }
});

// ─── Following (per deck profile) ────────────────────────────

router.get('/following', requireProfile, (req, res) => {
  ok(res, { following: state.getFollowing(req.telegramProfileId) });
});

router.post('/following', requireProfile, async (req, res) => {
  try {
    const handle = normaliseHandle(req.body.handle);
    if (!handle) return fail(res, 'handle is required');
    await tg.getEntityInfo(req.telegramProfileId, handle);
    state.follow(req.telegramProfileId, handle);
    ok(res, { handle });
  } catch (err) {
    fail(res, err.message);
  }
});

router.delete('/following/:handle', requireProfile, (req, res) => {
  const handle = normaliseHandle(req.params.handle);
  state.unfollow(req.telegramProfileId, handle);
  ok(res, { handle });
});

// ─── Lists (shared) ───────────────────────────────────────────

router.get('/lists', (req, res) => {
  ok(res, { lists: state.getLists() });
});

router.post('/lists', requireProfile, (req, res) => {
  const { name, emoji } = req.body;
  if (!name) return fail(res, 'name is required');
  const list = {
    id:       'l' + Date.now(),
    name,
    emoji:    typeof emoji === 'string' ? emoji : '',
    accounts: [],
  };
  state.addList(list);
  ok(res, { list });
});

router.delete('/lists/:id', requireProfile, (req, res) => {
  state.deleteList(req.params.id);
  ok(res, { id: req.params.id });
});

router.post('/lists/:id/accounts', requireProfile, async (req, res) => {
  try {
    const handle = normaliseHandle(req.body.handle);
    if (!handle) return fail(res, 'handle is required');
    await tg.getEntityInfo(req.telegramProfileId, handle);
    state.addAccountToList(req.params.id, handle);
    ok(res, { listId: req.params.id, handle });
  } catch (err) {
    fail(res, err.message);
  }
});

router.delete('/lists/:id/accounts/:handle', requireProfile, (req, res) => {
  const handle = normaliseHandle(req.params.handle);
  state.removeAccountFromList(req.params.id, handle);
  ok(res, { listId: req.params.id, handle });
});

// ─── Columns (per deck profile) ──────────────────────────────

router.get('/columns', requireProfile, (req, res) => {
  ok(res, { columns: state.getColumns(req.telegramProfileId) });
});

router.put('/columns', requireProfile, (req, res) => {
  const { columns } = req.body;
  if (!Array.isArray(columns)) return fail(res, 'columns must be an array');
  state.setColumns(req.telegramProfileId, columns);
  ok(res, { columns });
});

router.post('/columns', requireProfile, (req, res) => {
  const col = req.body;
  if (!col || !col.id || !col.type) return fail(res, 'id and type are required');
  state.addColumn(req.telegramProfileId, col);
  ok(res, { column: col });
});

router.delete('/columns/:id', requireProfile, (req, res) => {
  state.removeColumn(req.telegramProfileId, req.params.id);
  ok(res, { id: req.params.id });
});

// ─── Settings (per deck profile) ─────────────────────────────

router.get('/settings', requireProfile, (req, res) => {
  ok(res, { settings: state.getSettings(req.telegramProfileId) });
});

router.patch('/settings', requireProfile, (req, res) => {
  state.updateSettings(req.telegramProfileId, req.body);
  ok(res, { settings: state.getSettings(req.telegramProfileId) });
});

module.exports = router;
