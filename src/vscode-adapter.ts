import * as vscode from 'vscode';
import type { LangMsg, LangPart } from './types';

/**
 * Convert VS Code chat request messages into our internal LangMsg[] so the
 * router core (pure, vscode-free) can process them. Unknown part types are
 * filtered and reported rather than dropped silently.
 */
export function fromVscodeMessages(msgs: readonly vscode.LanguageModelChatRequestMessage[]): {
  messages: LangMsg[];
  skipped: { role: number; reason: string }[];
} {
  const messages: LangMsg[] = [];
  const skipped: { role: number; reason: string }[] = [];
  for (const m of msgs) {
    const parts: LangPart[] = [];
    for (const p of m.content) {
      if (p instanceof vscode.LanguageModelTextPart) {
        parts.push({ kind: 'text', value: p.value });
      } else if (p instanceof vscode.LanguageModelToolCallPart) {
        let input: unknown;
        try {
          input = p.input;
        } catch {
          input = { raw: String(p) };
        }
        parts.push({ kind: 'toolCall', callId: p.callId, name: p.name, input });
      } else if (p instanceof vscode.LanguageModelToolResultPart) {
        const content = p.content.map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : String(c))).join('\n');
        parts.push({ kind: 'toolResult', callId: p.callId, content });
      } else if (p instanceof vscode.LanguageModelDataPart) {
        // Binary/image. Marked so preflight can skip non-image targets.
        parts.push({ kind: 'data', mime: p.mimeType?.startsWith('image') ? 'image' : 'text', data: p.data });
      } else {
        skipped.push({ role: m.role, reason: `unknown part type filtered: ${String(p)}` });
      }
    }
    messages.push({ role: m.role === vscode.LanguageModelChatMessageRole.User ? 1 : 2, parts, name: m.name });
  }
  return { messages, skipped };
}

/** Forward a router LangPart to vscode progress / emit. */
export function toVscodePart(part: LangPart): vscode.LanguageModelResponsePart {
  switch (part.kind) {
    case 'text':
      return new vscode.LanguageModelTextPart(part.value);
    case 'toolCall':
      return new vscode.LanguageModelToolCallPart(
        part.callId,
        part.name,
        typeof part.input === 'object' && part.input !== null ? part.input : {}
      );
    case 'toolResult':
      return new vscode.LanguageModelToolResultPart(part.callId, [new vscode.LanguageModelTextPart(String(part.content))]);
    case 'data':
      return vscode.LanguageModelDataPart.image(
        part.data instanceof Uint8Array ? part.data : new Uint8Array(0),
        part.mime === 'image' ? 'image/png' : 'application/json'
      );
  }
}

/** Count tokens in a vscode message (fallback estimate). */
export function estimateVscodeTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
