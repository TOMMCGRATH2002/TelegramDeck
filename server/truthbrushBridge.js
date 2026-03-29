/**
 * Spawn truthbrush CLI, parse NDJSON statuses, normalize for deck post cards.
 * @see https://github.com/stanfordio/truthbrush
 */

const { spawn } = require('child_process');

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const SPAWN_TIMEOUT_MS = parseInt(process.env.TRUTHBRUSH_TIMEOUT_MS, 10) || 90000;

function truthEnvConfigured() {
  const t = (process.env.TRUTHSOCIAL_TOKEN || '').trim();
  if (t) return true;
  const u = (process.env.TRUTHSOCIAL_USERNAME || '').trim();
  const p = (process.env.TRUTHSOCIAL_PASSWORD || '').trim();
  return !!(u && p);
}

function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeTruthStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const acct = raw.account || {};
  const un = String(acct.username || 'unknown').replace(/^@/, '');
  const handle = '@' + un;
  const items = [];
  for (const m of raw.media_attachments || []) {
    const kind = m.type === 'video' || m.type === 'gifv' ? 'video' : 'image';
    const u = m.url || m.preview_url || m.remote_url;
    if (u) items.push({ url: u, kind });
  }
  const ts = Date.parse(raw.created_at);
  return {
    id: String(raw.id),
    source: 'truth',
    timestamp: Number.isFinite(ts) ? ts : 0,
    sender: {
      name: acct.display_name || un,
      handle,
      photoUrl: acct.avatar_static || acct.avatar || null,
    },
    text: stripHtml(raw.content || ''),
    url: raw.url || `https://truthsocial.com/@${un}/posts/${raw.id}`,
    mediaItems: items.length ? items : undefined,
  };
}

function compareTruthId(a, b) {
  try {
    if (BigInt(a) > BigInt(b)) return 1;
    if (BigInt(a) < BigInt(b)) return -1;
    return 0;
  } catch (_) {
    return String(a).localeCompare(String(b));
  }
}

function isValidTruthHandle(h) {
  if (!h || typeof h !== 'string') return false;
  return /^[a-zA-Z0-9_]{1,100}$/.test(h);
}

function sanitizeHandle(h) {
  if (!h || typeof h !== 'string') return '';
  const part = h.replace(/^@/, '').trim().split('/')[0];
  /** Truth / Mastodon acct lookup is case-insensitive; wrong casing often breaks lookups. */
  return part.toLowerCase();
}

function runTruthbrushStatuses(handle, { createdAfterIso }) {
  const bin = (process.env.TRUTHBRUSH_BIN || 'truthbrush').trim();
  const args = ['statuses', handle, '--created-after', createdAfterIso];

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env },
      windowsHide: true,
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch (_) {}
      reject(new Error('truthbrush timed out'));
    }, SPAWN_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });

    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT'
        ? 'truthbrush not found (install: pip install truthbrush, set PATH or TRUTHBRUSH_BIN)'
        : e.message));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const msg = (err || out || `truthbrush exited ${code}`).trim().slice(0, 800);
        reject(new Error(msg || `truthbrush exited with code ${code}`));
        return;
      }

      const rawList = [];
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          rawList.push(JSON.parse(t));
        } catch (_) {
          /* skip garbage lines */
        }
      }
      resolve(rawList);
    });
  });
}

async function fetchTruthFeed(handle, opts = {}) {
  const { sinceMs, afterId } = opts;
  const since = Number.isFinite(sinceMs) ? sinceMs : Date.now() - THREE_DAYS_MS;
  const createdAfterIso = new Date(since).toISOString();

  const raw = await runTruthbrushStatuses(handle, { createdAfterIso });
  let messages = raw.map(normalizeTruthStatus).filter(Boolean);
  messages.sort((a, b) => compareTruthId(b.id, a.id));

  if (afterId) {
    messages = messages.filter((m) => compareTruthId(m.id, afterId) > 0);
  }

  return messages;
}

module.exports = {
  truthEnvConfigured,
  THREE_DAYS_MS,
  isValidTruthHandle,
  sanitizeHandle,
  fetchTruthFeed,
};
