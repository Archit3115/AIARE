// AIARE — main orchestrator
// Streams Claude's verbose thinking live, persists chat history, supports
// file uploads (with auto-chunking) and a free-form "Ask agent" mode.

import {
  loadAll, persist, createSession, listSessions,
  activeSession, clearActiveSession, setActiveModel,
  appendMessage, getActiveMessages,
} from './js/storage.js';
import {
  EXAMPLE_LOG, reverseEngineer, mergeModel, chatWithAgent, analyzeInput,
} from './js/engine.js';
import { previewText } from './js/preview.js';
import { buildMermaid } from './js/mermaid-gen.js';
import {
  renderDiagram, showTooltip, hideTooltip, setZoom,
  downloadSvg, downloadPng, downloadText,
} from './js/renderer.js';
import { splitLogText, shouldChunk, chunkBanner } from './js/chunker.js';
import {
  computeViews, pickActiveViewId, subModelForView, viewTabLabel, isRootView,
} from './js/views.js';

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
  viewTabsBar:   $('view-tabs'),

  mergeBtn:      $('merge-btn'),
  chat:          $('chat'),
  logInput:      $('log-input'),
  submitLog:     $('submit-log'),
  askBtn:        $('ask-btn'),
  uploadBtn:     $('upload-btn'),
  logFile:       $('log-file'),
  exampleBtn:    $('example-btn'),

  settingsModal: $('settings-modal'),
  providerSelect:$('provider-select'),
  apiKey:        $('api-key'),
  baseUrl:       $('base-url'),
  baseUrlRow:    $('base-url-row'),
  modelSelect:   $('model-select'),
  modelCustom:   $('model-custom'),
  cavemanToggle: $('caveman-toggle'),
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

// inject .status style once
(() => {
  const s = document.createElement('style');
  s.textContent = `
    .msg .status { color: var(--accent); font-size: 11px; margin-bottom: 6px; font-family: ui-monospace, Menlo, monospace; }
    .msg.error .status { color: var(--err); }
  `;
  document.head.appendChild(s);
})();

// ------------------------------ Chat ------------------------------
function pushMsg({ role, label, body, thinking, status, persistMsg = true, meta }) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (label) {
    const l = document.createElement('div'); l.className = 'label'; l.textContent = label; div.appendChild(l);
  }
  if (status) {
    const s = document.createElement('div'); s.className = 'status'; s.textContent = status; div.appendChild(s);
  }
  if (thinking) {
    const t = document.createElement('div'); t.className = 'think'; t.textContent = thinking; div.appendChild(t);
  }
  if (body) {
    const b = document.createElement('div'); b.className = 'summary'; b.textContent = body; div.appendChild(b);
  }
  els.chat.appendChild(div);
  els.chat.scrollTop = els.chat.scrollHeight;
  if (persistMsg) {
    appendMessage(state, { role, label, text: body || '', thinking: thinking || '', status: status || '', meta });
    persist(state);
  }
  return div;
}
function pushSystem(text, opts = {}) { return pushMsg({ role: 'system', body: text, ...opts }); }
function pushError(text)  { return pushMsg({ role: 'error', label: 'error', body: text }); }

function makeAssistantBubble(label = 'thinking', cssRole = 'assistant') {
  const div = document.createElement('div');
  div.className = `msg ${cssRole}`;
  div.innerHTML = `<div class="label"></div><div class="status"></div><div class="think"></div><div class="summary"></div>`;
  div.querySelector('.label').textContent = label;
  els.chat.appendChild(div);
  els.chat.scrollTop = els.chat.scrollHeight;
  let startedAt = Date.now();
  let tick = null;
  let stage = '';
  const setStage = (text) => {
    stage = text;
    div.querySelector('.status').textContent = text;
  };
  const startTicking = () => {
    if (tick) return;
    tick = setInterval(() => {
      if (!stage) return;
      const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
      div.querySelector('.status').textContent = `${stage} · ${sec}s`;
    }, 200);
  };
  const stopTicking = () => { if (tick) { clearInterval(tick); tick = null; } };
  const appendThink = (text) => {
    div.querySelector('.think').textContent += text;
    els.chat.scrollTop = els.chat.scrollHeight;
  };
  const setSummary = (text) => { div.querySelector('.summary').textContent = text; };
  const setError = (text) => {
    div.classList.remove('assistant'); div.classList.remove('chat'); div.classList.add('error');
    div.querySelector('.label').textContent = 'error';
    stopTicking();
    setStage('');
    setSummary(text);
  };
  return { div, setStage, startTicking, stopTicking, appendThink, setSummary, setError };
}

const STAGE_LABELS = {
  submitting:  '📤 Submitting log to Claude…',
  awaiting:    '🌐 Awaiting first byte…',
  parsing:     '🧩 Parsing inferred architecture JSON…',
  validating:  '🔍 Validating nodes/edges…',
  merging:     '🧮 Merging into existing model…',
  persisting:  '💾 Saving session…',
  done:        '✅ Done',
};

// ------------------------------ Sessions ------------------------------
function refreshSessionSelect() {
  els.sessionSelect.innerHTML = '';
  for (const s of listSessions(state)) {
    const opt = document.createElement('option');
    opt.value = s.id; opt.textContent = s.name;
    if (s.id === state.activeId) opt.selected = true;
    els.sessionSelect.appendChild(opt);
  }
}

function rerenderChat() {
  els.chat.innerHTML = '';
  const messages = getActiveMessages(state);
  for (const m of messages) {
    pushMsg({
      role: m.role || 'system',
      label: m.label,
      body: m.text,
      thinking: m.thinking,
      status: m.status,
      persistMsg: false,
      meta: m.meta,
    });
  }
}

function switchSession(id) {
  if (!state.sessions[id]) return;
  state.activeId = id;
  state.drillPath = [];
  persist(state);
  refreshSessionSelect();
  rerenderChat();
  if (activeSession(state).logs.length === 0 && getActiveMessages(state).length === 0) {
    promptForFirstLog();
  } else {
    pushSystem(`Switched to "${activeSession(state).name}".`);
  }
  rerender();
}

function promptForFirstLog() {
  pushSystem('Paste a log, upload a file (📁), or just chat with the agent (💬). The diagram updates whenever you reverse-engineer a log.');
  if (!state.settings.apiKey) pushSystem('Tip: open ⚙ Settings to pick an LLM provider and paste your API key.');
}

// ------------------------------ Diagram ------------------------------
function renderBreadcrumbs() {
  els.breadcrumbs.innerHTML = '';
  const root = document.createElement('span');
  root.className = 'crumb'; root.textContent = 'Root';
  root.onclick = () => { state.drillPath = []; rerender(); };
  els.breadcrumbs.appendChild(root);
  let cursor = activeSession(state).model.nodes;
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

function renderViewTabs(views, activeId) {
  const bar = els.viewTabsBar;
  if (!bar) return;
  bar.innerHTML = '';
  // Hide the tab bar entirely when there's only one (root) view.
  if (!views || views.length <= 1) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  for (const v of views) {
    const t = document.createElement('span');
    t.className = 'tab' + (v.id === activeId ? ' active' : '');
    const lbl = viewTabLabel(v);
    // Split into name + count so we can style the count differently.
    const m = lbl.match(/^(.*) \((\d+)\)$/);
    if (m) {
      t.appendChild(document.createTextNode(m[1]));
      const c = document.createElement('span');
      c.className = 'count'; c.textContent = m[2];
      t.appendChild(c);
    } else {
      t.textContent = lbl;
    }
    t.title = `${v.nodeIds.length} node${v.nodeIds.length === 1 ? '' : 's'}`;
    t.onclick = () => {
      const sess = activeSession(state);
      sess.activeViewId = v.id;
      state.drillPath = [];
      persist(state);
      rerender();
    };
    bar.appendChild(t);
  }
}

async function rerender() {
  const sess = activeSession(state);
  const views = computeViews(sess.model);
  const activeViewId = pickActiveViewId(views, sess.activeViewId);
  if (activeViewId !== sess.activeViewId) {
    sess.activeViewId = activeViewId;
    persist(state);
  }
  renderViewTabs(views, activeViewId);
  const activeView = views.find(v => v.id === activeViewId) || views[0];
  // When in 'all' mode (only one view) we render the full model. Otherwise
  // we render the sub-model the active tab represents.
  const renderModel = (activeView && !isRootView(activeView))
    ? subModelForView(activeView, sess.model)
    : sess.model;
  const code = buildMermaid(renderModel, state.drillPath);
  await renderDiagram({
    mermaidCode: code,
    container: els.canvas,
    model: renderModel,
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

// ------------------------------ Reverse-engineer (one log/chunk) ------------------------------
let busy = false;

async function submitOne(rawText, { prefix = '', source = 'paste', overview } = {}) {
  const bubble = makeAssistantBubble(prefix ? `${prefix} · thinking` : 'thinking', 'assistant');
  bubble.setStage(STAGE_LABELS.submitting);
  bubble.startTicking();

  const onProgress = (p) => {
    if (typeof p === 'string') {
      bubble.setStage(STAGE_LABELS[p] || p);
    } else if (p && p.stage === 'streaming' && p.delta) {
      bubble.appendThink(p.delta);
    } else if (p && p.stage) {
      bubble.setStage(STAGE_LABELS[p.stage] || p.stage);
    }
  };

  try {
    const res = await reverseEngineer({ state, logText: rawText, onProgress, overview });
    bubble.stopTicking();
    if (!res.ok) {
      bubble.setError(res.error || 'Unknown error');
      if (res.raw) {
        const pre = document.createElement('pre');
        pre.textContent = String(res.raw).slice(0, 2000);
        bubble.div.appendChild(pre);
      }
      // persist as error message
      appendMessage(state, { role: 'error', label: 'error', text: res.error || '', meta: { source } });
      persist(state);
      return false;
    }
    bubble.setStage(STAGE_LABELS.done);
    bubble.div.querySelector('.label').textContent = prefix ? `${prefix} · reverse-engineered` : 'reverse-engineered';
    if (res.thinking) bubble.div.querySelector('.think').textContent = res.thinking;
    bubble.setSummary(res.summary || '(no summary)');
    appendMessage(state, {
      role: 'assistant',
      label: prefix ? `${prefix} · reverse-engineered` : 'reverse-engineered',
      text: res.summary || '',
      thinking: res.thinking || '',
      status: STAGE_LABELS.done,
      meta: { source },
    });
    persist(state);
    await rerender();
    return true;
  } catch (e) {
    bubble.setError(e.message || String(e));
    appendMessage(state, { role: 'error', label: 'error', text: e.message || String(e) });
    persist(state);
    return false;
  }
}

// Threshold above which we do a "scout" pass first (cheap LLM call to summarise
// the input) before the actual reverse-engineer pass(es). Below this size we
// skip the scout — overhead would outweigh benefit.
const SCOUT_THRESHOLD_BYTES = 6 * 1024;

async function runScout(rawText, filename) {
  const preview = previewText(rawText, filename || 'pasted-input');
  pushSystem(`🔍 Scouting "${preview.name}" — ${preview.sizeKB} KB, ${preview.lineCount} lines, type=${preview.type}${preview.distinctServices.length ? `, ~${preview.distinctServices.length} distinct service tokens` : ''}.`);
  const bubble = makeAssistantBubble('scout', 'assistant');
  bubble.setStage('🔭 Generating overview…');
  bubble.startTicking();
  const onProgress = (p) => {
    if (typeof p === 'string') {
      const map = { scouting: '🔭 Building input preview…', awaiting: '🌐 Asking LLM for overview…', done: '✅ Overview ready' };
      bubble.setStage(map[p] || p);
    } else if (p && p.stage === 'streaming' && p.delta) {
      bubble.appendThink(p.delta);
    }
  };
  const res = await analyzeInput({ state, preview, onProgress });
  bubble.stopTicking();
  if (!res.ok) {
    bubble.setError(res.error || 'Scout failed');
    appendMessage(state, { role: 'error', label: 'scout error', text: res.error || '' });
    persist(state);
    return null;
  }
  bubble.setStage('✅ Overview ready');
  bubble.div.querySelector('.label').textContent = 'scout · overview';
  const ov = res.overview || {};
  const summary = `📋 ${ov.summary || ''}` +
    (Array.isArray(ov.components) && ov.components.length ? `\nExpected components: ${ov.components.join(', ')}` : '') +
    (ov.estimates ? `\nEstimates: ${JSON.stringify(ov.estimates)}` : '') +
    (Array.isArray(ov.keyEntities) && ov.keyEntities.length ? `\nKey entities: ${ov.keyEntities.slice(0, 12).join(', ')}` : '') +
    (ov.strategy ? `\nStrategy: ${ov.strategy}` : '');
  bubble.setSummary(summary);
  appendMessage(state, { role: 'assistant', label: 'scout · overview', text: summary, status: '✅ Overview ready' });
  persist(state);
  return ov;
}

async function submitLogText(rawText, { source = 'paste', filename } = {}) {
  if (!rawText || !rawText.trim()) return;
  if (!state.settings.apiKey) {
    pushError('No API key set. Open ⚙ Settings and pick a provider + paste your key.');
    return;
  }
  if (busy) { pushSystem('Busy — please wait for the current request to finish.'); return; }
  busy = true; els.submitLog.disabled = true; els.askBtn.disabled = true; els.uploadBtn.disabled = true;
  try {
    const headLabel = filename ? `log file · ${filename}` : 'log';
    pushMsg({ role: 'user', label: headLabel, body: rawText.length > 600 ? rawText.slice(0, 600) + '…' : rawText });

    // Scout pass for files / large pastes — gives every chunk shared context.
    let overview = null;
    const shouldScout = !!filename || rawText.length >= SCOUT_THRESHOLD_BYTES;
    if (shouldScout) {
      overview = await runScout(rawText, filename);
      // If scout failed, continue without overview (degrade gracefully).
    }

    if (shouldChunk(rawText)) {
      const chunks = splitLogText(rawText);
      pushSystem(`🗂️ ${filename ? `"${filename}"` : 'Log'} is ${(rawText.length/1024).toFixed(1)} KB — splitting into ${chunks.length} chunks and processing sequentially${overview ? ' (each chunk will reuse the scout overview)' : ''}.`);
      for (const c of chunks) {
        pushSystem(`📄 ${chunkBanner(c)}`);
        const ok = await submitOne(c.text, { prefix: `chunk ${c.index + 1}/${c.total}`, source, overview });
        if (!ok) { pushSystem('⏸️ Stopping further chunks due to the previous error.'); break; }
      }
    } else {
      await submitOne(rawText, { source, overview });
    }
  } finally {
    busy = false; els.submitLog.disabled = false; els.askBtn.disabled = false; els.uploadBtn.disabled = false;
  }
}

// ------------------------------ Ask agent ------------------------------
async function askAgent(question) {
  if (!question || !question.trim()) return;
  if (!state.settings.apiKey) { pushError('No API key set. Open ⚙ Settings and pick a provider + paste your key.'); return; }
  if (busy) { pushSystem('Busy — please wait.'); return; }
  busy = true; els.submitLog.disabled = true; els.askBtn.disabled = true; els.uploadBtn.disabled = true;
  pushMsg({ role: 'user', label: 'ask', body: question });
  const bubble = makeAssistantBubble('agent', 'chat');
  bubble.setStage('🤔 Thinking…');
  bubble.startTicking();
  try {
    let liveText = '';
    const res = await chatWithAgent({
      state,
      userMessage: question,
      onProgress: (p) => {
        if (typeof p === 'string') {
          if (p === 'submitting') bubble.setStage('📤 Sending question…');
          else if (p === 'awaiting') bubble.setStage('🌐 Awaiting agent reply…');
          else if (p === 'done') bubble.setStage('✅ Done');
          else bubble.setStage(p);
        } else if (p && p.stage === 'streaming' && p.delta) {
          liveText += p.delta;
          bubble.div.querySelector('.summary').textContent = liveText;
          els.chat.scrollTop = els.chat.scrollHeight;
        }
      },
    });
    bubble.stopTicking();
    if (!res.ok) {
      bubble.setError(res.error || 'Unknown error');
      appendMessage(state, { role: 'error', label: 'agent error', text: res.error || '' });
      persist(state);
      return;
    }
    const finalText = res.reply || liveText || '(no reply)';
    bubble.div.querySelector('.summary').textContent = finalText;
    bubble.setStage('✅ Done');
    appendMessage(state, { role: 'chat', label: 'agent', text: finalText });
    persist(state);
  } catch (e) {
    bubble.setError(e.message || String(e));
  } finally {
    busy = false; els.submitLog.disabled = false; els.askBtn.disabled = false; els.uploadBtn.disabled = false;
  }
}

// ------------------------------ File upload ------------------------------
async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!state.settings.apiKey) { pushError('No API key set. Open ⚙ Settings and pick a provider + paste your key.'); return; }
  for (const file of files) {
    try {
      const text = await file.text();
      pushSystem(`📁 Reading "${file.name}" (${(file.size/1024).toFixed(1)} KB)…`);
      await submitLogText(text, { source: 'upload', filename: file.name });
    } catch (e) {
      pushError(`Failed to read "${file.name}": ${e.message}`);
    }
  }
  els.logFile.value = '';
}

// ------------------------------ Modals ------------------------------
const openModal  = (m) => m.classList.add('open');
const closeModal = (m) => m.classList.remove('open');

const PROVIDER_MODELS = {
  anthropic: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-opus-4-7'],
  openai:    ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'o3-mini', 'llama-3.3-70b-versatile', 'mixtral-8x7b-32768', 'deepseek-chat', 'deepseek-reasoner', 'mistral-large-latest', 'qwen2.5-72b-instruct'],
  gemini:    ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-1.5-pro', 'gemini-1.5-flash'],
};
const PROVIDER_DEFAULT_MODEL = {
  anthropic: 'claude-sonnet-4-6',
  openai:    'gpt-4o-mini',
  gemini:    'gemini-2.0-flash',
};

function populateModelSelect(provider, currentModel) {
  els.modelSelect.innerHTML = '';
  const opts = PROVIDER_MODELS[provider] || [];
  for (const m of opts) {
    const o = document.createElement('option');
    o.value = m; o.textContent = m;
    els.modelSelect.appendChild(o);
  }
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = '— Custom (type below) —';
  els.modelSelect.appendChild(customOpt);

  if (currentModel && opts.includes(currentModel)) {
    els.modelSelect.value = currentModel;
    els.modelCustom.style.display = 'none';
    els.modelCustom.value = '';
  } else if (currentModel) {
    els.modelSelect.value = '__custom__';
    els.modelCustom.style.display = '';
    els.modelCustom.value = currentModel;
  } else {
    els.modelSelect.value = opts[0] || '__custom__';
    els.modelCustom.style.display = 'none';
    els.modelCustom.value = '';
  }
}

function getSelectedModel() {
  if (els.modelSelect.value === '__custom__') return els.modelCustom.value.trim();
  return els.modelSelect.value;
}

function syncSettingsModalForProvider() {
  const p = els.providerSelect.value;
  els.baseUrlRow.style.display = (p === 'openai') ? '' : 'none';
  // When provider changes, default the model picker to that provider's default
  // unless the user has typed something custom.
  const cur = (p === state.settings.provider) ? state.settings.model : PROVIDER_DEFAULT_MODEL[p];
  populateModelSelect(p, cur);
}
function openSettings() {
  els.providerSelect.value = state.settings.provider || 'anthropic';
  els.apiKey.value = state.settings.apiKey || '';
  els.baseUrl.value = state.settings.baseUrl || '';
  els.baseUrlRow.style.display = (els.providerSelect.value === 'openai') ? '' : 'none';
  populateModelSelect(els.providerSelect.value, state.settings.model);
  els.cavemanToggle.checked = !!state.settings.caveman;
  openModal(els.settingsModal);
}
function saveSettings() {
  const provider = els.providerSelect.value;
  state.settings.provider = provider;
  state.settings.apiKey   = els.apiKey.value.trim();
  state.settings.baseUrl  = els.baseUrl.value.trim();
  state.settings.model    = getSelectedModel() || PROVIDER_DEFAULT_MODEL[provider] || 'claude-sonnet-4-6';
  state.settings.caveman  = !!els.cavemanToggle.checked;
  persist(state);
  closeModal(els.settingsModal);
  pushSystem(`Settings saved — provider: ${state.settings.provider}, model: ${state.settings.model}${state.settings.caveman ? ', caveman mode ON' : ''}.`);
}

function openMerge() {
  const list = listSessions(state).filter(s => s.id !== state.activeId);
  els.mergeSelect.innerHTML = '';
  if (!list.length) {
    const opt = document.createElement('option');
    opt.textContent = '(no other sessions)'; opt.disabled = true;
    els.mergeSelect.appendChild(opt);
  } else {
    for (const s of list) {
      const opt = document.createElement('option');
      opt.value = s.id; opt.textContent = s.name; els.mergeSelect.appendChild(opt);
    }
  }
  openModal(els.mergeModal);
}
function doMerge(ids) {
  const sess = activeSession(state);
  let merged = sess.model;
  for (const id of ids) { if (state.sessions[id]) merged = mergeModel(merged, state.sessions[id].model); }
  setActiveModel(state, merged);
  persist(state);
  closeModal(els.mergeModal);
  pushSystem(`Merged ${ids.length} session${ids.length === 1 ? '' : 's'} into "${sess.name}".`);
  rerender();
}
function openRename() { els.renameInput.value = activeSession(state).name; openModal(els.renameModal); }
function confirmRename() {
  const n = els.renameInput.value.trim();
  if (n) { activeSession(state).name = n; persist(state); refreshSessionSelect(); }
  closeModal(els.renameModal);
}

// ------------------------------ Wiring ------------------------------
function init() {
  window.mermaid.initialize({
    startOnLoad: false, theme: 'dark', securityLevel: 'loose',
    flowchart: { htmlLabels: true, curve: 'basis' },
  });
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

  els.sessionSelect.addEventListener('change', e => switchSession(e.target.value));
  els.newSession.addEventListener('click', () => {
    const id = createSession(state, `Session ${listSessions(state).length + 1}`);
    persist(state); switchSession(id);
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
    if (!confirm('Clear logs, model, and chat history in this session?')) return;
    clearActiveSession(state); persist(state);
    state.drillPath = []; els.chat.innerHTML = '';
    pushSystem('Session cleared.'); promptForFirstLog(); rerender();
  });

  els.fitBtn.addEventListener('click', () => { state.zoom = 1; setZoom(1); });
  els.zoomIn.addEventListener('click', () => { state.zoom = Math.min(3, (state.zoom || 1) + 0.15); setZoom(state.zoom); });
  els.zoomOut.addEventListener('click', () => { state.zoom = Math.max(0.4, (state.zoom || 1) - 0.15); setZoom(state.zoom); });
  els.canvasWrap.addEventListener('mouseleave', hideTooltip);

  els.mergeBtn.addEventListener('click', openMerge);
  els.submitLog.addEventListener('click', () => { const t = els.logInput.value.trim(); if (t) { submitLogText(t); els.logInput.value = ''; } });
  els.askBtn.addEventListener('click',     () => { const t = els.logInput.value.trim(); if (t) { askAgent(t);       els.logInput.value = ''; } });
  els.exampleBtn.addEventListener('click', () => { els.logInput.value = EXAMPLE_LOG; els.logInput.focus(); });
  els.uploadBtn.addEventListener('click',  () => els.logFile.click());
  els.logFile.addEventListener('change',   (e) => handleFiles(e.target.files));

  els.logInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) els.askBtn.click(); else els.submitLog.click();
    }
  });

  els.settingsCancel.addEventListener('click', () => closeModal(els.settingsModal));
  els.settingsSave.addEventListener('click', saveSettings);
  els.providerSelect.addEventListener('change', syncSettingsModalForProvider);
  els.modelSelect.addEventListener('change', () => {
    els.modelCustom.style.display = els.modelSelect.value === '__custom__' ? '' : 'none';
    if (els.modelSelect.value === '__custom__') els.modelCustom.focus();
  });
  els.mergeCancel.addEventListener('click', () => closeModal(els.mergeModal));
  els.mergeConfirm.addEventListener('click', () => {
    const id = els.mergeSelect.value;
    if (id && state.sessions[id]) doMerge([id]);
  });
  els.mergeAll.addEventListener('click', () => {
    const ids = listSessions(state).map(s => s.id).filter(id => id !== state.activeId);
    if (ids.length) doMerge(ids); else closeModal(els.mergeModal);
  });
  els.renameCancel.addEventListener('click', () => closeModal(els.renameModal));
  els.renameConfirm.addEventListener('click', confirmRename);

  for (const m of [els.settingsModal, els.mergeModal, els.renameModal]) {
    m.addEventListener('click', (e) => { if (e.target === m) closeModal(m); });
  }

  refreshSessionSelect();
  rerenderChat();
  if (activeSession(state).logs.length === 0 && getActiveMessages(state).length === 0) {
    promptForFirstLog();
  }
  rerender();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
