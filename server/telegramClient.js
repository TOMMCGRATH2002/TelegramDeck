/**
 * telegramClient.js
 * One GramJS TelegramClient per deck profile (each logged-in Telegram user).
 */

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const bigInt = require('big-integer');
const { iterDownload } = require('telegram/client/downloads');
const { parseHttpRange } = require('./mediaResponse');

const API_ID   = parseInt(process.env.TELEGRAM_API_ID, 10);
const API_HASH = process.env.TELEGRAM_API_HASH;

const MAX_MEDIA_BYTES = 45 * 1024 * 1024;

const clients = new Map();
const liveListeners = [];

function trace(...args) {
  if (process.env.TELEGRAMDECK_TRACE === '0') return;
  console.log('[TelegramDeck trace]', ...args);
}

function clientOptions() {
  const useWSS = process.env.TELEGRAM_USE_WSS !== '0' && process.env.TELEGRAM_USE_WSS !== 'false';
  const timeoutSec = Math.min(
    120,
    Math.max(5, parseInt(process.env.TELEGRAM_TIMEOUT_SEC || '25', 10) || 25)
  );
  return {
    connectionRetries: 5,
    retryDelay: 2000,
    autoReconnect: true,
    useWSS,
    timeout: timeoutSec,
  };
}

function emitLive(profileId, message) {
  liveListeners.forEach((fn) => {
    try { fn({ profileId, message }); } catch (_) {}
  });
}

function onLiveMessage(fn) {
  liveListeners.push(fn);
  return () => { const i = liveListeners.indexOf(fn); if (i >= 0) liveListeners.splice(i, 1); };
}

async function ensureConnected(profileId) {
  const state = require('./state');
  const sessionStr = state.getProfileSession(profileId);
  if (!sessionStr) throw new Error('Unknown profile or missing Telegram session');

  let client = clients.get(profileId);
  if (client && client.connected) return client;

  if (client) {
    try { await client.destroy(); } catch (_) {}
    clients.delete(profileId);
  }

  const session = new StringSession(sessionStr);
  client = new TelegramClient(session, API_ID, API_HASH, clientOptions());
  await client.connect();

  const authorised = await client.isUserAuthorized();
  if (!authorised) {
    try { await client.destroy(); } catch (_) {}
    clients.delete(profileId);
    throw new Error('Telegram session not authorised — run npm run auth and paste a new session string.');
  }

  console.log(`✅  Telegram MTProto connected for profile ${profileId}`);

  client.addEventHandler(async (event) => {
    try {
      const msg = event.message;
      if (!msg || !msg.peerId) return;
      const formatted = await formatSingleLiveMessage(msg, client);
      if (formatted) emitLive(profileId, formatted);
    } catch (_) {}
  }, new NewMessage({}));

  clients.set(profileId, client);
  return client;
}

async function destroyClient(profileId) {
  const c = clients.get(profileId);
  if (!c) return;
  try { await c.destroy(); } catch (_) {}
  clients.delete(profileId);
}

async function destroyAllClients() {
  const entries = [...clients.entries()];
  clients.clear();
  for (const [, c] of entries) {
    try { await c.destroy(); } catch (_) {}
  }
}

/** Validate a pasted session string (does not register it). */
async function testNewSession(sessionString) {
  if (!sessionString || typeof sessionString !== 'string') throw new Error('session string required');
  const session = new StringSession(sessionString.trim());
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 2,
    retryDelay: 1500,
    autoReconnect: false,
    useWSS: process.env.TELEGRAM_USE_WSS !== '0' && process.env.TELEGRAM_USE_WSS !== 'false',
    timeout: Math.min(60, Math.max(10, parseInt(process.env.TELEGRAM_TIMEOUT_SEC || '25', 10) || 25)),
  });
  await client.connect();
  try {
    if (!(await client.isUserAuthorized())) throw new Error('Session is not authorised');
    const me = await client.getMe();
    const label = [me.firstName, me.lastName].filter(Boolean).join(' ').trim()
      || (me.username ? `@${me.username}` : `User ${me.id}`);
    await client.destroy();
    return { label, username: me.username || '', id: me.id.toString() };
  } catch (e) {
    try { await client.destroy(); } catch (_) {}
    throw e;
  }
}

async function resolveEntity(client, handle) {
  const username = handle.replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '');
  try {
    return await client.getEntity(username);
  } catch (err) {
    throw new Error(`Could not resolve "${handle}": ${err.message}`);
  }
}

function idNum(m) {
  const v = m.id;
  return typeof v === 'bigint' ? Number(v) : Number(v);
}

function partitionIntoClusters(messages) {
  const used = new Set();
  const clusters = [];
  for (const msg of messages) {
    const id = idNum(msg);
    if (used.has(id)) continue;
    if (msg.groupedId != null) {
      const gid = String(msg.groupedId);
      const cluster = messages
        .filter(m => m.groupedId != null && String(m.groupedId) === gid)
        .sort((a, b) => idNum(a) - idNum(b));
      cluster.forEach(m => used.add(idNum(m)));
      clusters.push(cluster);
      continue;
    }
    used.add(id);
    clusters.push([msg]);
  }
  return clusters;
}

function buildMediaItemsForMessage(msg, pubUser) {
  if (!msg.media || !pubUser) return [];
  const uid = encodeURIComponent(pubUser);
  const mid = idNum(msg);
  const items = [];
  if (isImageLikeMedia(msg.media)) {
    items.push({ kind: 'image', url: `/api/media/${uid}/${mid}` });
  } else if (isVideoLikeMedia(msg.media)) {
    items.push({ kind: 'video', url: `/api/media/${uid}/${mid}` });
  }
  return items;
}

async function formatAggregatedMessage(cluster, entityHint, client) {
  if (!cluster.length) return null;

  const primary = cluster.find(m => String(m.message || m.text || '').trim()) || cluster[0];

  const text = String(primary.message || primary.text || '').trim();
  const anyMedia = cluster.some(m => m.media);
  if (!text && !anyMedia) return null;

  let senderInfo = { name: 'Unknown', handle: '@unknown' };
  try {
    let senderEntity = entityHint;
    if (!senderEntity && primary.peerId) {
      senderEntity = await client.getEntity(primary.peerId);
    }
    if (senderEntity) senderInfo = serializeEntity(senderEntity);
  } catch (_) {}

  const pubUser = senderInfo.handle && senderInfo.handle !== '@unknown'
    ? senderInfo.handle.replace('@', '').toLowerCase()
    : null;

  const mediaItems = [];
  for (const m of cluster) {
    mediaItems.push(...buildMediaItemsForMessage(m, pubUser));
  }

  const hasMedia = mediaItems.length > 0 || anyMedia;
  const mediaType = primary.media ? detectMediaType(primary.media) : null;

  let views = null;
  let forwards = null;
  for (const m of cluster) {
    if (m.views != null) views = views == null ? m.views : Math.max(views, m.views);
    if (m.forwards != null) forwards = forwards == null ? m.forwards : Math.max(forwards, m.forwards);
  }
  if (views != null) views = formatNum(views);
  if (forwards != null) forwards = formatNum(forwards);

  return {
    id:        String(idNum(primary)),
    text:      text || (hasMedia ? `[${mediaType || 'media'}]` : ''),
    timestamp: (primary.date || 0) * 1000,
    views,
    forwards,
    sender:    senderInfo,
    hasMedia,
    mediaType,
    mediaItems,
    url: pubUser ? `https://t.me/${pubUser}/${idNum(primary)}` : null,
  };
}

async function formatSingleLiveMessage(msg, client) {
  if (!msg) return null;
  const text = String(msg.message || msg.text || '').trim();
  if (!text && !msg.media) return null;

  let entityHint = null;
  try {
    if (msg.peerId) entityHint = await client.getEntity(msg.peerId);
  } catch (_) {}

  return formatAggregatedMessage([msg], entityHint, client);
}

async function getMessages(profileId, handle, limit = 30, _sinceMs = null) {
  const client = await ensureConnected(profileId);
  const t0 = Date.now();
  trace('gramjs getMessages start', handle, { limit });

  const entity = await resolveEntity(client, handle);
  const params = { limit: Math.min(limit, 100) };
  const messages = await client.getMessages(entity, params);
  const clusters = partitionIntoClusters(messages);
  const formatted = [];

  for (const cluster of clusters) {
    const f = await formatAggregatedMessage(cluster, entity, client);
    if (f) formatted.push(f);
  }

  const peer =
    entity.username != null ? `@${entity.username}` : (entity.title || handle);
  trace(
    `gramjs getMessages done ${Date.now() - t0}ms`,
    { peer, limit: params.limit, telegramRows: messages.length, posts: formatted.length }
  );

  return formatted;
}

async function getEntityInfo(profileId, handle) {
  const client = await ensureConnected(profileId);
  const entity = await resolveEntity(client, handle);
  return serializeEntity(entity);
}

async function getMe(profileId) {
  const client = await ensureConnected(profileId);
  const me = await client.getMe();
  const uname = (me.username || '').toLowerCase();
  const realPhoto = hasRealProfilePhoto(me);
  return {
    id: me.id.toString(),
    firstName: me.firstName || '',
    lastName:  me.lastName  || '',
    username:  me.username  || '',
    phone:     me.phone     || '',
    photoUrl:  uname && realPhoto ? `/api/avatar/${encodeURIComponent(uname)}` : null,
  };
}

function hasRealProfilePhoto(entity) {
  if (!entity || !entity.photo) return false;
  const cls = entity.photo.className || '';
  return !cls.includes('Empty');
}

function serializeEntity(entity) {
  if (!entity) return null;
  const name = entity.title
    || [entity.firstName, entity.lastName].filter(Boolean).join(' ')
    || entity.username
    || 'Unknown';

  const uname = (entity.username || '').toLowerCase();
  const realPhoto = hasRealProfilePhoto(entity);
  return {
    id:       entity.id?.toString?.() || '',
    name,
    handle:   '@' + (entity.username || ''),
    type:     entity.className || 'Unknown',
    verified: entity.verified || false,
    hasPhoto: realPhoto,
    photoUrl: uname && realPhoto ? `/api/avatar/${encodeURIComponent(uname)}` : null,
  };
}

function detectMediaType(media) {
  if (!media) return null;
  const cls = media.className || '';
  if (cls.includes('Photo')) return 'photo';
  if (cls.includes('Document')) return 'document';
  if (cls.includes('Video')) return 'video';
  if (cls.includes('Audio')) return 'audio';
  if (cls.includes('Poll')) return 'poll';
  return 'media';
}

function isImageLikeMedia(media) {
  if (!media) return false;
  const cls = media.className || '';
  if (cls.includes('Photo')) return true;
  if (cls === 'MessageMediaDocument' && media.document) {
    const mime = media.document.mimeType || '';
    if (mime.startsWith('image/')) return true;
  }
  return false;
}

function isVideoLikeMedia(media) {
  if (!media || media.className !== 'MessageMediaDocument' || !media.document) return false;
  const mime = media.document.mimeType || '';
  if (mime.startsWith('video/')) return true;
  const attrs = media.document.attributes || [];
  return attrs.some(a => (a.className || '').includes('Video'));
}

function formatNum(n) {
  if (n == null) return null;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function sniffImageMime(buf) {
  if (!buf || buf.length < 12) return 'application/octet-stream';
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'image/gif';
  if (buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return 'image/jpeg';
}

function sniffVideoMime(buf) {
  if (!buf || buf.length < 12) return 'video/mp4';
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'video/mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'video/webm';
  return 'video/mp4';
}

async function loadMessageMediaContext(profileId, handle, msgId) {
  const client = await ensureConnected(profileId);
  const entity = await resolveEntity(client, handle);
  const id = typeof msgId === 'bigint' ? Number(msgId) : parseInt(msgId, 10);
  if (!Number.isFinite(id) || id < 1 || id > 1e15) throw new Error('invalid message id');

  const messages = await client.getMessages(entity, { ids: [id] });
  const msg = messages[0];
  if (!msg || !msg.media) throw new Error('no media on message');
  return { client, msg };
}

/**
 * Stream video bytes from Telegram as they arrive (Range-aware). Fast start vs buffering the whole file.
 * @returns {Promise<boolean>} true if response was handled (video)
 */
async function pipeVideoMessageToResponse(req, res, client, msg) {
  if (!isVideoLikeMedia(msg.media)) return false;

  const doc = msg.media.document;
  if (!doc || !(doc instanceof Api.Document)) throw new Error('invalid document');

  const size = parseInt(String(doc.size != null ? doc.size : 0), 10);
  if (!Number.isFinite(size) || size < 1) throw new Error('unknown video size');
  if (size > MAX_MEDIA_BYTES) throw new Error('file too large');

  const mime = doc.mimeType && String(doc.mimeType).startsWith('video/')
    ? doc.mimeType
    : 'video/mp4';

  const parsed = parseHttpRange(req, size);
  if (parsed && parsed.error === 416) {
    res.status(416);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Range', `bytes */${size}`);
    res.end();
    return true;
  }

  let start = 0;
  let end = size - 1;
  let status = 200;
  if (parsed) {
    start = parsed.start;
    end = parsed.end;
    status = 206;
  }
  const contentLength = end - start + 1;

  const fr = doc.fileReference;
  const fileReference = Buffer.isBuffer(fr) ? fr : Buffer.from(fr || []);

  const location = new Api.InputDocumentFileLocation({
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference,
    thumbSize: '',
  });

  const msgData = msg.inputChat ? [msg.inputChat, msg.id] : undefined;

  res.status(status);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Vary', 'Cookie');
  res.setHeader('Content-Length', contentLength);
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (status === 206) {
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }

  const it = iterDownload(client, {
    file: location,
    offset: bigInt(start),
    fileSize: bigInt(size),
    dcId: doc.dcId,
    msgData,
  });

  try {
    let sent = 0;
    const need = contentLength;
    for await (const chunk of it) {
      if (res.writableEnded) break;
      let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (sent + buf.length > need) buf = buf.subarray(0, need - sent);
      if (buf.length === 0) continue;
      const ok = res.write(buf);
      sent += buf.length;
      if (!ok) await new Promise((resolve) => res.once('drain', resolve));
      if (sent >= need) break;
    }
  } catch (e) {
    if (!res.headersSent) throw e;
    try { res.destroy(); } catch (_) {}
    return true;
  }
  res.end();
  return true;
}

async function downloadMessageMediaFromMessage(client, msg) {
  const buf = await client.downloadMedia(msg, {});
  if (!buf || !Buffer.isBuffer(buf) || !buf.length) throw new Error('empty download');
  if (buf.length > MAX_MEDIA_BYTES) throw new Error('file too large');

  if (isImageLikeMedia(msg.media)) {
    return { buffer: buf, mime: sniffImageMime(buf) };
  }
  if (isVideoLikeMedia(msg.media)) {
    return { buffer: buf, mime: sniffVideoMime(buf) };
  }
  throw new Error('unsupported media type');
}

async function downloadMessageMedia(profileId, handle, msgId) {
  const { client, msg } = await loadMessageMediaContext(profileId, handle, msgId);
  return downloadMessageMediaFromMessage(client, msg);
}

async function downloadProfilePhoto(profileId, handle) {
  const client = await ensureConnected(profileId);
  const entity = await resolveEntity(client, handle);
  if (!entity.photo) throw new Error('no profile photo');
  let buf = await client.downloadProfilePhoto(entity, { isBig: false });
  if (buf != null && !Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (!buf || !buf.length) throw new Error('empty photo');
  if (buf.length > MAX_MEDIA_BYTES) throw new Error('photo too large');
  return { buffer: buf, mime: sniffImageMime(buf) };
}

module.exports = {
  ensureConnected,
  destroyClient,
  destroyAllClients,
  testNewSession,
  onLiveMessage,
  getMessages,
  getEntityInfo,
  getMe,
  downloadMessageMedia,
  loadMessageMediaContext,
  pipeVideoMessageToResponse,
  downloadMessageMediaFromMessage,
  downloadProfilePhoto,
};
