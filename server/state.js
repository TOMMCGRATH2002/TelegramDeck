/**
 * state.js — JSON persistence
 *
 * Shared: lists (same for every Telegram user on this server)
 * Per profile: Telegram session, individual follows, deck columns, UI settings
 */

const fs   = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'state.json');

const DEFAULT_PROFILE_SETTINGS = {
  autoTranslate: false,
  darkMode: true,
  sidebarExpanded: false,
};

const DEFAULT_COLUMNS = [
  { id: 'col-all', type: 'all', ref: null, title: 'All Accounts', icon: '⋯', iconBg: 'rgba(42,171,238,0.12)' },
];

function emptyState() {
  return {
    lists: [],
    profiles: {},
  };
}

function migrateLegacy(raw) {
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

function load() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(STATE_FILE)) {
      const envSession = process.env.TELEGRAM_SESSION || '';
      if (envSession) {
        return migrateLegacy({
          lists: [],
          followingAccounts: [],
          columns: [...DEFAULT_COLUMNS],
          settings: {},
        });
      }
      return emptyState();
    }
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return migrateLegacy(raw);
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

function ensureProfileShape(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    id: p.id,
    label: p.label || 'User',
    session: p.session || '',
    followingAccounts: Array.isArray(p.followingAccounts) ? p.followingAccounts : [],
    columns: Array.isArray(p.columns) && p.columns.length ? p.columns : [...DEFAULT_COLUMNS],
    settings: { ...DEFAULT_PROFILE_SETTINGS, ...(p.settings && typeof p.settings === 'object' ? p.settings : {}) },
  };
}

function getProfile(id) {
  if (!id) return null;
  const p = _state.profiles[id];
  return ensureProfileShape(p);
}

const state = {
  get() { return _state; },
  save() { save(_state); },

  listProfilesPublic() {
    return Object.values(_state.profiles).map(p => ({
      id: p.id,
      label: p.label || 'User',
    }));
  },

  getProfileSession(profileId) {
    const p = _state.profiles[profileId];
    return p && p.session ? p.session : null;
  },

  addProfile({ id, label, session }) {
    const pid = id || ('p_' + Date.now());
    _state.profiles[pid] = ensureProfileShape({
      id: pid,
      label: label || 'User',
      session,
      followingAccounts: [],
      columns: [...DEFAULT_COLUMNS],
      settings: { ...DEFAULT_PROFILE_SETTINGS },
    });
    save(_state);
    return pid;
  },

  updateProfileLabel(profileId, label) {
    const p = _state.profiles[profileId];
    if (!p) return;
    p.label = label || p.label;
    save(_state);
  },

  removeProfile(profileId) {
    delete _state.profiles[profileId];
    save(_state);
  },

  // Lists (shared)
  getLists() { return _state.lists; },
  getList(id) { return _state.lists.find(l => l.id === id); },
  addList(list) {
    _state.lists.push(list);
    save(_state);
  },
  updateList(id, patch) {
    const idx = _state.lists.findIndex(l => l.id === id);
    if (idx >= 0) { _state.lists[idx] = { ..._state.lists[idx], ...patch }; save(_state); }
  },
  deleteList(id) {
    _state.lists = _state.lists.filter(l => l.id !== id);
    Object.values(_state.profiles).forEach(p => {
      p.columns = (p.columns || []).filter(c => !(c.type === 'list' && c.ref === id));
    });
    save(_state);
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

  // Following (per profile)
  getFollowing(profileId) {
    const p = getProfile(profileId);
    return p ? p.followingAccounts : [];
  },
  follow(profileId, handle) {
    const p = _state.profiles[profileId];
    if (!p) throw new Error('Profile not found');
    if (!p.followingAccounts.includes(handle)) {
      p.followingAccounts.push(handle);
      save(_state);
    }
  },
  unfollow(profileId, handle) {
    const p = _state.profiles[profileId];
    if (!p) return;
    p.followingAccounts = p.followingAccounts.filter(a => a !== handle);
    p.columns = (p.columns || []).filter(c => !(c.type === 'account' && c.ref === handle));
    save(_state);
  },

  // Columns (per profile)
  getColumns(profileId) {
    const p = getProfile(profileId);
    return p ? p.columns : [...DEFAULT_COLUMNS];
  },
  setColumns(profileId, cols) {
    const p = _state.profiles[profileId];
    if (!p) throw new Error('Profile not found');
    p.columns = cols;
    save(_state);
  },
  addColumn(profileId, col) {
    const p = _state.profiles[profileId];
    if (!p) throw new Error('Profile not found');
    if (!p.columns.find(c => c.id === col.id)) {
      p.columns.push(col);
      save(_state);
    }
  },
  removeColumn(profileId, id) {
    const p = _state.profiles[profileId];
    if (!p) return;
    p.columns = p.columns.filter(c => c.id !== id);
    save(_state);
  },

  // Settings (per profile)
  getSettings(profileId) {
    const p = getProfile(profileId);
    return p ? { ...p.settings } : { ...DEFAULT_PROFILE_SETTINGS };
  },
  updateSettings(profileId, patch) {
    const p = _state.profiles[profileId];
    if (!p) throw new Error('Profile not found');
    p.settings = { ...p.settings, ...patch };
    save(_state);
  },
};

module.exports = state;
