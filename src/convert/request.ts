import type { LangMsg, LangPart, Role } from '../types';

export interface ConvertedMessage {
  role: 'user' | 'assistant' | 'tool';
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface ConvertRequestResult {
  messages: ConvertedMessage[];
  /** parts filtered out with a reason. */
  skipped: { index: number; reason: string }[];
  hasDataPart: boolean;
}

/**
 * Convert router-internal LangMsg[] into OpenAI chat-completions wire messages.
 * Pure function — no vscode dependency, unit-testable.
 */
export function toChatCompletionsMessages(messages: readonly LangMsg[]): ConvertRequestResult {
  const out: ConvertedMessage[] = [];
  const skipped: { index: number; reason: string }[] = [];
  let hasDataPart = false;

  messages.forEach((msg, idx) => {
    const roleName = roleToString(msg.role);
    const textParts: string[] = [];
    const toolCalls: unknown[] = [];
    const toolResults: ConvertedMessage[] = [];
    let hasValid = false;

    for (const part of msg.parts) {
      switch (part.kind) {
        case 'text':
          textParts.push(part.value);
          hasValid = true;
          break;
        case 'toolCall':
          toolCalls.push({ id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } });
          hasValid = true;
          break;
        case 'toolResult':
          toolResults.push({
            role: 'tool',
            content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
            tool_call_id: part.callId,
          });
          hasValid = true;
          break;
        case 'data':
          // Binary/image data cannot be sent to a text-only chat endpoint.
          skipped.push({ index: idx, reason: 'data part dropped (image/binary not supported by this endpoint)' });
          hasDataPart = true;
          break;
        default:
          skipped.push({ index: idx, reason: 'unknown part filtered' });
      }
    }

    if (!hasValid) return;

    if (toolResults.length > 0) {
      // Tool results must be sent as their own `role: "tool"` messages.
      out.push(...toolResults);
    }

    if (roleName === 'assistant' && toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: textParts.length ? textParts.join('\n') : null,
        tool_calls: toolCalls,
      });
    } else if (textParts.length > 0 || roleName === 'user') {
      out.push({
        role: roleName as 'user' | 'assistant',
        content: textParts.length ? textParts.join('\n') : '',
        name: msg.name,
      });
    }
  });

  return { messages: out, skipped, hasDataPart };
}

function roleToString(r: Role): string {
  // Stable enum: User=1, Assistant=2. There is no System role.
  if (r === 1) return 'user';
  if (r === 2) return 'assistant';
  // Defensive: map unknown role to 'user' and preserve order (documented choice).
  return 'user';
}

export interface ResponsesMessage {
  role: 'user' | 'assistant' | 'developer';
  content: unknown;
  name?: string;
}

/**
 * Convert to OpenAI Responses API input format.
 * Responses uses typed content parts; tool calls become output items.
 */
export function toResponsesMessages(messages: readonly LangMsg[]): {
  input: ResponsesMessage[];
  skipped: { index: number; reason: string }[];
  hasDataPart: boolean;
} {
  const out: ResponsesMessage[] = [];
  const skipped: { index: number; reason: string }[] = [];
  let hasDataPart = false;

  for (const msg of messages) {
    const role = roleToString(msg.role) as 'user' | 'assistant';
    const textParts: string[] = [];
    const items: unknown[] = [];
    let hasValid = false;

    for (const part of msg.parts) {
      switch (part.kind) {
        case 'text':
          textParts.push(part.value);
          hasValid = true;
          break;
        case 'toolCall':
          items.push({
            type: 'function_call',
            id: part.callId,
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
            call_id: part.callId,
          });
          hasValid = true;
          break;
        case 'toolResult':
          items.push({
            type: 'function_call_output',
            call_id: part.callId,
            output: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
          });
          hasValid = true;
          break;
        case 'data':
          skipped.push({ index: messages.indexOf(msg), reason: 'data part dropped (image/binary unsupported)' });
          hasDataPart = true;
          break;
        default:
          skipped.push({ index: messages.indexOf(msg), reason: 'unknown part filtered' });
      }
    }
    if (!hasValid) continue;
    const content = textParts.length ? textParts.join('\n') : (items.length ? null : '');
    const entry: ResponsesMessage = { role, content };
    if (items.length) {
      (entry as unknown as { content: unknown; items: unknown[] }).items = items;
    }
    out.push(entry);
  }

  return { input: out, skipped, hasDataPart };
}
