// Compute bounded "views" (tabs) over a potentially large architecture model.
// Pure module: no imports, no DOM, no globals.

export const DEFAULT_MAX_NODES_PER_VIEW = 400;

const KIND_ORDER = [
  'UI_TAB',
  'MIDDLEWARE',
  'SERVICE',
  'QUEUE',
  'DB',
  'CACHE',
  'EXTERNAL',
  'UNKNOWN',
];

function normalizeKind(k) {
  if (k === undefined || k === null || k === '') return 'UNKNOWN';
  return String(k);
}

function kindRank(k) {
  const i = KIND_ORDER.indexOf(k);
  return i === -1 ? KIND_ORDER.length : i;
}

function prettyKind(kind) {
  const s = String(kind || 'UNKNOWN').toLowerCase().replace(/_/g, ' ');
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function computeViews(model, opts = {}) {
  const max =
    opts && Number.isFinite(opts.max) && opts.max > 0
      ? Math.floor(opts.max)
      : DEFAULT_MAX_NODES_PER_VIEW;
  const nodes = model && Array.isArray(model.nodes) ? model.nodes : [];
  if (nodes.length === 0) return [];

  if (nodes.length <= max) {
    return [{ id: 'all', name: 'All', nodeIds: nodes.map((n) => n.id) }];
  }

  // Group by kind.
  const byKind = new Map();
  for (const n of nodes) {
    const k = normalizeKind(n && n.kind);
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(n.id);
  }

  // Order kinds: known order first, then any extras alphabetically.
  const presentKinds = Array.from(byKind.keys());
  presentKinds.sort((a, b) => {
    const ra = kindRank(a);
    const rb = kindRank(b);
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const views = [];
  for (const k of presentKinds) {
    const ids = byKind.get(k).slice().sort();
    if (ids.length <= max) {
      views.push({
        id: 'kind-' + k,
        name: k + ' (' + ids.length + ')',
        nodeIds: ids,
        kind: k,
      });
    } else {
      const totalPages = Math.ceil(ids.length / max);
      for (let p = 1; p <= totalPages; p++) {
        const slice = ids.slice((p - 1) * max, p * max);
        views.push({
          id: 'kind-' + k + '-p' + p,
          name: k + ' ' + p + '/' + totalPages + ' (' + slice.length + ')',
          nodeIds: slice,
          kind: k,
          page: p,
          totalPages,
        });
      }
    }
  }
  return views;
}

export function pickActiveViewId(views, previousId) {
  if (!Array.isArray(views) || views.length === 0) return null;
  if (previousId && views.some((v) => v && v.id === previousId)) return previousId;
  return views[0].id;
}

export function subModelForView(view, model) {
  const allNodes = model && Array.isArray(model.nodes) ? model.nodes : [];
  const allEdges = model && Array.isArray(model.edges) ? model.edges : [];
  const version = model ? model.version : undefined;
  if (!view || !Array.isArray(view.nodeIds)) {
    return { nodes: [], edges: [], version };
  }
  const idSet = new Set(view.nodeIds);
  const nodes = allNodes.filter((n) => n && idSet.has(n.id));
  const edges = allEdges.filter(
    (e) => e && idSet.has(e.from) && idSet.has(e.to),
  );
  return { nodes, edges, version };
}

export function viewTabLabel(view) {
  if (!view) return '';
  const count = Array.isArray(view.nodeIds) ? view.nodeIds.length : 0;
  if (view.id === 'all') return 'All (' + count + ')';
  const label = prettyKind(view.kind);
  if (view.page && view.totalPages) {
    return label + ' ' + view.page + '/' + view.totalPages + ' (' + count + ')';
  }
  return label + ' (' + count + ')';
}

export function isRootView(view) {
  return !!(view && view.id === 'all');
}
