import * as vscode from 'vscode';
import type { RouterConfig, Chain, Target, LangMsg, Transport, Logger } from './types';
import { FallbackRouter, RouterError, CancellationError } from './router/router';
import { CircuitBreaker, StateStore } from './router/circuitBreaker';
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

/** Metadata a chain target contributes to the composite capability merge. */
export interface ResolvedModelMeta {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  /** Platform metadata when available (selectChatModels' LanguageModelChat does
     * not expose capabilities on 1.137 — absent here means conservative). */
  capabilities?: { toolCalling: boolean; imageInput: boolean };
}

/** Pure capability merge over resolvable proxy metadata (T3 / Metis #1):
   * toolCalling = AND, imageInput = AND, token caps = chain min. Targets with
   * no capability metadata fall back to conservative defaults: toolCalling
   * stays true (never downgrade optimistically), imageInput false (don't claim
   * image support we can't prove). */
export function mergeChainCapabilities(resolved: ResolvedModelMeta[]): {
  maxInputTokens: number;
  maxOutputTokens: number;
  toolCalling: boolean;
  imageInput: boolean;
} {
  let minInput = Infinity;
  let minOutput = Infinity;
  let toolCalling = true;
  let allImage = true;
  for (const m of resolved) {
    minInput = Math.min(minInput, m.maxInputTokens ?? Infinity);
    minOutput = Math.min(minOutput, m.maxOutputTokens ?? Infinity);
    if (m.capabilities) {
      toolCalling = toolCalling && m.capabilities.toolCalling;
      allImage = allImage && m.capabilities.imageInput;
    } else {
      allImage = false;
    }
  }
  return {
    maxInputTokens: isFinite(minInput) ? minInput : 128000,
    maxOutputTokens: isFinite(minOutput) ? minOutput : 4096,
    toolCalling,
      imageInput: allImage && resolved.length > 0,
  };
}

export class FallbackRouterProvider implements vscode.LanguageModelChatProvider {
  private models: vscode.LanguageModelChatInformation[] = [];
  private modelsByChain = new Map<string, { chain: Chain; info: vscode.LanguageModelChatInformation }>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly emitter = new vscode.EventEmitter<void>();
  private activeControllers = new Set<AbortController>();
    /** Monotonic refresh generation: only the most recently started refresh may
       * commit, so an older in-flight refresh finishing last cannot install a
       * stale model list over a newer one (F2 remediation). */
    private refreshGen = 0;

  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> = this.emitter.event;

  constructor(private readonly deps: ProviderDeps) {}

  /** Build the in-memory model list from the current config, merging real
     * capabilities from live vscode.lm metadata (proxy-only chains). Old models
     * are kept until the merged set is complete (no flash/empty window).
     *
     * Capability merge (T3, Metis #1): toolCalling = AND, imageInput = AND,
     * token caps = chain min. Unresolvable models fall back to conservative
     * defaults (toolCalling stays true — never downgrade optimistically;
     * imageInput false — don't claim image support we can't prove).
     */
    async refresh(): Promise<void> {
          const gen = ++this.refreshGen;
          const cfg = this.deps.getConfig();
      const nextByChain = new Map<string, { chain: Chain; info: vscode.LanguageModelChatInformation }>();
      const nextInfos: vscode.LanguageModelChatInformation[] = [];
      await Promise.all(
        cfg.chains.map(async (chain) => {
          const resolved: ResolvedModelMeta[] = [];
          for (const t of chain.targets) {
            if (t.kind !== 'proxy') continue;
            try {
              const models = await vscode.lm.selectChatModels({ vendor: t.vendor, id: t.modelId });
              const m = models.find((x) => x.vendor === t.vendor && x.id === t.modelId);
              if (!m) continue; // Unresolvable: conservative defaults handle it.
              resolved.push({ maxInputTokens: m.maxInputTokens });
            } catch {
              // Per-model failure → conservative defaults for that target.
            }
          }
          if (chain.targets.length === 0) return;
          const caps = mergeChainCapabilities(resolved);
          const info: vscode.LanguageModelChatInformation = {
            id: `fallbackrouter:${chain.id}`,
            name: `${chain.name} (fallback)`,
            family: 'fallbackrouter',
            version: '1',
            maxInputTokens: caps.maxInputTokens,
            maxOutputTokens: caps.maxOutputTokens,
            capabilities: { toolCalling: caps.toolCalling, imageInput: caps.imageInput },
          };
          nextInfos.push(info);
          nextByChain.set(`fallbackrouter:${chain.id}`, { chain, info });
        })
      );
      // Swap only after the full merge completes (no flash/empty window).
            // Self-dismiss if a newer refresh was started while we were awaiting:
            // the newest snapshot is authoritative (F2 remediation).
            if (gen !== this.refreshGen) return;
            this.modelsByChain = nextByChain;
            this.models = nextInfos;
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
