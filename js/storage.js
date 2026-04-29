// AIARE storage module — persists sessions, active id, and settings to localStorage.

export const STORAGE_KEYS = {
  sessions: 'aiare:sessions',
  active:   'aiare:active',
  settings: 'aiare:settings',
};

export const DEFAULT_MODEL = { nodes: [], edges: [], version: 0 };

export const DEFAULT_SETTINGS = { apiKey: '', model: 'claude-sonnet-4-6' };

/** Generate a stable id with optional prefix. */
export function newId(prefix) {
  const rand = (window.crypto && typeof window.crypto.randomUUID === 'function')
    ? window.crypto.randomUUID()
    : Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  return prefix ? prefix + '_' + rand : rand;
}

function safeParse(raw, fallback) {
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

/** Load full app state from localStorage, ensuring at least one session exists. */
export function loadAll() {
  const sessions = safeParse(window.localStorage.getItem(STORAGE_KEYS.sessions), null) || {};
  let activeId  = safeParse(window.localStorage.getItem(STORAGE_KEYS.active), null) || '';
  const loadedSettings = safeParse(window.localStorage.getItem(STORAGE_KEYS.settings), null) || {};
  const settings = { ...DEFAULT_SETTINGS, ...loadedSettings };

  const state = { sessions, activeId, settings, drillPath: [], zoom: 1 };

  if (!state.sessions || Object.keys(state.sessions).length === 0) {
    state.sessions = {};
    createSession(state, 'Default');
  } else if (!state.sessions[state.activeId]) {
    state.activeId = Object.keys(state.sessions)[0];
  }
  // Migration: ensure every session has a messages array.
  for (const s of Object.values(state.sessions)) {
    if (!Array.isArray(s.messages)) s.messages = [];
  }
  return state;
}

/** Persist sessions, activeId, and settings to localStorage. */
export function persist(state) {
  try {
    window.localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(state.sessions));
    window.localStorage.setItem(STORAGE_KEYS.active,   JSON.stringify(state.activeId));
    window.localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
  } catch (err) {
    console.warn('AIARE: persist failed', err);
  }
}

/** Create a new session, insert into state, and return its id. */
export function createSession(state, name) {
  const id = newId('s');
  const count = Object.keys(state.sessions).length + 1;
  const session = {
    id,
    name: name || ('Session ' + count),
    createdAt: Date.now(),
    logs: [],
    messages: [],
    model: { ...DEFAULT_MODEL, nodes: [], edges: [] },
  };
  state.sessions[id] = session;
  state.activeId = id;
  return id;
}

/** Delete a session by id; reassigns active or creates a default if needed. */
export function deleteSession(state, id) {
  if (!state.sessions[id]) return;
  delete state.sessions[id];
  if (state.activeId === id) {
    const remaining = Object.keys(state.sessions);
    if (remaining.length > 0) {
      state.activeId = remaining[0];
    } else {
      createSession(state, 'default');
    }
  }
}

/** List sessions as {id, name} sorted by createdAt ascending. */
export function listSessions(state) {
  return Object.values(state.sessions)
    .slice()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map(s => ({ id: s.id, name: s.name }));
}

/** Return the currently active session object. */
export function activeSession(state) {
  return state.sessions[state.activeId];
}

/** Clear logs and reset model on the active session. */
export function clearActiveSession(state) {
  const s = activeSession(state);
  if (!s) return;
  s.logs = [];
  s.messages = [];
  s.model = { ...DEFAULT_MODEL, nodes: [], edges: [], version: 0 };
}

/** Replace the active session's model and bump its version. */
export function setActiveModel(state, newModel) {
  const s = activeSession(state);
  if (!s) return;
  const prevVersion = (s.model && typeof s.model.version === 'number') ? s.model.version : 0;
  s.model = {
    nodes: newModel && newModel.nodes ? newModel.nodes : [],
    edges: newModel && newModel.edges ? newModel.edges : [],
    version: prevVersion + 1,
  };
}

/** Append a raw log entry to the active session and return it. */
export function appendLog(state, raw) {
  const s = activeSession(state);
  if (!s) return null;
  const entry = { id: newId('l'), ingestedAt: Date.now(), raw: raw };
  s.logs.push(entry);
  return entry;
}

/**
 * Append a chat-pane message to the active session and return the stored entry.
 * `message` shape: { role: 'user'|'assistant'|'system'|'log'|'error'|'chat', text: string, label?: string, thinking?: string, meta?: object }
 */
export function appendMessage(state, message) {
  const sess = activeSession(state);
  if (!sess) return null;
  if (!Array.isArray(sess.messages)) sess.messages = [];
  const entry = {
    id: newId('m'),
    timestamp: Date.now(),
    ...message,
  };
  sess.messages.push(entry);
  return entry;
}

/**
 * Return the messages array of the active session (always an array, never null).
 */
export function getActiveMessages(state) {
  const sess = activeSession(state);
  if (!sess) return [];
  if (!Array.isArray(sess.messages)) sess.messages = [];
  return sess.messages;
}
