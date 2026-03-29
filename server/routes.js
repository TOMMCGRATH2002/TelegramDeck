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
  isValidDeckUserId,
  isValidListId,
  isValidDeckUsername,
  sanitizeDeckUsername,
} = require('./security');
const mediaCache = require('./mediaCache');
const { sendBufferWithRange } = require('./mediaResponse');
const truth = require('./truthbrushBridge');

const SESSION_DECK_USER_KEY = 'deckUserId';

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

const deckRegisterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ ok: false, error: 'Too many new deck names from this IP — try again later' });
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

function pickDeckUser(req, res, next) {
  try {
    req.deckUserId = req.session[SESSION_DECK_USER_KEY] || null;
  } catch (_) {
    req.deckUserId = null;
  }
  next();
}

function requireDeckUser(req, res, next) {
  if (!req.deckUserId) {
    return fail(res, 'Sign in with a deck username first.', 401);
  }
  next();
}

router.use(pickDeckUser);
router.use(apiLimiter);

// ─── Session & deck users (per-browser deck; one Telegram session on server) ──

router.get('/session', (req, res) => {
  const defTruth = (process.env.TRUTH_FEED_HANDLE || 'realDonaldTrump').replace(/^@/, '').trim() || 'realDonaldTrump';
  ok(res, {
    deckUsers:         state.listDeckUsersPublic(),
    activeDeckUserId:  req.deckUserId || null,
    telegramReady:     state.isTelegramConfigured(),
    truthReady:        truth.truthEnvConfigured(),
    truthDefaultHandle: defTruth,
  });
});

router.get('/truth/feed', requireDeckUser, async (req, res) => {
  if (!truth.truthEnvConfigured()) {
    return fail(res, 'Truth Social is not configured on this server (set TRUTHSOCIAL_TOKEN or TRUTHSOCIAL_USERNAME and TRUTHSOCIAL_PASSWORD in .env).', 503);
  }
  const rawHandle = (req.query.handle != null ? String(req.query.handle) : '') || (process.env.TRUTH_FEED_HANDLE || 'realDonaldTrump');
  const handle = truth.sanitizeHandle(rawHandle);
  if (!truth.isValidTruthHandle(handle)) {
    return fail(res, 'Invalid handle (letters, digits, underscore only).', 400);
  }
  const sinceParsed = req.query.since != null ? parseInt(req.query.since, 10) : NaN;
  const sinceMs = Number.isFinite(sinceParsed) ? sinceParsed : Date.now() - truth.THREE_DAYS_MS;
  const afterRaw = req.query.afterId != null ? String(req.query.afterId).trim() : '';
  const afterId = afterRaw || null;
  try {
    let messages = await truth.fetchTruthFeed(handle, { sinceMs, afterId });
    const autoTr = state.getSettings(req.deckUserId).autoTranslate === true;
    try {
      await maybeTranslate(messages, autoTr);
    } catch (trErr) {
      trace('GET /truth/feed translate skip', { error: trErr.message });
    }
    ok(res, { messages, handle });
  } catch (err) {
    trace('GET /truth/feed ERR', { handle, error: err.message });
    if (process.env.TELEGRAMDECK_TRUTH_ERRORS === '1') {
      return fail(res, (err && err.message) ? String(err.message).slice(0, 800) : 'Truth feed failed', 502);
    }
    fail500(res, err);
  }
});

router.post('/session/register', deckRegisterLimiter, (req, res) => {
  const raw = (req.body && req.body.username) != null ? String(req.body.username) : '';
  const username = sanitizeDeckUsername(raw);
  if (!isValidDeckUsername(username)) {
    return fail(res, 'Username must be 2–32 characters: letters, digits, underscore only.', 400);
  }
  if (state.findDeckUserByUsername(username)) {
    return fail(res, 'That username is already taken. Pick another or use Sign in.', 400);
  }
  const id = state.addDeckUser({ username });
  req.session[SESSION_DECK_USER_KEY] = id;
  req.session.save((err) => {
    if (err) return fail500(res, err);
    ok(res, { deckUser: { id, username } });
  });
});

router.post('/session/login', (req, res) => {
  const raw = (req.body && req.body.username) != null ? String(req.body.username) : '';
  const username = sanitizeDeckUsername(raw);
  if (!username) return fail(res, 'username is required', 400);
  const user = state.findDeckUserByUsername(username);
  if (!user) return fail(res, 'No deck with that username. Create one first.', 404);
  req.session[SESSION_DECK_USER_KEY] = user.id;
  req.session.save((err) => {
    if (err) return fail500(res, err);
    ok(res, { deckUser: { id: user.id, username: user.username } });
  });
});

router.post('/session/logout', (req, res) => {
  delete req.session[SESSION_DECK_USER_KEY];
  req.session.save((err) => {
    if (err) return fail500(res, err);
    ok(res, {});
  });
});

router.delete('/deck-users/:id', requireDeckUser, async (req, res) => {
  const id = req.params.id;
  if (!isValidDeckUserId(id)) return fail(res, 'Invalid deck user id', 400);
  if (!state.getDeckUser(id)) return fail(res, 'Unknown deck user', 404);
  if (req.deckUserId !== id) return fail(res, 'You can only remove your own deck.', 403);
  mediaCache.invalidateForProfile(id);
  state.removeDeckUser(id);
  delete req.session[SESSION_DECK_USER_KEY];
  req.session.save((err) => {
    if (err) return fail500(res, err);
    ok(res, { removed: id });
  });
});

router.get('/ws-token', wsTokenLimiter, requireDeckUser, (req, res) => {
  ok(res, { token: wsAuth.mint(req.deckUserId) });
});

// ─── Account / Telegram user ─────────────────────────────────

router.get('/me', requireDeckUser, async (req, res) => {
  try {
    await tg.ensureConnected(req.deckUserId);
    const du = state.getDeckUser(req.deckUserId);
    const raw = state.getListAccessSummaryForDeckUser(req.deckUserId);
    const incoming = raw.incoming.map((row) => {
      const ru = state.getDeckUser(row.requesterId);
      return {
        ...row,
        requesterUsername: ru ? ru.username : row.requesterId,
      };
    });
    ok(res, {
      user: {
        deckUsername: du ? du.username : '',
        deckUserId: req.deckUserId,
        telegramConnected: true,
        listAccess: { incoming, outgoingPending: raw.outgoingPending },
      },
    });
  } catch (err) {
    fail500(res, err);
  }
});

router.get('/entity/:handle', requireDeckUser, async (req, res) => {
  try {
    const handle = normaliseHandle(req.params.handle);
    const info   = await tg.getEntityInfo(req.deckUserId, handle);
    ok(res, { entity: info });
  } catch (err) {
    fail(res, err.message);
  }
});

router.get('/avatar/:username', mediaRate, requireDeckUser, async (req, res) => {
  try {
    const u = req.params.username;
    if (!isValidPublicUsername(u)) return res.status(400).end();
    const handle = normaliseHandle(u);
    const { buffer, mime } = await tg.downloadProfilePhoto(req.deckUserId, handle);
    sendBufferWithRange(req, res, buffer, mime, 'public, max-age=604800');
  } catch (_) {
    res.status(404).end();
  }
});

router.get('/media/:username/:msgId', mediaRate, requireDeckUser, async (req, res) => {
  try {
    const u = req.params.username;
    const msgId = req.params.msgId;
    if (!isValidPublicUsername(u) || !isValidMessageId(msgId)) {
      return res.status(400).end();
    }
    const handle = normaliseHandle(u);
    const cacheKey = `${req.deckUserId}|${handle}|${msgId}`;
    const cached = mediaCache.get(cacheKey);
    if (cached) {
      sendBufferWithRange(req, res, cached.buffer, cached.mime, 'public, max-age=604800, immutable');
      return;
    }
    const ctx = await tg.loadMessageMediaContext(req.deckUserId, handle, msgId);
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

router.get('/messages/batch', requireDeckUser, async (req, res) => {
  const t0 = Date.now();
  const pid = req.deckUserId;
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

router.get('/messages/:handle', requireDeckUser, async (req, res) => {
  const t0 = Date.now();
  const pid = req.deckUserId;
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

router.get('/following', requireDeckUser, (req, res) => {
  ok(res, { following: state.getFollowing(req.deckUserId) });
});

router.post('/following', requireDeckUser, async (req, res) => {
  try {
    const handle = normaliseHandle(req.body.handle);
    if (!handle) return fail(res, 'handle is required');
    await tg.getEntityInfo(req.deckUserId, handle);
    state.follow(req.deckUserId, handle);
    ok(res, { handle });
  } catch (err) {
    fail(res, err.message);
  }
});

router.delete('/following/:handle', requireDeckUser, (req, res) => {
  const handle = normaliseHandle(req.params.handle);
  state.unfollow(req.deckUserId, handle);
  ok(res, { handle });
});

// ─── Lists (private by owner; collaborators via access requests) ─

function requireListEditAccess(req, res, next) {
  const listId = req.params.id;
  if (!isValidListId(listId)) return fail(res, 'Invalid list id', 400);
  const list = state.getList(listId);
  if (!list) return fail(res, 'List not found', 404);
  if (!state.canEditListContents(list, req.deckUserId)) {
    return fail(res, 'You do not have access to edit this list.', 403);
  }
  req.list = list;
  next();
}

router.get('/lists', requireDeckUser, (req, res) => {
  const lists = state.getListsVisibleToDeckUser(req.deckUserId).map((l) =>
    state.listToClient(l, req.deckUserId)
  );
  ok(res, { lists });
});

router.get('/lists/lookup', requireDeckUser, (req, res) => {
  const listId = req.query.id != null ? String(req.query.id) : '';
  if (!isValidListId(listId)) return fail(res, 'Invalid list id', 400);
  const info = state.getListLookupForRequester(listId, req.deckUserId);
  ok(res, { lookup: info });
});

router.get('/lists/discover', requireDeckUser, (req, res) => {
  const q = req.query.q != null ? String(req.query.q) : '';
  if (q.length > 120) return fail(res, 'Search query too long', 400);
  const results = state.discoverConnectableLists(req.deckUserId, q);
  ok(res, { results });
});

router.post('/lists', requireDeckUser, (req, res) => {
  const { name, emoji } = req.body;
  if (!name) return fail(res, 'name is required');
  const list = {
    id: 'l' + Date.now(),
    name,
    emoji: typeof emoji === 'string' ? emoji : '',
    accounts: [],
    ownerId: req.deckUserId,
    memberIds: [],
    pendingRequests: [],
    blockedUserIds: [],
    legacyPublic: false,
  };
  state.addList(list);
  ok(res, { list: state.listToClient(list, req.deckUserId) });
});

router.delete('/lists/:id', requireDeckUser, (req, res) => {
  const listId = req.params.id;
  if (!isValidListId(listId)) return fail(res, 'Invalid list id', 400);
  const removed = state.deleteList(listId, req.deckUserId);
  if (!removed) return fail(res, 'List not found or you cannot delete it.', 403);
  ok(res, { id: listId });
});

router.post('/lists/:id/access-request', requireDeckUser, (req, res) => {
  const listId = req.params.id;
  if (!isValidListId(listId)) return fail(res, 'Invalid list id', 400);
  try {
    state.addListAccessRequest(listId, req.deckUserId);
    ok(res, { listId });
  } catch (err) {
    fail(res, err.message);
  }
});

router.post('/lists/:id/access-respond', requireDeckUser, (req, res) => {
  const listId = req.params.id;
  if (!isValidListId(listId)) return fail(res, 'Invalid list id', 400);
  const requesterId = req.body && req.body.requesterId != null ? String(req.body.requesterId) : '';
  const action = req.body && req.body.action != null ? String(req.body.action) : '';
  if (!isValidDeckUserId(requesterId)) return fail(res, 'Invalid requester id', 400);
  if (action !== 'allow' && action !== 'block') return fail(res, 'action must be allow or block', 400);
  try {
    state.respondToListAccessRequest(listId, req.deckUserId, requesterId, action);
    ok(res, { listId, requesterId, action });
  } catch (err) {
    fail(res, err.message);
  }
});

router.delete('/lists/:id/members/:userId', requireDeckUser, (req, res) => {
  const listId = req.params.id;
  const memberId = req.params.userId;
  if (!isValidListId(listId)) return fail(res, 'Invalid list id', 400);
  if (!isValidDeckUserId(memberId)) return fail(res, 'Invalid member id', 400);
  try {
    state.removeListMember(listId, req.deckUserId, memberId);
    ok(res, { listId, memberId });
  } catch (err) {
    fail(res, err.message);
  }
});

router.post('/lists/:id/accounts', requireDeckUser, requireListEditAccess, async (req, res) => {
  try {
    const handle = normaliseHandle(req.body.handle);
    if (!handle) return fail(res, 'handle is required');
    await tg.getEntityInfo(req.deckUserId, handle);
    state.addAccountToList(req.params.id, handle);
    ok(res, { listId: req.params.id, handle });
  } catch (err) {
    fail(res, err.message);
  }
});

router.delete('/lists/:id/accounts/:handle', requireDeckUser, requireListEditAccess, (req, res) => {
  const handle = normaliseHandle(req.params.handle);
  state.removeAccountFromList(req.params.id, handle);
  ok(res, { listId: req.params.id, handle });
});

// ─── Columns (per deck profile) ──────────────────────────────

router.get('/columns', requireDeckUser, (req, res) => {
  ok(res, { columns: state.getColumns(req.deckUserId) });
});

router.put('/columns', requireDeckUser, (req, res) => {
  const { columns } = req.body;
  if (!Array.isArray(columns)) return fail(res, 'columns must be an array');
  state.setColumns(req.deckUserId, columns);
  ok(res, { columns });
});

router.post('/columns', requireDeckUser, (req, res) => {
  const col = req.body;
  if (!col || !col.id || !col.type) return fail(res, 'id and type are required');
  state.addColumn(req.deckUserId, col);
  ok(res, { column: col });
});

router.delete('/columns/:id', requireDeckUser, (req, res) => {
  state.removeColumn(req.deckUserId, req.params.id);
  ok(res, { id: req.params.id });
});

// ─── Settings (per deck profile) ─────────────────────────────

router.get('/settings', requireDeckUser, (req, res) => {
  ok(res, { settings: state.getSettings(req.deckUserId) });
});

router.patch('/settings', requireDeckUser, (req, res) => {
  state.updateSettings(req.deckUserId, req.body);
  ok(res, { settings: state.getSettings(req.deckUserId) });
});

module.exports = router;
