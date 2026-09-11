import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscodeMock from './helpers/vscode-mock';

vi.mock('vscode', () => vscodeMock);

import { FallbackRouterProvider } from '../src/provider';
import type { RouterConfig } from '../src/types';

function makeConfig(chains: RouterConfig['chains']): RouterConfig {
  return {
    chains,
    retry: { maxAttempts: 3, initialDelayMs: 1000, backoffFactor: 2, maxDelayMs: 15000 },
    circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
    timeouts: { connectMs: 10000, headersMs: 15000, firstByteMs: 60000, stallMs: 120000 },
    maxTurnMs: 600000,
    maxTargetsPerTurn: 5,
    importMode: 'family',
    retryOnRateLimit: false,
    noticeStyle: 'markdown',
    logLevel: 'info',
  };
}

const stubLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
const stubStatus = { setChain: vi.fn(), show: vi.fn(), hide: vi.fn(), dispose: vi.fn() };
const stubSecrets = { get: vi.fn(async () => undefined), store: vi.fn(), delete: vi.fn() };
const stubContext = {
  globalState: { get: vi.fn(() => undefined), update: vi.fn(async () => undefined), keys: () => [] },
} as never;

function makeProvider(cfg: RouterConfig) {
  return new FallbackRouterProvider({
    getConfig: () => cfg,
    getSecretsProvider: () => async () => [],
    secrets: stubSecrets as never,
    context: stubContext,
    logger: stubLogger as never,
    statusBar: stubStatus as never,
  });
}

describe('FallbackRouterProvider.refresh', () => {
  beforeEach(() => { vi.clearAllMocks(); vscodeMock.__resetSinks(); });

  it('builds one model per chain and emits change event', async () => {
    const cfg = makeConfig([
      { id: 'deepseek', name: 'deepseek', targets: [
        { kind: 'http', baseUrl: 'a', apiType: 'chat-completions', model: 'm', secretRef: 'r', maxInputTokens: 64000, maxOutputTokens: 2048, toolCalling: true },
        { kind: 'http', baseUrl: 'b', apiType: 'responses', model: 'm', secretRef: 'r', maxInputTokens: 128000, maxOutputTokens: 4096, toolCalling: true },
      ]},
      { id: 'gpt', name: 'gpt', targets: [{ kind: 'http', baseUrl: 'c', apiType: 'chat-completions', model: 'm', secretRef: 'r' }] },
    ]);
    const p = makeProvider(cfg);
    const listener = vi.fn();
    p.onDidChangeLanguageModelChatInformation(listener);
    p.refresh();
    const models = await p.provideLanguageModelChatInformation({}, { isCancellationRequested: false, onCancellationRequested: () => () => {} } as never);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(models).toHaveLength(2);
    const ds = models.find((m) => m.id === 'fallbackrouter:deepseek')!;
    expect(ds.name).toBe('deepseek (fallback)');
    expect(ds.maxInputTokens).toBe(64000); // min across targets
    expect(ds.maxOutputTokens).toBe(2048);
    expect(ds.capabilities.toolCalling).toBe(true);
  });

  it('reflects toolCalling false when no target supports it and imageInput only when all support', async () => {
    const cfg = makeConfig([{ id: 'noop', name: 'noop', targets: [
      { kind: 'http', baseUrl: 'a', apiType: 'chat-completions', model: 'm', secretRef: 'r', toolCalling: false, imageInput: true },
    ]}]);
    const p = makeProvider(cfg);
    p.refresh();
    const models = await p.provideLanguageModelChatInformation({}, {} as never);
    expect(models[0].capabilities.toolCalling).toBe(false);
    expect(models[0].capabilities.imageInput).toBe(true);
  });

  it('provides token count estimate', async () => {
    const cfg = makeConfig([{ id: 'a', name: 'a', targets: [{ kind: 'http', baseUrl: 'a', apiType: 'chat-completions', model: 'm', secretRef: 'r' }] }]);
    const p = makeProvider(cfg);
    p.refresh();
    const n = await p.provideTokenCount({} as never, 'hello world', {} as never);
    expect(n).toBeGreaterThan(0);
  });

  it('silent information request returns models without UI', async () => {
    const cfg = makeConfig([{ id: 'a', name: 'a', targets: [{ kind: 'http', baseUrl: 'a', apiType: 'chat-completions', model: 'm', secretRef: 'r' }] }]);
    const p = makeProvider(cfg);
    p.refresh();
    const models = await p.provideLanguageModelChatInformation({ silent: true }, {} as never);
    expect(models).toHaveLength(1);
    expect(vscodeMock.__channelLines()).toHaveLength(0);
  });
});
