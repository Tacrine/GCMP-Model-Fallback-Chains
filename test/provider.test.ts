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

type FakeModel = { vendor: string; id: string; maxInputTokens?: number };

function stubSelect(bySelector: (vendor: string, id: string) => FakeModel[]): void {
  (vscodeMock.lm as { selectChatModels: (s: { vendor?: string; id?: string }) => Promise<FakeModel[]> }).selectChatModels =
    (s) => Promise.resolve(bySelector(s.vendor ?? '', s.id ?? ''));
}

beforeEach(() => {
  (vscodeMock.lm as { selectChatModels: () => Promise<never[]> }).selectChatModels = async () => [];
  vi.clearAllMocks();
  vscodeMock.__resetSinks();
});

describe('FallbackRouterProvider.refresh (live metadata merge, T3)', () => {
  it('builds one model per chain and emits change event; token caps = chain min', async () => {
    const cfg = makeConfig([
      { id: 'deepseek', name: 'deepseek', targets: [
        { kind: 'proxy', vendor: 'gcmp.compatible', modelId: 'deepseek/deepseek-chat' },
        { kind: 'proxy', vendor: 'gcmp.compatible', modelId: 'deepseek/deepseek-reasoner' },
      ]},
      { id: 'gpt', name: 'gpt', targets: [{ kind: 'proxy', vendor: 'gcmp.compatible', modelId: 'openai/gpt-4o' }] },
    ]);
    stubSelect((vendor, id) => {
      if (vendor !== 'gcmp.compatible') return [];
      const caps: Record<string, number> = {
        'deepseek/deepseek-chat': 64000,
        'deepseek/deepseek-reasoner': 128000,
        'openai/gpt-4o': 128000,
      };
      return [{ vendor, id, maxInputTokens: caps[id] ?? 0 }];
    });
    const p = makeProvider(cfg);
    const listener = vi.fn();
    p.onDidChangeLanguageModelChatInformation(listener);
    await p.refresh();
    const models = await p.provideLanguageModelChatInformation({}, { isCancellationRequested: false, onCancellationRequested: () => () => {} } as never);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(models).toHaveLength(2);
    const ds = models.find((m) => m.id === 'fallbackrouter:deepseek')!;
    expect(ds.name).toBe('deepseek (fallback)');
    expect(ds.maxInputTokens).toBe(64000); // min across targets from live metadata
    // 1.137 selectChatModels exposes no maxOutputTokens -> conservative default.
    expect(ds.maxOutputTokens).toBe(4096);
    // Platform metadata has no capabilities on 1.137 -> toolCalling never
    // downgraded optimistically, imageInput not claimed without proof.
    expect(ds.capabilities.toolCalling).toBe(true);
    expect(ds.capabilities.imageInput).toBe(false);
  });

  it('falls back to conservative defaults when a target is unresolvable', async () => {
    const cfg = makeConfig([{ id: 'noop', name: 'noop', targets: [
      { kind: 'proxy', vendor: 'gcmp.compatible', modelId: 'no/such-model' },
    ]}]);
    stubSelect(() => []);
    const p = makeProvider(cfg);
    await p.refresh();
    const models = await p.provideLanguageModelChatInformation({}, {} as never);
    expect(models).toHaveLength(1);
    expect(models[0].maxInputTokens).toBe(128000); // conservative default cap
    expect(models[0].capabilities.toolCalling).toBe(true);
    expect(models[0].capabilities.imageInput).toBe(false);
  });

  it('provides token count estimate', async () => {
    const cfg = makeConfig([{ id: 'a', name: 'a', targets: [{ kind: 'proxy', vendor: 'gcmp.compatible', modelId: 'openai/gpt-4o' }] }]);
    stubSelect((vendor, id) => [{ vendor, id, maxInputTokens: 128000 }]);
    const p = makeProvider(cfg);
    await p.refresh();
    const n = await p.provideTokenCount({} as never, 'hello world', {} as never);
    expect(n).toBeGreaterThan(0);
  });

  it('silent information request returns models without UI', async () => {
    const cfg = makeConfig([{ id: 'a', name: 'a', targets: [{ kind: 'proxy', vendor: 'gcmp.compatible', modelId: 'openai/gpt-4o' }] }]);
    stubSelect((vendor, id) => [{ vendor, id, maxInputTokens: 128000 }]);
    const p = makeProvider(cfg);
    await p.refresh();
    const models = await p.provideLanguageModelChatInformation({ silent: true }, {} as never);
    expect(models).toHaveLength(1);
    expect(vscodeMock.__channelLines()).toHaveLength(0);
  });

    it('lets the newest refresh win when overlapping refreshes race (F2 generation guard)', async () => {
      // Config object is mutable — the import path swaps config mid-flight.
      // Provider must read the MUTABLE outer cfg (direct deps, not makeProvider).
      let cfg = makeConfig([{ id: 'old', name: 'old', targets: [{ kind: 'proxy', vendor: 'gcmp.compatible', modelId: 'old-model' }] }]);
      const p = new FallbackRouterProvider({
        getConfig: () => cfg,
        getSecretsProvider: () => async () => [],
        secrets: stubSecrets as never,
        context: stubContext,
        logger: stubLogger as never,
        statusBar: stubStatus as never,
      });
      let releaseR1!: () => void;
      const gate = new Promise<void>((r) => { releaseR1 = r; });
      // First refresh hangs on selectChatModels for the OLD chain…
      let r1Resolved = 0;
      (vscodeMock.lm as { selectChatModels: (s: { id?: string }) => Promise<FakeModel[]> }).selectChatModels = async (s) => {
        if (s.id === 'old-model') {
          r1Resolved++;
          await gate;
          return [{ vendor: 'gcmp.compatible', id: 'old-model', maxInputTokens: 64000 }];
        }
        return [{ vendor: 'gcmp.compatible', id: 'new-model', maxInputTokens: 128000 }];
      };
      const r1 = p.refresh();
      // …while the second refresh (new config) completes first.
      cfg = makeConfig([{ id: 'new', name: 'new', targets: [{ kind: 'proxy', vendor: 'gcmp.compatible', modelId: 'new-model' }] }]);
      await p.refresh();
      // Release the stale refresh; its gen is superseded → must self-dismiss.
      releaseR1();
      await r1;
      expect(r1Resolved).toBeGreaterThan(0);
      const models = await p.provideLanguageModelChatInformation({}, {} as never);
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('fallbackrouter:new'); // stale snapshot never installed
    });
  });