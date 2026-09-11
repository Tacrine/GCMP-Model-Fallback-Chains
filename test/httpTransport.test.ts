import { describe, it, expect, vi } from 'vitest';
import { HttpTransport } from '../src/transport/httpTransport';
import type { LangMsg, LangPart, Target, Cancel, Logger } from '../src/types';

const noopLogger: Logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
const enc = new TextEncoder();

function cancelToken(): Cancel {
  return { isCancellationRequested: false, onCancellationRequested: () => () => {} };
}

function httpTarget(overrides: Partial<Target> = {}): Target {
  return { kind: 'http', baseUrl: 'https://t.test/v1', apiType: 'chat-completions', model: 'm', secretRef: 'r', toolCalling: true, ...overrides };
}

interface StreamStub {
  parts: Uint8Array[];
  hang?: boolean;
}
function makeResponse(status: number, parts: Uint8Array[], hang = false) {
  let i = 0;
  let cancelled = false;
  const body = {
    getReader: () => ({
      read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
        if (i < parts.length) return { done: false, value: parts[i++] };
        if (hang) return new Promise<{ done: boolean; value?: Uint8Array }>(() => {});
        return { done: true };
      },
      cancel: async () => { cancelled = true; },
    }),
    cancel: async () => { cancelled = true; },
  };
  return { status, ok: status >= 200 && status < 300, body, cancelled: () => cancelled } as unknown as Response & { cancelled(): boolean };
}

function sseFrame(json: string): Uint8Array {
  return enc.encode(`data: ${json}\n\n`);
}

function makeTransport(fetchImpl: (url: string, init: { headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>, getSecret: () => Promise<string | undefined> = async () => 'SECRET') {
  return new HttpTransport({
    logger: noopLogger,
    fetch: fetchImpl as typeof fetch,
    getSecret,
    secretsToRedact: async () => ['SECRET'],
  });
}

const textDelta = (c: string) => `{"choices":[{"delta":{"content":"${c}"}}]}`;

describe('HttpTransport', () => {
  it('sends customHeader verbatim and Authorization Bearer', async () => {
    let headers: Record<string, string> = {};
    const t = makeTransport(async (_u, init) => {
      headers = init.headers;
      return makeResponse(200, [sseFrame(textDelta('hi')), sseFrame('[DONE]')]);
    });
    const target = httpTarget({ customHeader: { 'x-api-version': '2024', 'user-agent': 'test' } });
    await t.send(target, [{ role: 1, parts: [{ kind: 'text', value: 'q' }] }], { timeouts: { connectMs: 100, headersMs: 100, firstByteMs: 2000, stallMs: 2000 } }, () => {}, cancelToken());
    expect(headers['x-api-version']).toBe('2024');
    expect(headers['user-agent']).toBe('test');
    expect(headers.Authorization).toBe('Bearer SECRET');
  });

  it('does not override customHeader Authorization', async () => {
    let headers: Record<string, string> = {};
    const t = makeTransport(async (_u, init) => { headers = init.headers; return makeResponse(200, [sseFrame('[DONE]')]); });
    await t.send(httpTarget({ customHeader: { Authorization: 'custom-token' } }), [{ role: 1, parts: [{ kind: 'text', value: 'q' }] }], { timeouts: { connectMs: 100, headersMs: 100, firstByteMs: 2000, stallMs: 2000 } }, () => {}, cancelToken());
    expect(headers.Authorization).toBe('custom-token');
  });

  it('concatenates multi-frame SSE text', async () => {
    const emitted: LangPart[] = [];
    const t = makeTransport(async () => makeResponse(200, [sseFrame(textDelta('he')), sseFrame(textDelta('llo')), sseFrame('[DONE]')]));
    const out = await t.send(httpTarget(), [{ role: 1, parts: [{ kind: 'text', value: 'q' }] }], { timeouts: { connectMs: 100, headersMs: 100, firstByteMs: 2000, stallMs: 2000 } }, (p) => emitted.push(p), cancelToken());
    expect(out.ok).toBe(true);
    expect(emitted.map((p) => (p.kind === 'text' ? p.value : '')).join('')).toBe('hello');
  });

  it('assembles tool_call arguments across frames into one part', async () => {
    const emitted: LangPart[] = [];
    const f1 = sseFrame(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}`);
    const f2 = sseFrame(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"th\\":\\"a\\"}"}}]}}]}`);
    const done = sseFrame('{"choices":[{"finish_reason":"stop"}]}');
    const t = makeTransport(async () => makeResponse(200, [f1, f2, done]));
    const out = await t.send(httpTarget(), [{ role: 1, parts: [{ kind: 'text', value: 'q' }] }], { timeouts: { connectMs: 100, headersMs: 100, firstByteMs: 2000, stallMs: 2000 } }, (p) => emitted.push(p), cancelToken());
    expect(out.ok).toBe(true);
    const tool = emitted.find((p) => p.kind === 'toolCall');
    expect(tool).toBeTruthy();
    expect((tool as { name: string }).name).toBe('read');
    expect((tool as { input: unknown }).input).toEqual({ path: 'a' });
  });

  it('assembles two parallel tool calls without mixing', async () => {
    const emitted: LangPart[] = [];
    const mk = (id: string, name: string) => sseFrame(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"${id}","function":{"name":"${name}","arguments":"{\\"a\\":1}"}}]}}]}`);
    const done = sseFrame('{"choices":[{"finish_reason":"stop"}]}');
    const t = makeTransport(async () => makeResponse(200, [mk('c1', 'read'), mk('c2', 'write'), done]));
    await t.send(httpTarget(), [{ role: 1, parts: [{ kind: 'text', value: 'q' }] }], { timeouts: { connectMs: 100, headersMs: 100, firstByteMs: 2000, stallMs: 2000 } }, (p) => emitted.push(p), cancelToken());
    const calls = emitted.filter((p) => p.kind === 'toolCall');
    expect(calls).toHaveLength(2);
    expect((calls[0] as { callId: string }).callId).not.toBe((calls[1] as { callId: string }).callId);
  });

  it('classifies 429/503 as retryable and 401/403 as non-retryable', async () => {
    for (const st of [429, 503]) {
      const t = makeTransport(async () => makeResponse(st, []));
      const out = await t.send(httpTarget(), [], { timeouts: { connectMs: 100, headersMs: 100, firstByteMs: 2000, stallMs: 2000 } }, () => {}, cancelToken());
      expect(out.retryable).toBe(true);
    }
    for (const st of [401, 403]) {
      const t = makeTransport(async () => makeResponse(st, []));
      const out = await t.send(httpTarget(), [], { timeouts: { connectMs: 100, headersMs: 100, firstByteMs: 2000, stallMs: 2000 } }, () => {}, cancelToken());
      expect(out.retryable).toBe(false);
    }
  });

  it('returns non-retryable error with hint when API key missing', async () => {
    const t = makeTransport(async () => makeResponse(200, [sseFrame('[DONE]')]), async () => undefined);
    const out = await t.send(httpTarget(), [{ role: 1, parts: [{ kind: 'text', value: 'q' }] }], { timeouts: { connectMs: 100, headersMs: 100, firstByteMs: 2000, stallMs: 2000 } }, () => {}, cancelToken());
    expect(out.ok).toBe(false);
    expect(out.retryable).toBe(false);
    expect(String(out.error)).toContain('setApiKey');
  });

  it('triggers first-byte timeout as retryable', async () => {
    const t = makeTransport(async () => makeResponse(200, [], true));
    const start = Date.now();
    const out = await t.send(httpTarget(), [{ role: 1, parts: [{ kind: 'text', value: 'q' }] }], { timeouts: { connectMs: 100, headersMs: 100, firstByteMs: 100, stallMs: 2000 } }, () => {}, cancelToken());
    const elapsed = Date.now() - start;
    expect(out.retryable).toBe(true);
    expect(out.emittedParts).toBe(0);
    expect(elapsed).toBeLessThan(2000);
  });

  it('triggers stall timeout when a later read hangs', async () => {
    const t = makeTransport(async () => makeResponse(200, [sseFrame(textDelta('hi'))], true));
    const start = Date.now();
    const out = await t.send(httpTarget(), [{ role: 1, parts: [{ kind: 'text', value: 'q' }] }], { timeouts: { connectMs: 100, headersMs: 100, firstByteMs: 2000, stallMs: 80 } }, () => {}, cancelToken());
    const elapsed = Date.now() - start;
    expect(out.retryable).toBe(true);
    expect(elapsed).toBeLessThan(2000);
  });

  it('canHandle skips targets lacking image input for data parts', () => {
    const t = makeTransport(async () => makeResponse(200, []));
    const r = t.canHandle(httpTarget({ imageInput: false }), false, true, 10);
    expect(r.ok).toBe(false);
  });

  it('canHandle skips targets lacking tool calling when tools requested', () => {
    const t = makeTransport(async () => makeResponse(200, []));
    const r = t.canHandle(httpTarget({ toolCalling: false }), true, false, 10);
    expect(r.ok).toBe(false);
  });

  it('canHandle skips targets exceeding maxInputTokens', () => {
    const t = makeTransport(async () => makeResponse(200, []));
    const r = t.canHandle(httpTarget({ maxInputTokens: 5 }), false, false, 100);
    expect(r.ok).toBe(false);
  });
});
