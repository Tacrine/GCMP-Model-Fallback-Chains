import * as vscode from 'vscode';
import type { Logger } from './types';
import { redact } from './util/redact';

export type LogLevel = 'off' | 'error' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { off: 0, error: 1, info: 2, debug: 3 };

export class OutputLogger implements Logger {
  private channel: vscode.OutputChannel;
  private level: LogLevel = 'info';
  private secrets: string[] = [];

  constructor(private readonly secretsProvider: () => Promise<string[]>) {
    this.channel = vscode.window.createOutputChannel('Fallback Router');
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  async refreshSecrets(): Promise<void> {
    this.secrets = await this.secretsProvider();
  }

  private write(level: LogLevel, msg: string, args: unknown[]): void {
    if (ORDER[level] === 0) return;
    if (ORDER[level] > ORDER[this.level]) return;
    const text = redact(msg, this.secrets) + (args.length ? ' ' + args.map((a) => redact(safe(a), this.secrets)).join(' ') : '');
    this.channel.appendLine(`[${new Date().toISOString()}] ${text}`);
  }

  error(msg: string, ...args: unknown[]): void { this.write('error', msg, args); }
  warn(msg: string, ...args: unknown[]): void { this.write('info', msg, args); }
  info(msg: string, ...args: unknown[]): void { this.write('info', msg, args); }
  debug(msg: string, ...args: unknown[]): void { this.write('debug', msg, args); }

  dispose(): void {
    this.channel.dispose();
  }
}

function safe(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export class StatusBar {
  private item: vscode.StatusBarItem;
  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.text = 'FR: idle';
    this.item.name = 'Fallback Router';
    this.item.tooltip = 'Fallback Router';
  }

  setChain(name: string | undefined, position?: string, state?: 'open' | 'halfOpen' | 'closed'): void {
    if (!name) {
      this.item.text = 'FR: idle';
      this.item.tooltip = 'Fallback Router';
      return;
    }
    if (state === 'open' || state === 'halfOpen') {
      this.item.text = `FR: ${name} · ${state}`;
      this.item.tooltip = `Fallback Router: chain "${name}" breaker ${state}`;
    } else {
      this.item.text = position ? `FR: ${name} · ${position}` : `FR: ${name}`;
      this.item.tooltip = `Fallback Router: chain "${name}"`;
    }
  }

  show(): void { this.item.show(); }
  hide(): void { this.item.hide(); }
  dispose(): void { this.item.dispose(); }
}
