/**
 * chunker.js — split very large logs into ordered chunks for sequential
 * submission to the reverse-engineer engine.
 *
 * Worked example:
 *   splitLogText("a\n\nb\n\nc", { maxChars: 3 })
 *   -> [
 *        { index: 0, total: 3, text: "a", charStart: 0, charEnd: 1, lineCount: 1 },
 *        { index: 1, total: 3, text: "b", charStart: 3, charEnd: 4, lineCount: 1 },
 *        { index: 2, total: 3, text: "c", charStart: 6, charEnd: 7, lineCount: 1 },
 *      ]
 */

/** Heuristic chunk-size threshold (in characters). */
export const DEFAULT_MAX_CHARS = 30000;

/** Quick "should we chunk this?" check. */
export function shouldChunk(text, maxChars = DEFAULT_MAX_CHARS) {
  return typeof text === 'string' && text.length > maxChars;
}

/** Split a long log string into ordered chunks. */
export function splitLogText(text, opts = {}) {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const norm = String(text ?? '').replace(/\r\n?/g, '\n');
  if (norm.length === 0) return [];
  if (norm.length <= maxChars) return [makeChunk(norm, 0, 0, norm.length)];

  // Build segment offsets by splitting on blank-line boundaries while
  // preserving absolute character positions in the normalized input.
  const ranges = []; // { start, end } half-open over `norm`
  const blankRe = /\n{2,}/g;
  let cursor = 0;
  let m;
  while ((m = blankRe.exec(norm)) !== null) {
    ranges.push({ start: cursor, end: m.index });
    cursor = m.index + m[0].length;
  }
  ranges.push({ start: cursor, end: norm.length });

  // Expand any oversize segment by single-newline splits, then hard-cut.
  const atoms = [];
  for (const r of ranges) {
    if (r.end - r.start <= maxChars) { atoms.push(r); continue; }
    let sub = r.start;
    while (sub < r.end) {
      const nl = norm.indexOf('\n', sub);
      const lineEnd = nl === -1 || nl >= r.end ? r.end : nl;
      if (lineEnd - sub <= maxChars) {
        atoms.push({ start: sub, end: lineEnd });
        sub = lineEnd + (nl === -1 || nl >= r.end ? 0 : 1);
      } else {
        for (let p = sub; p < lineEnd; p += maxChars) {
          atoms.push({ start: p, end: Math.min(p + maxChars, lineEnd) });
        }
        sub = lineEnd + (nl === -1 || nl >= r.end ? 0 : 1);
      }
    }
  }

  // Greedily pack atoms into chunks <= maxChars (joined by \n\n where adjacent).
  const out = [];
  let curStart = -1, curEnd = -1;
  for (const a of atoms) {
    if (curStart === -1) { curStart = a.start; curEnd = a.end; continue; }
    const joined = a.end - curStart; // covers original separators
    if (joined <= maxChars) { curEnd = a.end; }
    else { out.push({ start: curStart, end: curEnd }); curStart = a.start; curEnd = a.end; }
  }
  if (curStart !== -1) out.push({ start: curStart, end: curEnd });

  const total = out.length;
  return out.map((r, i) => makeChunk(norm.slice(r.start, r.end), i, r.start, r.end, total));
}

function makeChunk(text, index, charStart, charEnd, total = 1) {
  const lineCount = text.length === 0 ? 0 : text.split('\n').length;
  return { index, total, text, charStart, charEnd, lineCount };
}

/** Short human-readable banner for chunk N of M. */
export function chunkBanner(chunk) {
  const kb = (chunk.text.length / 1024).toFixed(1) + ' KB';
  return `Chunk ${chunk.index + 1} of ${chunk.total} — ${chunk.lineCount} lines, ~${kb}`;
}
