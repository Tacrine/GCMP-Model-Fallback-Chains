import { describe, it, expect, vi } from 'vitest';
import { normalizeConfig, extractLegacySecretRefs, shouldShowMigrationNotice } from '../src/config';

function sink() {
  const warn = vi.fn();
  const error = vi.fn();
  return { warn, error };
}

const httpTarget = (secretRef: string, extra: Record<string, unknown> = {}) => ({
  kind: 'http', baseUrl: 'https://a.test/v1', apiType: 'chat-completions', model: 'ds', secretRef, ...extra,
});
const proxyTarget = (vendor: string, modelId: string) => ({ kind: 'proxy', vendor, modelId });
const chain = (id: string, targets: unknown[]) => ({ id, name: id, targets });

describe('normalizeConfig migration capture (T3 / Metis #4, oracle #3)', () => {
  it('strips http targets, counts them in droppedHttpTargets, keeps proxy targets', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [
      chain('c1', [httpTarget('gcmp.x'), httpTarget('gcmp.y'), proxyTarget('gcmp.compatible', 'm1')]),
    ] }, s);
    expect(res.droppedHttpTargets).toBe(2);
    expect(res.droppedChains).toBe(0);
    expect(res.config.chains).toHaveLength(1);
    expect(res.config.chains[0].targets).toEqual([proxyTarget('gcmp.compatible', 'm1')]);
    expect(s.warn).toHaveBeenCalled(); // warning went through the sink
  });

  it('counts stripped http targets across multiple chains', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [
          chain('c1', [httpTarget('gcmp.a'), httpTarget('gcmp.b'), proxyTarget('gcmp.compatible', 'm1')]),
      chain('c2', [httpTarget('gcmp.c'), proxyTarget('gcmp.compatible', 'm2')]),
    ] }, s);
    expect(res.droppedHttpTargets).toBe(3);
    expect(res.droppedChains).toBe(0);
    expect(res.config.chains).toHaveLength(2);
    expect(res.config.chains[1].targets).toEqual([proxyTarget('gcmp.compatible', 'm2')]);
  });

  it('drops a chain whose http targets leave it empty (droppedChains, not droppedHttpTargets)', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [chain('c1', [httpTarget('gcmp.x')])] }, s);
    expect(res.droppedHttpTargets).toBe(1); // the stripped target is counted…
    expect(res.droppedChains).toBe(1);      // …and the now-empty chain is dropped separately
    expect(res.config.chains).toHaveLength(0);
  });

  it('distinguishes chain-level drops from http-target strips in mixed configs', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [
      chain('empty', []),                                  // droppedChains (no valid targets)
      chain('badid!', [httpTarget('gcmp.a')]),             // droppedChains (illegal id)
      chain('c3', [httpTarget('gcmp.b'), proxyTarget('gcmp.compatible', 'm3')]), // 1 strip, kept
    ] }, s);
    expect(res.droppedHttpTargets).toBe(1);
    expect(res.droppedChains).toBe(2);
    expect(res.config.chains).toHaveLength(1);
    expect(res.config.chains[0].id).toBe('c3');
    expect(res.config.chains[0].targets).toEqual([proxyTarget('gcmp.compatible', 'm3')]);
  });

  it('keeps duplicate-id and self-recursion guards (Must NOT regress)', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [
      chain('c1', [proxyTarget('fallbackrouter', 'x')]),   // self-recursion → target skipped
      { ...chain('dup', [proxyTarget('gcmp.compatible', 'm')]), id: 'dup' },
      chain('dup', [proxyTarget('gcmp.compatible', 'm2')]),// duplicate id → dropped
    ] }, s);
    expect(res.droppedChains).toBe(2); // c1 (empty after recursion guard) + dup
    expect(res.config.chains).toHaveLength(1);
  });

  it('reports zero drops for a clean proxy-only config', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [chain('c1', [proxyTarget('gcmp.compatible', 'm')])] }, s);
    expect(res.droppedHttpTargets).toBe(0);
    expect(res.droppedChains).toBe(0);
    expect(res.config.chains).toHaveLength(1);
  });
});

describe('extractLegacySecretRefs (RAW capture, overwrite semantics in caller)', () => {
  it('collects secretRefs of http targets in order', () => {
    const raw = [
      chain('c1', [httpTarget('gcmp.x'), proxyTarget('gcmp.compatible', 'm')]),
      chain('c2', [httpTarget('gcmp.y'), httpTarget('gcmp.z')]),
    ];
    expect(extractLegacySecretRefs(raw)).toEqual(['gcmp.x', 'gcmp.y', 'gcmp.z']);
  });

  it('ignores proxy targets and non-http records', () => {
    expect(extractLegacySecretRefs([chain('c1', [proxyTarget('gcmp.compatible', 'm')])])).toEqual([]);
    expect(extractLegacySecretRefs([null, 'x', 42])).toEqual([]);
  });

  it('skips http targets without a usable secretRef', () => {
    const raw = [chain('c1', [httpTarget('gcmp.ok'), { ...httpTarget(''), secretRef: '' }, { kind: 'http', baseUrl: 'x' }])];
    expect(extractLegacySecretRefs(raw)).toEqual(['gcmp.ok']);
  });

  it('returns an empty list for anything that is not an array', () => {
    expect(extractLegacySecretRefs(undefined)).toEqual([]);
    expect(extractLegacySecretRefs('nope')).toEqual([]);
    expect(extractLegacySecretRefs({})).toEqual([]);
  });
});

  describe('shouldShowMigrationNotice (one-time banner gate, F1 silent-point #4)', () => {
    it('shows the banner when no strip has been recorded yet', () => {
      expect(shouldShowMigrationNotice(undefined)).toBe(true);
    });

    it('suppresses the popup on later loads once migrated.strippedAt exists', () => {
      expect(shouldShowMigrationNotice(123)).toBe(false);
      expect(shouldShowMigrationNotice(0)).toBe(false);
    });
  });