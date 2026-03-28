/**
 * In-memory LRU for downloaded message media (repeat views / range requests are instant).
 */

const MAX_ENTRIES = 64;
const MAX_TOTAL_BYTES = 160 * 1024 * 1024;
const SKIP_CACHE_BYTES = 72 * 1024 * 1024;

class MediaLRU {
  constructor() {
    this.map = new Map();
    this.totalBytes = 0;
  }

  get(key) {
    const v = this.map.get(key);
    if (!v) return null;
    this.map.delete(key);
    this.map.set(key, v);
    return { buffer: v.buffer, mime: v.mime };
  }

  _evictOne() {
    const firstKey = this.map.keys().next().value;
    if (firstKey == null) return;
    const old = this.map.get(firstKey);
    this.totalBytes -= old.buffer.length;
    this.map.delete(firstKey);
  }

  set(key, buffer, mime) {
    if (!Buffer.isBuffer(buffer) || buffer.length > SKIP_CACHE_BYTES) return;

    while (this.map.size >= MAX_ENTRIES || this.totalBytes + buffer.length > MAX_TOTAL_BYTES) {
      if (this.map.size === 0) break;
      this._evictOne();
    }

    if (this.map.has(key)) {
      const o = this.map.get(key);
      this.totalBytes -= o.buffer.length;
      this.map.delete(key);
    }

    this.map.set(key, { buffer, mime });
    this.totalBytes += buffer.length;
  }
}

const lru = new MediaLRU();

function invalidateForProfile(profileId) {
  const prefix = `${String(profileId)}|`;
  for (const key of [...lru.map.keys()]) {
    if (key.startsWith(prefix)) {
      const o = lru.map.get(key);
      lru.totalBytes -= o.buffer.length;
      lru.map.delete(key);
    }
  }
}

lru.invalidateForProfile = invalidateForProfile;
module.exports = lru;
