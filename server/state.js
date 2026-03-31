/**
 * state.js — JSON persistence
 *
 * Shared: lists (private by owner; collaborators via access requests)
 * Legacy lists without ownerId remain "legacy public" (any signed-in deck user).
 * One Telegram MTProto session for the whole server (env TELEGRAM_SESSION or migrated into telegram.session)
 * Per deck user: username (login), individual follows, deck columns, UI settings
 */

const fs   = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'state.json');

const DEFAULT_PROFILE_SETTINGS = {
  autoTranslate: false,
  darkMode: true,
  /** 'dark' | 'light' | 'navy' — darkMode kept in sync for older clients */
  colorTheme: 'dark',
  sidebarExpanded: false,
  /** Merge Truth Social posts into the All Accounts column (server must have truthbrush + TRUTHSOCIAL_*). */
  includeTruthInAll: false,
};

const DEFAULT_COLUMNS = [
  { id: 'col-all', type: 'all', ref: null, title: 'All Accounts', icon: '⋯', iconBg: 'rgba(42,171,238,0.12)' },
];

function emptyState() {
  return {
    lists: [],
    telegram: { session: '' },
    deckUsers: {},
  };
}

/** Old file format before deck users */
function migrateLegacyRaw(raw) {
  if (raw && raw.deckUsers && typeof raw.deckUsers === 'object' && !Array.isArray(raw.deckUsers)) {
    return raw;
  }
  if (raw && raw.profiles && typeof raw.profiles === 'object' && !Array.isArray(raw.profiles)) {
    return {
      lists: Array.isArray(raw.lists) ? raw.lists : [],
      profiles: raw.profiles,
    };
  }

  const lists = Array.isArray(raw?.lists) ? raw.lists : [];
  const envSession = process.env.TELEGRAM_SESSION || '';
  const followingAccounts = Array.isArray(raw?.followingAccounts) ? raw.followingAccounts : [];
  const columns = Array.isArray(raw?.columns) && raw.columns.length ? raw.columns : [...DEFAULT_COLUMNS];
  const settings = { ...DEFAULT_PROFILE_SETTINGS, ...(raw?.settings && typeof raw.settings === 'object' ? raw.settings : {}) };

  if (!envSession) {
    return { lists, profiles: {} };
  }

  const id = 'p_primary';
  return {
    lists,
    profiles: {
      [id]: {
        id,
        label: 'Primary',
        session: envSession,
        followingAccounts,
        columns,
        settings,
      },
    },
  };
}

/**
 * Convert legacy { profiles with session } → { telegram, deckUsers }.
 * Persists once when migration runs.
 */
function normalizeToDeckUsersShape(legacy) {
  if (legacy.deckUsers && typeof legacy.deckUsers === 'object') {
    const stored = (legacy.telegram && legacy.telegram.session) || '';
    const env = (process.env.TELEGRAM_SESSION || '').trim();
    return {
      lists: Array.isArray(legacy.lists) ? legacy.lists : [],
      telegram: { session: env || stored },
      deckUsers: { ...legacy.deckUsers },
    };
  }

  const lists = Array.isArray(legacy.lists) ? legacy.lists : [];
  const profiles = legacy.profiles || {};
  let session = (process.env.TELEGRAM_SESSION || '').trim();
  const deckUsers = {};

  for (const [id, p] of Object.entries(profiles)) {
    if (!p || typeof p !== 'object') continue;
    const ps = p.session && typeof p.session === 'string' ? p.session.trim() : '';
    if (ps) {
      if (!session) session = ps;
      else if (ps !== session) {
        console.warn('[TelegramDeck] Old state had multiple Telegram sessions; using TELEGRAM_SESSION or first stored session.');
      }
    }
    deckUsers[id] = {
      id,
      username: String(p.label || id.replace(/^p_/, 'user') || 'user').trim() || id,
      followingAccounts: Array.isArray(p.followingAccounts) ? p.followingAccounts : [],
      columns: Array.isArray(p.columns) && p.columns.length ? p.columns : [...DEFAULT_COLUMNS],
      settings: { ...DEFAULT_PROFILE_SETTINGS, ...(p.settings && typeof p.settings === 'object' ? p.settings : {}) },
    };
  }

  return {
    lists,
    telegram: { session },
    deckUsers,
  };
}

function load() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(STATE_FILE)) {
      const legacy = migrateLegacyRaw(null);
      const normalized = normalizeToDeckUsersShape(legacy);
      if (normalized.telegram.session) save(normalized);
      return normalized;
    }
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const hadDeckUsers = raw.deckUsers && typeof raw.deckUsers === 'object';
    const legacy = migrateLegacyRaw(raw);
    const normalized = normalizeToDeckUsersShape(hadDeckUsers ? raw : legacy);
    if (!hadDeckUsers && (legacy.profiles && Object.keys(legacy.profiles).length)) {
      save(normalized);
      console.log('[TelegramDeck] Migrated state: profiles → deck users + single telegram.session');
    }
    return normalized;
  } catch (err) {
    console.warn('⚠️  Could not load state, using defaults:', err.message);
    return emptyState();
  }
}

function save(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('❌  Could not save state:', err.message);
  }
}

let _state = load();

function normalizeListInPlace(l) {
  if (!l || typeof l !== 'object') return;
  if (!Array.isArray(l.accounts)) l.accounts = [];
  if (!Array.isArray(l.memberIds)) l.memberIds = [];
  if (!Array.isArray(l.pendingRequests)) l.pendingRequests = [];
  if (!Array.isArray(l.blockedUserIds)) l.blockedUserIds = [];
  l.pendingRequests = l.pendingRequests.filter(
    (r) => r && typeof r === 'object' && r.userId && typeof r.at === 'number'
  );
  l.memberIds = [...new Set(l.memberIds.filter(Boolean))];
  l.blockedUserIds = [...new Set(l.blockedUserIds.filter(Boolean))];
  if (!l.ownerId) {
    l.legacyPublic = true;
  } else {
    l.legacyPublic = false;
    if (l.memberIds.includes(l.ownerId)) {
      l.memberIds = l.memberIds.filter((id) => id !== l.ownerId);
    }
  }
}

_state.lists.forEach(normalizeListInPlace);

function canDeleteListRecord(list, deckUserId) {
  if (!list || !deckUserId) return false;
  normalizeListInPlace(list);
  if (list.ownerId === deckUserId) return true;
  if (list.legacyPublic && !list.ownerId) return true;
  return false;
}

function ensureDeckUserShape(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    id: u.id,
    username: u.username || 'user',
    avatarDataUrl: (typeof u.avatarDataUrl === 'string' && u.avatarDataUrl.startsWith('data:image/')) ? u.avatarDataUrl : null,
    followingAccounts: Array.isArray(u.followingAccounts) ? u.followingAccounts : [],
    columns: Array.isArray(u.columns) && u.columns.length ? u.columns : [...DEFAULT_COLUMNS],
    settings: { ...DEFAULT_PROFILE_SETTINGS, ...(u.settings && typeof u.settings === 'object' ? u.settings : {}) },
  };
}

function getDeckUser(id) {
  if (!id) return null;
  const u = _state.deckUsers[id];
  return ensureDeckUserShape(u);
}

/** Effective Telegram StringSession: env overrides stored (ops convenience). */
function getTelegramSession() {
  const env = (process.env.TELEGRAM_SESSION || '').trim();
  if (env) return env;
  return (_state.telegram && _state.telegram.session) ? String(_state.telegram.session).trim() : '';
}

function setTelegramSessionInState(sessionStr) {
  if (!_state.telegram) _state.telegram = { session: '' };
  _state.telegram.session = sessionStr || '';
  save(_state);
}

const state = {
  get() { return _state; },
  save() { save(_state); },

  getDeckUser,

  getTelegramSession,

  /** True when the server can connect to Telegram */
  isTelegramConfigured() {
    return getTelegramSession().length > 20;
  },

  listDeckUsersPublic() {
    return Object.values(_state.deckUsers).map(u => ({
      id: u.id,
      username: u.username || u.id,
      hasAvatar: typeof u.avatarDataUrl === 'string' && u.avatarDataUrl.startsWith('data:image/'),
    }));
  },

  findDeckUserByUsername(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return null;
    for (const u of Object.values(_state.deckUsers)) {
      if (String(u.username || '').toLowerCase() === n) return ensureDeckUserShape(u);
    }
    return null;
  },

  addDeckUser({ id, username }) {
    const uid = id || `d_${Date.now()}`;
    _state.deckUsers[uid] = ensureDeckUserShape({
      id: uid,
      username: username || 'user',
      avatarDataUrl: null,
      followingAccounts: [],
      columns: [...DEFAULT_COLUMNS],
      settings: { ...DEFAULT_PROFILE_SETTINGS },
    });
    save(_state);
    return uid;
  },

  setDeckUserAvatar(deckUserId, avatarDataUrl) {
    const u = _state.deckUsers[deckUserId];
    if (!u) throw new Error('User not found');
    u.avatarDataUrl = avatarDataUrl || null;
    save(_state);
  },

  clearDeckUserAvatar(deckUserId) {
    const u = _state.deckUsers[deckUserId];
    if (!u) throw new Error('User not found');
    u.avatarDataUrl = null;
    save(_state);
  },

  updateDeckUsername(deckUserId, username) {
    const u = _state.deckUsers[deckUserId];
    if (!u) return;
    u.username = username;
    save(_state);
  },

  removeDeckUser(deckUserId) {
    delete _state.deckUsers[deckUserId];
    save(_state);
  },

  listRoleForUser(list, deckUserId) {
    if (!list || !deckUserId) return null;
    if (list.legacyPublic && !list.ownerId) return 'legacy';
    if (list.ownerId === deckUserId) return 'owner';
    if (list.memberIds.includes(deckUserId)) return 'member';
    return null;
  },

  canAccessList(list, deckUserId) {
    return this.listRoleForUser(list, deckUserId) != null;
  },

  canEditListContents(list, deckUserId) {
    const r = this.listRoleForUser(list, deckUserId);
    return r === 'owner' || r === 'member' || r === 'legacy';
  },

  canDeleteList(list, deckUserId) {
    const r = this.listRoleForUser(list, deckUserId);
    if (r === 'owner') return true;
    if (r === 'legacy') return true;
    return false;
  },

  getListsVisibleToDeckUser(deckUserId) {
    return _state.lists.filter((l) => this.canAccessList(l, deckUserId));
  },

  listToClient(list, deckUserId) {
    const role = this.listRoleForUser(list, deckUserId);
    const base = {
      id: list.id,
      name: list.name,
      emoji: list.emoji || '',
      accounts: list.accounts,
      myRole: role,
      ownerId: list.ownerId || null,
      legacyPublic: !!list.legacyPublic && !list.ownerId,
    };
    if (role === 'owner') {
      base.pendingRequests = (list.pendingRequests || []).map((r) => ({ ...r }));
      base.memberIds = [...(list.memberIds || [])];
    }
    return base;
  },

  getListAccessSummaryForDeckUser(deckUserId) {
    const incoming = [];
    const outgoingPending = [];
    for (const list of _state.lists) {
      if (list.ownerId === deckUserId && list.pendingRequests && list.pendingRequests.length) {
        for (const pr of list.pendingRequests) {
          incoming.push({
            listId: list.id,
            listName: list.name,
            requesterId: pr.userId,
            requestedAt: pr.at,
          });
        }
      }
      const pend = (list.pendingRequests || []).find((r) => r.userId === deckUserId);
      if (pend && list.ownerId && list.ownerId !== deckUserId) {
        const owner = _state.deckUsers[list.ownerId];
        outgoingPending.push({
          listId: list.id,
          listName: list.name,
          ownerUsername: owner ? owner.username : list.ownerId,
          requestedAt: pend.at,
        });
      }
    }
    return { incoming, outgoingPending };
  },

  getListLookupForRequester(listId, deckUserId) {
    const list = _state.lists.find((l) => l.id === listId);
    if (!list) return { exists: false };
    normalizeListInPlace(list);
    const role = this.listRoleForUser(list, deckUserId);
    const blocked = list.blockedUserIds.includes(deckUserId);
    const pending = list.pendingRequests.some((r) => r.userId === deckUserId);
    const isLegacy = list.legacyPublic && !list.ownerId;
    return {
      exists: true,
      name: list.name,
      youHaveAccess: role != null,
      canRequest:
        !isLegacy
        && list.ownerId
        && list.ownerId !== deckUserId
        && role == null
        && !blocked
        && !pending,
      pending,
      blocked,
      legacyPublic: isLegacy,
    };
  },

  /**
   * Private lists (with owner) the viewer does not have access to yet — for browse/search.
   * Does not expose account handles. Legacy open lists are omitted (already in GET /lists).
   */
  discoverConnectableLists(deckUserId, searchQuery) {
    const q = String(searchQuery || '').trim().toLowerCase();
    const max = 100;
    const candidates = [];
    for (const list of _state.lists) {
      normalizeListInPlace(list);
      if (!list.ownerId) continue;
      if (list.ownerId === deckUserId) continue;
      if (list.memberIds.includes(deckUserId)) continue;
      const name = String(list.name || '');
      if (q && !name.toLowerCase().includes(q)) continue;
      const owner = _state.deckUsers[list.ownerId];
      const blocked = list.blockedUserIds.includes(deckUserId);
      const pending = list.pendingRequests.some((r) => r.userId === deckUserId);
      const canRequest = !blocked && !pending;
      candidates.push({
        id: list.id,
        name: list.name,
        emoji: list.emoji || '',
        ownerUsername: owner ? owner.username : list.ownerId,
        canRequest,
        pending,
        blocked,
      });
    }
    candidates.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }));
    return candidates.slice(0, max);
  },

  addListAccessRequest(listId, requesterId) {
    const list = _state.lists.find((l) => l.id === listId);
    if (!list) throw new Error('List not found');
    normalizeListInPlace(list);
    if (list.legacyPublic && !list.ownerId) throw new Error('This list is open to everyone on the server');
    if (!list.ownerId) throw new Error('List has no owner');
    if (list.ownerId === requesterId) throw new Error('You already own this list');
    if (list.memberIds.includes(requesterId)) throw new Error('You already have access');
    if (list.blockedUserIds.includes(requesterId)) throw new Error('The list owner has blocked your requests');
    if (list.pendingRequests.some((r) => r.userId === requesterId)) throw new Error('Request already pending');
    list.pendingRequests.push({ userId: requesterId, at: Date.now() });
    save(_state);
  },

  respondToListAccessRequest(listId, ownerId, requesterId, action) {
    const list = _state.lists.find((l) => l.id === listId);
    if (!list) throw new Error('List not found');
    normalizeListInPlace(list);
    if (list.ownerId !== ownerId) throw new Error('Only the list creator can respond');
    const idx = list.pendingRequests.findIndex((r) => r.userId === requesterId);
    if (idx < 0) throw new Error('No pending request from that user');
    list.pendingRequests.splice(idx, 1);
    if (action === 'allow') {
      if (!list.memberIds.includes(requesterId)) list.memberIds.push(requesterId);
      list.blockedUserIds = list.blockedUserIds.filter((id) => id !== requesterId);
    } else if (action === 'block') {
      if (!list.blockedUserIds.includes(requesterId)) list.blockedUserIds.push(requesterId);
    } else {
      throw new Error('Invalid action');
    }
    save(_state);
  },

  removeListMember(listId, ownerId, memberId) {
    const list = _state.lists.find((l) => l.id === listId);
    if (!list) throw new Error('List not found');
    normalizeListInPlace(list);
    if (list.ownerId !== ownerId) throw new Error('Only the list creator can remove members');
    if (memberId === ownerId) throw new Error('Cannot remove yourself');
    list.memberIds = list.memberIds.filter((id) => id !== memberId);
    save(_state);
  },

  // Lists (shared storage, access-controlled per deck user)
  getLists() { return _state.lists; },
  getList(id) { return _state.lists.find(l => l.id === id); },
  addList(list) {
    normalizeListInPlace(list);
    _state.lists.push(list);
    save(_state);
  },
  updateList(id, patch) {
    const idx = _state.lists.findIndex(l => l.id === id);
    if (idx >= 0) { _state.lists[idx] = { ..._state.lists[idx], ...patch }; normalizeListInPlace(_state.lists[idx]); save(_state); }
  },
  deleteList(id, deckUserId) {
    const list = _state.lists.find((l) => l.id === id);
    if (!list) return false;
    normalizeListInPlace(list);
    if (!canDeleteListRecord(list, deckUserId)) return false;
    _state.lists = _state.lists.filter(l => l.id !== id);
    Object.values(_state.deckUsers).forEach(p => {
      p.columns = (p.columns || []).filter(c => !(c.type === 'list' && c.ref === id));
    });
    save(_state);
    return true;
  },
  addAccountToList(listId, handle) {
    const list = _state.lists.find(l => l.id === listId);
    if (!list) throw new Error('List not found');
    if (!list.accounts.includes(handle)) { list.accounts.push(handle); save(_state); }
  },
  removeAccountFromList(listId, handle) {
    const list = _state.lists.find(l => l.id === listId);
    if (!list) throw new Error('List not found');
    list.accounts = list.accounts.filter(a => a !== handle);
    save(_state);
  },

  getFollowing(deckUserId) {
    const u = getDeckUser(deckUserId);
    return u ? u.followingAccounts : [];
  },
  follow(deckUserId, handle) {
    const u = _state.deckUsers[deckUserId];
    if (!u) throw new Error('User not found');
    if (!u.followingAccounts.includes(handle)) {
      u.followingAccounts.push(handle);
      save(_state);
    }
  },
  unfollow(deckUserId, handle) {
    const u = _state.deckUsers[deckUserId];
    if (!u) return;
    u.followingAccounts = u.followingAccounts.filter(a => a !== handle);
    u.columns = (u.columns || []).filter(c => !(c.type === 'account' && c.ref === handle));
    save(_state);
  },

  getColumns(deckUserId) {
    const u = getDeckUser(deckUserId);
    return u ? u.columns : [...DEFAULT_COLUMNS];
  },
  setColumns(deckUserId, cols) {
    const u = _state.deckUsers[deckUserId];
    if (!u) throw new Error('User not found');
    u.columns = cols;
    save(_state);
  },
  addColumn(deckUserId, col) {
    const u = _state.deckUsers[deckUserId];
    if (!u) throw new Error('User not found');
    if (!u.columns.find(c => c.id === col.id)) {
      u.columns.push(col);
      save(_state);
    }
  },
  removeColumn(deckUserId, id) {
    const u = _state.deckUsers[deckUserId];
    if (!u) return;
    u.columns = u.columns.filter(c => c.id !== id);
    save(_state);
  },

  getSettings(deckUserId) {
    const u = getDeckUser(deckUserId);
    const raw = u ? { ...DEFAULT_PROFILE_SETTINGS, ...u.settings } : { ...DEFAULT_PROFILE_SETTINGS };
    const allowed = new Set(['dark', 'light', 'navy']);
    if (raw.colorTheme == null || !allowed.has(String(raw.colorTheme))) {
      raw.colorTheme = raw.darkMode === false ? 'light' : 'dark';
    }
    return raw;
  },
  updateSettings(deckUserId, patch) {
    const u = _state.deckUsers[deckUserId];
    if (!u) throw new Error('User not found');
    const p = { ...patch };
    const allowed = new Set(['dark', 'light', 'navy']);
    if (p.colorTheme != null && allowed.has(String(p.colorTheme))) {
      p.colorTheme = String(p.colorTheme);
      p.darkMode = p.colorTheme !== 'light';
    } else if (Object.prototype.hasOwnProperty.call(p, 'darkMode')) {
      p.colorTheme = p.darkMode ? 'dark' : 'light';
    }
    u.settings = { ...u.settings, ...p };
    save(_state);
  },
};

module.exports = state;
