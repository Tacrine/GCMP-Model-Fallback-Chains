/**
 * Deterministic end-to-end QA driver (plan task T10).
 *
 * Boots local fault-injection mock upstreams (test/mock-upstream/index.mjs),
 * drives the real A2 HttpTransport + FallbackRouter core (no VS Code, no
 * network, loopback only), and asserts every fault scenario end to end.
 *
 * Run: npm run qa:faults   (bundles this file with esbuild, then executes)
 *
 * Exit code 0 when every scenario prints a PASS line; 1 otherwise.
 */

import { createMockUpstream } from '../mock-upstream/index.mjs';
import { HttpTransport } from '../../src/transport/httpTransport';
import { FallbackRouter, RouterError } from '../../src/router/router';
import { CircuitBreaker } from '../../src/router/circuitBreaker';
import type {
  Cancel, Chain, HttpTarget, LangMsg, LangPart, Logger, Target, ToolDef,
} from '../../src/types';
import { Role } from '../../src/types';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** Small test timeouts (plan requirement): prove the override reaches the A2 transport. */
const TEST_TIMEOUTS = { connectMs: 500, headersMs: 500, firstByteMs: 500, stallMs: 2000 };

const CANCEL: Cancel = {
  isCancellationRequested: false,
  onCancellationRequested: () => () => {},
};

interface TurnOpts {
  tools?: readonly ToolDef[];
  maxAttempts?: number;
}

let failures = 0;

function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ok: ${label}`);
  } else {
    failures++;
    console.log(`  FAIL: ${label}`);
  }
}

function mkChain(id: string, targets: Target[]): Chain {
  return { id, name: id, targets };
}

function httpTarget(baseUrl: string, model: string, extra: Partial<HttpTarget> = {}): HttpTarget {
  return { kind: 'http', baseUrl, apiType: 'chat-completions', model, secretRef: 'qa.secret', ...extra };
}

function userMsg(text: string): LangMsg {
  return { role: Role.User, parts: [{ kind: 'text', value: text }] };
}

const READ_TOOL: ToolDef = {
  name: 'read',
  description: 'read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
};

interface RouterHarness {
  router: FallbackRouter;
  breakers: Map<string, CircuitBreaker>;
  warns: string[];
}

function newRouter(): RouterHarness {
  const breakers = new Map<string, CircuitBreaker>();
  const warns: string[] = [];
  const logger: Logger = {
    error: () => {},
    warn: (m: string) => warns.push(m),
    info: () => {},
    debug: () => {},
  };
  const transport = new HttpTransport({
    logger,
    getSecret: async () => 'qa-secret',
    secretsToRedact: async () => ['qa-secret'],
  });
  const router = new FallbackRouter({
    transports: () => transport,
    breakers,
    breakerFactory: (key) => new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60000 }),
    logger,
  });
  return { router, breakers, warns };
}

async function runTurn(
  router: FallbackRouter,
  chain: Chain,
  messages: readonly LangMsg[],
  opts: TurnOpts = {},
): Promise<{ result: Awaited<ReturnType<FallbackRouter['run']>>; emitted: LangPart[] }> {
  const emitted: LangPart[] = [];
  const result = await router.run(
    chain,
    messages,
    {
      tools: opts.tools,
      timeouts: TEST_TIMEOUTS,
      retry: { maxAttempts: opts.maxAttempts ?? 2, initialDelayMs: 50, backoffFactor: 2, maxDelayMs: 200 },
      circuitBreaker: { failureThreshold: 2, cooldownMs: 60000 },
      maxTurnMs: 30000,
      maxTargetsPerTurn: 4,
      retryOnRateLimit: false,
    },
    (p) => emitted.push(p),
    CANCEL,
  );
  return { result, emitted };
}

/** Fake tool executor: calls the mock's /tools/echo (side-effect counter). */
async function runToolCall(baseUrl: string, call: { callId: string; name: string; input: unknown }): Promise<LangMsg[]> {
  const res = await fetch(`${baseUrl}/tools/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(call),
  });
  const json = (await res.json()) as { ok: boolean; result: unknown };
  return [
    { role: Role.Assistant, parts: [{ kind: 'toolCall', callId: call.callId, name: call.name, input: call.input }] },
    { role: Role.User, parts: [{ kind: 'toolResult', callId: call.callId, content: JSON.stringify(json.result), isError: false }] },
  ];
}

interface MockServer {
  url: string;
  count: number;
  requests: {
    chatCompletions: { url: string; headers: Record<string, string>; body: unknown }[];
    responses: unknown[];
    all: unknown[];
  };
  close(): Promise<void>;
}

const mocks: MockServer[] = [];

async function mock(profile: Record<string, unknown> = {}): Promise<MockServer> {
  const m = (await createMockUpstream({ profile })) as MockServer;
  mocks.push(m);
  return m;
}

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`PASS ${name} elapsed=${Date.now() - t0}ms`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  } finally {
    await Promise.all(mocks.splice(0).map((m) => m.close().catch(() => {})));
  }
}

function textOf(emitted: readonly LangPart[]): string[] {
  return emitted.filter((p): p is { kind: 'text'; value: string } => p.kind === 'text').map((p) => p.value);
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

async function sHappy(): Promise<void> {
  const m = await mock({ label: 'A1' });
  const target = httpTarget(m.url, 'm1', { customHeader: { 'x-fr-test': 'abc', 'x-fr-two': '2' } });
  const h = newRouter();
  const { result, emitted } = await runTurn(h.router, mkChain('happy', [target]), [userMsg('hello')]);

  check(result.ok, 'happy ok');
  check(textOf(emitted).some((v) => v.includes('ANSWER-A1-')), 'answer emitted');
  const req = m.requests.chatCompletions[0];
  const headers = req?.headers ?? {};
  check(headers['x-fr-test'] === 'abc', 'customHeader x-fr-test forwarded verbatim');
  check(headers['x-fr-two'] === '2', 'customHeader x-fr-two forwarded verbatim');
  check(!!headers.authorization, 'authorization header set from secret');
  check(result.attempts.length === 1 && result.attempts[0].ok, 'single target attempt ok');
}

async function sFail502Fallback(): Promise<void> {
  // First two completion requests to this instance fail with 502 (retryable),
  // afterwards succeed. First target burns both attempts, second target wins.
  const m = await mock({ label: 'MQ', fail: 502, failN: 2 });
  const chain = mkChain('fail502', [httpTarget(m.url, 'm1'), httpTarget(m.url, 'm2')]);
  const h = newRouter();

  // Turn 1: tools requested -> A fails twice (502), B succeeds and emits a tool call.
  const t1 = await runTurn(h.router, chain, [userMsg('use the tool')], { tools: [READ_TOOL] });
  check(t1.result.ok, 'turn1 ok via second target');
  check(!t1.result.attempts[0].ok, 'first target failed (502)');
  check(t1.result.attempts[1].ok, 'second target succeeded');
  const calls = t1.emitted.filter((p): p is { kind: 'toolCall'; callId: string; name: string; input: unknown } => p.kind === 'toolCall');
  check(calls.length === 1, 'exactly one tool call emitted');

  // Turn 2: tool result sent back without tools -> plain answer, no re-execution.
  const extra = await runToolCall(m.url, calls[0]);
  check(m.count === 1, `side_effects=1 after echo (got ${m.count})`);
  const t2 = await runTurn(h.router, chain, [userMsg('use the tool'), ...extra]);
  check(t2.result.ok, 'turn2 ok');
  check(textOf(t2.emitted).some((v) => v.includes('ANSWER-MQ-')), 'final answer from second target');
  check(m.count === 1, `side_effects stays 1 (got ${m.count})`);

  // The request the second target received must not carry first-target output.
  const bReq = m.requests.chatCompletions.find((r) => (r.body as { model?: string })?.model === 'm2');
  check(bReq !== undefined, 'second target received a request');
  check(!JSON.stringify(bReq?.body).includes('FRAG'), 'fallback request carries no first-target fragment');
}

async function sMidstream(): Promise<void> {
  // A streams 20 tokens then aborts mid-stream; B completes the answer.
  const mA = await mock({ label: 'MA', fail: 'midstream' });
  const mB = await mock({ label: 'MB' });
  const h = newRouter();
  const chain = mkChain('midstream', [httpTarget(mA.url, 'm1'), httpTarget(mB.url, 'm2')]);

  const { result, emitted } = await runTurn(h.router, chain, [userMsg('hello')]);
  check(result.ok, 'ok after fallback');
  check(textOf(emitted).some((v) => v.includes('FRAG-MA-')), 'partial first-target text visible (hint)');
  check(textOf(emitted).some((v) => v.includes('ANSWER-MB-')), 'final answer complete');
  check(result.attempts[0].emittedParts > 0, 'first-target partial output recorded');
  const bReq = mB.requests.chatCompletions[0];
  check(!JSON.stringify(bReq?.body).includes('FRAG'), 'B request has no A fragments');
}

async function sAllFail(): Promise<void> {
  // 501 is outside the retryable set -> non-retryable, no per-target retry.
  const mA = await mock({ fail: 501 });
  const mB = await mock({ fail: 501 });
  const h = newRouter();
  const chain = mkChain('allfail', [httpTarget(mA.url, 'm1'), httpTarget(mB.url, 'm2')]);

  let threw = false;
  let message = '';
  try {
    await runTurn(h.router, chain, [userMsg('hi')], { maxAttempts: 1 });
  } catch (e) {
    threw = true;
    message = e instanceof Error ? e.message : String(e);
  }
  check(threw, 'aggregate RouterError thrown when all targets fail');
  check(message.includes('All targets'), 'error says all targets failed');
  check(message.includes('allfail'), 'error names the chain');
}

async function sCircuitOpen(): Promise<void> {
  const mA = await mock({ fail: 501 });
  const mB = await mock({ label: 'CB' });
  const h = newRouter();
  const keyA = `http:${mA.url}/m1`;

  // Two failing turns push the breaker past its threshold (2).
  for (let i = 0; i < 2; i++) {
    try {
      await runTurn(h.router, mkChain('cb', [httpTarget(mA.url, 'm1')]), [userMsg('hi')], { maxAttempts: 1 });
    } catch {
      /* aggregate RouterError expected */
    }
  }
  const breaker = h.breakers.get(keyA);
  check(breaker?.getState() === 'open', `breaker open after threshold (state=${breaker?.getState()})`);

  // Third turn: A skipped (circuit open), B succeeds.
  const t3 = await runTurn(h.router, mkChain('cb', [httpTarget(mA.url, 'm1'), httpTarget(mB.url, 'm2')]), [userMsg('hi')], { maxAttempts: 1 });
  check(t3.result.ok, 'turn3 ok via B');
  check(t3.result.attempts[0].skippedReason === 'circuit open', 'A skipped: circuit open');
  check(t3.result.attempts[1].ok, 'B succeeded');
  check(h.warns.some((w) => w.includes('circuit open')), 'warn logged for circuit open skip');
}

async function sToolsNone(): Promise<void> {
  // A declares no tool-calling support -> preflight skips it; B handles the tool round trip.
  const mA = await mock({ label: 'TN', tools: 'none' });
  const mB = await mock({ label: 'TB' });
  const h = newRouter();
  const chain = mkChain('toolsnone', [httpTarget(mA.url, 'm1', { toolCalling: false }), httpTarget(mB.url, 'm2')]);

  const { result, emitted } = await runTurn(h.router, chain, [userMsg('tool it')], { tools: [READ_TOOL] });
  check(result.ok, 'ok via B');
  check(mA.requests.chatCompletions.length === 0, 'A received 0 requests (preflight skip)');
  check(h.warns.some((w) => w.includes('tool calling')), 'warn logged for tool-calling skip');
  const calls = emitted.filter((p): p is { kind: 'toolCall'; callId: string; name: string; input: unknown } => p.kind === 'toolCall');
  check(calls.length === 1, 'tool call came from B');
  await runToolCall(mB.url, calls[0]);
  check(mB.count === 1, `side_effects=1 (echo once, got ${mB.count})`);
}

async function sImgReject(): Promise<void> {
  // A does not declare image input -> preflight skips it (and warns); B answers.
  const mA = await mock({});
  const mB = await mock({ label: 'IM' });
  const h = newRouter();
  const chain = mkChain('img', [httpTarget(mA.url, 'm1', { imageInput: false }), httpTarget(mB.url, 'm2', { imageInput: true })]);
  const imgMsg: LangMsg = {
    role: Role.User,
    parts: [
      { kind: 'text', value: 'describe this image' },
      { kind: 'data', mime: 'image', data: 'iVBORw0KGgo=' },
    ],
  };

  const { result } = await runTurn(h.router, chain, [imgMsg]);
  check(result.ok, 'ok via B');
  check(mA.requests.chatCompletions.length === 0, 'A received 0 requests (image preflight)');
  check(h.warns.some((w) => w.includes('image input')), 'warn logged for image-input skip');
}

async function sTiny(): Promise<void> {
  // A's maxInputTokens is tiny -> preflight skips it; B answers.
  const mA = await mock({});
  const mB = await mock({ label: 'TY' });
  const h = newRouter();
  const chain = mkChain('tiny', [httpTarget(mA.url, 'm1', { maxInputTokens: 20 }), httpTarget(mB.url, 'm2')]);

  const { result } = await runTurn(h.router, chain, [userMsg('x'.repeat(400))]); // ~100 tokens
  check(result.ok, 'ok via B');
  check(mA.requests.chatCompletions.length === 0, 'A received 0 requests (maxInputTokens preflight)');
  check(h.warns.some((w) => w.includes('maxInputTokens')), 'warn logged for maxInputTokens skip');
}

async function sStall(): Promise<void> {
  // A accepts, writes a partial frame, then stays silent -> stallMs timeout fires.
  const mA = await mock({ fail: 'stall' });
  const mB = await mock({ label: 'ST' });
  const h = newRouter();
  const chain = mkChain('stall', [httpTarget(mA.url, 'm1'), httpTarget(mB.url, 'm2')]);

  const t0 = Date.now();
  const { result } = await runTurn(h.router, chain, [userMsg('hi')], { maxAttempts: 1 });
  const elapsed = Date.now() - t0;
  const errMsg = String(result.attempts[0].error ?? '');
  check(result.ok, `ok via B (elapsed=${elapsed}ms)`);
  check(errMsg.includes('stall timeout after 2000ms'), `A failed with stall timeout at override value (${errMsg})`);
  check(elapsed <= 2000 + 2000, `stall switch within budget stallMs+2000 (elapsed=${elapsed}ms)`);
}

async function sFirstByte(): Promise<void> {
  // A delays the first body byte beyond firstByteMs -> first-byte timeout fires.
  const mA = await mock({ fail: 'firstbyte', firstByteMs: 800 });
  const mB = await mock({ label: 'FB' });
  const h = newRouter();
  const chain = mkChain('firstbyte', [httpTarget(mA.url, 'm1'), httpTarget(mB.url, 'm2')]);

  const t0 = Date.now();
  const { result } = await runTurn(h.router, chain, [userMsg('hi')], { maxAttempts: 1 });
  const elapsed = Date.now() - t0;
  const errMsg = String(result.attempts[0].error ?? '');
  check(result.ok, `ok via B (elapsed=${elapsed}ms)`);
  check(errMsg.includes('first byte timeout after 500ms'), `A failed with first-byte timeout at override value (${errMsg})`);
  check(elapsed <= 500 + 2000, `firstbyte switch within budget firstByteMs+2000 (elapsed=${elapsed}ms)`);
}

async function sMidstreamAfterToolCall(): Promise<void> {
  // Turn 1: A fully emits a tool call (executed once). Turn 2: A aborts right
  // after the tool result is sent back; the tool result must flow to the
  // fallback target and never be re-executed.
  const mA = await mock({ label: 'MT', fail: 'midstream-after-toolcall' });
  const mB = await mock({ label: 'MB2' });
  const h = newRouter();
  const chain = mkChain('mat', [httpTarget(mA.url, 'm1'), httpTarget(mB.url, 'm2')]);
  const msgs0 = [userMsg('use the tool')];

  const t1 = await runTurn(h.router, chain, msgs0, { tools: [READ_TOOL] });
  check(t1.result.ok, 'turn1 ok (tool call emitted)');
  const calls = t1.emitted.filter((p): p is { kind: 'toolCall'; callId: string; name: string; input: unknown } => p.kind === 'toolCall');
  check(calls.length === 1, 'one tool call emitted');
  const extra = await runToolCall(mA.url, calls[0]);
  check(mA.count === 1, `side_effects=1 after echo (got ${mA.count})`);

  const t2 = await runTurn(h.router, chain, [...msgs0, ...extra]);
  check(t2.result.ok, 'turn2 ok via fallback');
  check(!t2.result.attempts[0].ok && t2.result.attempts[0].emittedParts > 0, 'A aborted midstream after tool result');
  check(t2.result.attempts[1].ok, 'B succeeded');
  const bReq = mB.requests.chatCompletions[0];
  check(JSON.stringify(bReq?.body).includes('"role":"tool"'), 'tool result flowed to fallback target');
  check(textOf(t2.emitted).some((v) => v.includes('ANSWER-MB2-')), 'final answer complete');
  check(mA.count === 1, `side_effects stays 1 — no re-execution (got ${mA.count})`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const t0 = Date.now();
  await scenario('happy', sHappy);
  await scenario('fail502_fallback (failThenOk:2)', sFail502Fallback);
  await scenario('midstream', sMidstream);
  await scenario('all_fail', sAllFail);
  await scenario('circuit_open', sCircuitOpen);
  await scenario('tools_none', sToolsNone);
  await scenario('img_reject', sImgReject);
  await scenario('tiny', sTiny);
  await scenario('stall', sStall);
  await scenario('firstbyte', sFirstByte);
  await scenario('midstream_after_toolcall', sMidstreamAfterToolCall);
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`} (total ${Date.now() - t0}ms)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
