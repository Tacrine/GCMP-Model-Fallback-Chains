/**
 * Minimal, transport-agnostic types shared by the router core and transports.
 * These intentionally do NOT reference the `vscode` module so the router core
 * and converters can be unit-tested without a VS Code runtime.
 */

export type ApiType = 'chat-completions' | 'responses';

export interface HttpTarget {
  kind: 'http';
  /** Base URL, e.g. https://host/v1 */
  baseUrl: string;
  apiType: ApiType;
  /** Upstream model identifier, passed verbatim. */
  model: string;
  /** Reference name for the API key stored in SecretStorage under `fallbackrouter.<secretRef>`. */
  secretRef: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
  imageInput?: boolean;
  customHeader?: Record<string, string>;
  modelsEndpoint?: string;
}

export interface ProxyTarget {
  kind: 'proxy';
  /** Vendor of the existing BYOK provider (e.g. gcmp.compatible). */
  vendor: string;
  /** Model id as resolvable via `selectChatModels`. */
  modelId: string;
}

export type Target = HttpTarget | ProxyTarget;

export interface Chain {
  id: string;
  name: string;
  targets: Target[];
}

/** Validated, normalized configuration (immutable by convention). */
export interface RouterConfig {
  chains: Chain[];
  retry: { maxAttempts: number; initialDelayMs: number; backoffFactor: number; maxDelayMs: number };
  circuitBreaker: { failureThreshold: number; cooldownMs: number };
  timeouts: { connectMs: number; headersMs: number; firstByteMs: number; stallMs: number };
  maxTurnMs: number;
  maxTargetsPerTurn: number;
  importMode: 'family' | 'exact';
  retryOnRateLimit: boolean;
  noticeStyle: 'markdown' | 'plain';
  logLevel: 'off' | 'error' | 'info' | 'debug';
}

/** Chat roles — mirrors vscode's stable enum (User=1, Assistant=2). */
export enum Role {
  User = 1,
  Assistant = 2,
}

export type DataMime = 'text' | 'image';

/** A chat message part forwarded through the router. */
export type LangPart =
  | { kind: 'text'; value: string }
  | { kind: 'toolCall'; callId: string; name: string; input: unknown }
  | { kind: 'toolResult'; callId: string; content: unknown; isError?: boolean }
  | { kind: 'data'; mime: DataMime; data: unknown };

/** A chat message: role + ordered parts. */
export interface LangMsg {
  role: Role;
  parts: LangPart[];
  name?: string;
}

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export type ToolMode = 'auto' | 'required';

export interface SendOptions {
  tools?: readonly ToolDef[];
  toolMode?: ToolMode;
  modelOptions?: Record<string, unknown>;
  timeouts: { connectMs: number; headersMs: number; firstByteMs: number; stallMs: number };
}

export type Cancel = { readonly isCancellationRequested: boolean; onCancellationRequested: (fn: () => void) => () => void };

export interface SendOutcome {
  ok: boolean;
  error?: unknown;
  retryable?: boolean;
  emittedParts: number;
  emittedToolCall: boolean;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
  toolCalling: boolean;
  firstByteMs: number;
}

export interface Logger {
  error(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}

export interface Transport {
  readonly id: string;
  probe?(target: Target): Promise<ProbeResult>;
  send(
    target: Target,
    messages: readonly LangMsg[],
    options: SendOptions,
    emit: (part: LangPart) => void,
    token: Cancel
  ): Promise<SendOutcome>;
  /** Whether this target can accept the given message/tool profile (preflight). */
  canHandle(target: Target, needsTools: boolean, hasDataParts: boolean, msgTokenCount: number): { ok: boolean; reason?: string };
}
