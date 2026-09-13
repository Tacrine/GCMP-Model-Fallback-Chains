import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscodeMock from './helpers/vscode-mock';

vi.mock('vscode', () => vscodeMock);

import { importFromLm, familyName, sanitizeChainId } from '../src/import/importer';
import type { LmModelLike } from '../src/import/importer';
import { waitForModels, writeImportChains, importGcmpFlow } from '../src/extension';
import type { Chain } from '../src/types';

// ---------------------------------------------------------------------------
// harness: mutable vscode mock surfaces
// ---------------------------------------------------------------------------

type FakeModel = { vendor: string; id: string; maxInputTokens?: number };

/** selectChatModels: returns `fallbackrouter` models only for the self-vendor
 * probe (waitForModels), everything else for the live GCMP query. */
function stubSelect(models: FakeModel[]): void {
  (vscodeMock.lm as { selectChatModels: (s: { vendor?: string }) => Promise<FakeModel[]> }).selectChatModels = (s) =>
    Promise.resolve(s.vendor === 'fallbackrouter' ? models.filter((m) => m.vendor === 'fallbackrouter') : models);
}

interface UpdateRec {
  key: string;
  value: unknown;
  target: number | undefined;
}

let cfgGetImpl: (key: string) => unknown;
let updates: UpdateRec[];

function installConfigStub(): void {
  updates = [];
  cfgGetImpl = () => undefined;
  const cfg = {
    get: (key: string, dflt?: unknown): unknown => {
      const v = cfgGetImpl(key);
      return v === undefined ? dflt : v;
    },
    update: async (key: string, value: unknown, target?: number): Promise<void> => {
      updates.push({ key, value, target });
    },
  };
  (vscodeMock.workspace as { getConfiguration: () => unknown }).getConfiguration = () => cfg;
}

const gcmpPkg = {
  packageJSON: {
    contributes: {
      languageModelChatProviders: [
        { vendor: 'gcmp.deepseek' },
        { vendor: 'gcmp.compatible' },
      ],
      commands: [{ command: 'gcmp.showProviders' }],
    },
  },
};

function stubGcmpExtension(pkg: unknown = gcmpPkg): void {
  (vscodeMock.extensions as { getExtension: (id: string) => unknown }).getExtension = (id) =>
    id === 'vicanent.gcmp' ? pkg : undefined;
}

function stubWarnings(result: unknown): void {
  (vscodeMock.window as { showWarningMessage: (m: string) => Promise<unknown> }).showWarningMessage =
    async () => result;
}

beforeEach(() => {
  stubSelect([]);
  installConfigStub();
  stubGcmpExtension();
  stubWarnings(undefined);
  (vscodeMock.window as { showInformationMessage: (m: string) => Promise<unknown> }).showInformationMessage =
    async () => undefined;
  (vscodeMock.commands as { executeCommand: (c: string) => Promise<unknown> }).executeCommand =
    async () => undefined;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// pure importFromLm
// ---------------------------------------------------------------------------

describe('importFromLm (pure, T5)', () => {
  const live: FakeModel[] = [
    { vendor: 'gcmp.deepseek', id: 'deepseek-chat' },
    { vendor: 'gcmp.compatible', id: 'futureppo-grok-4.6' },
  ];

  it('exact mode: full-id chain ids, concrete vendor, never gcmp.* wildcard', () => {
    const { chains, skipped } = importFromLm(live, 'exact');
    expect(skipped).toEqual([]);
      expect(chains.map((c) => c.id)).toEqual(['deepseek-chat', 'futureppo-grok-4_6']);
    expect(chains[0].targets).toEqual([{ kind: 'proxy', vendor: 'gcmp.deepseek', modelId: 'deepseek-chat' }]);
    expect(chains[1].targets).toEqual([{ kind: 'proxy', vendor: 'gcmp.compatible', modelId: 'futureppo-grok-4.6' }]);
    expect(JSON.stringify(chains)).not.toContain('gcmp.*');
  });

  it('family mode: groups by family name, concrete vendor preserved', () => {
    const { chains } = importFromLm(live, 'family');
    expect(chains.map((c) => c.id)).toEqual(['deepseek', 'futureppo']);
    expect(chains[0].targets[0].vendor).toBe('gcmp.deepseek');
    expect(chains[1].targets[0].vendor).toBe('gcmp.compatible');
    expect(JSON.stringify(chains)).not.toContain('gcmp.*');
  });

  it('groups same family across vendors, sorted by vendor then modelId', () => {
    const { chains } = importFromLm(
      [
        { vendor: 'gcmp.zzz', id: 'futureppo-grok-4.6' },
        { vendor: 'gcmp.aaa', id: 'futureppo-mini' },
      ],
      'family'
    );
    expect(chains.length).toBe(1);
    expect(chains[0].id).toBe('futureppo');
    expect(chains[0].targets.map((t) => t.vendor)).toEqual(['gcmp.aaa', 'gcmp.zzz']);
  });

  it('skips self vendor (fallbackrouter) and models without id', () => {
    const { chains, skipped } = importFromLm(
      [
        { vendor: 'fallbackrouter', id: 'fallbackrouter:deepseek' },
        { vendor: 'gcmp.ok', id: 'nice-model' },
        { vendor: 'gcmp.broken' } as LmModelLike,
      ],
      'exact'
    );
    expect(chains.map((c) => c.id)).toEqual(['nice-model']);
    expect(skipped.map((s) => s.reason)).toContain('self vendor (fallbackrouter)');
    expect(skipped.map((s) => s.reason)).toContain('missing vendor or id');
  });

  it('familyName/sanitizeChainId keep legacy semantics', () => {
    expect(familyName('futureppo-grok-4.6')).toBe('futureppo');
    expect(familyName('gcmp.compatible/qwen-qwq-32b')).toBe('qwen');
    expect(sanitizeChainId('futureppo-grok-4.6')).toBe('futureppo-grok-4_6');
  });
});

// ---------------------------------------------------------------------------
// writeImportChains / waitForModels
// ---------------------------------------------------------------------------

describe('writeImportChains (direct config write + loopback, T5)', () => {
  const chains: Chain[] = [
    { id: 'deepseek', name: 'deepseek', targets: [{ kind: 'proxy', vendor: 'gcmp.deepseek', modelId: 'deepseek-chat' }] },
  ];

  it('updates Global config and confirms via waitForModels loopback', async () => {
    installConfigStub();
    stubSelect([
      { vendor: 'gcmp.deepseek', id: 'deepseek-chat' },
      { vendor: 'fallbackrouter', id: 'fallbackrouter:deepseek' },
    ]);
    const ok = await writeImportChains(chains, 500);
    expect(ok).toBe(true);
    expect(updates).toEqual([
      { key: 'chains', value: chains, target: 1 }, // ConfigurationTarget.Global
    ]);
  });

  it('rolls back to previous value when models never resolve', async () => {
    installConfigStub();
    cfgGetImpl = (key) => (key === 'chains' ? [{ id: 'old', name: 'old', targets: [] }] : undefined);
    stubSelect([{ vendor: 'gcmp.deepseek', id: 'deepseek-chat' }]); // no fallbackrouter:*
    const ok = await writeImportChains(chains, 300);
    expect(ok).toBe(false);
    expect(updates).toHaveLength(2);
    expect(updates[0].value).toBe(chains);
    expect(updates[1].value).toEqual([{ id: 'old', name: 'old', targets: [] }]); // rollback
    expect(updates[1].target).toBe(1);
  });

  it('waitForModels is satisfied by self-vendor composite models', async () => {
    stubSelect([{ vendor: 'fallbackrouter', id: 'fallbackrouter:a' }, { vendor: 'fallbackrouter', id: 'fallbackrouter:b' }]);
    const ok = await waitForModels(
      [{ id: 'a', name: 'a', targets: [] }, { id: 'b', name: 'b', targets: [] }],
      500
    );
    expect(ok).toBe(true);
  });

  it('waitForModels times out when composites are missing', async () => {
    stubSelect([]);
    const ok = await waitForModels([{ id: 'a', name: 'a', targets: [] }], 200);
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// importGcmpFlow (live selectChatModels -> declared GCMP vendors -> direct write)
// ---------------------------------------------------------------------------

describe('importGcmpFlow (T5)', () => {
  it('imports only live models from GCMP-declared vendors and writes chains', async () => {
    stubSelect([
      { vendor: 'gcmp.deepseek', id: 'deepseek-chat' },
      { vendor: 'gcmp.compatible', id: 'futureppo-grok-4.6' },
      { vendor: 'gcmp-bridge', id: 'impostor-model' }, // starts with gcmp. but NOT declared by GCMP
      { vendor: 'fallbackrouter', id: 'fallbackrouter:deepseek' },
      { vendor: 'fallbackrouter', id: 'fallbackrouter:futureppo' },
    ]);
    cfgGetImpl = (key) => (key === 'importMode' ? 'family' : undefined);
    const showInfo = vi.fn(async (): Promise<unknown> => undefined);
    (vscodeMock.window as { showInformationMessage: typeof showInfo }).showInformationMessage = showInfo;

    await importGcmpFlow();

    expect(updates).toHaveLength(1);
    expect(updates[0].key).toBe('chains');
    expect(updates[0].target).toBe(1);
    const written = updates[0].value as Chain[];
    expect(written.map((c) => c.id)).toEqual(['deepseek', 'futureppo']);
    expect(written[0].targets).toEqual([{ kind: 'proxy', vendor: 'gcmp.deepseek', modelId: 'deepseek-chat' }]);
    expect(written[1].targets).toEqual([{ kind: 'proxy', vendor: 'gcmp.compatible', modelId: 'futureppo-grok-4.6' }]);
    expect(JSON.stringify(written)).not.toContain('gcmp-bridge'); // impostor filtered out
        expect(JSON.stringify(written)).not.toContain('gcmp.*'); // no wildcard vendors
    expect(JSON.stringify(written)).not.toContain('fallbackrouter:');
    expect(showInfo.mock.calls[0][0]).toContain('configuration written');
  });

  it('no live GCMP models -> warning mentions configuring GCMP, no config write', async () => {
    stubSelect([
      { vendor: 'fellowship.middleearth', id: 'importer-test-ignore-me' },
    ]);
    const warn = vi.fn(async (): Promise<unknown> => undefined);
    (vscodeMock.window as { showWarningMessage: typeof warn }).showWarningMessage = warn;

    await importGcmpFlow();

    expect(warn.mock.calls[0][0]).toContain('Configure a GCMP provider');
    expect(updates).toHaveLength(0);
  });

  it('empty model list opens GCMP setup when user picks the action', async () => {
    stubSelect([]);
    stubWarnings('Open configuration');
    const exec = vi.fn(async (): Promise<unknown> => undefined);
    (vscodeMock.commands as { executeCommand: typeof exec }).executeCommand = exec;

    await importGcmpFlow();

    expect(exec.mock.calls[0][0]).toBe('gcmp.showProviders'); // from GCMP contributes.commands
    expect(updates).toHaveLength(0);
  });

  it('falls back to settings.json when GCMP contributes no config command', async () => {
    stubSelect([]);
    stubWarnings('Open configuration');
    stubGcmpExtension({ packageJSON: { contributes: { languageModelChatProviders: [] } } });
    const exec = vi.fn(async (): Promise<unknown> => undefined);
    (vscodeMock.commands as { executeCommand: typeof exec }).executeCommand = exec;

    await importGcmpFlow();

    expect(exec.mock.calls[0][0]).toBe('workbench.action.openSettingsJson');
  });
});