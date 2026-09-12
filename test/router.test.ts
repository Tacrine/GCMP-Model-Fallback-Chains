import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker, type StateStore } from '../src/router/circuitBreaker';
import { FallbackRouter, classifyRetryable, backoffDelay, RouterError, CancellationError } from '../src/router/router';
import type { Chain, LangMsg, LangPart, SendOptions, Target, Transport, Cancel, Logger } from '../src/types';

// --- helpers ---

const noopLogger: Logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

function cancelToken(): Cancel {
  const fns: (() => void)[] = [];
  return {
    isCancellationRequested: false,
    onCancellationRequested: (fn) => { fns.push(fn); return () => { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); }; },
  };
}

function langMsg(text: string): LangMsg[] {
  return [{ role: 1, parts: [{ kind: 'text', value: text }] }];
}

function proxyTarget(modelId = 'm'): Target {
  return { kind: 'proxy', vendor: 'v1', modelId };
}

function makeTransport(behavior: (t: Target, opts: SendOptions, emit: (p: LangPart) => void) => Promise<{ ok: boolean; error?: Error; retryable?: boolean; emittedParts: number; emittedToolCall: boolean }>) {
  const t: Transport = {
    id: 'mock',
    canHandle: () => ({ ok: true }),
    async send(target, _m, opts, emit, _token) {
      return behavior(target, opts, emit);
    },
  };
  return t;
}

function runOptions(overrides: Record<string, unknown> = {}) {
  return {
    retry: { maxAttempts: 3, initialDelayMs: 1, backoffFactor: 2, maxDelayMs: 10 },
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1000 },
    maxTurnMs: 10000,
    maxTargetsPerTurn: 5,
    retryOnRateLimit: false,
    ...overrides,
  };
}

function newRouter(deps: Partial<ConstructorParameters<typeof FallbackRouter>[0]> = {}) {
  return new FallbackRouter({
    transports: (t) => deps.transports!(t),
    breakers: new Map(),
    breakerFactory: (k) => new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 }),
    logger: noopLogger,
    now: () => 0,
    ...deps,
  } as ConstructorParameters<typeof FallbackRouter>[0]);
}

// --- circuit breaker ---

describe('CircuitBreaker', () => {
  it('opens after failureThreshold and half-opens after cooldown', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: () => now });
    expect(b.canAttempt()).toBe(true);
    b.beginProbe();
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    expect(b.getState()).toBe('open');
    expect(b.canAttempt()).toBe(false);
    now = 1001;
    expect(b.canAttempt()).toBe(true);
    expect(b.getState()).toBe('halfOpen');
  });

  it('closes on half-open probe success', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10, now: () => now });
    b.beginProbe(); b.recordFailure();
    now = 11;
    expect(b.canAttempt()).toBe(true);
    b.beginProbe(); b.recordSuccess();
    expect(b.getState()).toBe('closed');
  });

  it('reopens immediately when half-open probe fails', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10, now: () => now });
    b.beginProbe(); b.recordFailure();
    now = 11;
    b.beginProbe(); b.recordFailure();
    expect(b.getState()).toBe('open');
    expect(b.canAttempt()).toBe(false);
  });

  it('allows only a single probe in half-open state', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10, now: () => now });
    b.beginProbe(); b.recordFailure();
    now = 11;
    expect(b.canAttempt()).toBe(true);
    b.beginProbe(); // in flight
    expect(b.canAttempt()).toBe(false);
  });

  it('persists open state via StateStore', () => {
    let now = 100;
    const store: StateStore = { get: () => undefined, set: vi.fn() };
    const b1 = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now, store, persistKey: 'k' });
    b1.beginProbe(); b1.recordFailure();
    expect(store.set).toHaveBeenCalledWith('k', expect.objectContaining({ state: 'open' }));
    const saved = (store.set as ReturnType<typeof vi.fn>).mock.calls[0][1] as { state: 'open' | 'closed'; openUntil: number };
    const store2: StateStore = { get: (k) => (k === 'k' ? saved : undefined), set: vi.fn() };
    const b2 = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => now, store: store2, persistKey: 'k' });
    expect(b2.getState()).toBe('open');
  });
});

// --- retry classification ---

describe('classifyRetryable', () => {
  it('classifies HTTP 5xx/429 and network errors as retryable', () => {
    expect(classifyRetryable({ status: 502 }, false)).toBe(true);
    expect(classifyRetryable({ status: 500 }, false)).toBe(true);
    expect(classifyRetryable({ status: 429 }, false)).toBe(false);
    expect(classifyRetryable({ status: 429 }, true)).toBe(true);
    expect(classifyRetryable(new Error('ECONNREFUSED'), false)).toBe(true);
  });
  it('classifies 401/403 and NoPermissions/Blocked/NotFound as non-retryable', () => {
    expect(classifyRetryable({ status: 401 }, false)).toBe(false);
    expect(classifyRetryable({ code: 'NoPermissions' }, false)).toBe(false);
    expect(classifyRetryable({ code: 'Blocked' }, false)).toBe(false);
    expect(classifyRetryable({ code: 'NotFound' }, false)).toBe(false);
  });
});

describe('backoffDelay', () => {
  it('computes exponential backoff capped at maxDelayMs', () => {
    const opts = { maxAttempts: 5, initialDelayMs: 1000, backoffFactor: 2, maxDelayMs: 15000 };
    expect(backoffDelay(0, opts)).toBe(1000);
    expect(backoffDelay(1, opts)).toBe(2000);
    expect(backoffDelay(4, opts)).toBe(15000);
  });
});

// --- router ---

describe('FallbackRouter', () => {
  it('succeeds on first target without switching', async () => {
    const emit = vi.fn();
    const transport = makeTransport(async (_t, _o, e) => { e({ kind: 'text', value: 'hello' }); return { ok: true, emittedParts: 1, emittedToolCall: false }; });
    const router = newRouter({ transports: () => transport });
    const res = await router.run({ id: 'a', name: 'a', targets: [proxyTarget('m1'), proxyTarget('m2')] }, langMsg('q'), runOptions(), emit, cancelToken());
    expect(res.ok).toBe(true);
    expect(emit).toHaveBeenCalledWith({ kind: 'text', value: 'hello' });
  });

  it('retries retryable failure to maxAttempts then switches to next target', async () => {
    const calls: string[] = [];
    const emit = vi.fn();
    const transportA = makeTransport(async () => { calls.push('A'); return { ok: false, error: new Error('http 502'), retryable: true, emittedParts: 0, emittedToolCall: false }; });
    const transportB = makeTransport(async (_t, _o, e) => { calls.push('B'); e({ kind: 'text', value: 'from B' }); return { ok: true, emittedParts: 1, emittedToolCall: false }; });
    const router = newRouter({ transports: (t) => (t.modelId === 'm1' ? transportA : transportB) });
    const res = await router.run({ id: 'a', name: 'a', targets: [proxyTarget('m1'), proxyTarget('m2')] }, langMsg('q'), runOptions({ retry: { maxAttempts: 3, initialDelayMs: 1, backoffFactor: 2, maxDelayMs: 5 } }), emit, cancelToken());
    expect(calls.filter((c) => c === 'A')).toHaveLength(3);
    expect(res.attempts[0].attemptsMade).toBe(3);
    expect(emit).toHaveBeenCalledWith({ kind: 'text', value: 'from B' });
  });

  it('throws aggregated error when all targets fail', async () => {
    const transport = makeTransport(async () => ({ ok: false, error: new Error('boom'), retryable: true, emittedParts: 0, emittedToolCall: false }));
    const router = newRouter({ transports: () => transport });
    await expect(router.run({ id: 'a', name: 'a', targets: [proxyTarget('m1'), proxyTarget('m2')] }, langMsg('q'), runOptions({ retry: { maxAttempts: 1, initialDelayMs: 1, backoffFactor: 2, maxDelayMs: 5 } }), vi.fn(), cancelToken())).rejects.toBeInstanceOf(RouterError);
  });

  it('aborts immediately after a tool call is emitted (never switches)', async () => {
    const transportA = makeTransport(async (_t, _o, e) => { e({ kind: 'toolCall', callId: 'c1', name: 'read', input: {} }); return { ok: false, error: new Error('boom after tool'), retryable: false, emittedParts: 1, emittedToolCall: true }; });
    const transportB = makeTransport(async () => ({ ok: true, emittedParts: 0, emittedToolCall: false }));
    const router = newRouter({ transports: (t) => (t.modelId === 'm1' ? transportA : transportB) });
    await expect(router.run({ id: 'a', name: 'a', targets: [proxyTarget('m1'), proxyTarget('m2')] }, langMsg('q'), runOptions({ retry: { maxAttempts: 1, initialDelayMs: 1, backoffFactor: 2, maxDelayMs: 5 } }), vi.fn(), cancelToken())).rejects.toBeInstanceOf(RouterError);
  });

  it('treats NoPermissions as non-retryable but still switches target', async () => {
    const calls: string[] = [];
    const transportA = makeTransport(async () => { calls.push('A'); return { ok: false, error: Object.assign(new Error('denied'), { code: 'NoPermissions' }), retryable: false, emittedParts: 0, emittedToolCall: false }; });
    const transportB = makeTransport(async (_t, _o, e) => { calls.push('B'); e({ kind: 'text', value: 'ok' }); return { ok: true, emittedParts: 1, emittedToolCall: false }; });
    const router = newRouter({ transports: (t) => (t.modelId === 'm1' ? transportA : transportB) });
    const res = await router.run({ id: 'a', name: 'a', targets: [proxyTarget('m1'), proxyTarget('m2')] }, langMsg('q'), runOptions({ retry: { maxAttempts: 5, initialDelayMs: 1, backoffFactor: 2, maxDelayMs: 5 } }), vi.fn(), cancelToken());
    expect(calls.filter((c) => c === 'A')).toHaveLength(1);
    expect(res.ok).toBe(true);
  });

  it('isolates circuit breakers per target', async () => {
    const transportA = makeTransport(async () => ({ ok: false, error: new Error('fail'), retryable: false, emittedParts: 0, emittedToolCall: false }));
    const transportB = makeTransport(async (_t, _o, e) => { e({ kind: 'text', value: 'B ok' }); return { ok: true, emittedParts: 1, emittedToolCall: false }; });
    // force A to open by running a chain where A always fails
    const router = newRouter({ transports: (t) => (t.modelId === 'm1' ? transportA : transportB) });
    await expect(router.run({ id: 'a', name: 'a', targets: [proxyTarget('m1')] }, langMsg('q'), runOptions({ retry: { maxAttempts: 1, initialDelayMs: 1, backoffFactor: 2, maxDelayMs: 5 } }), vi.fn(), cancelToken())).rejects.toBeInstanceOf(RouterError);
    // A's breaker now open; B still usable
    const router2 = newRouter({ transports: (t) => (t.modelId === 'm1' ? transportA : transportB) });
    const res = await router2.run({ id: 'a', name: 'a', targets: [proxyTarget('m2')] }, langMsg('q'), runOptions(), vi.fn(), cancelToken());
    expect(res.ok).toBe(true);
  });

  it('skips target whose circuit breaker is open', async () => {
      const called = vi.fn();
      const transportA = makeTransport(async () => { called(); return { ok: true, emittedParts: 0, emittedToolCall: false }; });
      const router = newRouter({ transports: () => transportA });
      // pre-open breaker for m1 — targetKey for proxy targets is `proxy:${vendor}/${modelId}`
      const key = 'proxy:v1/m1';
      const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 100000, now: () => 0 });
      breaker.beginProbe(); breaker.recordFailure();
      const deps = { breakers: new Map([[key, breaker]]), transports: () => transportA } as unknown as ConstructorParameters<typeof FallbackRouter>[0];
      const r = new FallbackRouter({ ...deps, breakerFactory: (k) => new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 }), logger: noopLogger, now: () => 0 });
      const res = await r.run({ id: 'a', name: 'a', targets: [proxyTarget('m1')] }, langMsg('q'), runOptions({ retry: { maxAttempts: 1, initialDelayMs: 1, backoffFactor: 2, maxDelayMs: 5 } }), vi.fn(), cancelToken());
      expect(res.ok).toBe(false);
      expect(called).not.toHaveBeenCalled();
      expect(res.attempts[0].skippedReason).toBe('circuit open');
    });

    it('delegates tool-request preflight to the transport (no target-level skip)', async () => {
      const called = vi.fn();
      const transport = makeTransport(async () => { called(); return { ok: true, emittedParts: 0, emittedToolCall: false }; });
      const router = newRouter({ transports: () => transport });
      const opts = runOptions();
      opts.tools = [{ name: 'read', description: '', inputSchema: {} }];
      // http-stack target-field preflight (toolCalling/maxInputTokens) was
      // removed (T3 Metis #3); proxy targets defer capability checks to the
      // upstream transport canHandle().
      const res = await router.run({ id: 'a', name: 'a', targets: [proxyTarget('m1')] }, langMsg('q'), opts, vi.fn(), cancelToken());
      expect(called).toHaveBeenCalledTimes(1);
      expect(res.ok).toBe(true);
    });

  it('respects maxTargetsPerTurn truncation', async () => {
    const calls: string[] = [];
    const transport = makeTransport(async (_t) => { calls.push((_t as { modelId: string }).modelId); return { ok: false, error: new Error('fail'), retryable: false, emittedParts: 0, emittedToolCall: false }; });
    const router = newRouter({ transports: () => transport });
    const targets = [proxyTarget('m1'), proxyTarget('m2'), proxyTarget('m3'), proxyTarget('m4')];
    await expect(router.run({ id: 'a', name: 'a', targets }, langMsg('q'), runOptions({ maxTargetsPerTurn: 2, retry: { maxAttempts: 1, initialDelayMs: 1, backoffFactor: 2, maxDelayMs: 5 } }), vi.fn(), cancelToken())).rejects.toBeInstanceOf(RouterError);
    expect(calls).toHaveLength(2);
  });

  it('stops on cancellation without trying next target', async () => {
    const token = cancelToken();
    const called = vi.fn();
    const transportA = makeTransport(async () => ({ ok: false, error: new Error('fail'), retryable: true, emittedParts: 0, emittedToolCall: false }));
    const transportB = makeTransport(async () => { called(); return { ok: true, emittedParts: 0, emittedToolCall: false }; });
    const router = newRouter({ transports: (t) => (t.modelId === 'm1' ? transportA : transportB) });
    (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
    await expect(router.run({ id: 'a', name: 'a', targets: [proxyTarget('m1'), proxyTarget('m2')] }, langMsg('q'), runOptions({ retry: { maxAttempts: 1, initialDelayMs: 1, backoffFactor: 2, maxDelayMs: 5 } }), vi.fn(), token)).rejects.toBeInstanceOf(CancellationError);
    expect(called).not.toHaveBeenCalled();
  });
});
