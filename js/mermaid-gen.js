// AIARE Mermaid source builder.
// Pure string builder: takes an ArchModel, returns `flowchart TD` source.

export const KIND_STYLES = {
  SERVICE:    { class: 'service',    fill: '#1976D2', stroke: '#0D47A1' },
  MIDDLEWARE: { class: 'middleware', fill: '#7B1FA2', stroke: '#4A148C' },
  QUEUE:      { class: 'queue',      fill: '#F57C00', stroke: '#E65100' },
  DB:         { class: 'db',         fill: '#388E3C', stroke: '#1B5E20' },
  CACHE:      { class: 'cache',      fill: '#0097A7', stroke: '#006064' },
  UI_TAB:     { class: 'ui',         fill: '#C2185B', stroke: '#880E4F' },
  EXTERNAL:   { class: 'external',   fill: '#455A64', stroke: '#263238' },
  UNKNOWN:    { class: 'unknown',    fill: '#37474F', stroke: '#90A4AE' },
};

const KIND_ORDER = ['UI_TAB', 'MIDDLEWARE', 'SERVICE', 'QUEUE', 'DB', 'CACHE', 'EXTERNAL', 'UNKNOWN'];

const HEADER = [
  'flowchart TD',
  'classDef service     fill:#1976D2,stroke:#0D47A1,color:#fff,stroke-width:2px',
  'classDef middleware  fill:#7B1FA2,stroke:#4A148C,color:#fff,stroke-width:2px',
  'classDef queue       fill:#F57C00,stroke:#E65100,color:#fff,stroke-width:2px',
  'classDef db          fill:#388E3C,stroke:#1B5E20,color:#fff,stroke-width:2px',
  'classDef cache       fill:#0097A7,stroke:#006064,color:#fff,stroke-width:2px',
  'classDef ui          fill:#C2185B,stroke:#880E4F,color:#fff,stroke-width:2px',
  'classDef external    fill:#455A64,stroke:#263238,color:#fff,stroke-width:2px',
  'classDef unknown     fill:#37474F,stroke:#90A4AE,color:#fff,stroke-width:2px',
  'classDef ghost       fill:#1c2230,stroke:#6b7280,color:#8a93a6,stroke-width:1px,stroke-dasharray:5 4',
  'classDef resource    fill:#22304a,stroke:#3e5680,color:#cbd5e1,stroke-width:1px',
].join('\n');

export function sanitizeLabel(s) {
  if (!s) return '';
  const orig = String(s);
  const cleaned = orig.replace(/[;`"]/g, '').replace(/\r?\n/g, '<br/>').replace(/\s+/g, ' ').trim();
  const cut = cleaned.slice(0, 80);
  return cut + (orig.length > 80 ? '…' : '');
}

export function sanitizeId(id) {
  return ('n_' + String(id || '').toLowerCase().replace(/[^a-z0-9_]/g, '_')).slice(0, 60);
}

function kindOf(node) {
  const k = node && node.kind;
  return KIND_STYLES[k] ? k : 'UNKNOWN';
}

function classFor(kind) {
  return KIND_STYLES[kind].class;
}

function nodeLine(node) {
  const kind = kindOf(node);
  const safeId = sanitizeId(node.id);
  const safeLabel = sanitizeLabel(node.label || node.id || '');
  const cls = classFor(kind);
  // Apply only the kind class with `:::`. Ghost styling is applied via a
  // separate `class <id> ghost` directive at the bottom of the diagram —
  // Mermaid 10 doesn't accept chained `:::a:::b` syntax.
  return `${safeId}["${safeLabel}<br/><i>${kind.toLowerCase()}</i>"]:::${cls}`;
}

function ghostClassLines(nodes) {
  const ids = (nodes || []).filter(n => n && n.ghost).map(n => sanitizeId(n.id));
  if (!ids.length) return [];
  // De-dupe and chunk to keep lines reasonable.
  const uniq = Array.from(new Set(ids));
  return [`class ${uniq.join(',')} ghost`];
}

function clickLine(node) {
  const safeId = sanitizeId(node.id);
  const kind = kindOf(node);
  const tip = sanitizeLabel(`${node.label || node.id || ''} — ${kind}`);
  return `click ${safeId} aiareClick "${tip}"`;
}

function findByPath(model, drillPath) {
  if (!model || !Array.isArray(model.nodes) || !drillPath.length) return null;
  let list = model.nodes;
  let found = null;
  for (const id of drillPath) {
    found = (list || []).find(n => n && n.id === id);
    if (!found) return null;
    list = found.children || [];
  }
  return found;
}

function buildTopLevel(model) {
  const lines = [];
  const nodes = Array.isArray(model.nodes) ? model.nodes.slice() : [];
  const edges = Array.isArray(model.edges) ? model.edges.slice() : [];

  const byKind = {};
  for (const n of nodes) {
    const k = kindOf(n);
    (byKind[k] = byKind[k] || []).push(n);
  }

  for (const k of KIND_ORDER) {
    const group = byKind[k];
    if (!group || !group.length) continue;
    group.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    lines.push(`subgraph k_${k}["${k}"]`);
    for (const n of group) lines.push('  ' + nodeLine(n));
    lines.push('end');
  }

  // Edges
  const sortedEdges = edges.slice().sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
  const nodeMap = {};
  for (const n of nodes) nodeMap[n.id] = n;
  for (const e of sortedEdges) {
    if (!e || !e.from || !e.to) continue;
    const fromGhost = (nodeMap[e.from] && nodeMap[e.from].ghost) || e.ghost;
    const toGhost = (nodeMap[e.to] && nodeMap[e.to].ghost) || e.ghost;
    const arrow = (fromGhost || toGhost || e.ghost) ? '-.->' : '-->';
    const proto = sanitizeLabel(e.protocol || '');
    // Wrap edge label in quotes so it tolerates parens, slashes, etc.
    const lbl = proto ? `|"${proto}"|` : '';
    lines.push(`${sanitizeId(e.from)} ${arrow}${lbl} ${sanitizeId(e.to)}`);
  }

  // Apply ghost class to ghost nodes (separate directive — see nodeLine).
  for (const l of ghostClassLines(nodes)) lines.push(l);

  // Click directives (sorted by id for stability)
  const clickNodes = nodes.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const n of clickNodes) lines.push(clickLine(n));

  return lines.join('\n');
}

function buildDrill(model, target) {
  const lines = [];
  const kind = kindOf(target);
  const safeLabel = sanitizeLabel(target.label || target.id || '');
  lines.push(`subgraph drill["Drill: ${safeLabel} (${kind})"]`);
  lines.push('  ' + nodeLine(target));

  const children = Array.isArray(target.children) ? target.children.slice() : [];
  children.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const c of children) lines.push('  ' + nodeLine(c));

  const resources = Array.isArray(target.resources) ? target.resources.slice() : [];
  const resIds = [];
  resources.forEach((r, i) => {
    const rid = `res_${i}`;
    const rLabel = sanitizeLabel(`${r.kind || 'resource'}: ${r.name || ''}`);
    lines.push(`  ${rid}["${rLabel}"]:::resource`);
    resIds.push(rid);
  });
  lines.push('end');

  const targetId = sanitizeId(target.id);
  for (const c of children) lines.push(`${targetId} --> ${sanitizeId(c.id)}`);
  for (const rid of resIds) lines.push(`${targetId} --> ${rid}`);

  // Apply ghost class to ghost nodes (target + children).
  for (const l of ghostClassLines([target, ...children])) lines.push(l);

  // Click for target + children, not resources
  lines.push(clickLine(target));
  for (const c of children) lines.push(clickLine(c));

  return lines.join('\n');
}

export function buildMermaid(model, drillPath = []) {
  const safeModel = model && typeof model === 'object' ? model : { nodes: [], edges: [] };
  let body;
  if (Array.isArray(drillPath) && drillPath.length) {
    const target = findByPath(safeModel, drillPath);
    body = target ? buildDrill(safeModel, target) : buildTopLevel(safeModel);
  } else {
    body = buildTopLevel(safeModel);
  }
  return HEADER + '\n' + body + '\n';
}
