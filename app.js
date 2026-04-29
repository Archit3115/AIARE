// AIARE — main orchestrator
// Wires DOM, sessions, engine, and renderer together.

import {
  loadAll, persist, createSession, deleteSession, listSessions,
  activeSession, clearActiveSession, setActiveModel,
} from './js/storage.js';
import {
  EXAMPLE_LOG, reverseEngineer, mergeModel,
} from './js/engine.js';
import { buildMermaid } from './js/mermaid-gen.js';
import {
  renderDiagram, showTooltip, hideTooltip, setZoom, currentSvg,
  downloadSvg, downloadPng, downloadText,
} from './js/renderer.js';

const $ = (id) => document.getElementById(id);

const state = loadAll();

// ------------------------------ DOM refs ------------------------------
const els = {
  sessionSelect: $('session-select'),
  newSession:    $('new-session'),
  renameSession: $('rename-session'),
  settingsBtn:   $('settings-btn'),
  dlSvg:         $('download-svg'),
  dlPng:         $('download-png'),
  dlMmd:         $('download-mmd'),
  resetSession:  $('reset-session'),

  breadcrumbs:   $('breadcrumbs'),
  fitBtn:        $('fit-btn'),
  zoomIn:        $('zoom-in'),
  zoomOut:       $('zoom-out'),
  canvasWrap:    $('canvas-wrap'),
  canvas:        $('mermaid-canvas'),
  emptyMsg:      $('empty-msg'),
  legend:        $('legend'),

  mergeBtn:      $('merge-btn'),
  chat:          $('chat'),
  logInput:      $('log-input'),
  submitLog:     $('submit-log'),
  exampleBtn:    $('example-btn'),

  settingsModal: $('settings-modal'),
  apiKey:        $('api-key'),
  modelSelect:   $('model-select'),
  settingsCancel:$('settings-cancel'),
  settingsSave:  $('settings-save'),

  mergeModal:    $('merge-modal'),
  mergeSelect:   $('merge-select'),
  mergeCancel:   $('merge-cancel'),
  mergeAll:      $('merge-all'),
  mergeConfirm:  $('merge-confirm'),

  renameModal:   $('rename-modal'),
  renameInput:   $('rename-input'),
  renameCancel:  $('rename-cancel'),
  renameConfirm: $('rename-confirm'),
};

// ------------------------------ Chat ------------------------------
function pushMsg({ role, label, body, thinking }) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (label) {
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = label;
    div.appendChild(l);
  }
  if (thinking) {
    const t = document.createElement('div');
    t.className = 'think';
    t.textContent = thinking;
    div.appendChild(t);
  }
  if (body) {
    const b = document.createElement('div');
    b.className = 'summary';
    b.textContent = body;
    div.appendChild(b);
  }
  els.chat.appendChild(div);
  els.chat.scrollTop = els.chat.scrollHeight;
  return div;
}

function pushSystem(text) { return pushMsg({ role: 'system', body: text }); }
function pushError(text)  { return pushMsg({ role: 'error', label: 'error', body: text }); }

// ------------------------------ Sessions ------------------------------
function refreshSessionSelect() {
  const list = listSessions(state);
  els.sessionSelect.innerHTML = '';
  for (const s of list) {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.name;
    if (s.id === state.activeId) opt.selected = true;
    els.sessionSelect.appendChild(opt);
  }
}

function switchSession(id) {
  if (!state.sessions[id]) return;
  state.activeId = id;
  state.drillPath = [];
  persist(state);
  refreshSessionSelect();
  els.chat.innerHTML = '';
  pushSystem(`Switched to session "${state.sessions[id].name}".`);
  if (state.sessions[id].logs.length === 0) promptForFirstLog();
  rerender();
}

function promptForFirstLog() {
  pushSystem('Paste your first log to begin. AIARE will reverse-engineer the architecture from it.');
}

// ------------------------------ Render ------------------------------
function renderBreadcrumbs() {
  els.breadcrumbs.innerHTML = '';
  const root = document.createElement('span');
  root.className = 'crumb';
  root.textContent = 'Root';
  root.onclick = () => { state.drillPath = []; rerender(); };
  els.breadcrumbs.appendChild(root);

  let cursor = state.sessions[state.activeId].model.nodes;
  for (let i = 0; i < state.drillPath.length; i++) {
    const id = state.drillPath[i];
    const node = (cursor || []).find(n => n.id === id);
    const sep = document.createElement('span');
    sep.style.color = 'var(--muted)'; sep.textContent = '›';
    els.breadcrumbs.appendChild(sep);
    const c = document.createElement('span');
    c.className = 'crumb';
    c.textContent = node ? (node.label || node.id) : id;
    const depth = i + 1;
    c.onclick = () => { state.drillPath = state.drillPath.slice(0, depth); rerender(); };
    els.breadcrumbs.appendChild(c);
    cursor = node && node.children;
  }
}

async function rerender() {
  const sess = activeSession(state);
  const code = buildMermaid(sess.model, state.drillPath);
  await renderDiagram({
    mermaidCode: code,
    container: els.canvas,
    model: sess.model,
    callbacks: {
      onNodeClick: (node) => {
        if ((node.children && node.children.length) || (node.resources && node.resources.length)) {
          state.drillPath = [...state.drillPath, node.id];
          rerender();
        }
      },
      onNodeHover: (node, x, y) => showTooltip({ node, x, y }),
    },
  });
  setZoom(state.zoom || 1);
  renderBreadcrumbs();
}

// ------------------------------ Submit log ------------------------------
let busy = false;
async function onSubmit() {
  if (busy) return;
  const txt = els.logInput.value.trim();
  if (!txt) return;
  if (!state.settings.apiKey) {
    pushError('No Anthropic API key set. Open ⚙ Settings and paste your key.');
    return;
  }
  busy = true;
  els.submitLog.disabled = true;
  pushMsg({ role: 'user', label: 'log', body: txt.length > 600 ? txt.slice(0, 600) + '…' : txt });
  const stageMsg = pushMsg({ role: 'assistant', label: 'thinking', body: '⏳ submitting…' });
  try {
    const res = await reverseEngineer({
      state,
      logText: txt,
      onProgress: (stage) => {
        const map = {
          submitting: '⏳ submitting log…',
          awaiting:   '🤔 awaiting Claude response…',
          parsing:    '🧩 parsing inferred architecture…',
          merging:    '🧮 merging into existing model…',
          done:       '✅ done',
        };
        const b = stageMsg.querySelector('.summary');
        if (b) b.textContent = map[stage] || stage;
      },
    });
    if (!res.ok) {
      stageMsg.classList.remove('assistant');
      stageMsg.classList.add('error');
      stageMsg.querySelector('.summary').textContent = res.error;
      if (res.raw) {
        const pre = document.createElement('pre');
        pre.textContent = res.raw;
        stageMsg.appendChild(pre);
      }
    } else {
      stageMsg.querySelector('.label').textContent = 'reverse-engineered';
      const think = document.createElement('div');
      think.className = 'think'; think.textContent = res.thinking || '';
      stageMsg.insertBefore(think, stageMsg.querySelector('.summary'));
      stageMsg.querySelector('.summary').textContent = res.summary || '(no summary)';
      els.logInput.value = '';
      await rerender();
    }
  } catch (e) {
    pushError(e.message || String(e));
  } finally {
    busy = false;
    els.submitLog.disabled = false;
  }
}

// ------------------------------ Modals ------------------------------
function openModal(m) { m.classList.add('open'); }
function closeModal(m) { m.classList.remove('open'); }

function openSettings() {
  els.apiKey.value = state.settings.apiKey || '';
  els.modelSelect.value = state.settings.model || 'claude-sonnet-4-6';
  openModal(els.settingsModal);
}
function saveSettings() {
  state.settings.apiKey = els.apiKey.value.trim();
  state.settings.model  = els.modelSelect.value;
  persist(state);
  closeModal(els.settingsModal);
  pushSystem('Settings saved.');
}

function openMerge() {
  const list = listSessions(state).filter(s => s.id !== state.activeId);
  els.mergeSelect.innerHTML = '';
  if (list.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '(no other sessions)'; opt.disabled = true;
    els.mergeSelect.appendChild(opt);
  } else {
    for (const s of list) {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = s.name;
      els.mergeSelect.appendChild(opt);
    }
  }
  openModal(els.mergeModal);
}

function doMerge(ids) {
  const sess = activeSession(state);
  let merged = sess.model;
  for (const id of ids) {
    const other = state.sessions[id];
    if (!other) continue;
    merged = mergeModel(merged, other.model);
  }
  setActiveModel(state, merged);
  persist(state);
  closeModal(els.mergeModal);
  pushSystem(`Merged ${ids.length} session${ids.length === 1 ? '' : 's'} into "${sess.name}".`);
  rerender();
}

function openRename() {
  els.renameInput.value = activeSession(state).name;
  openModal(els.renameModal);
}
function confirmRename() {
  const n = els.renameInput.value.trim();
  if (n) {
    activeSession(state).name = n;
    persist(state);
    refreshSessionSelect();
  }
  closeModal(els.renameModal);
}

// ------------------------------ Wiring ------------------------------
function init() {
  window.mermaid.initialize({
    startOnLoad: false, theme: 'dark', securityLevel: 'loose',
    flowchart: { htmlLabels: true, curve: 'basis' },
  });

  // Mermaid click directives call this global
  window.aiareClick = (id) => {
    const sess = activeSession(state);
    let cursor = sess.model.nodes;
    for (const did of state.drillPath) {
      const n = (cursor || []).find(x => x.id === did);
      cursor = n && n.children;
    }
    const node = (cursor || []).find(n => n.id === id || (n.id && id.endsWith(n.id)));
    if (node && ((node.children && node.children.length) || (node.resources && node.resources.length))) {
      state.drillPath = [...state.drillPath, node.id];
      rerender();
    }
  };

  // Top bar
  els.sessionSelect.addEventListener('change', e => switchSession(e.target.value));
  els.newSession.addEventListener('click', () => {
    const id = createSession(state, `Session ${listSessions(state).length + 1}`);
    persist(state);
    switchSession(id);
  });
  els.renameSession.addEventListener('click', openRename);
  els.settingsBtn.addEventListener('click', openSettings);
  els.dlSvg.addEventListener('click', () => downloadSvg(`${activeSession(state).name}.svg`));
  els.dlPng.addEventListener('click', () => downloadPng(`${activeSession(state).name}.png`));
  els.dlMmd.addEventListener('click', () => {
    const code = buildMermaid(activeSession(state).model, state.drillPath);
    downloadText(code, `${activeSession(state).name}.mmd`, 'text/plain');
  });
  els.resetSession.addEventListener('click', () => {
    if (!confirm('Clear all logs and the model in this session?')) return;
    clearActiveSession(state);
    persist(state);
    state.drillPath = [];
    els.chat.innerHTML = '';
    pushSystem('Session cleared.');
    promptForFirstLog();
    rerender();
  });

  // Canvas controls
  els.fitBtn.addEventListener('click', () => { state.zoom = 1; setZoom(1); });
  els.zoomIn.addEventListener('click', () => { state.zoom = Math.min(3, (state.zoom || 1) + 0.15); setZoom(state.zoom); });
  els.zoomOut.addEventListener('click', () => { state.zoom = Math.max(0.4, (state.zoom || 1) - 0.15); setZoom(state.zoom); });
  els.canvasWrap.addEventListener('mouseleave', hideTooltip);

  // Right pane
  els.mergeBtn.addEventListener('click', openMerge);
  els.submitLog.addEventListener('click', onSubmit);
  els.exampleBtn.addEventListener('click', () => { els.logInput.value = EXAMPLE_LOG; els.logInput.focus(); });
  els.logInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); onSubmit(); }
  });

  // Settings modal
  els.settingsCancel.addEventListener('click', () => closeModal(els.settingsModal));
  els.settingsSave.addEventListener('click', saveSettings);

  // Merge modal
  els.mergeCancel.addEventListener('click', () => closeModal(els.mergeModal));
  els.mergeConfirm.addEventListener('click', () => {
    const id = els.mergeSelect.value;
    if (id && state.sessions[id]) doMerge([id]);
  });
  els.mergeAll.addEventListener('click', () => {
    const ids = listSessions(state).map(s => s.id).filter(id => id !== state.activeId);
    if (ids.length) doMerge(ids);
    else closeModal(els.mergeModal);
  });

  // Rename modal
  els.renameCancel.addEventListener('click', () => closeModal(els.renameModal));
  els.renameConfirm.addEventListener('click', confirmRename);

  // Click outside modal closes
  for (const m of [els.settingsModal, els.mergeModal, els.renameModal]) {
    m.addEventListener('click', (e) => { if (e.target === m) closeModal(m); });
  }

  refreshSessionSelect();
  if (activeSession(state).logs.length === 0) {
    promptForFirstLog();
    if (!state.settings.apiKey) {
      pushSystem('Tip: open ⚙ Settings to add your Anthropic API key first.');
    }
  } else {
    pushSystem(`Restored session "${activeSession(state).name}" with ${activeSession(state).logs.length} log${activeSession(state).logs.length === 1 ? '' : 's'}.`);
  }
  rerender();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
