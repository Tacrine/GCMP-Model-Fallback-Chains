import { describe, it, expect, vi } from 'vitest';
import { ProxyTransport, type LmLike, type ChatModelLike } from '../src/transport/proxyTransport';
import type { LangMsg, LangPart, Target, Cancel, Logger } from '../src/types';

const noopLogger: Logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };

function token(): Cancel {
  return { isCancellationRequested: false, onCancellationRequested: () => () => {} };
}

function proxyTarget(vendor = 'gcmp.compatible', modelId = 'gcmp.初叶:::初叶/deepseek-v4-flash'): Target {
  return { kind: 'proxy', vendor, modelId };
}

function makeModel(overrides: Partial<ChatModelLike> = {}): ChatModelLike {
  return {
    vendor: 'gcmp.compatible',
    id: 'gcmp.初叶:::初叶/deepseek-v4-flash',
    async sendRequest(_m, _o, _t) {
      return { stream: (async function* () { yield { kind: 'text', value: 'ping' }; })() };
    },
    ...overrides,
  };
}

function makeTransport(models: ChatModelLike[]) {
  const lm: LmLike = { async selectChatModels() { return models; } };
  return new ProxyTransport({
    logger: noopLogger,
    lm,
    toUpstreamMessages: (m) => m as unknown as unknown[],
    toUpstreamPart: (p) => p as never,
    toDownstreamPart: (p) => {
      if (p.kind === 'text') return { kind: 'text', value: p.value ?? '' };
      if (p.kind === 'toolCall') return { kind: 'toolCall', callId: p.callId ?? '', name: p.name ?? '', input: p.input ?? {} };
      return null;
    },
  });
}

describe('ProxyTransport', () => {
  it('forwards text parts verbatim on success', async () => {
    const t = makeTransport([makeModel()]);
    const emitted: LangPart[] = [];
    const out = await t.send(proxyTarget(), [], { timeouts: { connectMs: 100, headersMs: 100, firstByteMs: 100, stallMs: 1000 } }, (p) => emitted.push(p), token());
    expect(out.ok).toBe(true);
    expect(emitted).toEqual([{ kind: 'text', value: 'ping' }]);
  });

  it('filters out fallbackrouter-vendor models (recursion guard)', async () => {
    const lm: LmLike = { async selectChatModels() { return [makeModel({ vendor: 'fallbackrouter', id: 'x' })]; } };
    const t = new ProxyTransport({ logger: noopLogger, lm, toUpstreamMessages: (m) => m as unknown as unknown[], toUpstreamPart: (p) => p as never, toDownstreamPart: (p) => ({ kind: 'text', value: 'x' }) });
    const out = await t.send(proxyTarget('fallbackrouter', 'x'), [], { timeouts: { connectMs: 100, headersMs: 100, firstByteMs: 100, stallMs: 1000 } }, vi.fn(), token());
    expect(out.ok).toBe(false);
    expect(out.retryable).toBe(false);
  });

  it('returns explicit error when target not found', async () => {
    const t = makeTransport([]);
    const out = await t.send(proxyTarget('gcmp.compatible', 'nonexistent'), [], { timeouts: { connectMs: 100, headersMs: 100, firstByteMs: 100, stallMs: 1000 } }, vi.fn(), token());
    expect(out.ok).toBe(false);
    expect(out.retryable).toBe(false);
    expect(String(out.error)).toContain('未找到');
  });

  it('propagates NoPermissions code as non-retryable', async () => {
    const err = Object.assign(new Error('no perms'), { code: 'NoPermissions' });
    const model = makeModel({ async sendRequest() { throw err; } });
    const t = makeTransport([model]);
    const out = await t.send(proxyTarget(), [], { timeouts: { connectMs: 100, headersMs: 100, firstByteMs: 100, stallMs: 1000 } }, vi.fn(), token());
    expect(out.ok).toBe(false);
    expect(out.retryable).toBe(false);
    expect((out.error as { code?: string }).code).toBe('NoPermissions');
  });
});
