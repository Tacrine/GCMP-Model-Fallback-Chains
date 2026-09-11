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
    if (!entry) throw new vscode.LanguageModelError(`model ${model.id} not configured`, vscode.LanguageModelError.Unknown);
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
        throw new vscode.LanguageModelError(
          `${err.message} (chain=${chain.id}${err.targetKey ? ', target=' + err.targetKey : ''})`,
          err.code === 'Unknown' ? vscode.LanguageModelError.Unknown : mapCode(err.code)
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
        getSecret: (ref) => this.deps.secrets.get(`fallbackrouter.${ref}`),
        secretsToRedact: () => this.deps.getSecretsProvider()(),
      });
    }
    return new ProxyTransport({
      logger: this.deps.logger,
      lm: lmAdapter,
      toUpstreamMessages: (m) => m,
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

/** Proxy part conversion from a vscode-like part to LangPart. */
function proxyToLangPart(p: import('./transport/proxyTransport').ChatPartLike): import('./types').LangPart | null {
  switch (p.kind) {
    case 'text': return { kind: 'text', value: p.value ?? '' };
    case 'toolCall': return { kind: 'toolCall', callId: p.callId ?? '', name: p.name ?? '', input: p.input ?? {} };
    case 'toolResult': return { kind: 'toolResult', callId: p.callId ?? '', content: p.content ?? '' };
    case 'data': return { kind: 'data', mime: p.mimeType?.startsWith('image') ? 'image' : 'text', data: p.data };
    default: return null;
  }
}

class EmitGuard {
  private allowed = true;
  /** After deadline/target switch, refuse late parts. */
  guard(): boolean {
    return this.allowed;
  }
  block(): void { this.allowed = false; }
}

function mapCode(code: string): vscode.LanguageModelErrorCode {
  switch (code) {
    case 'NoPermissions': return vscode.LanguageModelError.NoPermissions;
    case 'Blocked': return vscode.LanguageModelError.Blocked;
    case 'NotFound': return vscode.LanguageModelError.NotFound;
    default: return vscode.LanguageModelError.Unknown;
  }
}

const lmAdapter: LmLike = {
  async selectChatModels(selector) {
    const models = await vscode.lm.selectChatModels(selector as vscode.LanguageModelChatSelector);
    return models.map((m) => ({
      vendor: m.vendor,
      id: m.id,
      async sendRequest(msgs, options, token) {
        const resp = await m.sendRequest(msgs as never, { tools: options.tools as never, toolMode: options.toolMode as never, modelOptions: options.modelOptions }, token as vscode.CancellationToken);
        return { stream: resp.stream as AsyncIterable<import('./transport/proxyTransport').ChatPartLike> };
      },
      async countTokens(text, t) { return m.countTokens(text, t); },
    }));
  },
};
