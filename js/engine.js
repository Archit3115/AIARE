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
return a small JSON DELTA describing only what changes.

Allowed node kinds: SERVICE, MIDDLEWARE, QUEUE, DB, CACHE, UI_TAB, EXTERNAL, UNKNOWN.

Output rules:
- Do NOT echo back unchanged nodes or edges. Only return what is new, promoted, or updated.
- Use kebab-case node ids. Re-use existing ids when the log refers to a node we already inferred.
- If a producer or consumer is implied but not directly observed yet, emit it as a node with "ghost": true. Use kind UNKNOWN if you can't even guess.
- When a new log confirms a previously-ghost node, list its id under "nodesPromote" (this flips ghost: false). Same for edges via "edgesPromote".
- If a node's summary/resources/confidence/sourceLogIds need updating, add a partial entry to "nodesUpdate" with { id, ...fieldsToChange }.

Each new node in nodesAdd MUST have: id (kebab-case), label, kind, ghost (boolean), confidence (0-1), summary (one sentence), sourceLogIds (array), resources (array; can be empty), children (array; can be empty).
Each new edge in edgesAdd MUST have: id, from, to, protocol (e.g. "HTTP POST /orders", "Kafka topic order.events", "SQL INSERT"), ghost (boolean), sourceLogIds, summary.
thinking: 2-4 sentences of verbose reasoning.
summary: 1-2 sentences describing what changed in this iteration.

Output ONLY a single JSON object with this exact shape, no prose, no code fences:
{
  "thinking": "...",
  "summary": "...",
  "nodesAdd":     [...],
  "nodesPromote": ["id1", "id2"],
  "nodesUpdate":  [{ "id": "auth-svc", "summary": "...", "confidence": 0.9 }],
  "edgesAdd":     [...],
  "edgesPromote": ["id1"]
}

If you have absolutely nothing new for one of these arrays, emit an empty array []. Never omit a key.`;

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

/** Internal: read an SSE stream from a fetch Response, calling onFrame(frameString) for each '\n\n'-separated frame. */
async function readSseStream(res, onFrame) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.trim()) onFrame(frame);
    }
  }
  if (buffer.trim()) onFrame(buffer);
}

function providerLabel(p) {
  if (p === 'openai') return 'OpenAI';
  if (p === 'gemini') return 'Gemini';
  return 'Anthropic';
}

/** Raised by a provider call when the model output was cut off due to a token limit. The `partial` field carries whatever was emitted so the caller can resume. */
class TruncatedError extends Error {
  constructor(message, partial) {
    super(message);
    this.name = 'TruncatedError';
    this.partial = partial || '';
  }
}

/** Anthropic Messages API. */
async function callAnthropic({ apiKey, model, system, user, assistantPrefill, maxTokens, asJson, stream, onTextDelta, onEvent }) {
  const messages = [{ role: 'user', content: user }];
  if (assistantPrefill) messages.push({ role: 'assistant', content: assistantPrefill });
  const body = { model, max_tokens: maxTokens, system, messages };
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
    let errText = ''; try { errText = await res.text(); } catch (_) {}
    throw new Error('Anthropic API ' + res.status + ': ' + errText.slice(0, 300));
  }
  let assistantText = '';
  let stopReason = null;
  if (stream) {
    await readSseStream(res, (frame) => {
      const lines = frame.split('\n');
      let evType = null, dataLine = null;
      for (const line of lines) {
        if (line.startsWith('event:')) evType = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLine = line.slice(5).trim();
      }
      if (!dataLine) return;
      let payload; try { payload = JSON.parse(dataLine); } catch { return; }
      if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
        assistantText += payload.delta.text;
        try { onTextDelta && onTextDelta(payload.delta.text); } catch {}
      } else if (payload.type === 'message_delta' && payload.delta?.stop_reason) {
        stopReason = payload.delta.stop_reason;
      }
      try { onEvent && onEvent({ type: payload.type || evType, payload }); } catch {}
    });
  } else {
    const data = await res.json();
    const blocks = Array.isArray(data?.content) ? data.content : [];
    assistantText = blocks.filter(b => b?.type === 'text').map(b => b.text || '').join('');
    stopReason = data?.stop_reason || null;
  }
  if (stopReason === 'max_tokens') {
    throw new TruncatedError('Anthropic hit max_tokens=' + maxTokens, assistantText);
  }
  if (asJson === false) return assistantText;
  return extractJsonObject(assistantText);
}

/** OpenAI-compatible Chat Completions (OpenAI, Groq, OpenRouter, DeepSeek, Together, vLLM, ...). */
async function callOpenAI({ apiKey, baseUrl, model, system, user, assistantPrefill, maxTokens, asJson, stream, onTextDelta, onEvent }) {
  const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/chat/completions';
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  if (assistantPrefill) messages.push({ role: 'assistant', content: assistantPrefill });
  const body = { model, max_tokens: maxTokens, messages };
  if (stream) body.stream = true;
  const res = await window.fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let errText = ''; try { errText = await res.text(); } catch (_) {}
    throw new Error('OpenAI API ' + res.status + ': ' + errText.slice(0, 300));
  }
  let assistantText = '';
  let stopReason = null;
  if (stream) {
    await readSseStream(res, (frame) => {
      // Frames are usually just `data: {...}` (sometimes with no event:)
      const lines = frame.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let payload; try { payload = JSON.parse(data); } catch { continue; }
        const choice = payload.choices && payload.choices[0];
        if (!choice) continue;
        const delta = choice.delta && choice.delta.content;
        if (delta) {
          assistantText += delta;
          try { onTextDelta && onTextDelta(delta); } catch {}
        }
        if (choice.finish_reason) stopReason = choice.finish_reason;
        try { onEvent && onEvent({ type: 'chunk', payload }); } catch {}
      }
    });
  } else {
    const data = await res.json();
    const choice = data?.choices && data.choices[0];
    assistantText = choice?.message?.content || '';
    stopReason = choice?.finish_reason || null;
  }
  if (stopReason === 'length') {
    throw new TruncatedError('OpenAI hit max_tokens=' + maxTokens, assistantText);
  }
  if (asJson === false) return assistantText;
  return extractJsonObject(assistantText);
}

/** Google Gemini generateContent / streamGenerateContent. */
async function callGemini({ apiKey, model, system, user, assistantPrefill, maxTokens, asJson, stream, onTextDelta, onEvent }) {
  const base = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model);
  const url = stream
    ? base + ':streamGenerateContent?alt=sse&key=' + encodeURIComponent(apiKey)
    : base + ':generateContent?key=' + encodeURIComponent(apiKey);
  const contents = [{ role: 'user', parts: [{ text: user }] }];
  if (assistantPrefill) contents.push({ role: 'model', parts: [{ text: assistantPrefill }] });
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { maxOutputTokens: maxTokens },
  };
  const res = await window.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let errText = ''; try { errText = await res.text(); } catch (_) {}
    throw new Error('Gemini API ' + res.status + ': ' + errText.slice(0, 300));
  }
  let assistantText = '';
  let stopReason = null;
  if (stream) {
    await readSseStream(res, (frame) => {
      const lines = frame.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let payload; try { payload = JSON.parse(data); } catch { continue; }
        const cand = payload.candidates && payload.candidates[0];
        if (!cand) continue;
        const parts = cand.content && cand.content.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (p && typeof p.text === 'string' && p.text.length) {
              assistantText += p.text;
              try { onTextDelta && onTextDelta(p.text); } catch {}
            }
          }
        }
        if (cand.finishReason) stopReason = cand.finishReason;
        try { onEvent && onEvent({ type: 'chunk', payload }); } catch {}
      }
    });
  } else {
    const data = await res.json();
    const cand = data?.candidates && data.candidates[0];
    const parts = cand?.content?.parts || [];
    assistantText = parts.map(p => p?.text || '').join('');
    stopReason = cand?.finishReason || null;
  }
  if (stopReason === 'MAX_TOKENS') {
    throw new TruncatedError('Gemini hit maxOutputTokens=' + maxTokens, assistantText);
  }
  if (asJson === false) return assistantText;
  return extractJsonObject(assistantText);
}

function dispatchProvider(provider, opts) {
  switch (provider) {
    case 'openai': return callOpenAI(opts);
    case 'gemini': return callGemini(opts);
    case 'anthropic':
    default:       return callAnthropic(opts);
  }
}

/**
 * Provider-agnostic LLM call with auto-continuation.
 *
 * If the provider truncates the response (max_tokens / length / MAX_TOKENS),
 * this loops up to `maxContinuations` extra times, sending the partial output
 * back as an `assistantPrefill` so the model resumes exactly where it stopped.
 * Subsequent attempts disable streaming because token deltas can't easily be
 * threaded through a continuation anyway.
 */
export async function callLLM({ settings, system, user, maxTokens = 32000, asJson = true, stream = false, onTextDelta, onEvent, maxContinuations = 5 }) {
  const provider = (settings && settings.provider) || 'anthropic';
  const baseOpts = {
    apiKey:  settings && settings.apiKey,
    baseUrl: settings && settings.baseUrl,
    model:   settings && settings.model,
    system, user, maxTokens,
    asJson: false,                       // we always collect raw text and parse at the end
    onTextDelta, onEvent,
  };

  let accumulated = '';
  let attempt = 0;
  // First attempt may stream; later continuations are non-streaming for simplicity.
  while (true) {
    try {
      const text = await dispatchProvider(provider, {
        ...baseOpts,
        stream: attempt === 0 ? stream : false,
        assistantPrefill: accumulated || undefined,
      });
      accumulated += text;
      break; // not truncated
    } catch (err) {
      if (err && err.name === 'TruncatedError' && attempt < maxContinuations) {
        accumulated += err.partial || '';
        attempt++;
        try { onEvent && onEvent({ type: 'continuation', attempt, totalChars: accumulated.length, lastReason: err.message }); } catch {}
        try { onTextDelta && onTextDelta(''); } catch {}
        continue;
      }
      if (err && err.name === 'TruncatedError') {
        // Exhausted all continuations.
        accumulated += err.partial || '';
        const e = new Error(`${providerLabel(provider)} response still truncated after ${maxContinuations + 1} attempts (${accumulated.length} chars). Try a shorter input.`);
        e.raw = accumulated;
        throw e;
      }
      throw err;
    }
  }
  if (asJson === false) return accumulated;
  return extractJsonObject(accumulated);
}

/** Back-compat alias. Older callers passed { apiKey, model, ... } directly; route them to Anthropic. */
export async function callClaude(opts) {
  if (opts && opts.settings) return callLLM(opts);
  return callLLM({
    settings: { provider: 'anthropic', apiKey: opts.apiKey, model: opts.model, baseUrl: '' },
    system: opts.system, user: opts.user,
    maxTokens: opts.maxTokens, asJson: opts.asJson, stream: opts.stream,
    onTextDelta: opts.onTextDelta, onEvent: opts.onEvent,
  });
}

/**
 * Apply a small delta returned by the LLM to the previous model.
 * Delta shape: { nodesAdd, nodesPromote, nodesUpdate, edgesAdd, edgesPromote }.
 * Idempotent: re-applying the same delta is safe.
 */
export function applyDelta(prevModel, delta) {
  const prev = prevModel || { nodes: [], edges: [], version: 0 };
  const d = delta || {};
  const byNode = new Map();
  for (const n of (prev.nodes || [])) {
    if (n && n.id) byNode.set(String(n.id), n);
  }
  const byEdge = new Map();
  for (const e of (prev.edges || [])) {
    if (e && e.id) byEdge.set(String(e.id), e);
  }
  for (const n of (d.nodesAdd || [])) {
    if (!n || !n.id) continue;
    const existing = byNode.get(n.id);
    byNode.set(n.id, existing ? { ...existing, ...n, sourceLogIds: unionStrings(existing.sourceLogIds, n.sourceLogIds), resources: unionResources(existing.resources, n.resources) } : n);
  }
  for (const id of (d.nodesPromote || [])) {
    const n = byNode.get(String(id));
    if (n) byNode.set(String(id), { ...n, ghost: false });
  }
  for (const upd of (d.nodesUpdate || [])) {
    if (!upd || !upd.id) continue;
    const n = byNode.get(String(upd.id));
    if (!n) continue;
    byNode.set(String(upd.id), {
      ...n,
      ...upd,
      sourceLogIds: unionStrings(n.sourceLogIds, upd.sourceLogIds),
      resources: unionResources(n.resources, upd.resources),
    });
  }
  for (const e of (d.edgesAdd || [])) {
    if (!e || !e.id) continue;
    const existing = byEdge.get(e.id);
    byEdge.set(e.id, existing ? { ...existing, ...e, sourceLogIds: unionStrings(existing.sourceLogIds, e.sourceLogIds) } : e);
  }
  for (const id of (d.edgesPromote || [])) {
    const e = byEdge.get(String(id));
    if (e) byEdge.set(String(id), { ...e, ghost: false });
  }
  return {
    nodes: Array.from(byNode.values()),
    edges: Array.from(byEdge.values()),
    version: (prev.version || 0) + 1,
  };
}

/**
 * Detect whether a parsed LLM response is a delta or a full model.
 * Returns 'delta' | 'full' | 'unknown'.
 */
export function detectResponseShape(resp) {
  if (!resp || typeof resp !== 'object') return 'unknown';
  const isDeltaShape = ['nodesAdd', 'nodesPromote', 'nodesUpdate', 'edgesAdd', 'edgesPromote'].some(k => Array.isArray(resp[k]));
  if (isDeltaShape) return 'delta';
  if (Array.isArray(resp.nodes) && Array.isArray(resp.edges)) return 'full';
  return 'unknown';
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
      const prov = (state && state.settings && state.settings.provider) || 'anthropic';
      return { ok: false, error: 'No API key set for ' + providerLabel(prov) + '. Open Settings.' };
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
    const resp = await callLLM({
      settings: state.settings,
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
    const shape = detectResponseShape(resp);
    if (shape === 'unknown') {
      return { ok: false, error: 'LLM response was not a delta or full model. Expected nodesAdd/edgesAdd/etc., or nodes/edges.', raw: resp };
    }

    onProgress && onProgress('validating');

    onProgress && onProgress('merging');
    let merged;
    if (shape === 'delta') {
      merged = applyDelta(prevModel, resp);
    } else {
      const llmModel = { nodes: resp.nodes, edges: resp.edges, version: (prevModel.version || 0) + 1 };
      merged = defensiveMerge(prevModel, llmModel);
    }

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
    const prov = state?.settings?.provider || 'anthropic';
    return { ok: false, error: 'No API key set for ' + providerLabel(prov) + '. Open Settings.' };
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
    const data = await callLLM({
      settings: state.settings,
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
