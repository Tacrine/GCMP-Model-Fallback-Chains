import { describe, it, expect } from 'vitest';
import { toChatCompletionsMessages, toResponsesMessages } from '../src/convert/request';
import { parseSse, chatCompletionsDelta, responsesEvent, ToolCallAssembler } from '../src/convert/sse';
import type { LangMsg } from '../src/types';

describe('toChatCompletionsMessages', () => {
  it('preserves message order and maps roles', () => {
    const msgs: LangMsg[] = [
      { role: 1, parts: [{ kind: 'text', value: 'hi' }] },
      { role: 2, parts: [{ kind: 'text', value: 'hello' }] },
      { role: 1, parts: [{ kind: 'text', value: 'again' }] },
    ];
    const r = toChatCompletionsMessages(msgs);
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(r.messages.map((m) => m.content)).toEqual(['hi', 'hello', 'again']);
  });

  it('serializes tool results as role tool messages', () => {
    const msgs: LangMsg[] = [
      { role: 1, parts: [{ kind: 'text', value: 'q' }] },
      { role: 2, parts: [{ kind: 'toolCall', callId: 'c1', name: 'read', input: { path: 'a' } }] },
      { role: 1, parts: [{ kind: 'toolResult', callId: 'c1', content: 'RESULT' }] },
    ];
    const r = toChatCompletionsMessages(msgs);
    const toolMsg = r.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect((toolMsg as { content: string }).content).toBe('RESULT');
    expect((toolMsg as { tool_call_id: string }).tool_call_id).toBe('c1');
  });

  it('filters unknown parts and flags data parts', () => {
    const msgs: LangMsg[] = [
      { role: 1, parts: [{ kind: 'data' as 'text', mime: 'image', data: new Uint8Array(0) } as never] },
    ];
    const r = toChatCompletionsMessages(msgs);
    expect(r.hasDataPart).toBe(true);
    expect(r.messages).toHaveLength(0);
    expect(r.skipped.length).toBeGreaterThan(0);
  });
});

describe('toResponsesMessages', () => {
  it('produces function_call items and function_call_output items', () => {
    const msgs: LangMsg[] = [
      { role: 1, parts: [{ kind: 'toolResult', callId: 'c1', content: 'out' }] },
      { role: 2, parts: [{ kind: 'toolCall', callId: 'c1', name: 'fn', input: { x: 1 } }] },
    ];
    const r = toResponsesMessages(msgs);
    const itemTypes = r.input.flatMap((m) => ((m as unknown as { items?: { type: string }[] }).items ?? []).map((i: { type: string }) => i.type));
    expect(itemTypes).toContain('function_call');
    expect(itemTypes).toContain('function_call_output');
  });
});

describe('parseSse', () => {
  it('splits data frames and keeps trailing partial', () => {
    const { chunks, rest } = parseSse('data: {"a":1}\n\n: comment\ndata: {"b":2}\n\npartial');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].data).toBe('{"a":1}');
    expect(chunks[1].data).toBe('{"b":2}');
    expect(rest).toBe('partial');
  });
});

describe('chatCompletionsDelta', () => {
  it('parses text delta', () => {
    const d = chatCompletionsDelta('{"choices":[{"delta":{"content":"hi"}}]}');
    expect(d?.part).toEqual({ kind: 'text', value: 'hi' });
  });
  it('parses tool_call delta chunk', () => {
    const d = chatCompletionsDelta('{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{}"}}]}}]}');
    expect(d?.chunk?.callId).toBe('c1');
    expect(d?.chunk?.name).toBe('read');
  });
  it('returns done on finish_reason', () => {
    const d = chatCompletionsDelta('{"choices":[{"finish_reason":"stop"}]}');
    expect(d?.done).toBe(true);
  });
});

describe('responsesEvent', () => {
  it('parses output_text delta', () => {
    const d = responsesEvent('{"type":"response.output_text.delta","delta":"hi"}');
    expect(d?.part).toEqual({ kind: 'text', value: 'hi' });
  });
  it('parses function_call_arguments delta', () => {
    const d = responsesEvent('{"type":"response.function_call_arguments.delta","item_id":"i1","delta":"{\\"a\\":1}"}');
    expect(d?.chunk?.callId).toBe('i1');
  });
  it('returns done on completed', () => {
    const d = responsesEvent('{"type":"response.completed"}');
    expect(d?.done).toBe(true);
  });
});

describe('ToolCallAssembler', () => {
  it('assembles a tool call across frames and flushes only complete ones', () => {
    const a = new ToolCallAssembler();
    a.feed({ key: 'id:c1', callId: 'c1', name: 'read', argumentsFrag: '{"p' });
    expect(a.flush()).toHaveLength(0);
    a.feed({ key: 'id:c1', callId: 'c1', name: 'read', argumentsFrag: 'ath":"a"}' });
    a.markDone();
    const out = a.flush();
    expect(out).toHaveLength(1);
    expect(out[0].callId).toBe('c1');
    expect(JSON.parse(out[0].arguments)).toEqual({ path: 'a' });
  });

  it('supports multiple parallel tool calls without mixing', () => {
    const a = new ToolCallAssembler();
    a.feed({ key: 'id:c1', callId: 'c1', name: 'read', argumentsFrag: '{"a":1}' });
    a.feed({ key: 'id:c2', callId: 'c2', name: 'write', argumentsFrag: '{"b":2}' });
    a.markDone();
    const out = a.flush();
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.callId).sort()).toEqual(['c1', 'c2']);
    expect(JSON.parse(out[0].arguments)).toEqual({ a: 1 });
    expect(JSON.parse(out[1].arguments)).toEqual({ b: 2 });
  });
});
