// AIARE renderer.js — Mermaid render + tooltip + zoom + downloads.
import { sanitizeId } from './mermaid-gen.js';

let _currentSvg = null;
let _zoom = 1;

const tipEl = () => document.getElementById('tooltip');

function ensureTooltipChildren(el) {
  if (!el.querySelector('.t-title')) {
    const t = document.createElement('div'); t.className = 't-title'; el.appendChild(t);
  }
  if (!el.querySelector('.t-meta')) {
    const m = document.createElement('div'); m.className = 't-meta'; el.appendChild(m);
  }
  if (!el.querySelector('.t-body')) {
    const b = document.createElement('div'); b.className = 't-body'; el.appendChild(b);
  }
}

function recoverSafeId(domId) {
  // Mermaid sets id="flowchart-<safeId>-<n>"
  if (!domId) return null;
  let s = domId;
  if (s.startsWith('flowchart-')) s = s.slice('flowchart-'.length);
  s = s.replace(/-\d+$/, '');
  return s;
}

function findModelNode(model, safeId) {
  if (!model || !Array.isArray(model.nodes)) return null;
  return model.nodes.find(n => sanitizeId(n.id) === safeId) || null;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
}

function serializeSvg(svg) {
  const cloned = svg.cloneNode(true);
  cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!cloned.getAttribute('xmlns:xlink')) cloned.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  const xml = new XMLSerializer().serializeToString(cloned);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + xml;
}

/** Renders Mermaid source into the container; wires hover/click. */
export async function renderDiagram({ mermaidCode, container, model, callbacks }) {
  const wrap = document.querySelector('.canvas-wrap');
  const emptyMsg = document.getElementById('empty-msg');
  const legend = document.getElementById('legend');

  const hasNodes = typeof mermaidCode === 'string' && /:::/.test(mermaidCode);
  if (!mermaidCode || !hasNodes) {
    container.innerHTML = '';
    if (wrap) wrap.classList.add('empty');
    if (emptyMsg) emptyMsg.style.display = '';
    if (legend) legend.style.display = 'none';
    _currentSvg = null;
    return null;
  }
  if (wrap) wrap.classList.remove('empty');
  if (emptyMsg) emptyMsg.style.display = 'none';
  if (legend) legend.style.display = '';

  let svg, bindFunctions;
  try {
    const out = await window.mermaid.render('aiare-svg-' + Date.now(), mermaidCode);
    svg = out.svg; bindFunctions = out.bindFunctions;
  } catch (err) {
    container.innerHTML = '';
    const errBox = document.createElement('div');
    errBox.style.cssText = 'padding:12px;color:#f88;background:#2a1414;border:1px solid #5a2a2a;border-radius:6px;font-family:monospace;white-space:pre-wrap;';
    errBox.textContent = 'Mermaid render error:\n' + (err && err.message ? err.message : String(err));
    container.appendChild(errBox);
    _currentSvg = null;
    return null;
  }

  container.innerHTML = svg;
  _currentSvg = container.querySelector('svg');
  if (_currentSvg && _zoom !== 1) {
    _currentSvg.style.transform = `scale(${_zoom})`;
    _currentSvg.style.transformOrigin = 'top left';
  }
  try { bindFunctions?.(container); } catch (_) { /* noop */ }

  let nodes = container.querySelectorAll('g.node');
  if (!nodes || nodes.length === 0) {
    nodes = container.querySelectorAll('g[id^="flowchart-"]');
  }
  nodes.forEach(g => {
    const safeId = recoverSafeId(g.id);
    const modelNode = findModelNode(model, safeId);
    if (!modelNode) return;
    g.classList.add('clickable');
    g.style.cursor = 'pointer';
    g.addEventListener('mouseenter', (e) => {
      callbacks?.onNodeHover?.(modelNode, e.clientX, e.clientY);
    });
    g.addEventListener('mousemove', (e) => {
      callbacks?.onNodeHover?.(modelNode, e.clientX, e.clientY);
    });
    g.addEventListener('mouseleave', () => { hideTooltip(); });
    g.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      callbacks?.onNodeClick?.(modelNode);
    });
  });

  return { svgEl: _currentSvg };
}

/** Shows the floating tooltip populated for a node. */
export function showTooltip({ node, x, y }) {
  const el = tipEl(); if (!el || !node) return;
  ensureTooltipChildren(el);
  el.querySelector('.t-title').textContent = node.label || node.id;
  const ghostTxt = node.ghost ? '\u{1F47B} ghost — ' : '';
  const conf = (typeof node.confidence === 'number') ? Math.round(node.confidence * 100) + '%' : '—';
  const logs = (node.sourceLogIds || []).length;
  el.querySelector('.t-meta').textContent =
    `${ghostTxt}${node.kind || 'UNKNOWN'} · confidence ${conf} · ${logs} log ref${logs === 1 ? '' : 's'}`;
  el.querySelector('.t-body').textContent = node.summary || '';
  el.style.display = 'block';
  const margin = 12;
  const rect = el.getBoundingClientRect();
  let nx = x + 14, ny = y + 14;
  if (nx + rect.width > window.innerWidth - margin) nx = x - rect.width - 14;
  if (ny + rect.height > window.innerHeight - margin) ny = y - rect.height - 14;
  if (nx < margin) nx = margin;
  if (ny < margin) ny = margin;
  el.style.left = nx + 'px';
  el.style.top = ny + 'px';
}

/** Hides the floating tooltip. */
export function hideTooltip() {
  const el = tipEl(); if (el) el.style.display = 'none';
}

/** Apply a CSS scale transform to the rendered SVG (clamped 0.4..3). */
export function setZoom(scale) {
  let s = Number(scale);
  if (!isFinite(s)) s = 1;
  if (s < 0.4) s = 0.4;
  if (s > 3) s = 3;
  _zoom = s;
  if (_currentSvg) {
    _currentSvg.style.transform = `scale(${s})`;
    _currentSvg.style.transformOrigin = 'top left';
  }
}

/** Returns the currently rendered <svg> element, or null. */
export function currentSvg() {
  return _currentSvg;
}

/** Downloads the current SVG as a standalone .svg file. */
export function downloadSvg(filename = 'aiare-diagram.svg') {
  if (!_currentSvg) { console.warn('downloadSvg: no SVG rendered'); return; }
  const text = serializeSvg(_currentSvg);
  const blob = new Blob([text], { type: 'image/svg+xml' });
  triggerDownload(blob, filename);
}

/** Renders the current SVG to a PNG at 2x and triggers a download. */
export async function downloadPng(filename = 'aiare-diagram.png') {
  if (!_currentSvg) { console.warn('downloadPng: no SVG rendered'); return; }
  const svg = _currentSvg;
  const text = serializeSvg(svg);
  const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
  const baseW = (svg.width && svg.width.baseVal && svg.width.baseVal.value) || svg.getBoundingClientRect().width || 800;
  const baseH = (svg.height && svg.height.baseVal && svg.height.baseVal.value) || svg.getBoundingClientRect().height || 600;
  const w = Math.max(1, Math.round(baseW * 2));
  const h = Math.max(1, Math.round(baseH * 2));

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#0f1115';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('toBlob returned null')); return; }
          triggerDownload(blob, filename);
          resolve();
        }, 'image/png');
      } catch (err) { reject(err); }
    };
    img.onerror = (e) => reject(new Error('Failed to load SVG into Image: ' + (e && e.message ? e.message : '')));
    img.src = dataUrl;
  });
}

/** Triggers a download of arbitrary text content. */
export function downloadText(text, filename, mime = 'text/plain') {
  const blob = new Blob([text == null ? '' : String(text)], { type: mime });
  triggerDownload(blob, filename || 'download.txt');
}
