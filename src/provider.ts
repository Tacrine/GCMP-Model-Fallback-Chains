import * as vscode from 'vscode';
import type { RouterConfig, Chain, Target, LangMsg, Transport, Logger } from './types';
import { FallbackRouter, RouterError, CancellationError } from './router/router';
import { CircuitBreaker, StateStore } from './router/circuitBreaker';
import { HttpTransport } from './transport/httpTransport';
import { ProxyTransport, LmLike } from './transport/proxyTransport';
import { fromVscodeMessages, toVscodePart } from './vscode-adapter';
import { OutputLogger, StatusBar } from './observability';

/** Code we throw when aborting after a tool call / full-chain failure.
 * From T1 third stage; falls back to Unknown if none suppresses retry. */
export const SUPPRESS_RETRY_CODE = 'Unknown';
/** Stable `LanguageModelError` only exposes NoPermissions/Blocked/NotFound; use the
 * string code 'Unknown' for unspecified failures (its `code` field is a string). */
const CODE_UNKNOWN = 'Unknown';

/** Build a LanguageModelError for a given code string. Stable API has no
 * `Unknown` factory, so Unknown maps to `NotFound` (unspecified model failure). */
function lmError(message: string, code: string): vscode.LanguageModelError {
  switch (code) {
    case 'NoPermissions': return vscode.LanguageModelError.NoPermissions(message);
    case 'Blocked': return vscode.LanguageModelError.Blocked(message);
    default: return vscode.LanguageModelError.NotFound(message);
  }
}

export interface ProviderDeps {
  getConfig: () => RouterConfig;
  getSecretsProvider: () => () => Promise<string[]>;
  secrets: vscode.SecretStorage;
  context: vscode.ExtensionContext;
  logger: OutputLogger;
  statusBar: StatusBar;
}

export class FallbackRouterProvider implements vscode.LanguageModelChatProvider {
  private models: vscode.LanguageModelChatInformation[] = [];
  private modelsByChain = new Map<string, { chain: Chain; info: vscode.LanguageModelChatInformation }>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly emitter = new vscode.EventEmitter<void>();
  private activeControllers = new Set<AbortController>();

  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> = this.emitter.event;

  constructor(private readonly deps: ProviderDeps) {}

  /** Build the in-memory model list from the current config. Call on config change. */
  refresh(): void {
    const cfg = this.deps.getConfig();
    this.modelsByChain.clear();
    const infos: vscode.LanguageModelChatInformation[] = [];
    for (const chain of cfg.chains) {
      let minInput = Infinity;
      let minOutput = Infinity;
      let toolCalling = false;
      let allImage = true;
      for (const t of chain.targets) {
        if (t.kind === 'http') {
          minInput = Math.min(minInput, t.maxInputTokens ?? Infinity);
          minOutput = Math.min(minOutput, t.maxOutputTokens ?? Infinity);
          toolCalling = toolCalling || t.toolCalling !== false;
          allImage = allImage && t.imageInput === true;
        }
      }
      if (chain.targets.length === 0) continue;
      if (!isFinite(minInput)) minInput = 128000;
      if (!isFinite(minOutput)) minOutput = 4096;
      const info: vscode.LanguageModelChatInformation = {
        id: `fallbackrouter:${chain.id}`,
        name: `${chain.name} (fallback)`,
        family: 'fallbackrouter',
        version: '1',
        maxInputTokens: minInput,
        maxOutputTokens: minOutput,
        capabilities: { toolCalling, imageInput: allImage && chain.targets.length > 0 },
      };
      infos.push(info);
      this.modelsByChain.set(`fallbackrouter:${chain.id}`, { chain, info });
    }
    this.models = infos;
    this.emitter.fire();
  }

  async provideLanguageModelChatInformation(
    options: { silent?: boolean },
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    // Never emit any UI in this method.
    return this.models;
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    opts: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const cfg = this.deps.getConfig();
    const entry = this.modelsByChain.get(model.id);
    if (!entry) throw lmError(`model ${model.id} not configured`, CODE_UNKNOWN);
    const { chain } = entry;

    const conv = fromVscodeMessages(messages);
    for (const s of conv.skipped) this.deps.logger.warn(`[provider] skipped part role=${s.role}: ${s.reason}`);

    const langMsgs = conv.messages;
    const langOptions = {
      tools: (opts.tools ?? []) as never[],
      toolMode: (opts.toolMode ?? 'auto') as never,
      timeouts: cfg.timeouts,
      modelOptions: undefined,
    };

    const router = new FallbackRouter({
      transports: (t) => this.transportFor(t),
      breakers: this.breakers,
      breakerFactory: (key) =>
        new CircuitBreaker({ ...cfg.circuitBreaker, persistKey: `fallbackrouter.breaker.${key}`, store: this.stateStore() }),
      logger: this.deps.logger,
    });

    const controller = new AbortController();
    this.activeControllers.add(controller);
    const emitGuard = new EmitGuard();
    const disp = token.onCancellationRequested(() => { controller.abort(); });

    try {
      const result = await router.run(
        chain,
        langMsgs,
        {
          ...langOptions,
          retry: cfg.retry,
          circuitBreaker: cfg.circuitBreaker,
          maxTurnMs: cfg.maxTurnMs,
          maxTargetsPerTurn: cfg.maxTargetsPerTurn,
          retryOnRateLimit: cfg.retryOnRateLimit,
        },
        (part) => {
          if (emitGuard.guard()) progress.report(toVscodePart(part));
        },
        { isCancellationRequested: controller.signal.aborted, onCancellationRequested: (fn) => { const f = () => { if (controller.signal.aborted) fn(); }; controller.signal.addEventListener('abort', f); return () => controller.signal.removeEventListener('abort', f); } }
      );
      void result;
    } catch (err) {
      if (err instanceof CancellationError) throw err;
      if (err instanceof RouterError) {
        this.deps.logger.error(`[provider] chain ${chain.id} failed: ${err.message}`);
        throw lmError(
          `${err.message} (chain=${chain.id}${err.targetKey ? ', target=' + err.targetKey : ''})`,
          err.code === 'Unknown' ? CODE_UNKNOWN : mapCode(err.code)
        );
      }
      throw err;
    } finally {
      disp.dispose();
      this.activeControllers.delete(controller);
    }
  }

  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const content = typeof text === 'string' ? text : text.content.map((p) => p instanceof vscode.LanguageModelTextPart ? p.value : '').join(' ');
    return Math.ceil(content.length / 4);
  }

  private transportFor(t: Target): Transport {
    if (t.kind === 'http') {
      return new HttpTransport({
        logger: this.deps.logger,
        getSecret: async (ref) => this.deps.secrets.get(`fallbackrouter.${ref}`),
        secretsToRedact: () => this.deps.getSecretsProvider()(),
      });
    }
    return new ProxyTransport({
      logger: this.deps.logger,
      lm: lmAdapter,
        // Inverse of fromVscodeMessages: vscode.lm rejects plain LangMsg objects
        // (platform validates message shape before dispatch; T1 spike found
        // identity passthrough -> LanguageModelError NotFound in 3ms).
        toUpstreamMessages: (msgs) =>
          msgs.map((m) => ({
            role:
              m.role === 1
                ? vscode.LanguageModelChatMessageRole.User
                : vscode.LanguageModelChatMessageRole.Assistant,
            content: m.parts.map((p) => {
              switch (p.kind) {
                case 'text':
                  return new vscode.LanguageModelTextPart(p.value);
                case 'toolCall':
                  return new vscode.LanguageModelToolCallPart(
                    p.callId,
                    p.name,
                    typeof p.input === 'object' && p.input !== null ? p.input : {}
                  );
                case 'toolResult':
                  return new vscode.LanguageModelToolResultPart(p.callId, [
                    new vscode.LanguageModelTextPart(String(p.content)),
                  ]);
                case 'data':
                  return vscode.LanguageModelDataPart.image(
                    p.data instanceof Uint8Array ? p.data : new Uint8Array(0),
                    p.mime === 'image' ? 'image/png' : 'application/json'
                  );
              }
            }),
          })),
        toUpstreamPart: (p) => p,
        toDownstreamPart: (p) => proxyToLangPart(p),
      });
    }

  private stateStore(): StateStore {
    return {
      get: (k) => this.deps.context.globalState.get<{ state: 'open' | 'closed'; openUntil: number }>(k),
      set: (k, v) => { void this.deps.context.globalState.update(k, v); },
    };
  }

  dispose(): void {
    this.emitter.dispose();
    for (const c of this.activeControllers) c.abort();
  }

  getChains(): Map<string, { chain: Chain; info: vscode.LanguageModelChatInformation }> {
    return this.modelsByChain;
  }
}

/** Proxy part conversion from a vscode-like part to LangPart. Real vscode parts
 * (LanguageModelTextPart etc.) have NO `.kind` property (verified in T1 spike:
 * keys=[value]), so first dispatch on `.kind` for stubs, then on instanceof for
 * real platform parts (same approach as GCMP's own provider). */
function proxyToLangPart(p: import('./transport/proxyTransport').ChatPartLike): import('./types').LangPart | null {
  if (typeof (p as { kind?: unknown }).kind === 'string') {
    switch (p.kind) {
      case 'text': return { kind: 'text', value: p.value ?? '' };
      case 'toolCall': return { kind: 'toolCall', callId: p.callId ?? '', name: p.name ?? '', input: p.input ?? {} };
      case 'toolResult': return { kind: 'toolResult', callId: p.callId ?? '', content: p.content ?? '' };
      case 'data': return { kind: 'data', mime: p.mimeType?.startsWith('image') ? 'image' : 'text', data: p.data };
      default: return null;
    }
  }
  if (p instanceof vscode.LanguageModelTextPart) return { kind: 'text', value: p.value ?? '' };
  const ToolCallCtor = vscode.LanguageModelToolCallPart as (new (...a: never[]) => object) | undefined;
  if (ToolCallCtor && p instanceof ToolCallCtor) {
    const tc = p as { callId?: string; name?: string; input?: unknown };
    return { kind: 'toolCall', callId: tc.callId ?? '', name: tc.name ?? '', input: tc.input ?? {} };
  }
  const DataCtor = vscode.LanguageModelDataPart as (new (...a: never[]) => object) | undefined;
  if (DataCtor && p instanceof DataCtor) {
    return { kind: 'data', mime: 'text', data: (p as { data?: unknown }).data };
  }
  return null;
}

class EmitGuard {
  private allowed = true;
  /** After deadline/target switch, refuse late parts. */
  guard(): boolean {
    return this.allowed;
  }
  block(): void { this.allowed = false; }
}

function mapCode(code: string): string {
  switch (code) {
    case 'NoPermissions': return 'NoPermissions';
    case 'Blocked': return 'Blocked';
    case 'NotFound': return 'NotFound';
    default: return CODE_UNKNOWN;
  }
}

const lmAdapter: LmLike = {
  async selectChatModels(selector) {
    const models = await vscode.lm.selectChatModels(selector as vscode.LanguageModelChatSelector);
    return models.map((m) => ({
      vendor: m.vendor,
      id: m.id,
      async sendRequest(msgs, options, token) {
        // The router's Cancel is NOT a vscode.CancellationToken: its
        // onCancellationRequested returns a plain fn, but vscode.lm expects a
        // Disposable (it calls `.dispose()` on the returned registration).
        const lmToken: vscode.CancellationToken = {
          isCancellationRequested: token.isCancellationRequested,
          onCancellationRequested: (listener) => {
            const detach = token.onCancellationRequested(() => listener(undefined as never));
            return { dispose: detach };
          },
        };
        const resp = await m.sendRequest(
          msgs as never,
          { tools: options.tools as never, toolMode: options.toolMode as never, modelOptions: options.modelOptions },
          lmToken
        );
        return { stream: resp.stream as AsyncIterable<import('./transport/proxyTransport').ChatPartLike> };
      },
      async countTokens(text, t) { return m.countTokens(text, t as unknown as vscode.CancellationToken | undefined); },
    }));
  },
};
