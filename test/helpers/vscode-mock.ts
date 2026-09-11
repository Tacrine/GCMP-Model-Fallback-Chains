// Minimal `vscode` module mock for vitest unit tests that import src/provider.ts
// or src/observability.ts. Only the members those modules touch at runtime matter.

export class EventEmitter<T = void> {
  private fns: ((e: T) => void)[] = [];
  event = (fn: (e: T) => void): (() => void) => {
    this.fns.push(fn);
    return () => { const i = this.fns.indexOf(fn); if (i >= 0) this.fns.splice(i, 1); };
  };
  fire = (e: T): void => { for (const f of [...this.fns]) f(e); };
  dispose = (): void => { this.fns = []; };
}

export class LanguageModelError extends Error {
  static NoPermissions(message?: string): LanguageModelError { const e = new LanguageModelError(message ?? ''); e.code = 'NoPermissions'; return e; }
  static Blocked(message?: string): LanguageModelError { const e = new LanguageModelError(message ?? ''); e.code = 'Blocked'; return e; }
  static NotFound(message?: string): LanguageModelError { const e = new LanguageModelError(message ?? ''); e.code = 'NotFound'; return e; }
  code = 'Unknown';
  constructor(message?: string, code?: string) { super(message); this.code = code ?? 'Unknown'; }
}

export class LanguageModelTextPart { constructor(public value: string) {} }
export class LanguageModelToolCallPart { constructor(public callId: string, public name: string, public input: object) {} }
export class LanguageModelToolResultPart { constructor(public callId: string, public content: unknown[]) {} }
export class LanguageModelDataPart {
  static image(data: Uint8Array, mime: string): LanguageModelDataPart { return new LanguageModelDataPart(data, mime); }
  constructor(public data: Uint8Array, public mimeType: string) {}
}

export const lm = {
  selectChatModels: async (): Promise<never[]> => [],
  registerLanguageModelChatProvider: (): { dispose: () => void } => ({ dispose() {} }),
};

let channelSink: string[] = [];
let statusSink: { text: string; tooltip: string } = { text: '', tooltip: '' };

export const StatusBarAlignment = { Left: 1, Right: 2 };

export const window = {
  createOutputChannel: () => ({
    appendLine(line: string) { channelSink.push(line); },
    dispose() {},
  }),
  createStatusBarItem: () => ({
    show() {}, hide() {}, dispose() {},
    set text(v: string) { statusSink.text = v; },
    get text() { return statusSink.text; },
    set tooltip(v: string) { statusSink.tooltip = v; },
    get tooltip() { return statusSink.tooltip; },
    name: 'Fallback Router',
  }),
};

export function __resetSinks(): void { channelSink = []; statusSink = { text: '', tooltip: '' }; }
export function __channelLines(): string[] { return channelSink; }
export function __statusText(): string { return statusSink.text; }
