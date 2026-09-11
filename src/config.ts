import type { Chain, RouterConfig, Target, HttpTarget, ProxyTarget, ApiType } from './types';

export const CHAIN_ID_RE = /^[a-zA-Z0-9_-]+$/;

export interface ConfigLoadResult {
  config: RouterConfig;
  warnings: string[];
  /** Number of chains dropped as invalid. */
  droppedChains: number;
}

/** Minimal logger interface for config load errors/warnings. */
export interface ConfigSink {
  warn(msg: string): void;
  error(msg: string): void;
}

const DEFAULT_RETRY = { maxAttempts: 3, initialDelayMs: 1000, backoffFactor: 2, maxDelayMs: 15000 };
const DEFAULT_BREAKER = { failureThreshold: 3, cooldownMs: 60000 };
const DEFAULT_TIMEOUTS = { connectMs: 10000, headersMs: 15000, firstByteMs: 60000, stallMs: 120000 };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, def: number, min: number, max: number): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return def;
  if (v < min || v > max) return def;
  return v;
}

function posNum(v: unknown, def: number): number {
  if (typeof v !== 'number' || Number.isNaN(v) || v <= 0) return def;
  return v;
}

/** Pure validation — no vscode dependency; unit-testable directly. */
export function normalizeConfig(raw: unknown, sink: ConfigSink): ConfigLoadResult {
  const warnings: string[] = [];
  let droppedChains = 0;
  if (!isRecord(raw)) {
    return { config: emptyConfig(), warnings: ['config root is not an object'], droppedChains: 1 };
  }

  const retryRaw = isRecord(raw.retry) ? raw.retry : {};
  const breakerRaw = isRecord(raw.circuitBreaker) ? raw.circuitBreaker : {};
  const toRaw = isRecord(raw.timeouts) ? raw.timeouts : {};

  const retry = {
    maxAttempts: num(retryRaw.maxAttempts, DEFAULT_RETRY.maxAttempts, 1, 10),
    initialDelayMs: posNum(retryRaw.initialDelayMs, DEFAULT_RETRY.initialDelayMs),
    backoffFactor: posNum(retryRaw.backoffFactor, DEFAULT_RETRY.backoffFactor),
    maxDelayMs: posNum(retryRaw.maxDelayMs, DEFAULT_RETRY.maxDelayMs),
  };
  const circuitBreaker = {
    failureThreshold: num(breakerRaw.failureThreshold, DEFAULT_BREAKER.failureThreshold, 1, 100),
    cooldownMs: posNum(breakerRaw.cooldownMs, DEFAULT_BREAKER.cooldownMs),
  };
  const timeouts = {
    connectMs: posNum(toRaw.connectMs, DEFAULT_TIMEOUTS.connectMs),
    headersMs: posNum(toRaw.headersMs, DEFAULT_TIMEOUTS.headersMs),
    firstByteMs: posNum(toRaw.firstByteMs, DEFAULT_TIMEOUTS.firstByteMs),
    stallMs: posNum(toRaw.stallMs, DEFAULT_TIMEOUTS.stallMs),
  };

  const importMode: RouterConfig['importMode'] = raw.importMode === 'exact' ? 'exact' : 'family';
  const noticeStyle: RouterConfig['noticeStyle'] = raw.noticeStyle === 'plain' ? 'plain' : 'markdown';
  const logLevel: RouterConfig['logLevel'] = (['off', 'error', 'info', 'debug'] as const).includes(raw.logLevel as never)
    ? (raw.logLevel as RouterConfig['logLevel'])
    : 'info';

  const chains = normalizeChains(raw.chains, warnings, sink);

  return {
    config: {
      chains,
      retry,
      circuitBreaker,
      timeouts,
      maxTurnMs: posNum(raw.maxTurnMs, 600000),
      maxTargetsPerTurn: num(raw.maxTargetsPerTurn, 5, 1, 100),
      importMode,
      retryOnRateLimit: typeof raw.retryOnRateLimit === 'boolean' ? raw.retryOnRateLimit : false,
      noticeStyle,
      logLevel,
    },
    warnings,
    droppedChains,
  };
}

function emptyConfig(): RouterConfig {
  return {
    chains: [],
    retry: { ...DEFAULT_RETRY },
    circuitBreaker: { ...DEFAULT_BREAKER },
    timeouts: { ...DEFAULT_TIMEOUTS },
    maxTurnMs: 600000,
    maxTargetsPerTurn: 5,
    importMode: 'family',
    retryOnRateLimit: false,
    noticeStyle: 'markdown',
    logLevel: 'info',
  };
}

function normalizeChains(raw: unknown, warnings: string[], sink: ConfigSink): Chain[] {
  const out: Chain[] = [];
  if (!Array.isArray(raw)) return out;
  const seenIds = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) {
      sink.warn('chain is not an object; dropped');
      continue;
    }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || !CHAIN_ID_RE.test(id)) {
      sink.warn(`chain dropped: invalid id ${JSON.stringify(id)}`);
      continue;
    }
    if (seenIds.has(id)) {
      sink.warn(`chain dropped: duplicate id ${id}`);
      continue;
    }
    const targets = normalizeTargets(item.targets, id, warnings, sink);
    if (targets.length === 0) {
      sink.warn(`chain ${id} dropped: no valid targets`);
      continue;
    }
    seenIds.add(id);
    out.push({
      id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id,
      targets,
    });
    if (targets.length === 1) {
      sink.warn(`chain ${id}: single target, no fallback available`);
    }
  }
  return out;
}

function normalizeTargets(raw: unknown, chainId: string, warnings: string[], sink: ConfigSink): Target[] {
  const out: Target[] = [];
  if (!Array.isArray(raw)) return out;
  const seenKeys = new Set<string>();
  for (const t of raw) {
    if (!isRecord(t)) {
      sink.warn(`chain ${chainId}: target not an object; skipped`);
      continue;
    }
    const kind = t.kind;
    if (kind !== 'http' && kind !== 'proxy') {
      sink.warn(`chain ${chainId}: unknown target kind ${JSON.stringify(kind)}; skipped`);
      continue;
    }
    if (kind === 'proxy') {
      const vendor = typeof t.vendor === 'string' ? t.vendor : '';
      const modelId = typeof t.modelId === 'string' ? t.modelId : '';
      // Reject self-recursion: routing to our own vendor would recurse forever.
      if (vendor === 'fallbackrouter') {
        sink.warn(`chain ${chainId}: proxy target with vendor "fallbackrouter" dropped (self-recursion)`);
        continue;
      }
      if (!vendor || !modelId) {
        sink.warn(`chain ${chainId}: proxy target missing vendor/modelId; skipped`);
        continue;
      }
      const key = `proxy:${vendor}/${modelId}`;
      if (seenKeys.has(key)) {
        sink.warn(`chain ${chainId}: duplicate proxy target ${key}; skipped`);
        continue;
      }
      seenKeys.add(key);
      out.push({ kind: 'proxy', vendor, modelId } satisfies ProxyTarget);
      continue;
    }
    // kind === 'http'
    const baseUrl = typeof t.baseUrl === 'string' ? t.baseUrl.trim() : '';
    const model = typeof t.model === 'string' ? t.model.trim() : '';
    const secretRef = typeof t.secretRef === 'string' ? t.secretRef.trim() : '';
    if (!baseUrl || !model) {
      sink.warn(`chain ${chainId}: http target missing baseUrl/model; skipped`);
      continue;
    }
    const apiTypeRaw = t.apiType;
    if (apiTypeRaw !== 'chat-completions' && apiTypeRaw !== 'responses') {
      sink.warn(`chain ${chainId}: http target invalid apiType ${JSON.stringify(apiTypeRaw)}; skipped`);
      continue;
    }
    const apiType: ApiType = apiTypeRaw;
    const key = `http:${baseUrl}/${model}`;
    if (seenKeys.has(key)) {
      sink.warn(`chain ${chainId}: duplicate http target ${key}; skipped`);
      continue;
    }
    seenKeys.add(key);
    out.push({
      kind: 'http',
      baseUrl,
      apiType,
      model,
      secretRef,
      maxInputTokens: posNum(t.maxInputTokens, 128000),
      maxOutputTokens: posNum(t.maxOutputTokens, 4096),
      toolCalling: typeof t.toolCalling === 'boolean' ? t.toolCalling : true,
      imageInput: typeof t.imageInput === 'boolean' ? t.imageInput : false,
      customHeader: isRecord(t.customHeader) ? (t.customHeader as Record<string, string>) : undefined,
      modelsEndpoint: typeof t.modelsEndpoint === 'string' ? t.modelsEndpoint : undefined,
    } satisfies HttpTarget);
  }
  return out;
}

/** Convenience wrapper used by the extension to read vscode configuration. */
export function normalizeFromVscode(raw: unknown, sink: ConfigSink): ConfigLoadResult {
  return normalizeConfig(raw, sink);
}
