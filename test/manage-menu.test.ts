import { describe, it, expect } from 'vitest';
import type { QuickPickItem } from 'vscode';
import type { Chain } from '../src/types';
import {
  runManageMenu,
  targetLabel,
  type L10nArgs,
  type LmModel,
  type ManageDeps,
  type MenuUi,
  type SelectOptions,
} from '../src/manage/menu';

type Step =
  | { kind: 'pick'; label: string }
  | { kind: 'index'; index: number }
  | { kind: 'cancel' }
  | { kind: 'input'; value: string }
  | { kind: 'inputCancel' };

interface Call {
  kind: 'select' | 'input';
  title: string;
  labels: string[];
}

/** Deterministic stand-in for the picker/input surfaces. */
class FakeUi implements MenuUi {
  readonly calls: Call[] = [];
  readonly infos: string[] = [];
  readonly errors: string[] = [];

  constructor(private readonly steps: Step[]) {}

  remaining(): number {
    return this.steps.length;
  }

  titles(): string[] {
    return this.calls.map((c) => c.title);
  }

  labelsOf(title: string): string[] {
    const call = this.calls.find((c) => c.kind === 'select' && c.title === title);
    if (!call) throw new Error(`no picker titled "${title}" (got: ${this.titles().join(' | ')})`);
    return call.labels;
  }

  async select<T extends QuickPickItem>(items: readonly T[], options: SelectOptions): Promise<T | undefined> {
    const labels = items.map((i) => i.label);
    this.calls.push({ kind: 'select', title: options.title, labels });
    const step = this.steps.shift();
    if (!step) throw new Error(`unexpected picker "${options.title}" [${labels.join(' | ')}]`);
    if (step.kind === 'cancel') return undefined;
    if (step.kind === 'pick') {
      const found = items.find((i) => i.label === step.label);
      if (!found) throw new Error(`no item "${step.label}" in "${options.title}": ${labels.join(' | ')}`);
      return found;
    }
    if (step.kind === 'index') return items[step.index];
    throw new Error(`expected a picker, got "${step.kind}" for "${options.title}"`);
  }

  async input(prompt: string): Promise<string | undefined> {
    this.calls.push({ kind: 'input', title: prompt, labels: [] });
    const step = this.steps.shift();
    if (!step) throw new Error(`unexpected input "${prompt}"`);
    if (step.kind === 'inputCancel') return undefined;
    if (step.kind !== 'input') throw new Error(`expected an input, got "${step.kind}" for "${prompt}"`);
    return step.value;
  }

  info(message: string): void {
    this.infos.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }
}

interface Harness {
  ui: FakeUi;
  deps: ManageDeps;
  writes: Chain[][];
  chains: () => Chain[];
  counts: { imports: number; settings: number };
  tested: string[];
}

const MODELS: LmModel[] = [
  { vendor: 'gcmp.deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
  { vendor: 'gcmp.qwen', id: 'qwen-max' },
];

function interpolate(message: string, args?: L10nArgs): string {
  if (!args) return message;
  return message.replace(/\{(\w+)\}/g, (m, k: string) => (k in args ? String(args[k]) : m));
}

function chain(id: string, targets: string[]): Chain {
  return {
    id,
    name: id.toUpperCase(),
    targets: targets.map((spec) => {
      const [vendor, modelId] = spec.split('/');
      return { kind: 'proxy' as const, vendor, modelId };
    }),
  };
}

function harness(steps: Step[], seed: Chain[], opts: { failWrite?: boolean; t?: ManageDeps['t'] } = {}): Harness {
  const ui = new FakeUi(steps);
  let chains: Chain[] = seed;
  const writes: Chain[][] = [];
  const counts = { imports: 0, settings: 0 };
  const tested: string[] = [];
  const deps: ManageDeps = {
    ui,
    getChains: () => chains,
    writeChains: async (next) => {
      if (opts.failWrite) throw new Error('boom');
      writes.push(next);
      chains = next; // emulate persistence so later steps see the new data
    },
    gcmpModels: async () => MODELS,
    importGcmpConfig: async () => {
      counts.imports++;
      chains = [chain('imported', ['gcmp.deepseek/deepseek-chat'])];
    },
    openSettings: async () => {
      counts.settings++;
    },
    testTarget: async (target) => {
      tested.push(targetLabel(target));
    },
    t: opts.t ?? interpolate,
  };
  return { ui, deps, writes, chains: () => chains, counts, tested };
}

describe('runManageMenu', () => {
  it('returns to the action menu after an action so edits can be chained', async () => {
    const h = harness(
      [
        { kind: 'pick', label: 'ALPHA (2 targets)' },
        { kind: 'pick', label: 'Move down' },
        { kind: 'index', index: 0 },
        { kind: 'pick', label: 'Remove target' },
        { kind: 'index', index: 1 },
        { kind: 'pick', label: 'Back to chain list' },
        { kind: 'cancel' },
      ],
      [chain('alpha', ['gcmp.a/one', 'gcmp.b/two'])]
    );

    await runManageMenu(h.deps);

    expect(h.ui.titles()).toEqual([
      'Fallback Router: select chain',
      'Chain: ALPHA',
      'Select target to move',
      'Chain: ALPHA',
      'Select target to remove',
      'Chain: ALPHA',
      'Fallback Router: select chain',
    ]);
    expect(h.writes).toHaveLength(2);
    expect(h.chains()[0].targets.map(targetLabel)).toEqual(['proxy gcmp.b/two']);
    expect(h.ui.remaining()).toBe(0);
  });

  it('moves a target up in place', async () => {
    const h = harness(
      [
        { kind: 'pick', label: 'ALPHA (3 targets)' },
        { kind: 'pick', label: 'Move up' },
        { kind: 'index', index: 1 },
        { kind: 'cancel' },
        { kind: 'cancel' },
      ],
      [chain('alpha', ['gcmp.a/one', 'gcmp.b/two', 'gcmp.c/three'])]
    );

    await runManageMenu(h.deps);

    expect(h.chains()[0].targets.map(targetLabel)).toEqual([
      'proxy gcmp.b/two',
      'proxy gcmp.a/one',
      'proxy gcmp.c/three',
    ]);
  });

  it('reports a move past the last target instead of writing unchanged data', async () => {
    const h = harness(
      [
        { kind: 'pick', label: 'ALPHA (2 targets)' },
        { kind: 'pick', label: 'Move down' },
        { kind: 'index', index: 1 },
        { kind: 'cancel' },
        { kind: 'cancel' },
      ],
      [chain('alpha', ['gcmp.a/one', 'gcmp.b/two'])]
    );

    await runManageMenu(h.deps);

    expect(h.writes).toHaveLength(0);
    expect(h.ui.infos).toEqual(['Already the last target.']);
  });

  it('reports an edge move instead of writing unchanged data', async () => {
    const h = harness(
      [
        { kind: 'pick', label: 'ALPHA (2 targets)' },
        { kind: 'pick', label: 'Move up' },
        { kind: 'index', index: 0 },
        { kind: 'cancel' },
        { kind: 'cancel' },
      ],
      [chain('alpha', ['gcmp.a/one', 'gcmp.b/two'])]
    );

    await runManageMenu(h.deps);

    expect(h.writes).toHaveLength(0);
    expect(h.ui.infos).toEqual(['Already the first target.']);
  });

  it('adds a target picked from the live GCMP model list', async () => {
    const h = harness(
      [
        { kind: 'pick', label: 'ALPHA (1 target, no fallback)' },
        { kind: 'pick', label: 'Add target' },
        { kind: 'pick', label: 'DeepSeek Chat' },
        { kind: 'pick', label: 'Back to chain list' },
        { kind: 'cancel' },
      ],
      [chain('alpha', ['gcmp.a/one'])]
    );

    await runManageMenu(h.deps);

    expect(h.ui.labelsOf('Add target to chain: ALPHA')).toEqual([
      'DeepSeek Chat',
      'qwen-max',
      'Manual input (enter vendor & modelId)',
    ]);
    expect(h.chains()[0].targets.map(targetLabel)).toEqual(['proxy gcmp.a/one', 'proxy gcmp.deepseek/deepseek-chat']);
  });

  it('marks models already in the chain in the picker detail', async () => {
    const h = harness(
      [
        { kind: 'pick', label: 'ALPHA (2 targets)' },
        { kind: 'pick', label: 'Add target' },
        { kind: 'pick', label: 'qwen-max' },
        { kind: 'cancel' },
        { kind: 'cancel' },
      ],
      [chain('alpha', ['gcmp.a/one', 'gcmp.qwen/qwen-max'])]
    );

    await runManageMenu(h.deps);

    expect(h.chains()[0].targets).toHaveLength(3);
    expect(h.chains()[0].targets[2]).toEqual({ kind: 'proxy', vendor: 'gcmp.qwen', modelId: 'qwen-max' });
  });

  it('adds a target from manual input, trimmed', async () => {
    const h = harness(
      [
        { kind: 'pick', label: 'ALPHA (2 targets)' },
        { kind: 'pick', label: 'Add target' },
        { kind: 'pick', label: 'Manual input (enter vendor & modelId)' },
        { kind: 'input', value: '  gcmp.custom  ' },
        { kind: 'input', value: 'my-model' },
        { kind: 'cancel' },
        { kind: 'cancel' },
      ],
      [chain('alpha', ['gcmp.a/one', 'gcmp.b/two'])]
    );

    await runManageMenu(h.deps);

    expect(h.chains()[0].targets[2]).toEqual({ kind: 'proxy', vendor: 'gcmp.custom', modelId: 'my-model' });
  });

  it('writes nothing when manual input is cancelled', async () => {
    const h = harness(
      [
        { kind: 'pick', label: 'ALPHA (2 targets)' },
        { kind: 'pick', label: 'Add target' },
        { kind: 'pick', label: 'Manual input (enter vendor & modelId)' },
        { kind: 'inputCancel' },
        { kind: 'pick', label: 'Back to chain list' },
        { kind: 'cancel' },
      ],
      [chain('alpha', ['gcmp.a/one', 'gcmp.b/two'])]
    );

    await runManageMenu(h.deps);

    expect(h.writes).toHaveLength(0);
    expect(h.ui.titles()).toContain('Chain: ALPHA');
  });

  it('returns to the chain list when the action menu is dismissed', async () => {
    const h = harness(
      [
        { kind: 'pick', label: 'ALPHA (2 targets)' },
        { kind: 'cancel' },
        { kind: 'cancel' },
      ],
      [chain('alpha', ['gcmp.a/one', 'gcmp.b/two'])]
    );

    await runManageMenu(h.deps);

    expect(h.ui.titles()).toEqual(['Fallback Router: select chain', 'Chain: ALPHA', 'Fallback Router: select chain']);
  });

  it('reports a failing action and keeps the menu usable', async () => {
    const h = harness(
      [
        { kind: 'pick', label: 'ALPHA (2 targets)' },
        { kind: 'pick', label: 'Add target' },
        { kind: 'pick', label: 'qwen-max' },
        { kind: 'pick', label: 'Back to chain list' },
        { kind: 'cancel' },
      ],
      [chain('alpha', ['gcmp.a/one', 'gcmp.b/two'])],
      { failWrite: true }
    );

    await runManageMenu(h.deps);

    expect(h.ui.errors).toEqual(['Action failed: boom']);
    expect(h.ui.titles()).toEqual([
      'Fallback Router: select chain',
      'Chain: ALPHA',
      'Add target to chain: ALPHA',
      'Chain: ALPHA',
      'Fallback Router: select chain',
    ]);
  });

  it('tests the selected target through the injected probe', async () => {
    const h = harness(
      [
        { kind: 'pick', label: 'ALPHA (2 targets)' },
        { kind: 'pick', label: 'Test this target' },
        { kind: 'index', index: 1 },
        { kind: 'cancel' },
        { kind: 'cancel' },
      ],
      [chain('alpha', ['gcmp.a/one', 'gcmp.b/two'])]
    );

    await runManageMenu(h.deps);

    expect(h.tested).toEqual(['proxy gcmp.b/two']);
  });

  it('does not offer target actions on a chain without targets', async () => {
    const h = harness(
      [
        { kind: 'pick', label: 'EMPTY (no targets)' },
        { kind: 'pick', label: 'Remove target' },
        { kind: 'cancel' },
        { kind: 'cancel' },
      ],
      [chain('empty', [])]
    );

    await runManageMenu(h.deps);

    expect(h.writes).toHaveLength(0);
  });

  it('offers import/settings when nothing is configured and re-reads the chains', async () => {
    const h = harness(
      [
        { kind: 'pick', label: 'Import from GCMP' },
        { kind: 'pick', label: 'IMPORTED (1 target, no fallback)' },
        { kind: 'cancel' },
        { kind: 'cancel' },
      ],
      []
    );

    await runManageMenu(h.deps);

    expect(h.counts.imports).toBe(1);
    expect(h.ui.titles()).toEqual([
      'No chains configured. Import from GCMP or open settings?',
      'Fallback Router: select chain',
      'Chain: IMPORTED',
      'Fallback Router: select chain',
    ]);
  });

  it('ends the flow after opening settings.json when nothing is configured', async () => {
    const h = harness([{ kind: 'pick', label: 'Open settings.json' }], []);

    await runManageMenu(h.deps);

    expect(h.counts.settings).toBe(1);
    expect(h.ui.remaining()).toBe(0);
  });

  it('dispatches actions by tag, not by their localized label', async () => {
    // A `t` that decorates every message differently per call: string-comparing
    // the picked label against a freshly localized one would never match.
    let counter = 0;
    const h = harness(
      [
        { kind: 'index', index: 0 },
        { kind: 'index', index: 3 }, // "Move down"
        { kind: 'index', index: 0 },
        { kind: 'cancel' },
        { kind: 'cancel' },
      ],
      [chain('alpha', ['gcmp.a/one', 'gcmp.b/two'])],
      { t: (message, args) => `#${counter++} ${interpolate(message, args)}` }
    );

    await runManageMenu(h.deps);

    expect(h.chains()[0].targets.map(targetLabel)).toEqual(['proxy gcmp.b/two', 'proxy gcmp.a/one']);
  });

  it('labels chains with their target count', async () => {
    const h = harness([{ kind: 'cancel' }], [chain('zero', []), chain('one', ['gcmp.a/one']), chain('two', ['gcmp.a/one', 'gcmp.b/two'])]);

    await runManageMenu(h.deps);

    expect(h.ui.labelsOf('Fallback Router: select chain')).toEqual([
      'ZERO (no targets)',
      'ONE (1 target, no fallback)',
      'TWO (2 targets)',
    ]);
  });

  it('keeps consecutive writes from clobbering earlier edits', async () => {
    const h = harness(
      [
        { kind: 'pick', label: 'ALPHA (1 target, no fallback)' },
        { kind: 'pick', label: 'Add target' },
        { kind: 'pick', label: 'DeepSeek Chat' },
        { kind: 'pick', label: 'Add target' },
        { kind: 'pick', label: 'qwen-max' },
        { kind: 'cancel' },
        { kind: 'cancel' },
      ],
      [chain('alpha', ['gcmp.a/one'])]
    );

    await runManageMenu(h.deps);

    expect(h.writes).toHaveLength(2);
    expect(h.writes[1].map((c) => c.targets.map(targetLabel))).toEqual([
      ['proxy gcmp.a/one', 'proxy gcmp.deepseek/deepseek-chat', 'proxy gcmp.qwen/qwen-max'],
    ]);
  });
});
