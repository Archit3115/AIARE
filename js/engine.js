// AIARE engine module — calls Claude, parses model JSON, and merges into state.

import { activeSession, appendLog, setActiveModel, persist } from './storage.js';

export const EXAMPLE_LOG = `2026-04-29T14:22:01Z svc=checkout-api level=info "POST /api/v1/orders HTTP/1.1" 201 142ms user=u_8821
2026-04-29T14:22:01Z svc=checkout-api level=debug auth_mw decoded jwt sub=u_8821 scopes=[orders:write]
2026-04-29T14:22:01Z svc=checkout-api level=info db.query="INSERT INTO orders(id,user_id,total) VALUES($1,$2,$3)" pg=primary dur=11ms
2026-04-29T14:22:01Z svc=checkout-api level=info cache.set key=user:u_8821:cart ttl=300 backend=redis
2026-04-29T14:22:01Z svc=checkout-api level=info kafka.produce topic=order.events partition=3 key=ord_19f offset=88421
2026-04-29T14:22:02Z svc=notify-worker level=info kafka.consume topic=order.events group=notify offset=88421
2026-04-29T14:22:02Z svc=notify-worker level=info "POST https://hooks.stripe.com/v1/charges" 200 87ms`;

export const SYSTEM_PROMPT = `You are AIARE's reverse-engineering engine. Given:
  1) the current architecture model (JSON), and
  2) one new log line (or a short multi-line log block),
infer the FULL updated architecture and return it as strict JSON.

Allowed node kinds: SERVICE, MIDDLEWARE, QUEUE, DB, CACHE, UI_TAB, EXTERNAL, UNKNOWN.

Rules:
- Always return the COMPLETE updated model — don't return only the diff.
- Preserve previously identified nodes/edges unless the new log contradicts them.
- If a producer or consumer is implied but not directly observed yet, emit it as a node with "ghost": true. Use kind UNKNOWN if you can't even guess the kind.
- When a later log confirms a ghost, set "ghost": false in your output and keep the same id.
- Each node MUST have: id (kebab-case), label (human readable), kind, ghost (boolean), confidence (0-1), summary (one sentence), sourceLogIds (array of log ids that informed it), resources (array; can be empty), children (array of nested nodes; can be empty).
- Each edge MUST have: id, from (node id), to (node id), protocol (e.g. "HTTP POST /orders", "Kafka topic order.events", "SQL"), ghost, sourceLogIds, summary.
- thinking: 2-4 sentences of verbose reasoning (what you saw in the log, what you inferred, what's still unknown).
- summary: 1-2 sentences describing what changed in this iteration (e.g. "Promoted auth-mw to concrete; added new queue order.events with 1 ghost consumer.").

Output ONLY a single JSON object with this exact shape, no prose, no code fences:
{
  "thinking": "...",
  "summary": "...",
  "nodes": [...],
  "edges": [...]
}`;

function extractJsonObject(text) {
  if (!text) throw new Error('Empty response from Claude');
  // Find first '{'
  const start = text.indexOf('{');
  if (start < 0) throw new Error('No JSON object found in response: ' + text.slice(0, 300));
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inStr = false; continue; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try { return JSON.parse(slice); }
        catch (e) {
          const err = new Error('Could not parse JSON from Claude response: ' + slice.slice(0, 300));
          err.raw = slice;
          throw err;
        }
      }
    }
  }
  // Reached end without closing brace -> truncated
  const err = new Error('JSON object in Claude response is unterminated (likely truncated). First 300 chars: ' + text.slice(start, start + 300));
  err.raw = text;
  throw err;
}

/** Internal: read an Anthropic SSE stream from a fetch Response. */
async function readSseStream(res, { onTextDelta, onEvent } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let assistantText = '';
  let stopReason = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!frame.trim()) continue;
      const lines = frame.split('\n');
      let evType = null, dataLine = null;
      for (const line of lines) {
        if (line.startsWith('event:')) evType = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
      }
      if (!dataLine) continue;
      let payload;
      try { payload = JSON.parse(dataLine); } catch { continue; }
      if (payload.type === 'content_block_delta' && payload.delta && payload.delta.type === 'text_delta') {
        assistantText += payload.delta.text;
        try { onTextDelta && onTextDelta(payload.delta.text); } catch (_) {}
      } else if (payload.type === 'message_delta') {
        if (payload.delta && payload.delta.stop_reason) stopReason = payload.delta.stop_reason;
      }
      try { onEvent && onEvent({ type: payload.type || evType, payload }); } catch (_) {}
    }
  }
  return { assistantText, stopReason };
}

/** Call Claude messages API from the browser. Returns parsed JSON object by default, or raw text if asJson=false. */
export async function callClaude({ apiKey, model, system, user, maxTokens = 16384, asJson = true, stream = false, onTextDelta, onEvent }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  };
  if (stream) body.stream = true;
  const res = await window.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let errText = '';
    try { errText = await res.text(); } catch (_) { errText = ''; }
    throw new Error('Claude API ' + res.status + ': ' + (errText || '').slice(0, 300));
  }
  if (stream) {
    const { assistantText, stopReason } = await readSseStream(res, { onTextDelta, onEvent });
    if (stopReason === 'max_tokens') {
      throw new Error('Claude response was truncated (hit max_tokens=' + maxTokens + '). Try a shorter log or increase the limit.');
    }
    if (asJson === false) return assistantText;
    return extractJsonObject(assistantText);
  }
  const data = await res.json();
  const blocks = Array.isArray(data && data.content) ? data.content : [];
  const assistantText = blocks.filter(b => b && b.type === 'text').map(b => b.text || '').join('');
  if (asJson === false) {
    return assistantText;
  }
  if (data && data.stop_reason === 'max_tokens') {
    throw new Error('Claude response was truncated (hit max_tokens=' + maxTokens + '). Try a shorter log or increase the limit.');
  }
  return extractJsonObject(assistantText);
}

/** Defensive merge: keep prev concrete nodes/edges the LLM may have dropped. */
export function defensiveMerge(prevModel, llmModel) {
  const prev = prevModel || { nodes: [], edges: [], version: 0 };
  const llm = llmModel || { nodes: [], edges: [], version: 0 };
  const llmNodeIds = new Set((llm.nodes || []).map(n => String(n.id || '').toLowerCase()));
  const llmEdgeKeys = new Set((llm.edges || []).map(edgeKey));
  const nodes = (llm.nodes || []).slice();
  for (const n of (prev.nodes || [])) {
    if (n && n.ghost === false && !llmNodeIds.has(String(n.id || '').toLowerCase())) {
      nodes.push(n);
    }
  }
  const edges = (llm.edges || []).slice();
  for (const e of (prev.edges || [])) {
    if (e && e.ghost === false && !llmEdgeKeys.has(edgeKey(e))) {
      edges.push(e);
    }
  }
  return {
    nodes,
    edges,
    version: Math.max(prev.version || 0, llm.version || 0),
  };
}

function edgeKey(e) {
  return String(e.from || '').toLowerCase() + '|' + String(e.to || '').toLowerCase() + '|' + String(e.protocol || '').toLowerCase();
}

function unionStrings(a, b) {
  const set = new Set();
  for (const x of (a || [])) set.add(x);
  for (const x of (b || [])) set.add(x);
  return Array.from(set);
}

function unionResources(a, b) {
  const map = new Map();
  for (const r of (a || [])) {
    if (!r) continue;
    map.set(String(r.kind || '') + '|' + String(r.name || ''), r);
  }
  for (const r of (b || [])) {
    if (!r) continue;
    map.set(String(r.kind || '') + '|' + String(r.name || ''), r);
  }
  return Array.from(map.values());
}

function mergeNode(a, b) {
  if (!a) return b;
  if (!b) return a;
  const aGhost = a.ghost !== false;
  const bGhost = b.ghost !== false;
  // Concrete wins; if both same ghostness, prefer b (newer).
  const base = (!aGhost && bGhost) ? a : (!bGhost && aGhost ? b : b);
  const other = base === a ? b : a;
  const ghost = aGhost && bGhost;
  return {
    ...other,
    ...base,
    id: base.id || other.id,
    label: base.label || other.label,
    kind: base.kind || other.kind,
    ghost,
    confidence: Math.max(Number(a.confidence) || 0, Number(b.confidence) || 0),
    summary: base.summary || other.summary || '',
    sourceLogIds: unionStrings(a.sourceLogIds, b.sourceLogIds),
    resources: unionResources(a.resources, b.resources),
    children: mergeChildren(a.children, b.children),
    parentId: base.parentId != null ? base.parentId : other.parentId,
  };
}

function mergeChildren(a, b) {
  const map = new Map();
  for (const n of (a || [])) {
    if (!n) continue;
    map.set(String(n.id || '').toLowerCase(), n);
  }
  for (const n of (b || [])) {
    if (!n) continue;
    const k = String(n.id || '').toLowerCase();
    map.set(k, map.has(k) ? mergeNode(map.get(k), n) : n);
  }
  return Array.from(map.values());
}

function mergeEdge(a, b) {
  if (!a) return b;
  if (!b) return a;
  const aGhost = a.ghost !== false;
  const bGhost = b.ghost !== false;
  const base = (!aGhost && bGhost) ? a : (!bGhost && aGhost ? b : b);
  const other = base === a ? b : a;
  return {
    ...other,
    ...base,
    id: base.id || other.id,
    from: base.from || other.from,
    to: base.to || other.to,
    protocol: base.protocol || other.protocol || '',
    ghost: aGhost && bGhost,
    sourceLogIds: unionStrings(a.sourceLogIds, b.sourceLogIds),
    summary: base.summary || other.summary || '',
  };
}

/** Pure union of two ArchModels — case-insensitive ids, ghost-promotion, dedup. */
export function mergeModel(a, b) {
  const aa = a || { nodes: [], edges: [], version: 0 };
  const bb = b || { nodes: [], edges: [], version: 0 };
  const nodeMap = new Map();
  for (const n of (aa.nodes || [])) {
    if (!n) continue;
    nodeMap.set(String(n.id || '').toLowerCase(), n);
  }
  for (const n of (bb.nodes || [])) {
    if (!n) continue;
    const k = String(n.id || '').toLowerCase();
    nodeMap.set(k, nodeMap.has(k) ? mergeNode(nodeMap.get(k), n) : n);
  }
  const edgeMap = new Map();
  for (const e of (aa.edges || [])) {
    if (!e) continue;
    edgeMap.set(edgeKey(e), e);
  }
  for (const e of (bb.edges || [])) {
    if (!e) continue;
    const k = edgeKey(e);
    edgeMap.set(k, edgeMap.has(k) ? mergeEdge(edgeMap.get(k), e) : e);
  }
  return {
    nodes: Array.from(nodeMap.values()),
    edges: Array.from(edgeMap.values()),
    version: Math.max(aa.version || 0, bb.version || 0) + 1,
  };
}

/** Top-level orchestrator: append log, call Claude, merge defensively, persist. */
export async function reverseEngineer({ state, logText, onProgress }) {
  try {
    if (!state || !state.settings || !state.settings.apiKey) {
      return { ok: false, error: 'No Anthropic API key set. Open Settings and paste your key.' };
    }
    onProgress && onProgress('submitting');
    const entry = appendLog(state, logText);
    const newLogId = entry ? entry.id : '';
    const sess = activeSession(state);
    const sessName = sess ? sess.name : '(none)';
    const prevModel = (sess && sess.model) ? sess.model : { nodes: [], edges: [], version: 0 };
    const logIds = (sess && sess.logs ? sess.logs : []).map(l => l.id).join(', ');
    const user =
      'Active session: ' + sessName + '\n' +
      'Logs so far (ids): ' + logIds + '\n' +
      'Current model:\n' +
      JSON.stringify(prevModel, null, 2) + '\n' +
      'New log (id=' + newLogId + '):\n' +
      logText;

    onProgress && onProgress('awaiting');
    const resp = await callClaude({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      system: SYSTEM_PROMPT,
      user,
      stream: true,
      onTextDelta: (delta) => {
        try { onProgress && onProgress({ stage: 'streaming', delta }); } catch (_) {}
      },
      onEvent: (e) => {
        try { onProgress && onProgress({ stage: 'event', event: e }); } catch (_) {}
      },
    });

    onProgress && onProgress('parsing');
    if (!resp || !Array.isArray(resp.nodes) || !Array.isArray(resp.edges)) {
      return { ok: false, error: 'Claude response missing nodes/edges arrays.', raw: resp };
    }

    onProgress && onProgress('validating');
    const llmModel = {
      nodes: resp.nodes,
      edges: resp.edges,
      version: (prevModel.version || 0) + 1,
    };

    onProgress && onProgress('merging');
    const merged = defensiveMerge(prevModel, llmModel);

    onProgress && onProgress('persisting');
    setActiveModel(state, merged);
    persist(state);

    onProgress && onProgress('done');
    return {
      ok: true,
      thinking: resp.thinking || '',
      summary: resp.summary || '',
      model: merged,
    };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), raw: err && err.raw };
  }
}

const CHAT_SYSTEM_PROMPT = `You are AIARE's AI agent. The user has been incrementally reverse-engineering a system architecture from logs. They may ask you general questions about the current architecture, ask for explanations of inferred components, suggest changes, or just chat. Use the provided JSON architecture model as context. Reply in plain prose (NOT JSON). Be concise (3-8 sentences) unless asked for detail. If the user references nodes by label, identify them in the model. If a question can't be answered from the model alone, say what additional log evidence would help.`;

/**
 * Free-form chat with the agent about the current architecture.
 * Does NOT modify the model. Returns { ok, reply, error? }.
 * Uses storage.appendMessage to record both user message and assistant reply.
 */
export async function chatWithAgent({ state, userMessage, onProgress }) {
  if (!state?.settings?.apiKey) {
    return { ok: false, error: 'No Anthropic API key set. Open Settings and paste your key.' };
  }
  if (!userMessage || !userMessage.trim()) {
    return { ok: false, error: 'Empty message.' };
  }
  try {
    onProgress?.('submitting');
    const sess = activeSession(state);
    const recentHistory = (sess.messages || []).slice(-10)
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => `${m.role.toUpperCase()}: ${m.text}`)
      .join('\n');
    const user = `Active session: ${sess.name}
Logs ingested so far: ${(sess.logs || []).length}
Current architecture model:
${JSON.stringify(sess.model, null, 2)}

Recent conversation:
${recentHistory || '(none)'}

User question:
${userMessage}`;
    onProgress?.('awaiting');
    const data = await callClaude({
      apiKey: state.settings.apiKey,
      model: state.settings.model || 'claude-sonnet-4-6',
      system: CHAT_SYSTEM_PROMPT,
      user,
      maxTokens: 1024,
      asJson: false,
      stream: true,
      onTextDelta: (delta) => {
        try { onProgress?.({ stage: 'streaming', delta }); } catch (_) {}
      },
      onEvent: (e) => {
        try { onProgress?.({ stage: 'event', event: e }); } catch (_) {}
      },
    });
    onProgress?.('done');
    return { ok: true, reply: typeof data === 'string' ? data : (data?.reply || JSON.stringify(data)) };
  } catch (err) {
    return { ok: false, error: err.message || String(err), raw: err.raw };
  }
}
