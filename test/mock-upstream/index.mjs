/**
 * Deterministic fault-injection mock upstream for the QA driver (task T10).
 *
 * Pure node:http â€?no third-party dependencies, loopback only, no real relays,
 * no network access. Never bundled into the VSIX (`.vscodeignore` keeps `test/**`).
 *
 * Fault control (per-instance `profile`, optionally merged with the
 * MOCK_UPSTREAM_PROFILE env var; per-request query params also override when
 * present):
 *
 *   fail: null | <http status number> | 'reset' | 'midstream'
 *         | 'midstream-after-toolcall' | 'stall' | 'firstbyte' | 'slow'
 *     - <number>                  respond with that status (e.g. 501, 502).
 *     - 'reset'                   drop the connection without a response.
 *     - 'midstream'               emit `fragTokens` text tokens via SSE, abort.
 *     - 'midstream-after-toolcall'request carrying a tool result (role:'tool'
 *                                 message / function_call_output item): emit 2
 *                                 tokens then abort; request without one: fully
 *                                 emit a tool_call with args + done (exercises
 *                                 the "failed after tool call emitted" path).
 *     - 'stall'                   accept, write a partial frame, stay silent
 *                                 (fake dead TCP) â€?the transport's stallMs
 *                                 timeout must fire.
 *     - 'firstbyte' / 'slow'      delay the first byte by `firstByteMs`.
 *   failN: scenario=failThenOk:N â€?the first N completion requests fail (counted
 *          per mock-server instance, NOT per connection), then succeed.
 *   failSeq: per-request behavior array used during the failing phase
 *            (failSeq[seq-1] ?? fail ?? 502).
 *   fragTokens / tokenDelayMs: tokens emitted before a midstream abort.
 *   label: token prefix so assertions can tell which target streamed what.
 *   tools: 'none' marker (the driver additionally sets toolCalling:false).
 *   img / tiny: informational markers for image-input / maxInputTokens preflights.
 *
 * Endpoints:
 *   POST /v1/chat/completions   POST /v1/responses   (SSE streaming)
 *   POST /tools/echo            (tool executor: increments the side-effect count)
 *   GET  /count                 ({count}) â€?every response also carries X-FR-Count.
 *   GET  /models                (probe support)
 */

import http from 'node:http';
import { URL } from 'node:url';

const DEFAULTS = {
  fail: null,
  failN: 0,
  failSeq: null,
  firstByteMs: 0,
  fragTokens: 20,
  tokenDelayMs: 8,
  answerTokens: 4,
  label: 'T',
  tools: null,
  img: null,
  tiny: null,
};

/** Parse a profile from an object or a string (JSON, or `k=v&k2=v2` style). */
export function parseProfile(source) {
  if (source == null) return {};
  if (typeof source === 'object') return { ...source };
  const s = String(source).trim();
  if (!s) return {};
  if (s.startsWith('{')) {
    try {
      return JSON.parse(s);
    } catch {
      /* fall through to query-string style */
    }
  }
  const out = {};
  for (const pair of s.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = pair.slice(0, eq);
    const val = decodeURIComponent(pair.slice(eq + 1));
    if (k === 'fail') {
      const n = Number(val);
      out.fail = val === '' || Number.isNaN(n) ? (val === 'false' ? null : val) : n;
    } else if (k === 'failSeq') {
      try {
        out.failSeq = JSON.parse(val);
      } catch {
        out.failSeq = val.split(',').map((v) => {
          const n = Number(v);
          return Number.isNaN(n) ? v : n;
        });
      }
    } else if (k === 'scenario' && val.startsWith('failThenOk:')) {
      out.failN = Number(val.slice('failThenOk:'.length)) || 0;
    } else if (k === 'slow' || k === 'firstbyte') {
      out.fail = k === 'slow' ? 'slow' : 'firstbyte';
      out.firstByteMs = Number(val) || 0;
    } else if (k === 'stall') {
      out.fail = 'stall';
    } else if (k === 'tools' || k === 'img' || k === 'tiny') {
      out[k] = val;
    } else if (k === 'label') {
      out.label = val;
    } else if (['firstByteMs', 'fragTokens', 'tokenDelayMs', 'answerTokens'].includes(k)) {
      out[k] = Number(val) || 0;
    }
  }
  return out;
}

/** Behavior active for this request, or null when the request should succeed. */
function failingMode(p, seq) {
  if (p.failN > 0) {
    if (seq <= p.failN) {
      if (Array.isArray(p.failSeq)) return p.failSeq[seq - 1] ?? p.fail ?? 502;
      return p.fail ?? 502;
    }
    return null;
  }
  return p.fail;
}

export async function createMockUpstream(opts = {}) {
  const envProfile = parseProfile(process.env.MOCK_UPSTREAM_PROFILE);
  const profile = { ...DEFAULTS, ...envProfile, ...parseProfile(opts.profile) };
  let count = 0;
  let requestSeq = 0; // per instance, across completion endpoints
  const requests = { chatCompletions: [], responses: [], echo: [], all: [] };

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => resolve(''));
    });
  }

  async function onRequest(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    const path = u.pathname;
    const p = { ...profile, ...parseProfile(u.searchParams.toString()) };
    const record = { url: req.url, headers: req.headers, at: Date.now() };
    const bodyText = await readBody(req);
    let body = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = null;
    }
    record.body = body;
    requests.all.push(record);

    const stamp = (r) => r.setHeader('X-FR-Count', String(count));

    if (req.method === 'GET' && path.endsWith('/count')) {
      stamp(res);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count }));
      return;
    }
    if (req.method === 'GET' && path.endsWith('/models')) {
      stamp(res);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model' }] }));
      return;
    }
    if (req.method === 'POST' && path.endsWith('/tools/echo')) {
      count++;
      requests.echo.push(record);
      stamp(res);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { echoed: body ?? {}, callId: body?.callId ?? null } }));
      return;
    }
    if (req.method === 'POST' && path.endsWith('/chat/completions')) {
      requests.chatCompletions.push(record);
      requestSeq++;
      stamp(res);
      streamChat(p, body, res, requestSeq);
      return;
    }
    if (req.method === 'POST' && path.endsWith('/responses')) {
      requests.responses.push(record);
      requestSeq++;
      stamp(res);
      streamResponses(p, body, res, requestSeq);
      return;
    }
    stamp(res);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  const server = http.createServer(onRequest);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    profile: { ...profile },
    get count() {
      return count;
    },
    requests,
    reset() {
      count = 0;
      requestSeq = 0;
      requests.chatCompletions.length = 0;
      requests.responses.length = 0;
      requests.echo.length = 0;
      requests.all.length = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------------------------------------------------------------------------
// streaming helpers
// ---------------------------------------------------------------------------

function writeHeadSafe(res, status, headers) {
  if (res.destroyed || res.writableEnded) return;
  try {
    res.writeHead(status, headers);
  } catch {
    /* client gone */
  }
}

/** True when the request body carries a completed tool result (role:'tool'). */
function hasToolResult(body) {
  if (Array.isArray(body?.messages)) {
    return body.messages.some((m) => m.role === 'tool');
  }
  if (Array.isArray(body?.input)) {
    return body.input.some((m) => m.items?.some((i) => i.type === 'function_call_output'));
  }
  return false;
}

// --- chat-completions ---

function streamChat(p, body, res, seq) {
  const mode = failingMode(p, seq);
  if (mode === 'reset') {
    res.destroy();
    return;
  }
  if (typeof mode === 'number') {
    writeHeadSafe(res, mode, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `mock upstream fail ${mode}`, type: 'mock_fail', status: mode } }));
    return;
  }
  if (mode === 'midstream-after-toolcall') {
    if (!hasToolResult(body)) {
      emitChatToolCall(p, res);
      return;
    }
    emitChatTextFrag(p, res, 2, true);
    return;
  }
  if (mode === 'midstream') {
    emitChatTextFrag(p, res, p.fragTokens, true);
    return;
  }
  if (mode === 'stall') {
    writeHeadSafe(res, 200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'st' } }] })}`);
    const t = setTimeout(() => res.destroy(), 6000);
    t.unref?.();
    return;
  }
  if (mode === 'firstbyte' || mode === 'slow') {
    // Headers arrive immediately so the transport's connect+headers budget is
    // satisfied; only the *body* is delayed, which is what firstByteMs covers.
    writeHeadSafe(res, 200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    const t = setTimeout(() => {
      if (!res.destroyed) streamChatSuccess(p, body, res, true);
    }, p.firstByteMs || 800);
    t.unref?.();
    return;
  }
  streamChatSuccess(p, body, res);
}

function streamChatSuccess(p, body, res, headless = false) {
  if (!headless) {
    if (p.tools === 'none' && body?.tools?.length) {
      writeHeadSafe(res, 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'target declares no tool-calling support', type: 'mock_tools_none' } }));
      return;
    }
    writeHeadSafe(res, 200, { 'content-type': 'text/event-stream' });
  }
  if (body?.tools?.length) {
    emitChatToolCall(p, res);
    return;
  }
  const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  for (let i = 0; i < p.answerTokens; i++) {
    sse({ choices: [{ delta: { content: `ANSWER-${p.label}-${i}` } }] });
  }
  sse({ choices: [{ finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

function emitChatTextFrag(p, res, n, destroyAfter) {
  writeHeadSafe(res, 200, { 'content-type': 'text/event-stream' });
  const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  let i = 0;
  const tick = () => {
    if (res.destroyed) return;
    if (i >= n) {
      if (destroyAfter) {
        // give the client a moment to drain the buffered frames, then abort
        const t = setTimeout(() => res.destroy(), 60);
        t.unref?.();
        return;
      }
      sse({ choices: [{ finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    sse({ choices: [{ delta: { content: `FRAG-${p.label}-${String(i).padStart(2, '0')}` } }] });
    i++;
    const t = setTimeout(tick, p.tokenDelayMs);
    t.unref?.();
  };
  tick();
}

function emitChatToolCall(p, res) {
  writeHeadSafe(res, 200, { 'content-type': 'text/event-stream' });
  const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read' } }] } }] });
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { arguments: '{"pa' } }] } }] });
  sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { arguments: 'th":"a.txt"}' } }] } }] });
  sse({ choices: [{ finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

// --- responses api ---

function streamResponses(p, body, res, seq) {
  const mode = failingMode(p, seq);
  if (mode === 'reset') {
    res.destroy();
    return;
  }
  if (typeof mode === 'number') {
    writeHeadSafe(res, mode, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `mock upstream fail ${mode}`, type: 'mock_fail', status: mode } }));
    return;
  }
  if (mode === 'midstream-after-toolcall') {
    if (!hasToolResult(body)) {
      emitResponsesToolCall(p, res);
      return;
    }
    emitResponsesTextFrag(p, res, 2, true);
    return;
  }
  if (mode === 'midstream') {
    emitResponsesTextFrag(p, res, p.fragTokens, true);
    return;
  }
  if (mode === 'stall') {
    writeHeadSafe(res, 200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'st' })}`);
    const t = setTimeout(() => res.destroy(), 6000);
    t.unref?.();
    return;
  }
  if (mode === 'firstbyte' || mode === 'slow') {
    writeHeadSafe(res, 200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    const t = setTimeout(() => {
      if (!res.destroyed) streamResponsesSuccess(p, body, res, true);
    }, p.firstByteMs || 800);
    t.unref?.();
    return;
  }
  streamResponsesSuccess(p, body, res);
}

function streamResponsesSuccess(p, body, res, headless = false) {
  if (!headless) {
    if (p.tools === 'none' && body?.tools?.length) {
      writeHeadSafe(res, 400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'target declares no tool-calling support', type: 'mock_tools_none' } }));
      return;
    }
    writeHeadSafe(res, 200, { 'content-type': 'text/event-stream' });
  }
  const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (body?.tools?.length) {
    // The transport never surfaces a `name` for responses-api tool calls, so a
    // full tool-call round trip is only exercised through chat-completions.
    sse({ type: 'response.function_call_arguments.delta', item_id: 'c1', delta: '{"path":"a.txt"}' });
    sse({ type: 'response.function_call_arguments.done', item_id: 'c1' });
  } else {
    for (let i = 0; i < p.answerTokens; i++) {
      sse({ type: 'response.output_text.delta', delta: `ANSWER-${p.label}-${i}` });
    }
  }
  sse({ type: 'response.completed' });
  res.end();
}

function emitResponsesTextFrag(p, res, n, destroyAfter) {
  writeHeadSafe(res, 200, { 'content-type': 'text/event-stream' });
  const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  let i = 0;
  const tick = () => {
    if (res.destroyed) return;
    if (i >= n) {
      if (destroyAfter) {
        const t = setTimeout(() => res.destroy(), 60);
        t.unref?.();
        return;
      }
      sse({ type: 'response.completed' });
      res.end();
      return;
    }
    sse({ type: 'response.output_text.delta', delta: `FRAG-${p.label}-${String(i).padStart(2, '0')}` });
    i++;
    const t = setTimeout(tick, p.tokenDelayMs);
    t.unref?.();
  };
  tick();
}

function emitResponsesToolCall(p, res) {
  writeHeadSafe(res, 200, { 'content-type': 'text/event-stream' });
  const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  sse({ type: 'response.function_call_arguments.delta', item_id: 'c1', delta: '{"path":"a.txt"}' });
  sse({ type: 'response.function_call_arguments.done', item_id: 'c1' });
  sse({ type: 'response.completed' });
  res.end();
}
