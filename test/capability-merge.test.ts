import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscodeMock from './helpers/vscode-mock';

vi.mock('vscode', () => vscodeMock);

import { FallbackRouterProvider, mergeChainCapabilities } from '../src/provider';
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

function makeProvider(cfg: RouterConfig): FallbackRouterProvider {
  return new FallbackRouterProvider({
    getConfig: () => cfg,
    getSecretsProvider: () => async () => [],
    secrets: stubSecrets as never,
    context: stubContext,
    logger: stubLogger as never,
    statusBar: stubStatus as never,
  });
}

async function infos(p: FallbackRouterProvider): Promise<Array<Record<string, unknown>>> {
  return p.provideLanguageModelChatInformation({ silent: true } as never, {} as never) as Promise<Array<Record<string, unknown>>>;
}

type FakeModel = { vendor: string; id: string; maxInputTokens?: number };

function stubSelect(bySelector: (vendor: string, id: string) => FakeModel[]): void {
  (vscodeMock.lm as { selectChatModels: (s: { vendor?: string; id?: string }) => Promise<FakeModel[]> }).selectChatModels =
    (s) => Promise.resolve(bySelector(s.vendor ?? '', s.id ?? ''));
}

beforeEach(() => {
  (vscodeMock.lm as { selectChatModels: () => Promise<never[]> }).selectChatModels = async () => [];
  vi.clearAllMocks();
});

describe('mergeChainCapabilities (pure, T3 Metis #1)', () => {
  it('ANDs toolCalling across resolvable metadata', () => {
    const caps = mergeChainCapabilities([
      { capabilities: { toolCalling: true, imageInput: true } },
      { capabilities: { toolCalling: false, imageInput: true } },
    ]);
    expect(caps.toolCalling).toBe(false);
  });

  it('ANDs imageInput across resolvable metadata', () => {
    const caps = mergeChainCapabilities([
      { capabilities: { toolCalling: true, imageInput: true } },
      { capabilities: { toolCalling: true, imageInput: false } },
    ]);
    expect(caps.imageInput).toBe(false);
  });

  it('keeps imageInput true only when every target proves it', () => {
    const caps = mergeChainCapabilities([
      { capabilities: { toolCalling: true, imageInput: true } },
      { capabilities: { toolCalling: true, imageInput: true } },
    ]);
    expect(caps.imageInput).toBe(true);
  });

  it('takes the chain min for token caps', () => {
    const caps = mergeChainCapabilities([
      { maxInputTokens: 32000, maxOutputTokens: 16000 },
      { maxInputTokens: 8000, maxOutputTokens: 4000 },
    ]);
    expect(caps.maxInputTokens).toBe(8000);
    expect(caps.maxOutputTokens).toBe(4000);
  });

  it('falls back to conservative defaults when metadata is absent', () => {
    const caps = mergeChainCapabilities([{ maxInputTokens: 32000 }, { maxInputTokens: 64000 }]);
    expect(caps.toolCalling).toBe(true); // never downgrade optimistically
    expect(caps.imageInput).toBe(false); // don't claim what we can't prove
    expect(caps.maxInputTokens).toBe(32000);
  });

  it('defaults an empty merge to platform-safe caps', () => {
    const caps = mergeChainCapabilities([]);
    expect(caps.maxInputTokens).toBe(128000);
    expect(caps.maxOutputTokens).toBe(4096);
    expect(caps.toolCalling).toBe(true);
    expect(caps.imageInput).toBe(false);
  });
});

describe('FallbackRouterProvider.refresh (async merge, no-flash swap)', () => {
  it('merges real maxInputTokens per chain and fires the change event once', async () => {
    stubSelect((vendor, id) => [
      { vendor, id, maxInputTokens: vendor === 'a' && id === 'big' ? 32000 : 16000 },
    ]);
    const p = makeProvider(makeConfig([
      { id: 'c1', name: 'c1', targets: [
        { kind: 'proxy', vendor: 'a', modelId: 'big' },
        { kind: 'proxy', vendor: 'a', modelId: 'small' },
      ] },
    ]));
    let fired = 0;
    p.onDidChangeLanguageModelChatInformation(() => { fired++; });
    await p.refresh();
    expect(fired).toBe(1);
    const list = await infos(p);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('fallbackrouter:c1');
    expect(list[0].maxInputTokens).toBe(16000);
    // Platform exposes no capabilities on LanguageModelChat (1.137) → conservative.
    expect(list[0].capabilities).toMatchObject({ toolCalling: true, imageInput: false });
  });

  it('keeps old models until the merged set fully completes (no flash)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const p = makeProvider(makeConfig([
      { id: 'c1', name: 'c1', targets: [{ kind: 'proxy', vendor: 'a', modelId: 'm' }] },
    ]));
    await p.refresh();
    const before = await infos(p);
    expect(before).toHaveLength(1);
    (vscodeMock.lm as { selectChatModels: () => Promise<never[]> }).selectChatModels = () => gate.then(() => [
      { vendor: 'a', id: 'm', maxInputTokens: 9999 },
    ]) as never;
    const pending = p.refresh();
    await Promise.resolve(); // let the merge start and await the gate
    const during = await infos(p);
    expect(during).toEqual(before); // old models still served
    release();
    await pending;
    const after = await infos(p);
    expect(after[0].maxInputTokens).toBe(9999);
  });

  it('per-model failure falls back to conservative defaults and keeps other chains', async () => {
    stubSelect((vendor, id) => {
      if (vendor === 'boom') throw new Error('select failed');
      return [{ vendor, id, maxInputTokens: 20000 }];
    });
    const p = makeProvider(makeConfig([
      { id: 'bad', name: 'bad', targets: [{ kind: 'proxy', vendor: 'boom', modelId: 'x' }] },
      { id: 'ok', name: 'ok', targets: [{ kind: 'proxy', vendor: 'a', modelId: 'y' }] },
    ]));
    await p.refresh();
    const list = await infos(p);
    expect(list).toHaveLength(2);
    const bad = list.find((x) => x.id === 'fallbackrouter:bad');
    const ok = list.find((x) => x.id === 'fallbackrouter:ok');
    expect(bad!.maxInputTokens).toBe(128000); // unresolvable → default
    expect(bad!.capabilities).toMatchObject({ imageInput: false });
    expect(ok!.maxInputTokens).toBe(20000);
  });

  it('drops chains whose targets all failed to resolve metadata, keeping valid ones', async () => {
    stubSelect(() => []);
    const p = makeProvider(makeConfig([
      { id: 'c1', name: 'c1', targets: [{ kind: 'proxy', vendor: 'a', modelId: 'none' }] },
    ]));
    await p.refresh();
    const list = await infos(p);
    expect(list).toHaveLength(1); // unresolvable targets still yield a composite
    expect(list[0].id).toBe('fallbackrouter:c1');
    expect(list[0].maxInputTokens).toBe(128000);
  });
});