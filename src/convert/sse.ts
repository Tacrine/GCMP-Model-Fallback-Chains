import type { LangPart } from '../types';

export interface ToolCallChunk {
  key: string;
  callId?: string;
  name?: string;
  argumentsFrag: string;
}

export interface ParsedDelta {
  part?: LangPart;
  chunk?: ToolCallChunk;
  done?: boolean;
  error?: string;
  httpStatus?: number;
}

export interface SseChunk {
  data: string;
}

/** Very small SSE frame splitter (handles CRLF/LF, ignores comments). */
export function parseSse(buffer: string): { chunks: SseChunk[]; rest: string } {
  const chunks: SseChunk[] = [];
  const lines = buffer.split(/\r?\n/);
  let rest = lines.pop() ?? '';
  let dataLines: string[] = [];
  for (const line of lines) {
    if (line === '') {
      if (dataLines.length) {
        chunks.push({ data: dataLines.join('\n') });
        dataLines = [];
      }
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    else if (line.startsWith('data')) dataLines.push(line.slice(4).trimStart());
  }
  return { chunks, rest };
}

/** Parse chat-completions delta into a LangPart or tool-call chunk. */
export function chatCompletionsDelta(data: string): ParsedDelta | null {
  let obj: any;
  try {
    obj = JSON.parse(data);
  } catch {
    return null;
  }
  if (obj.error) {
    return { error: typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error), httpStatus: obj.status };
  }
  const choice = obj.choices && obj.choices[0];
  if (!choice) return null;
  const delta = choice.delta || {};
  if (choice.finish_reason) return { done: true };
  if (typeof delta.content === 'string' && delta.content.length) {
    return { part: { kind: 'text', value: delta.content } };
  }
  if (delta.tool_calls && delta.tool_calls.length) {
    const tc = delta.tool_calls[0];
    const idx = typeof tc.index === 'number' ? tc.index : 0;
    return {
      chunk: {
        key: tc.id ? `id:${tc.id}` : `idx:${idx}`,
        callId: tc.id,
        name: tc.function && tc.function.name,
        argumentsFrag: (tc.function && tc.function.arguments) || '',
      },
    };
  }
  return null;
}

/** Response-API event → LangPart or tool-call chunk. */
export function responsesEvent(data: string): ParsedDelta | null {
  let obj: any;
  try {
    obj = JSON.parse(data);
  } catch {
    return null;
  }
  if (obj.error) {
    return { error: typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error) };
  }
  const type = obj.type;
  if (type === 'response.completed') return { done: true };
  if (type === 'response.failed') return { error: obj.error?.message || 'response failed' };
  if (type === 'response.output_text.delta') {
    const d = obj.delta != null ? obj.delta : obj.text;
    if (typeof d === 'string' && d.length) return { part: { kind: 'text', value: d } };
  }
  if (type === 'response.function_call_arguments.delta') {
    const frag = obj.delta || '';
    const id = obj.item_id || obj.call_id;
    return { chunk: { key: id ? `id:${id}` : 'idx:0', callId: id, name: undefined, argumentsFrag: typeof frag === 'string' ? frag : '' } };
  }
  if (type === 'response.function_call_arguments.done') {
    return { done: true };
  }
  return null;
}

export interface AssembledToolCall {
  callId: string;
  name: string;
  arguments: string;
}

/** Accumulate tool-call chunks per call key and emit a complete call when the
 * stream ends / a done marker arrives. Supports multiple parallel calls. */
export class ToolCallAssembler {
  private byKey = new Map<string, { callId: string; name: string; args: string }>();

  feed(chunk: ToolCallChunk | undefined): void {
    if (!chunk) return;
    let bucket = this.byKey.get(chunk.key);
    if (!bucket) {
      bucket = { callId: chunk.callId || `call_${this.byKey.size}`, name: '', args: '' };
      this.byKey.set(chunk.key, bucket);
    }
    if (chunk.name) bucket.name = chunk.name;
    bucket.args += chunk.argumentsFrag;
  }

  /** Return calls that have a name+callId, removing them from the buffer. */
  flush(): AssembledToolCall[] {
    const out: AssembledToolCall[] = [];
    for (const [key, b] of this.byKey) {
      if (b.name && b.callId) {
        out.push({ callId: b.callId, name: b.name, arguments: b.args });
        this.byKey.delete(key);
      }
    }
    return out;
  }

  /** Return every pending call (used on abort/error to salvage completed ones). */
  drain(): AssembledToolCall[] {
    const out: AssembledToolCall[] = [];
    for (const [, b] of this.byKey) {
      if (b.name && b.callId) out.push({ callId: b.callId, name: b.name, arguments: b.args });
    }
    this.byKey.clear();
    return out;
  }
}
