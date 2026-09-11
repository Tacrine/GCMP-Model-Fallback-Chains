import { describe, it, expect, vi } from 'vitest';
import { normalizeConfig } from '../src/config';

function sink() {
  const warn = vi.fn();
  const error = vi.fn();
  return { warn, error };
}

const validChain = {
  id: 'deepseek',
  name: 'deepseek',
  targets: [
    { kind: 'http', baseUrl: 'https://a.test/v1', apiType: 'chat-completions', model: 'ds', secretRef: 'gcmp.x' },
    { kind: 'http', baseUrl: 'https://b.test/v1', apiType: 'responses', model: 'ds', secretRef: 'gcmp.y' },
  ],
};

describe('normalizeConfig', () => {
  it('accepts a fully valid config', () => {
    const s = sink();
    const raw = { chains: [validChain], retry: { maxAttempts: 5 }, circuitBreaker: { failureThreshold: 2, cooldownMs: 1000 }, timeouts: { connectMs: 100, headersMs: 200, firstByteMs: 300, stallMs: 400 }, maxTurnMs: 5000, maxTargetsPerTurn: 3, importMode: 'family', retryOnRateLimit: true, noticeStyle: 'plain', logLevel: 'debug' };
    const res = normalizeConfig(raw, s);
    expect(res.droppedChains).toBe(0);
    expect(res.config.chains).toHaveLength(1);
    expect(res.config.retry.maxAttempts).toBe(5);
    expect(res.config.importMode).toBe('family');
    expect(res.config.retryOnRateLimit).toBe(true);
    expect(res.config.noticeStyle).toBe('plain');
    expect(res.config.logLevel).toBe('debug');
    expect(res.config.timeouts.stallMs).toBe(400);
  });

  it('drops chains with empty targets', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [{ id: 'x', name: 'x', targets: [] }] }, s);
    expect(res.config.chains).toHaveLength(0);
    expect(res.droppedChains).toBe(1);
  });

  it('drops duplicate chain ids', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [validChain, { ...validChain }] }, s);
    expect(res.config.chains).toHaveLength(1);
  });

  it('rejects chain id with illegal characters', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [{ ...validChain, id: 'bad id!' }] }, s);
    expect(res.config.chains).toHaveLength(0);
  });

  it('rejects unknown target kind', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [{ id: 'a', name: 'a', targets: [{ kind: 'bogus' }] }] }, s);
    expect(res.config.chains).toHaveLength(0);
  });

  it('rejects unknown apiType', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [{ id: 'a', name: 'a', targets: [{ kind: 'http', baseUrl: 'x', model: 'm', secretRef: 'r', apiType: 'weird' }] }] }, s);
    expect(res.config.chains).toHaveLength(0);
  });

  it('rejects out-of-range maxAttempts and clamps to default', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [], retry: { maxAttempts: 99 } }, s);
    expect(res.config.retry.maxAttempts).toBe(3);
  });

  it('drops proxy target with vendor fallbackrouter (self-recursion)', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [{ id: 'a', name: 'a', targets: [{ kind: 'proxy', vendor: 'fallbackrouter', modelId: 'x' }] }] }, s);
    expect(res.config.chains).toHaveLength(0);
    expect(s.warn).toHaveBeenCalledWith(expect.stringContaining('fallbackrouter'));
  });

  it('dedupes duplicate targets within a chain', () => {
    const s = sink();
    const dup = { kind: 'http', baseUrl: 'https://a.test/v1', apiType: 'chat-completions' as const, model: 'ds', secretRef: 'gcmp.x' };
    const res = normalizeConfig({ chains: [{ id: 'a', name: 'a', targets: [dup, dup] }] }, s);
    expect(res.config.chains[0].targets).toHaveLength(1);
  });

  it('warns on single-target chains', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [{ id: 'a', name: 'a', targets: [{ kind: 'http', baseUrl: 'x', apiType: 'chat-completions', model: 'm', secretRef: 'r' }] }] }, s);
    expect(res.config.chains).toHaveLength(1);
    expect(s.warn).toHaveBeenCalledWith(expect.stringContaining('no fallback'));
  });

  it('rejects non-positive timeout fields with default', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [], timeouts: { connectMs: 0, headersMs: -5 } }, s);
    expect(res.config.timeouts.connectMs).toBe(10000);
    expect(res.config.timeouts.headersMs).toBe(15000);
  });

  it('rejects out-of-range maxTargetsPerTurn with default', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [], maxTargetsPerTurn: 0 }, s);
    expect(res.config.maxTargetsPerTurn).toBe(5);
  });

  it('rejects non-boolean retryOnRateLimit with default', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [], retryOnRateLimit: 'yes' as unknown as boolean }, s);
    expect(res.config.retryOnRateLimit).toBe(false);
  });

  it('falls back to family for invalid importMode', () => {
    const s = sink();
    const res = normalizeConfig({ chains: [], importMode: 'bogus' as never }, s);
    expect(res.config.importMode).toBe('family');
  });

  it('returns empty config for non-object root', () => {
    const s = sink();
    const res = normalizeConfig(null, s);
    expect(res.config.chains).toHaveLength(0);
  });
});
