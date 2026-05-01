// AIARE preview module — pure heuristic inspection of a piece of text or a file.
// Produces a small structured summary that the LLM can scout in one cheap call
// before we start the (expensive) full reverse-engineering pass.
//
// No DOM, no globals, no imports.

const HEAD_CHARS = 2000;
const TAIL_CHARS = 1000;
const MAX_SAMPLE_LINES = 12;

/**
 * Inspect a text payload (typically the contents of an uploaded log file or a
 * pasted block) and return a structural preview.
 *
 * Shape:
 * {
 *   name:        string,
 *   sizeBytes:   number,
 *   sizeKB:      number,
 *   lineCount:   number,
 *   type:        'json'|'jsonl'|'yaml'|'log-structured'|'log-text'|'unknown',
 *   head:        string,         // first ~2000 chars
 *   tail:        string,         // last ~1000 chars (only when text is bigger than head+tail)
 *   sampleLines: string[],       // up to ~12 representative lines (head, mid, tail mix)
 *   jsonTopKeys: string[]|null,  // present when type is 'json' and we could parse it
 *   distinctServices: string[],  // crude regex: tokens like svc=foo, service: foo, [foo-svc]
 *   distinctLevels:   string[],  // INFO, ERROR, WARN, DEBUG, etc.
 * }
 */
export function previewText(text, name = 'pasted-input') {
  const safeText = typeof text === 'string' ? text : '';
  const sizeBytes = safeText.length;
  const sizeKB = +(sizeBytes / 1024).toFixed(1);
  const lines = safeText.split(/\r?\n/);
  const lineCount = lines.length;

  const head = safeText.slice(0, HEAD_CHARS);
  const tail = sizeBytes > HEAD_CHARS + TAIL_CHARS ? safeText.slice(-TAIL_CHARS) : '';

  const type = detectType(safeText, name);

  let jsonTopKeys = null;
  if (type === 'json') {
    try {
      const parsed = JSON.parse(safeText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        jsonTopKeys = Object.keys(parsed).slice(0, 60);
      } else if (Array.isArray(parsed) && parsed.length && typeof parsed[0] === 'object') {
        jsonTopKeys = Object.keys(parsed[0]).slice(0, 60);
      }
    } catch (_) { /* malformed JSON, leave null */ }
  }

  return {
    name,
    sizeBytes,
    sizeKB,
    lineCount,
    type,
    head,
    tail,
    sampleLines: sampleLines(lines),
    jsonTopKeys,
    distinctServices: distinctServices(safeText),
    distinctLevels:   distinctLevels(safeText),
    structural: structuralDigest(safeText, type),
  };
}

/**
 * Compact structural digest of a JSON / JSONL input — collections, item counts,
 * sampled items per collection. Returns null if input isn't JSON-shaped.
 *
 * For each top-level array we record { kind: 'array', count, itemKeys, samples }
 * where samples is up to 3 representative items with string fields truncated.
 * Cap on overall digest size: ~16 KB JSON-stringified.
 */
export function structuralDigest(text, type) {
  if (type !== 'json' && type !== 'jsonl') return null;
  let parsed;
  try {
    if (type === 'jsonl') {
      // First few lines as separate objects; this gives schema without exploding size.
      const lines = (text || '').split(/\r?\n/).filter(l => l.trim()).slice(0, 200);
      const items = [];
      for (const l of lines) {
        try { items.push(JSON.parse(l)); } catch (_) {}
        if (items.length >= 200) break;
      }
      parsed = items;
    } else {
      parsed = JSON.parse(text);
    }
  } catch (_) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;

  if (Array.isArray(parsed)) {
    return {
      shape: 'array',
      count: parsed.length,
      itemKeys: extractItemKeys(parsed),
      samples: sampleObjects(parsed, 3),
    };
  }

  const collections = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (Array.isArray(v)) {
      collections[k] = {
        shape: 'array',
        count: v.length,
        itemKeys: extractItemKeys(v),
        samples: sampleObjects(v, 3),
      };
    } else if (v && typeof v === 'object') {
      collections[k] = {
        shape: 'object',
        keys: Object.keys(v).slice(0, 50),
        sample: truncateValue(v),
      };
    } else {
      collections[k] = { shape: 'scalar', value: truncateValue(v) };
    }
  }
  return { shape: 'object', collections };
}

function extractItemKeys(arr) {
  if (!arr.length) return [];
  // Sample a few items and union their keys (for arrays of heterogeneous shape).
  const keys = new Set();
  const probes = [arr[0], arr[Math.floor(arr.length / 2)], arr[arr.length - 1]];
  for (const it of probes) {
    if (it && typeof it === 'object' && !Array.isArray(it)) {
      for (const k of Object.keys(it)) {
        if (keys.size >= 60) break;
        keys.add(k);
      }
    }
  }
  return Array.from(keys);
}

function sampleObjects(arr, n) {
  if (!arr.length) return [];
  if (arr.length <= n) return arr.map(truncateValue);
  // First, middle(s), last
  const idxs = [];
  if (n === 1) idxs.push(0);
  else if (n === 2) idxs.push(0, arr.length - 1);
  else {
    idxs.push(0);
    for (let i = 1; i < n - 1; i++) idxs.push(Math.floor((arr.length * i) / (n - 1)));
    idxs.push(arr.length - 1);
  }
  return idxs.map(i => truncateValue(arr[i]));
}

function truncateValue(v, depth = 0) {
  if (v == null) return v;
  if (typeof v === 'string') return v.length > 160 ? v.slice(0, 160) + '…' : v;
  if (typeof v !== 'object') return v;
  if (depth > 2) return Array.isArray(v) ? `[${v.length} items]` : '{…}';
  if (Array.isArray(v)) {
    if (v.length === 0) return [];
    if (v.length > 4) return [...v.slice(0, 3).map(x => truncateValue(x, depth + 1)), `+${v.length - 3} more`];
    return v.map(x => truncateValue(x, depth + 1));
  }
  const out = {};
  let kept = 0;
  for (const [k, val] of Object.entries(v)) {
    if (kept >= 30) { out['…'] = '+more keys'; break; }
    out[k] = truncateValue(val, depth + 1);
    kept++;
  }
  return out;
}

/** Format a preview as a compact, human/LLM-readable string. */
export function summarizePreview(p) {
  if (!p) return '';
  const parts = [];
  parts.push(`File: ${p.name} (${p.sizeKB} KB, ${p.lineCount} lines, type=${p.type})`);
  if (p.jsonTopKeys && p.jsonTopKeys.length) {
    parts.push('JSON top-level keys: ' + p.jsonTopKeys.slice(0, 30).join(', '));
  }
  if (p.distinctServices.length) {
    parts.push('Distinct service tokens (sampled): ' + p.distinctServices.slice(0, 20).join(', '));
  }
  if (p.distinctLevels.length) {
    parts.push('Log levels seen: ' + p.distinctLevels.join(', '));
  }
  if (p.sampleLines.length) {
    parts.push('Sample lines:\n' + p.sampleLines.map(l => '  ' + l.slice(0, 240)).join('\n'));
  }
  parts.push('Head (first ~2KB):\n' + p.head);
  if (p.tail) parts.push('Tail (last ~1KB):\n' + p.tail);
  return parts.join('\n\n');
}

function detectType(text, name) {
  const lower = (name || '').toLowerCase();
  const trimmed = text.trim();
  if (lower.endsWith('.json') || /^[\[{]/.test(trimmed)) {
    // Could be JSON or JSONL
    if (/^\s*\{[^\n]*\}\s*$/m.test(text) && text.split('\n').filter(l => l.trim().startsWith('{')).length > 1) {
      return 'jsonl';
    }
    try { JSON.parse(trimmed); return 'json'; } catch (_) {}
    return 'json'; // probably truncated but it's JSON-shaped
  }
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  // Structured logs: lots of `key=value` pairs
  const kvLines = (text.match(/\b\w+=[^\s]+/g) || []).length;
  if (kvLines > 20) return 'log-structured';
  return 'log-text';
}

function sampleLines(lines) {
  if (!lines || !lines.length) return [];
  const filtered = lines.filter(l => l && l.trim());
  if (filtered.length <= MAX_SAMPLE_LINES) return filtered;
  const out = [];
  const headN = 4, tailN = 3;
  for (let i = 0; i < headN && i < filtered.length; i++) out.push(filtered[i]);
  // Pick MAX_SAMPLE_LINES - headN - tailN evenly from the middle.
  const middleN = MAX_SAMPLE_LINES - headN - tailN;
  const startMid = headN, endMid = filtered.length - tailN;
  for (let k = 0; k < middleN; k++) {
    const i = Math.floor(startMid + ((endMid - startMid) * k) / middleN);
    if (i >= 0 && i < filtered.length) out.push(filtered[i]);
  }
  for (let i = filtered.length - tailN; i < filtered.length; i++) out.push(filtered[i]);
  return out;
}

function distinctServices(text) {
  const set = new Set();
  // svc=foo, service: foo, app=foo, service-name=foo
  const re = /\b(?:svc|service|app|app_name|service_name|service-name|component)[=:]\s*"?([A-Za-z][\w.-]{1,40})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (set.size >= 30) break;
    set.add(m[1]);
  }
  // Bracketed prefixes like [order-svc]
  const re2 = /\[([a-z][\w.-]{2,40}(?:-svc|-service|-api|-worker))\]/g;
  while ((m = re2.exec(text)) !== null) {
    if (set.size >= 30) break;
    set.add(m[1]);
  }
  return Array.from(set);
}

function distinctLevels(text) {
  const set = new Set();
  const re = /\b(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|CRITICAL)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) set.add(m[1].toUpperCase());
  return Array.from(set);
}
