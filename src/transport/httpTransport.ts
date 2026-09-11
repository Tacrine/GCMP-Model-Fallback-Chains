import type { Cancel, HttpTarget, LangMsg, LangPart, ProbeResult, SendOptions, SendOutcome, Target, Transport, Logger } from '../types';
import { toChatCompletionsMessages, toResponsesMessages } from '../convert/request';
import { parseSse, chatCompletionsDelta, responsesEvent, ToolCallAssembler } from '../convert/sse';

interface HttpDeps {
  logger: Logger;
  fetch?: typeof fetch;
  /** resolve API key for a secretRef, e.g. context.secrets.get('fallbackrouter.<ref>') */
  getSecret: (secretRef: string) => Promise<string | undefined>;
  secretsToRedact: () => Promise<string[]>;
}

/** Minimal fetch+stream interface so tests can inject a mock. */
export interface StreamLike {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> };
}

export class HttpError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
  }
}

function baseUrlJoin(base: string, endpoint: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${b}${endpoint}`;
}

export class HttpTransport implements Transport {
  readonly id = 'http';
  constructor(private readonly deps: HttpDeps) {}

  canHandle(target: Target, needsTools: boolean, hasDataParts: boolean, msgTokenCount: number): { ok: boolean; reason?: string } {
    if (target.kind !== 'http') return { ok: false, reason: 'not an http target' };
    if (needsTools && target.toolCalling === false) return { ok: false, reason: 'target does not support tool calling' };
    if (hasDataParts && target.imageInput !== true) return { ok: false, reason: 'target does not support image input' };
    if (target.maxInputTokens !== undefined && msgTokenCount > target.maxInputTokens) {
      return { ok: false, reason: `input tokens exceed maxInputTokens (${msgTokenCount} > ${target.maxInputTokens})` };
    }
    return { ok: true };
  }

  async probe(target: Target): Promise<ProbeResult> {
    if (target.kind !== 'http') return { ok: false, message: 'not http', toolCalling: false, firstByteMs: 0 };
    const started = Date.now();
    try {
      const url = baseUrlJoin(target.baseUrl, target.modelsEndpoint ?? '/models');
      const headers = await this.buildHeaders(target);
      const res = await (this.deps.fetch ?? globalThis.fetch)(url, { method: 'GET', headers, signal: undefined });
      const firstByteMs = Date.now() - started;
      return { ok: res.ok, message: res.ok ? `ok (${res.status})` : `http ${res.status}`, toolCalling: target.toolCalling !== false, firstByteMs };
    } catch (e) {
      return { ok: false, message: describeError(e), toolCalling: false, firstByteMs: Date.now() - started };
    }
  }

  private async buildHeaders(target: HttpTarget): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // customHeader verbatim, highest precedence.
    if (target.customHeader) {
      for (const [k, v] of Object.entries(target.customHeader)) headers[k] = v;
    }
    const key = await this.deps.getSecret(target.secretRef);
    if (key) {
      // Do not override a customHeader-supplied Authorization.
      if (!target.customHeader || !Object.keys(target.customHeader).some((k) => k.toLowerCase() === 'authorization')) {
        headers.Authorization = `Bearer ${key}`;
      }
    }
    return headers;
  }

  async send(
    target: Target,
    messages: readonly LangMsg[],
    options: SendOptions,
    emit: (part: LangPart) => void,
    token: Cancel
  ): Promise<SendOutcome> {
    if (target.kind !== 'http') {
      return { ok: false, error: new Error('not an http target'), retryable: false, emittedParts: 0, emittedToolCall: false };
    }
    const controller = new AbortController();
    const disp = token.onCancellationRequested(() => controller.abort());
    try {
      const { url, body, apiType } = this.buildRequest(target, messages, options);
      this.deps.logger.debug(`[http] POST ${url} apiType=${apiType}`);
      const res = await this.fetchWithTimeout(target, url, body, controller, options.timeouts);
      if (!res) {
        return { ok: false, error: new Error('request aborted/timed out'), retryable: true, emittedParts: 0, emittedToolCall: false };
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel?.().catch(() => {});
        return { ok: false, error: new HttpError(`unauthorized (http ${res.status})`, res.status, res.status === 401 ? 'unauthorized' : 'forbidden'), retryable: false, emittedParts: 0, emittedToolCall: false };
      }
      if (res.status !== 200) {
        const retryable = [429, 500, 502, 503, 504].includes(res.status);
        const body = await readBody(res).catch(() => '');
        return { ok: false, error: new HttpError(`http ${res.status}: ${body.slice(0, 200)}`, res.status, retryable ? 'retryable' : 'nonretryable'), retryable, emittedParts: 0, emittedToolCall: false };
      }
      const result = await this.readStream(target, res, apiType, emit, token, options.timeouts);
      return { ok: result.ok, error: result.error, retryable: result.retryable, emittedParts: result.emittedParts, emittedToolCall: result.emittedToolCall };
    } catch (e) {
      if (token.isCancellationRequested) {
        return { ok: false, error: new Error('cancelled'), retryable: false, emittedParts: 0, emittedToolCall: false };
      }
      const retryable = isRetryableNetworkError(e);
      return { ok: false, error: e, retryable, emittedParts: 0, emittedToolCall: false };
    } finally {
      disp();
    }
  }

  private buildRequest(target: HttpTarget, messages: readonly LangMsg[], options: SendOptions): { url: string; body: string; apiType: string } {
    const endpoint = target.apiType === 'responses' ? '/responses' : '/chat/completions';
    const url = baseUrlJoin(target.baseUrl, endpoint);
    const tools = options.tools?.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema ?? { type: 'object', properties: {} } },
    }));
    const toolMode = options.toolMode === 'required' ? 'required' : 'auto';
    if (target.apiType === 'responses') {
      const c = toResponsesMessages(messages);
      const body: Record<string, unknown> = {
        model: target.model,
        input: c.input,
        stream: true,
      };
      if (tools && tools.length) {
        body.tools = tools;
        body.tool_choice = options.toolMode === 'required' ? 'required' : 'auto';
      }
      return { url, body: JSON.stringify(body), apiType: 'responses' };
    }
    const c = toChatCompletionsMessages(messages);
    const body: Record<string, unknown> = {
      model: target.model,
      messages: c.messages,
      stream: true,
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = toolMode;
    }
    return { url, body: JSON.stringify(body), apiType: 'chat-completions' };
  }

  private async fetchWithTimeout(
    target: HttpTarget,
    url: string,
    body: string,
    controller: AbortController,
    timeouts: SendOptions['timeouts']
  ): Promise<Response | null> {
    const headers = await this.buildHeaders(target);
    const timeout = (ms: number) => new Promise<never>((_, rej) => {
      const timer = setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    // connect+headers stage timeout
    const res = await Promise.race([
      (this.deps.fetch ?? globalThis.fetch)(url, { method: 'POST', headers, body, signal: controller.signal }),
      timeout(timeouts.connectMs + timeouts.headersMs),
    ]);
    return res;
  }

  private async readStream(
    target: HttpTarget,
    res: Response,
    apiType: string,
    emit: (part: LangPart) => void,
    token: Cancel,
    timeouts: SendOptions['timeouts']
  ): Promise<{ ok: boolean; error?: unknown; retryable?: boolean; emittedParts: number; emittedToolCall: boolean }> {
    const t = timeouts;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let emittedParts = 0;
    let emittedToolCall = false;
    const assembler = new ToolCallAssembler();
    let lastChunkAt = Date.now();

    const stallTimer = () =>
      new Promise<boolean>((resolve) => {
        const check = setInterval(() => {
          if (token.isCancellationRequested) { clearInterval(check); resolve(false); }
          else if (Date.now() - lastChunkAt > t.stallMs) { clearInterval(check); resolve(true); }
        }, Math.min(t.stallMs, 250));
        (check as unknown as { unref?: () => void }).unref?.();
      });

    try {
      // first-byte timeout: race first read against firstByteMs.
      const firstReadPromise = reader.read();
      const first = await Promise.race([
        firstReadPromise,
        new Promise<{ done: true }>((resolve) => {
          const timer = setTimeout(() => resolve({ done: true }), t.firstByteMs);
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
      let { done, value } = first;
      while (!done) {
        lastChunkAt = Date.now();
        const text = decoder.decode(value, { stream: true });
        buffer += text;
        const { chunks, rest } = parseSse(buffer);
        buffer = rest;
        for (const chunk of chunks) {
          if (!chunk.data) continue;
          if (chunk.data === '[DONE]') { done = true; break; }
          const parsed = apiType === 'responses' ? responsesEvent(chunk.data) : chatCompletionsDelta(chunk.data);
          if (!parsed) continue;
          if (parsed.error) {
            return { ok: false, error: new Error(parsed.error), retryable: isRetryableHttpCode(parsed.httpStatus), emittedParts, emittedToolCall };
          }
          if (parsed.chunk) {
            assembler.feed(parsed.chunk);
            // emit completed calls as they finish (multiple parallel supported)
            for (const call of assembler.flush()) {
              emittedToolCall = true;
              emittedParts++;
              emit({ kind: 'toolCall', callId: call.callId, name: call.name, input: safeParse(call.arguments) });
            }
          }
          if (parsed.part) {
            if (parsed.part.kind === 'text') { emittedParts++; emit(parsed.part); }
          }
          if (parsed.done) {
            for (const call of assembler.flush()) {
              emittedToolCall = true;
              emittedParts++;
              emit({ kind: 'toolCall', callId: call.callId, name: call.name, input: safeParse(call.arguments) });
            }
            return { ok: true, emittedParts, emittedToolCall };
          }
        }
        if (token.isCancellationRequested) return { ok: false, error: new Error('cancelled'), retryable: false, emittedParts, emittedToolCall };
        // stall timeout check
        const stalled = await Promise.race([stallTimer(), Promise.resolve(false)]);
        if (stalled) {
          return { ok: false, error: new Error(`stall timeout after ${t.stallMs}ms`), retryable: true, emittedParts, emittedToolCall };
        }
        if (token.isCancellationRequested) return { ok: false, error: new Error('cancelled'), retryable: false, emittedParts, emittedToolCall };
        ({ done, value } = await reader.read());
      }
      // end of stream: flush any assembled tool calls
      for (const call of assembler.flush()) {
        emittedToolCall = true;
        emittedParts++;
        emit({ kind: 'toolCall', callId: call.callId, name: call.name, input: safeParse(call.arguments) });
      }
      return { ok: true, emittedParts, emittedToolCall };
    } catch (e) {
      if (token.isCancellationRequested) return { ok: false, error: new Error('cancelled'), retryable: false, emittedParts, emittedToolCall };
      return { ok: false, error: e, retryable: isRetryableNetworkError(e), emittedParts, emittedToolCall };
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  private timeouts() {
    // These are set by the caller via SendOptions.timeouts; resolved here.
    // (The real values come through options; the transport uses them.)
    return { connectMs: 10000, headersMs: 15000, firstByteMs: 60000, stallMs: 120000 };
  }
}

function readBody(res: Response): Promise<string> {
  return res.text();
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function isRetryableHttpCode(status?: number): boolean {
  return !!status && [429, 500, 502, 503, 504].includes(status);
}

function isRetryableNetworkError(e: unknown): boolean {
  if (!e) return false;
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed') || msg.includes('timeout') || msg.includes('aborted') || msg.includes('stall')) return true;
  if (e instanceof HttpError) return e.status !== undefined && [429, 500, 502, 503, 504].includes(e.status);
  return false;
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
