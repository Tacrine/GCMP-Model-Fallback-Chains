import type { Chain, RouterConfig, Target, ProxyTarget } from './types';

export const CHAIN_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** One-time migration banner gate: the notice fires only until
   * 'migrated.strippedAt' is recorded; on later loads (strippedAt set) the
   * popup is suppressed and the strip is log-only (F1 silent-point #4). */
export function shouldShowMigrationNotice(strippedAt: number | undefined): boolean {
  return strippedAt === undefined;
}

export interface ConfigLoadResult {
  config: RouterConfig;
  warnings: string[];
  /** Number of chains dropped as invalid. */
  droppedChains: number;
  /** Number of legacy http targets stripped during normalization (proxy-only). */
  droppedHttpTargets: number;
}

/** Minimal logger interface for config load errors/warnings. */
export interface ConfigSink {
  warn(msg: string): void;
  error(msg: string): void;
}

const DEFAULT_RETRY = { maxAttempts: 3, initialDelayMs: 1000, backoffFactor: 2, maxDelayMs: 15000 };
const DEFAULT_BREAKER = { failureThreshold: 3, cooldownMs: 60000 };

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
    return { config: emptyConfig(), warnings: ['config root is not an object'], droppedChains: 1, droppedHttpTargets: 0 };
  }

  const retryRaw = isRecord(raw.retry) ? raw.retry : {};
  const breakerRaw = isRecord(raw.circuitBreaker) ? raw.circuitBreaker : {};

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

  const importMode: RouterConfig['importMode'] = raw.importMode === 'exact' ? 'exact' : 'family';
  const noticeStyle: RouterConfig['noticeStyle'] = raw.noticeStyle === 'plain' ? 'plain' : 'markdown';
  const logLevel: RouterConfig['logLevel'] = (['off', 'error', 'info', 'debug'] as const).includes(raw.logLevel as never)
    ? (raw.logLevel as RouterConfig['logLevel'])
    : 'info';

  const chainsResult = normalizeChains(raw.chains, warnings, sink);

    return {
      config: {
        chains: chainsResult.chains,
        retry,
        circuitBreaker,
        maxTurnMs: posNum(raw.maxTurnMs, 600000),
        maxTargetsPerTurn: num(raw.maxTargetsPerTurn, 5, 1, 100),
        importMode,
        retryOnRateLimit: typeof raw.retryOnRateLimit === 'boolean' ? raw.retryOnRateLimit : false,
        noticeStyle,
        logLevel,
      },
      warnings,
      droppedChains: chainsResult.dropped,
      droppedHttpTargets: chainsResult.droppedHttpTargets,
    };
  }

  function emptyConfig(): RouterConfig {
    return {
      chains: [],
      retry: { ...DEFAULT_RETRY },
      circuitBreaker: { ...DEFAULT_BREAKER },
      maxTurnMs: 600000,
      maxTargetsPerTurn: 5,
      importMode: 'family',
      retryOnRateLimit: false,
      noticeStyle: 'markdown',
      logLevel: 'info',
    };
  }

  function normalizeChains(raw: unknown, warnings: string[], sink: ConfigSink): { chains: Chain[]; dropped: number; droppedHttpTargets: number } {
    const out: Chain[] = [];
    let dropped = 0;
    let droppedHttpTargets = 0;
    if (!Array.isArray(raw)) return { chains: out, dropped, droppedHttpTargets };
    const seenIds = new Set<string>();
    for (const item of raw) {
      if (!isRecord(item)) {
        sink.warn('chain is not an object; dropped');
        dropped++;
        continue;
      }
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id || !CHAIN_ID_RE.test(id)) {
        sink.warn(`chain dropped: invalid id ${JSON.stringify(id)}`);
        dropped++;
        continue;
      }
      if (seenIds.has(id)) {
        sink.warn(`chain dropped: duplicate id ${id}`);
        dropped++;
        continue;
      }
      const targets = normalizeTargets(item.targets, id, warnings, sink);
      droppedHttpTargets += targets.droppedHttp;
      if (targets.targets.length === 0) {
        sink.warn(`chain ${id} dropped: no valid targets`);
        dropped++;
        continue;
      }
      seenIds.add(id);
      out.push({
        id,
        name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id,
        targets: targets.targets,
      });
      if (targets.targets.length === 1) {
        sink.warn(`chain ${id}: single target, no fallback available`);
      }
    }
    return { chains: out, dropped, droppedHttpTargets };
  }

  function normalizeTargets(raw: unknown, chainId: string, warnings: string[], sink: ConfigSink): { targets: Target[]; droppedHttp: number } {
    const out: Target[] = [];
    let droppedHttp = 0;
    if (!Array.isArray(raw)) return { targets: out, droppedHttp };
    const seenKeys = new Set<string>();
    for (const t of raw) {
      if (!isRecord(t)) {
        sink.warn(`chain ${chainId}: target not an object; skipped`);
        continue;
      }
      const kind = t.kind;
      if (kind !== 'proxy') {
        // Legacy http targets are stripped (GCMP companion: keys live in GCMP now).
        if (kind === 'http') {
          sink.warn(`chain ${chainId}: legacy http target removed; reconfigure keys in GCMP and re-import`);
          droppedHttp++;
        } else {
          sink.warn(`chain ${chainId}: unknown target kind ${JSON.stringify(kind)}; skipped`);
        }
        continue;
      }
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
    }
    return { targets: out, droppedHttp };
  }

/** Pure extraction of legacy http-target secretRefs from a raw `chains` value
   * (migration capture — no vscode dependency, unit-testable directly).
   * Overwrite-on-load semantics are enforced by the caller (globalState.update). */
export function extractLegacySecretRefs(raw: unknown): string[] {
  const refs: string[] = [];
  if (!Array.isArray(raw)) return refs;
  for (const c of raw) {
    if (typeof c !== 'object' || c === null) continue;
    const targets = (c as Record<string, unknown>).targets;
    if (!Array.isArray(targets)) continue;
    for (const t of targets) {
      if (typeof t !== 'object' || t === null) continue;
      const rec = t as Record<string, unknown>;
      if (rec.kind === 'http' && typeof rec.secretRef === 'string' && rec.secretRef !== '') {
        refs.push(rec.secretRef);
      }
    }
  }
  return refs;
}

/** Convenience wrapper used by the extension to read vscode configuration. */
export function normalizeFromVscode(raw: unknown, sink: ConfigSink): ConfigLoadResult {
  return normalizeConfig(raw, sink);
}
