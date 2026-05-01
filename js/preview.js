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
  };
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
