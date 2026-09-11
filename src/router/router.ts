import type { Cancel, Chain, LangMsg, LangPart, SendOptions, Target, Transport, ToolDef, Logger } from '../types';
import { CircuitBreaker, StateStore } from './circuitBreaker';

export interface RouterDeps {
  transports: (target: Target) => Transport;
  breakers: Map<string, CircuitBreaker>;
  breakerFactory: (key: string) => CircuitBreaker;
  now?: () => number;
  logger: Logger;
}

export interface RunOptions extends SendOptions {
  retry: { maxAttempts: number; initialDelayMs: number; backoffFactor: number; maxDelayMs: number };
  circuitBreaker: { failureThreshold: number; cooldownMs: number };
  maxTurnMs: number;
  maxTargetsPerTurn: number;
  retryOnRateLimit: boolean;
}

export interface AttemptRecord {
  targetKey: string;
  ok: boolean;
  error?: unknown;
  retryable?: boolean;
  attemptsMade: number;
  emittedParts: number;
  emittedToolCall: boolean;
  skippedReason?: string;
}

export interface RunResult {
  ok: boolean;
  attempts: AttemptRecord[];
  /** parts emitted (only from the successful/last source) */
  emittedParts: number;
  error?: unknown;
  /** true when the final failure happened after a tool call was emitted */
  abortedAfterToolCall?: boolean;
}

/** Error shape thrown when the whole chain is exhausted or deadline hit. */
export class RouterError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly chainId: string,
    readonly targetKey?: string,
    readonly cause?: unknown
  ) {
    super(message);
  }
}

export class CancellationError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancellationError';
  }
}

function sleep(ms: number, token: Cancel): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = () => {
      cleanup();
      resolve(false);
    };
    const tick = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      disp();
    };
    const disp = token.onCancellationRequested(done);
    timer = setTimeout(tick, ms);
  });
}

function targetKey(t: Target): string {
  return t.kind === 'proxy' ? `proxy:${t.vendor}/${t.modelId}` : `http:${t.baseUrl}/${t.model}`;
}

/** Fixed retryable classification table (from T1 empirical shape). */
export function classifyRetryable(error: unknown, retryOnRateLimit: boolean): boolean {
  if (error instanceof CancellationError) return false;
  if (isHttpStatus(error, 401) || isHttpStatus(error, 403)) return false;
  if (isHttpStatus(error, 429)) return retryOnRateLimit;
  if (isHttpStatus(error, [500, 502, 503, 504])) return true;
  const code = errorCode(error);
  if (code === 'NoPermissions' || code === 'Blocked' || code === 'NotFound') return false;
  if (code === 'rateLimited' || code === 'quotaExceeded') return retryOnRateLimit;
  if (code === 'refusal' || code === 'filtered' || code === 'offTopic') return false;
  if (code === 'canceled') return false;
  return true;
}

function errorCode(e: unknown): string | undefined {
  if (e && typeof e === 'object') {
    const o = e as { code?: unknown; name?: unknown; message?: unknown };
    if (typeof o.code === 'string') return o.code;
    if (o.name === 'TimeoutError' || o.name === 'AbortError' || o.name === 'ECONNREFUSED' || o.name === 'ETIMEDOUT') return o.name;
  }
  return undefined;
}

function isHttpStatus(e: unknown, status: number | number[]): boolean {
  if (e && typeof e === 'object') {
    const o = e as { status?: unknown; statusCode?: unknown };
    const s = typeof o.status === 'number' ? o.status : typeof o.statusCode === 'number' ? o.statusCode : undefined;
    if (s === undefined) return false;
    return Array.isArray(status) ? status.includes(s) : s === status;
  }
  return false;
}

function isRetryableHttp(e: unknown, retryOnRateLimit: boolean): boolean {
  if (isHttpStatus(e, [500, 502, 503, 504])) return true;
  if (isHttpStatus(e, 429)) return retryOnRateLimit;
  return false;
}

export function classifyRetryableExplicit(error: unknown, retryOnRateLimit: boolean): boolean {
  // Compose: explicit HTTP + code rules, falling back to generic network classification.
  if (error instanceof CancellationError) return false;
  if (isHttpStatus(error, [401, 403])) return false;
  if (isRetryableHttp(error, retryOnRateLimit)) return true;
  if (isHttpStatus(error, 429) && !retryOnRateLimit) return false;
  return classifyRetryable(error, retryOnRateLimit);
}

/** Compute per-attempt backoff delay. */
export function backoffDelay(attempt: number, opts: RunOptions['retry']): number {
  // attempt is 0-based.
  const exp = Math.pow(opts.backoffFactor, attempt);
  return Math.min(opts.initialDelayMs * exp, opts.maxDelayMs);
}

export interface NoticeEmitter {
  (part: LangPart): void;
}

/**
 * The fallback router core. Pure logic — no vscode, no HTTP.
 * Transport, breaker store, logger are all injected.
 */
export class FallbackRouter {
  constructor(private readonly deps: RouterDeps) {}

  private breaker(key: string): CircuitBreaker {
    const existing = this.deps.breakers.get(key);
    if (existing) return existing;
    const b = this.deps.breakerFactory(key);
    this.deps.breakers.set(key, b);
    return b;
  }

  async run(
    chain: Chain,
    messages: readonly LangMsg[],
    options: RunOptions,
    emit: NoticeEmitter,
    token: Cancel
  ): Promise<RunResult> {
    const started = (this.deps.now ?? Date.now)();
    const deadline = started + options.maxTurnMs;
    const attempts: AttemptRecord[] = [];
    let emittedPartsTotal = 0;

    // Preflight: message profile.
    const needsTools = !!options.tools && options.tools.length > 0;
    const hasDataParts = messages.some((m) => m.parts.some((p) => p.kind === 'data'));
    const msgTokenCount = estimateTokens(messages);

    const targets = chain.targets.slice(0, options.maxTargetsPerTurn);

    for (const target of targets) {
      if (token.isCancellationRequested) throw new CancellationError();
      const key = targetKey(target);
      const transport = this.deps.transports(target);

      // Static target-capability preflight (transport-agnostic).
      const skip = (reason: string): void => {
        attempts.push({
          targetKey: key, ok: false, skippedReason: reason, attemptsMade: 0,
          emittedParts: 0, emittedToolCall: false,
        });
        this.deps.logger.warn(`[router] skip ${key}: ${reason}`);
      };
      if (target.kind === 'http') {
        if (needsTools && target.toolCalling === false) { skip('target does not support tool calling'); continue; }
        if (hasDataParts && target.imageInput !== true) { skip('target does not support image input'); continue; }
        if (target.maxInputTokens !== undefined && msgTokenCount > target.maxInputTokens) {
          skip(`input tokens ${msgTokenCount} exceed maxInputTokens ${target.maxInputTokens}`);
          continue;
        }
      }

      // Transport preflight skip.
      const handle = transport.canHandle(target, needsTools, hasDataParts, msgTokenCount);
      if (!handle.ok) {
        attempts.push({
          targetKey: key, ok: false, skippedReason: handle.reason, attemptsMade: 0,
          emittedParts: 0, emittedToolCall: false,
        });
        this.deps.logger.warn(`[router] skip ${key}: ${handle.reason}`);
        continue;
      }

      const breaker = this.breaker(key);
      if (!breaker.canAttempt(this.deps.now ? this.deps.now() : undefined)) {
        attempts.push({
          targetKey: key, ok: false, skippedReason: 'circuit open', attemptsMade: 0,
          emittedParts: 0, emittedToolCall: false,
        });
        this.deps.logger.warn(`[router] skip ${key}: circuit open`);
        continue;
      }

      const rec: AttemptRecord = {
        targetKey: key, ok: false, attemptsMade: 0, emittedParts: 0, emittedToolCall: false,
      };
      attempts.push(rec);

      breaker.beginProbe();
      const outcome = await this.runTarget(
        target, transport, messages, options, deadline, breaker, rec, emit, token
      );
      emittedPartsTotal += rec.emittedParts;

      if (outcome.ok) {
        breaker.recordSuccess();
        rec.ok = true;
        return { ok: true, attempts, emittedParts: emittedPartsTotal };
      }

      // failure
      breaker.recordFailure();
      rec.ok = false;
      rec.error = outcome.error;
      rec.retryable = outcome.retryable;

      if (token.isCancellationRequested) throw new CancellationError();

      // Abort after tool call: never retry tool effects.
      if (rec.emittedToolCall) {
        this.deps.logger.error(`[router] ${key} failed after emitting tool call; aborting turn`);
        throw new RouterError(
          `Target ${key} failed after emitting a tool call; turn aborted to avoid re-running tools`,
          outcome.errorCode ?? 'Unknown',
          chain.id,
          key,
          outcome.error
        );
      }

      if (this.deps.now ? (this.deps.now)() : Date.now() >= deadline) {
        throw new RouterError(`Turn deadline exceeded (maxTurnMs=${options.maxTurnMs})`, 'Unknown', chain.id, key);
      }

      // Otherwise continue to next target.
    }

    // Exhausted all targets. If no target was actually attempted (every one
    // skipped by preflight/breaker), report non-ok instead of throwing.
    if (!attempts.some((a) => a.attemptsMade > 0 || a.error !== undefined)) {
      return { ok: false, attempts, emittedParts: emittedPartsTotal };
    }
    const firstErr = attempts.find((a) => a.error !== undefined && !a.skippedReason);
    throw new RouterError(
      `All targets in chain "${chain.id}" failed`,
      'Unknown',
      chain.id,
      undefined,
      firstErr?.error
    );
  }

  private async runTarget(
    target: Target,
    transport: Transport,
    messages: readonly LangMsg[],
    options: RunOptions,
    deadline: number,
    breaker: CircuitBreaker,
    rec: AttemptRecord,
    emit: NoticeEmitter,
    token: Cancel
  ): Promise<{ ok: boolean; error?: unknown; retryable?: boolean; errorCode?: string }> {
    const maxAttempts = options.retry.maxAttempts;
    let lastError: unknown;
    let lastRetryable = false;
    let lastErrorCode: string | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (token.isCancellationRequested) throw new CancellationError();
      if ((this.deps.now ?? Date.now)() >= deadline) {
        throw new RouterError(`Turn deadline exceeded (maxTurnMs=${options.maxTurnMs})`, 'Unknown', '', targetKey(target));
      }
      rec.attemptsMade = attempt + 1;
      this.deps.logger.info(`[router] target=${targetKey(target)} attempt=${attempt + 1}/${maxAttempts}`);

      // Per-target buffered emit: only forward parts once the first delta arrived
      // and reset on a clean target transition via the emit callback gate.
      let firstDeltaSeen = false;
      let emittedToolCall = false;
      let emittedParts = 0;

      const outcome = await transport.send(
        target,
        messages,
        { tools: options.tools, toolMode: options.toolMode, timeouts: options.timeouts },
        (part) => {
          // Buffered: do not forward until first meaningful delta is received.
          if (isDelta(part)) firstDeltaSeen = true;
          if (!firstDeltaSeen) return;
          if (part.kind === 'toolCall') emittedToolCall = true;
          emittedParts++;
          rec.emittedParts = emittedParts;
          rec.emittedToolCall = emittedToolCall;
          emit(part);
        },
        token
      );

      rec.emittedParts = outcome.emittedParts;
      rec.emittedToolCall = outcome.emittedToolCall;
      emittedParts = outcome.emittedParts;

      if (outcome.ok) {
        return { ok: true };
      }
      lastError = outcome.error;
      lastRetryable = !!outcome.retryable;
      lastErrorCode = (outcome.error as { code?: string } | undefined)?.code ?? errorCode(outcome.error);
      this.deps.logger.warn(`[router] target=${targetKey(target)} attempt=${attempt + 1} failed: ${describeError(outcome.error)}`);

      if (token.isCancellationRequested) throw new CancellationError();

      // Abort after tool call — never retry.
      if (outcome.emittedToolCall) {
        return { ok: false, error: lastError, retryable: false, errorCode: lastErrorCode };
      }

      // If parts were emitted (text) but not a tool call, we cannot silently retry the SAME target
      // either — retrying would duplicate output. Treat as terminal for this target.
      if (outcome.emittedParts > 0) {
        return { ok: false, error: lastError, retryable: false, errorCode: lastErrorCode };
      }

      if (!outcome.retryable) {
        return { ok: false, error: lastError, retryable: false, errorCode: lastErrorCode };
      }

      // retryable with no emitted parts: backoff then retry within this target.
      if (attempt < maxAttempts - 1) {
        const delay = backoffDelay(attempt, options.retry);
        const proceeded = await sleep(delay, token);
        if (!proceeded) throw new CancellationError();
      }
    }

    return { ok: false, error: lastError, retryable: lastRetryable, errorCode: lastErrorCode };
  }
}

function isDelta(p: LangPart): boolean {
  // Any part counts as a "delta" for buffering; tool calls are buffered until complete by transports.
  return p.kind === 'text' || p.kind === 'toolCall' || p.kind === 'data';
}

function estimateTokens(messages: readonly LangMsg[]): number {
  let n = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind === 'text') n += Math.ceil(p.value.length / 4);
      else if (p.kind === 'toolResult') n += 50;
      else if (p.kind === 'toolCall') n += 30;
      else n += 20;
    }
  }
  return n;
}

function describeError(e: unknown): string {
  if (!e) return 'unknown';
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** Count messages for token estimation (shared). */
export function countMessageTokens(messages: readonly LangMsg[]): number {
  return estimateTokens(messages);
}
