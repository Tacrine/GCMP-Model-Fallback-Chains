/**
 * Deterministic proxy fault-injection QA driver (plan todo 4).
 *
 * The http stack is gone: delegation happens through vscode.lm into existing
 * BYOK providers (GCMP). Real delegation is proven once, in extension host,
 * by the T1 spike (npm run test:e2e). This driver injects faults into a stub
 * LmLike (no VS Code, no network) and asserts ProxyTransport + FallbackRouter
 * behavior: retryable classification, NoPermissions passthrough, cancellation
 * propagation, chain fallback.
 *
 * Run: npm run qa:faults   (bundles this file with esbuild, then executes)
 *
 * Exit code 0 when every scenario prints a PASS line; 1 otherwise.
 */

import { ProxyTransport } from '../../src/transport/proxyTransport';
import type { LmLike, ChatModelLike, ChatPartLike } from '../../src/transport/proxyTransport';
import { FallbackRouter, RouterError } from '../../src/router/router';
import { CircuitBreaker } from '../../src/router/circuitBreaker';
import type {
  Cancel, Chain, LangMsg, LangPart, Logger, Target,
} from '../../src/types';
import { Role } from '../../src/types';

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const CANCEL: Cancel = {
  isCancellationRequested: false,
  onCancellationRequested: () => () => {},
};

function check(cond: boolean, label: string): boolean {
  if (cond) {
    console.log(`  ok: ${label}`);
    return true;
  }
  console.log(`  FAIL: ${label}`);
  return false;
}

let failures = 0;

async function* iter(parts: ChatPartLike[]): AsyncIterable<ChatPartLike> {
  for (const p of parts) yield p;
}

function silentLogger(): Logger {
  return { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
}

/** Stub model with scripted sendRequest behavior. */
function mockModel(vendor: string, id: string, behavior: {
  fail?: { code?: string; message?: string };
  parts?: ChatPartLike[];
}): ChatModelLike {
  return {
    vendor,
    id,
    async sendRequest() {
      if (behavior.fail) {
        const err = new Error(behavior.fail.message ?? 'boom') as Error & { code?: string };
        if (behavior.fail.code) err.code = behavior.fail.code;
        throw err;
      }
      return { stream: iter(behavior.parts ?? []) };
    },
  };
}

function lmStub(models: ChatModelLike[]): LmLike {
  return {
    selectChatModels: async (sel) =>
      models.filter((m) => (sel.vendor === undefined || m.vendor === sel.vendor) && (sel.id === undefined || m.id === sel.id)),
  };
}

/** ProxyTransport with identity conversion (mirrors provider.ts proxy wiring). */
function proxyTransport(lm: LmLike): ProxyTransport {
  return new ProxyTransport({
    logger: silentLogger(),
    lm,
    toUpstreamMessages: (msgs) => msgs as unknown[],
    toUpstreamPart: (p) => p as unknown as ChatPartLike,
    toDownstreamPart: (p) => p as unknown as LangPart,
  });
}

function userMsg(text: string): LangMsg {
  return { role: Role.User, parts: [{ kind: 'text', value: text }] };
}

function mkChain(id: string, targets: Target[]): Chain {
  return { id, name: id, targets };
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

async function s01PreflightMiss(): Promise<boolean> {
  console.log('s01: unresolved target (selectChatModels empty) → hard fail, not retryable');
  const t = proxyTransport(lmStub([]));
  const out = await t.send(
    { kind: 'proxy', vendor: 'gcmp.compatible', modelId: 'ghost' },
    [userMsg('hi')],
    {},
    () => {},
    CANCEL,
  );
  return check(!out.ok && out.retryable === false && String((out.error as Error)?.message).includes('未找到'), 'miss → retryable=false + 未找到');
}

async function s02NoPermissions(): Promise<boolean> {
  console.log('s02: NoPermissions → NOT retryable, error passed through unchanged');
  const m = mockModel('gcmp.foo', 'm', { fail: { code: 'NoPermissions', message: 'user declined' } });
  const t = proxyTransport(lmStub([m]));
  const out = await t.send(
    { kind: 'proxy', vendor: 'gcmp.foo', modelId: 'm' },
    [userMsg('hi')],
    {},
    () => {},
    CANCEL,
  );
  const e = out.error as Error & { code?: string };
  return check(!out.ok && out.retryable === false, 'NoPermissions retryable=false')
    && check(e?.message === 'user declined' && e?.code === 'NoPermissions', 'error passthrough intact');
}

async function s03QuotaExceeded(): Promise<boolean> {
  console.log('s03: quotaExceeded → retryable (rate/usage class)');
  const m = mockModel('gcmp.foo', 'm', { fail: { code: 'quotaExceeded', message: 'out of quota' } });
  const t = proxyTransport(lmStub([m]));
  const out = await t.send(
    { kind: 'proxy', vendor: 'gcmp.foo', modelId: 'm' },
    [userMsg('hi')],
    {},
    () => {},
    CANCEL,
  );
  return check(!out.ok && out.retryable === true, 'quotaExceeded retryable=true');
}

async function s04NetworkError(): Promise<boolean> {
  console.log('s04: network-style error → retryable');
  const m = mockModel('gcmp.foo', 'm', { fail: { message: 'fetch failed' } });
  const t = proxyTransport(lmStub([m]));
  const out = await t.send(
    { kind: 'proxy', vendor: 'gcmp.foo', modelId: 'm' },
    [userMsg('hi')],
    {},
    () => {},
    CANCEL,
  );
  return check(!out.ok && out.retryable === true, 'network error retryable=true');
}

async function s05StreamOk(): Promise<boolean> {
  console.log('s05: healthy stream → ok, parts counted and emitted');
  const m = mockModel('gcmp.foo', 'm', {
    parts: [
      { kind: 'text', value: 'hel' },
      { kind: 'text', value: 'lo' },
    ],
  });
  const t = proxyTransport(lmStub([m]));
  const emitted: LangPart[] = [];
  const out = await t.send(
    { kind: 'proxy', vendor: 'gcmp.foo', modelId: 'm' },
    [userMsg('hi')],
    {},
    (p) => emitted.push(p),
    CANCEL,
  );
  return check(out.ok && out.emittedParts === 2 && emitted.length === 2, 'ok + 2 parts emitted')
    && check(emitted.every((p) => p.kind === 'text'), 'parts are text');
}

async function s06Cancellation(): Promise<boolean> {
  console.log('s06: cancelled mid-turn → cancelled outcome, not retryable');
  const m = mockModel('gcmp.foo', 'm', { parts: [{ kind: 'text', value: 'x' }] });
  const t = proxyTransport(lmStub([m]));
  let cancelled = false;
  const token: Cancel = {
    get isCancellationRequested() { return cancelled; },
    onCancellationRequested: () => () => {},
  };
  const out = await (async () => {
    const p = t.send({ kind: 'proxy', vendor: 'gcmp.foo', modelId: 'm' }, [userMsg('hi')], {}, () => {}, token);
    cancelled = true; // platform cancels before/while streaming
    return p;
  })();
  return check(!out.ok && out.retryable === false, 'cancelled retryable=false');
}

async function s07ChainFallbackAcrossNoPermissions(): Promise<boolean> {
  console.log('s07: chain [NoPermissions target, healthy target] → non-retryable failure moves to next target');
  const boom = mockModel('gcmp.a', 'x', { fail: { code: 'NoPermissions', message: 'blocked' } });
  const ok = mockModel('gcmp.b', 'y', { parts: [{ kind: 'text', value: 'from second' }] });
  const transport = proxyTransport(lmStub([boom, ok]));
  const breakers = new Map<string, CircuitBreaker>();
  const router = new FallbackRouter({
    transports: () => transport,
    breakers,
    breakerFactory: (key) => new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60000 }),
    logger: silentLogger(),
  });
  const emitted: LangPart[] = [];
  const result = await router.run(
    mkChain('c1', [
      { kind: 'proxy', vendor: 'gcmp.a', modelId: 'x' },
      { kind: 'proxy', vendor: 'gcmp.b', modelId: 'y' },
    ]),
    [userMsg('go')],
    {
      tools: [],
      retry: { maxAttempts: 2, initialDelayMs: 20, backoffFactor: 2, maxDelayMs: 100 },
      circuitBreaker: { failureThreshold: 2, cooldownMs: 60000 },
      maxTurnMs: 5000,
      maxTargetsPerTurn: 4,
      retryOnRateLimit: false,
    },
    (p) => emitted.push(p),
    CANCEL,
  );
  return check(result.ok && emitted.some((p) => p.kind === 'text' && p.value === 'from second'), 'second target served the turn')
    && check(result.attempts.filter((a) => a.targetKey === 'proxy:gcmp.a/x' && !a.ok).length >= 1, 'boom target recorded as failed')
    && check(result.attempts.filter((a) => a.targetKey === 'proxy:gcmp.b/y' && a.ok).length === 1, 'ok target recorded ok');
}

async function s08ChainAllNoPermissions(): Promise<boolean> {
  console.log('s08: whole chain NoPermissions → run throws RouterError, cause preserved');
  const boom = mockModel('gcmp.a', 'x', { fail: { code: 'NoPermissions', message: 'nope' } });
  const transport = proxyTransport(lmStub([boom]));
  const router = new FallbackRouter({
    transports: () => transport,
    breakers: new Map(),
    breakerFactory: (key) => new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60000 }),
    logger: silentLogger(),
  });
  let thrown: unknown;
  try {
    await router.run(
      mkChain('c1', [{ kind: 'proxy', vendor: 'gcmp.a', modelId: 'x' }]),
      [userMsg('go')],
      {
        tools: [],
        retry: { maxAttempts: 2, initialDelayMs: 20, backoffFactor: 2, maxDelayMs: 100 },
        circuitBreaker: { failureThreshold: 2, cooldownMs: 60000 },
        maxTurnMs: 5000,
        maxTargetsPerTurn: 4,
        retryOnRateLimit: false,
      },
      () => {},
      CANCEL,
    );
  } catch (e) {
    thrown = e;
  }
  const err = thrown as { code?: string; chainId?: string; cause?: { code?: string; message?: string } } | undefined;
  return check(thrown instanceof RouterError, 'RouterError thrown when chain exhausted')
    && check((err?.cause as { code?: string } | undefined)?.code === 'NoPermissions', 'NoPermissions cause preserved');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const scenarios: Array<() => Promise<boolean>> = [
    s01PreflightMiss,
    s02NoPermissions,
    s03QuotaExceeded,
    s04NetworkError,
    s05StreamOk,
    s06Cancellation,
    s07ChainFallbackAcrossNoPermissions,
    s08ChainAllNoPermissions,
  ];
  for (const s of scenarios) {
    if (!(await s())) failures++;
  }
  console.log(failures === 0 ? '\nALL QA SCENARIOS PASS' : `\n${failures} QA SCENARIO(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();