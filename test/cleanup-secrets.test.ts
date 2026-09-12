import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscodeMock from './helpers/vscode-mock';

vi.mock('vscode', () => vscodeMock);

interface SecretStorageLike {
  get: (key: string) => Promise<string | undefined>;
  delete: (key: string) => Promise<void>;
  store: (key: string, value: string) => Promise<void>;
}

interface GlobalStateLike {
  keys: () => readonly string[];
  get: <T>(key: string, defaultValue?: T) => T;
  update: (key: string, value: unknown) => Thenable<void>;
}

interface ContextLike {
  secrets: SecretStorageLike;
  globalState: GlobalStateLike;
}

function makeContext(seedSecrets: Record<string, string>, seedGlobal: Record<string, unknown>): {
  context: ContextLike;
  deleted: string[];
} {
  const secretStore = new Map(Object.entries(seedSecrets));
  const globalStore = new Map(Object.entries(seedGlobal));
  const deleted: string[] = [];
  const context: ContextLike = {
    secrets: {
      get: async (key) => secretStore.get(key),
      delete: async (key) => {
        deleted.push(key);
        secretStore.delete(key);
      },
      store: async (key, value) => {
        secretStore.set(key, value);
      },
    },
    globalState: {
      keys: () => [...globalStore.keys()],
      get: <T,>(key: string, defaultValue?: T) =>
        (globalStore.has(key) ? (globalStore.get(key) as T) : (defaultValue as T)),
      update: async (key, value) => {
        if (value === undefined) globalStore.delete(key);
        else globalStore.set(key, value);
      },
    },
  };
  return { context, deleted };
}

async function importCleanup() {
  const mod = await import('../src/extension');
  return mod.cleanup as (context: ContextLike) => Promise<void>;
}

describe('cleanup legacy secrets + breaker state', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vscodeMock.__resetSinks();
    vscodeMock.window.showWarningMessage = vi.fn(async () => 'Delete') as never;
    vscodeMock.window.showInformationMessage = vi.fn(async () => {}) as never;
  });

  it('deletes only globalState-captured refs, merges values into redaction, clears breaker state and ref key', async () => {
    const { context, deleted } = makeContext(
      {
        'fallbackrouter.gcmp.x': 'sk-value-x',
        'fallbackrouter.gcmp.y': 'sk-value-y',
        'fallbackrouter.untracked': 'sk-untracked',
      },
      {
        legacySecretRefs: ['gcmp.x', 'gcmp.y'],
        'fallbackrouter.breaker.c1': { open: true },
      }
    );
    const cleanup = await importCleanup();
    await cleanup(context as never);

    // (a) deletion driven by captured ref names only — untracked key survives.
    expect(deleted.sort()).toEqual(['fallbackrouter.gcmp.x', 'fallbackrouter.gcmp.y']);
    expect(await context.secrets.get('fallbackrouter.gcmp.x')).toBeUndefined();
    expect(await context.secrets.get('fallbackrouter.gcmp.y')).toBeUndefined();
    expect(await context.secrets.get('fallbackrouter.untracked')).toBe('sk-untracked');
    // (b) captured refs cleared -> idempotent.
    expect(context.globalState.get('legacySecretRefs', [])).toEqual([]);
    // (c) breaker state purged.
    expect(context.globalState.keys()).not.toContain('fallbackrouter.breaker.c1');
  });

  it('second run is a no-op (idempotent): no delete calls, no throw', async () => {
        const { context, deleted } = makeContext({}, {});
        const cleanup = await importCleanup();
        await cleanup(context as never);
    await cleanup(context as never);
        expect(deleted).toEqual([]);
        expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(2);
    });

    it('one failing secret delete does not abort the rest', async () => {
        const { context, deleted } = makeContext(
          {
            'fallbackrouter.gcmp.x': 'sk-value-x',
            'fallbackrouter.gcmp.y': 'sk-value-y',
          },
          { legacySecretRefs: ['gcmp.x', 'gcmp.y'] }
        );
        const rawDelete = context.secrets.delete;
        context.secrets.delete = (async (key: string) => {
          if (key === 'fallbackrouter.gcmp.x') {
            deleted.push(key);
            throw new Error('secret backend offline');
          }
          await rawDelete(key as never);
        }) as ContextLike['secrets']['delete'];
        const cleanup = await importCleanup();
        await expect(cleanup(context as never)).resolves.toBeUndefined();
        // loop continued past the throwing key.
        expect(deleted).toContain('fallbackrouter.gcmp.x');
        expect(deleted).toContain('fallbackrouter.gcmp.y');
        expect(await context.secrets.get('fallbackrouter.gcmp.y')).toBeUndefined();
        expect(await context.secrets.get('fallbackrouter.gcmp.x')).toBe('sk-value-x');
        expect(context.globalState.get('legacySecretRefs', [])).toEqual([]);
    });

  it('declining the confirmation dialog deletes nothing', async () => {
    vscodeMock.window.showWarningMessage = vi.fn(async () => 'Cancel') as never;
    const { context, deleted } = makeContext(
      { 'fallbackrouter.gcmp.x': 'sk-value-x' },
      { legacySecretRefs: ['gcmp.x'] }
    );
    const cleanup = await importCleanup();
    await cleanup(context as never);
    expect(deleted).toEqual([]);
    expect(await context.secrets.get('fallbackrouter.gcmp.x')).toBe('sk-value-x');
    expect(context.globalState.get('legacySecretRefs', [])).toEqual(['gcmp.x']);
  });
});