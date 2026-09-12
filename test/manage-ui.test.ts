import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscodeMock from './helpers/vscode-mock';

vi.mock('vscode', () => vscodeMock);

import { VscodeMenuUi, l10nT } from '../src/manage/vscode-ui';

interface PickCall {
  items: { label: string }[];
  options: { title?: string; placeHolder?: string; ignoreFocusOut?: boolean; matchOnDescription?: boolean };
}

interface StubStep {
  /** Item to resolve with; omitted means the user/host dismissed the picker. */
  item?: unknown;
  /** How long the picker stays open before resolving. */
  delayMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const uiWindow = vscodeMock.window as unknown as {
  showQuickPick: unknown;
  showInputBox: unknown;
  showInformationMessage: unknown;
  showErrorMessage: unknown;
};

/** Drive `showQuickPick` with a scripted sequence of resolutions. */
function stubQuickPick(steps: StubStep[]): PickCall[] {
  const calls: PickCall[] = [];
  let index = 0;
  uiWindow.showQuickPick = async (items: PickCall['items'], options: PickCall['options']) => {
    calls.push({ items, options });
    const step = steps[Math.min(index++, steps.length - 1)] ?? {};
    if (step.delayMs) await sleep(step.delayMs);
    return step.item;
  };
  return calls;
}

const ITEMS = [{ label: 'Add target' }, { label: 'Remove target' }];

describe('VscodeMenuUi', () => {
  beforeEach(() => {
    uiWindow.showQuickPick = async () => undefined;
    uiWindow.showInputBox = async () => undefined;
    uiWindow.showInformationMessage = async () => undefined;
    uiWindow.showErrorMessage = async () => undefined;
  });

  it('shows a picker that survives focus loss and returns the picked item', async () => {
    const calls = stubQuickPick([{ item: ITEMS[1] }]);
    const ui = new VscodeMenuUi();

    const picked = await ui.select(ITEMS, { title: 'Chain: alpha', placeHolder: 'pick one', matchOnDescription: true });

    expect(picked).toEqual(ITEMS[1]);
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toMatchObject({
      title: 'Chain: alpha',
      placeHolder: 'pick one',
      matchOnDescription: true,
      ignoreFocusOut: true,
    });
  });

  it('re-shows the picker when the host dismisses it the instant it opens', async () => {
    const calls = stubQuickPick([{}, { item: ITEMS[0] }]);
    const logs: string[] = [];
    const ui = new VscodeMenuUi({ log: (message) => logs.push(message) });

    const picked = await ui.select(ITEMS, { title: 'Chain: alpha' });

    expect(picked).toEqual(ITEMS[0]);
    expect(calls).toHaveLength(2);
    expect(logs.join('\n')).toContain('re-showing');
  });

  it('gives up after one retry so a real cancel still returns to the caller', async () => {
    const calls = stubQuickPick([{}, {}]);
    const ui = new VscodeMenuUi();

    const picked = await ui.select(ITEMS, { title: 'Chain: alpha' });

    expect(picked).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('treats a slow dismissal as a genuine cancel and does not retry', async () => {
    const calls = stubQuickPick([{ delayMs: 400 }]);
    const ui = new VscodeMenuUi();

    const picked = await ui.select(ITEMS, { title: 'Chain: alpha' });

    expect(picked).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('asks for text input without focus-loss auto-cancel', async () => {
    const boxes: { prompt?: string; ignoreFocusOut?: boolean }[] = [];
    uiWindow.showInputBox = async (options: { prompt?: string; ignoreFocusOut?: boolean }) => {
      boxes.push(options);
      return 'gcmp.custom';
    };
    const ui = new VscodeMenuUi();

    await expect(ui.input('proxy vendor')).resolves.toBe('gcmp.custom');

    expect(boxes).toEqual([{ prompt: 'proxy vendor', ignoreFocusOut: true }]);
  });

  it('surfaces info and error messages to the user and the log', async () => {
    const shown: string[] = [];
    uiWindow.showInformationMessage = async (message: string) => {
      shown.push(`info:${message}`);
    };
    uiWindow.showErrorMessage = async (message: string) => {
      shown.push(`error:${message}`);
    };
    const logs: string[] = [];
    const ui = new VscodeMenuUi({ log: (message) => logs.push(message) });

    ui.info('Already the first target.');
    ui.error('Action failed: boom');
    await sleep(0);

    expect(shown).toEqual(['info:Already the first target.', 'error:Action failed: boom']);
    expect(logs).toEqual(['Already the first target.', 'Action failed: boom']);
  });

  it('localizes with and without interpolation arguments', () => {
    expect(l10nT('Add target')).toBe('Add target');
    expect(l10nT('Chain: {name}', { name: 'alpha' })).toBe('Chain: alpha');
  });
});
