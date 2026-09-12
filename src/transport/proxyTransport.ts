import type { Cancel, LangMsg, LangPart, ProbeResult, SendOptions, SendOutcome, Target, Transport, Logger } from '../types';

/** Abstraction over vscode.lm so the transport is unit-testable without VS Code. */
export interface LmLike {
  selectChatModels(selector: { vendor?: string; id?: string }): Promise<ChatModelLike[]>;
}

export interface ChatModelLike {
  readonly vendor: string;
  readonly id: string;
  sendRequest(
    messages: unknown[],
    options: { tools?: unknown[]; toolMode?: unknown; modelOptions?: Record<string, unknown> },
    token: { isCancellationRequested: boolean; onCancellationRequested: (fn: () => void) => () => void }
  ): Promise<{ stream: AsyncIterable<ChatPartLike> }>;
  countTokens?(text: string, token?: unknown): Promise<number>;
}

export interface ChatPartLike {
  kind: 'text' | 'toolCall' | 'toolResult' | 'data';
  value?: string;
  callId?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  mimeType?: string;
  data?: unknown;
}

interface ProxyDeps {
  logger: Logger;
  lm: LmLike;
  /** convert internal LangMsg[] back to provider-facing messages (identity passthrough in this transport). */
  toUpstreamMessages(messages: readonly LangMsg[]): unknown[];
  toUpstreamPart(part: LangPart): ChatPartLike;
  toDownstreamPart(part: ChatPartLike): LangPart | null;
}

export class ProxyTransport implements Transport {
  readonly id = 'proxy';
  constructor(private readonly deps: ProxyDeps) {}

  canHandle(target: Target, needsTools: boolean, hasDataParts: boolean, msgTokenCount: number): { ok: boolean; reason?: string } {
    // Proxy delegates capability checks to the underlying provider; nothing to skip here.
    return { ok: true };
  }

  async probe(target: Target): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const models = await this.resolve(target);
      if (models.length === 0) return { ok: false, message: 'target not found', toolCalling: false, firstByteMs: 0 };
      return { ok: true, message: 'ok', toolCalling: true, firstByteMs: Date.now() - started };
    } catch (e) {
      return { ok: false, message: String(e), toolCalling: false, firstByteMs: Date.now() - started };
    }
  }

  private async resolve(target: Target): Promise<ChatModelLike[]> {
    if (target.kind !== 'proxy') return [];
    // Recursion guard: never delegate to our own vendor.
    if (target.vendor === 'fallbackrouter') return [];
    const models = await this.deps.lm.selectChatModels({ vendor: target.vendor, id: target.modelId });
    return models.filter((m) => m.vendor !== 'fallbackrouter' && m.vendor === target.vendor && m.id === target.modelId);
  }

  async send(
    target: Target,
    messages: readonly LangMsg[],
    options: SendOptions,
    emit: (part: LangPart) => void,
    token: Cancel
  ): Promise<SendOutcome> {
    if (target.kind !== 'proxy') {
      return { ok: false, error: new Error('not a proxy target'), retryable: false, emittedParts: 0, emittedToolCall: false };
    }
    const models = await this.resolve(target);
    if (models.length === 0) {
      // preflight hard failure: wrong id silently yields [].
      return {
        ok: false,
        error: new Error(`目标 ${target.vendor}/${target.modelId} 未找到：请检查配置，或先安装对应的 BYOK provider（如 gcmp）`),
        retryable: false,
        emittedParts: 0,
        emittedToolCall: false,
      };
    }
    const model = models[0];
    const upstreamMsgs = this.deps.toUpstreamMessages(messages);
    const upstreamOptions = {
      tools: options.tools ? [...options.tools] as unknown[] : undefined,
      toolMode: options.toolMode as unknown,
      modelOptions: options.modelOptions,
    };
        // Track emitted parts outside the try so a mid-stream error keeps the real
        // counts: the router's anti-duplication guards (emittedParts > 0 /
        // emittedToolCall) then take the terminal non-retry path instead of
        // re-streaming a fresh response over already-emitted output.
        let emittedParts = 0;
        let emittedToolCall = false;
        try {
          const response = await model.sendRequest(upstreamMsgs, upstreamOptions, token);
          for await (const chunk of response.stream) {
        if (token.isCancellationRequested) break;
        const part = this.deps.toDownstreamPart(chunk);
        if (!part) continue;
        if (part.kind === 'toolCall') emittedToolCall = true;
        emittedParts++;
        emit(part);
      }
      if (token.isCancellationRequested) {
        return { ok: false, error: new Error('cancelled'), retryable: false, emittedParts, emittedToolCall };
      }
      return { ok: true, emittedParts, emittedToolCall };
    } catch (e) {
      const isNoPerm = e && typeof e === 'object' && (e as { code?: string }).code === 'NoPermissions';
          return { ok: false, error: e, retryable: !isNoPerm, emittedParts, emittedToolCall };
    }
  }
}
