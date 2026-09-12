import * as vscode from 'vscode';
import type { L10nArgs, MenuUi, SelectOptions } from './menu';

/**
 * Grace period after a picker/input box resolved. VS Code hides the widget with
 * an animation and, if the next one is requested before that teardown ends, the
 * new widget can be dismissed immediately — which is what made the level-2/3
 * menu entries look like no-ops when Manage was started from the command
 * palette.
 */
const SETTLE_MS = 150;

/**
 * A picker that resolves faster than this was not closed by a human: it was
 * dismissed by the host (palette teardown, focus loss while the previous widget
 * is still closing). Re-show it once instead of silently doing nothing.
 */
const MIN_HUMAN_MS = 250;

export interface VscodeMenuUiOptions {
  log?(message: string): void;
}

/** `MenuUi` backed by the real `vscode.window` surfaces. */
export class VscodeMenuUi implements MenuUi {
  private closedAt = 0;

  constructor(private readonly options: VscodeMenuUiOptions = {}) {}

  async select<T extends vscode.QuickPickItem>(items: readonly T[], options: SelectOptions): Promise<T | undefined> {
    const first = await this.show(items, options);
    if (!first.bogusDismiss) return first.item;
    this.options.log?.('[menu] picker dismissed by the host right after opening; re-showing');
    const second = await this.show(items, options);
    return second.item;
  }

  async input(prompt: string): Promise<string | undefined> {
    await this.settle();
    const value = await vscode.window.showInputBox({ prompt, ignoreFocusOut: true });
    this.closedAt = Date.now();
    return value;
  }

  info(message: string): void {
    this.options.log?.(message);
    void vscode.window.showInformationMessage(message);
  }

  error(message: string): void {
    this.options.log?.(message);
    void vscode.window.showErrorMessage(message);
  }

  private async show<T extends vscode.QuickPickItem>(
    items: readonly T[],
    options: SelectOptions
  ): Promise<{ item: T | undefined; bogusDismiss: boolean }> {
    await this.settle();
    const startedAt = Date.now();
    const item = await vscode.window.showQuickPick(items, {
      title: options.title,
      placeHolder: options.placeHolder,
      matchOnDescription: options.matchOnDescription,
      // The picker must survive the window/channel losing focus: every level of
      // this menu is opened while the previous widget is still around.
      ignoreFocusOut: true,
    });
    this.closedAt = Date.now();
    return { item, bogusDismiss: item === undefined && Date.now() - startedAt < MIN_HUMAN_MS };
  }

  private async settle(): Promise<void> {
    const wait = SETTLE_MS - (Date.now() - this.closedAt);
    await new Promise<void>((resolve) => setTimeout(resolve, wait > 0 ? wait : 0));
  }
}

/** `vscode.l10n.t` adapted to the menu's localization port. */
export function l10nT(message: string, args?: L10nArgs): string {
  return args === undefined ? vscode.l10n.t(message) : vscode.l10n.t(message, args);
}
