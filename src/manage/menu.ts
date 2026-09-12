/**
 * Step-by-step "Manage" menu for fallback chains.
 *
 * Every host interaction (pickers, text input, messages, config persistence,
 * model discovery) is injected, so this navigation state machine can be unit
 * tested without an extension host.
 *
 * Levels:
 *   L1 chain list ──select──▶ L2 action menu ──action──▶ L3 item pickers
 *        ▲                        │      ▲                       │
 *        └──────── Back ──────────┘      └── after every action ──┘
 *
 * L2 is a loop: once an action finishes, the action menu is shown again with
 * freshly read data, so several edits can be chained without re-opening the
 * command palette. Dismissing L2 (Esc) goes back to L1 instead of dropping the
 * whole flow.
 */
import type { QuickPickItem } from 'vscode';
import type { Chain, ProxyTarget } from '../types';

export interface SelectOptions {
  title: string;
  placeHolder?: string;
  matchOnDescription?: boolean;
}

/** Host surfaces the menu needs. */
export interface MenuUi {
  /** Show a picker. `undefined` means the user dismissed it. */
  select<T extends QuickPickItem>(items: readonly T[], options: SelectOptions): Promise<T | undefined>;
  input(prompt: string): Promise<string | undefined>;
  info(message: string): void;
  error(message: string): void;
}

/** A model resolvable through `vscode.lm.selectChatModels`. */
export interface LmModel {
  vendor: string;
  id: string;
  name?: string;
}

export type L10nArgs = Record<string, string | number | boolean>;

export interface ManageDeps {
  ui: MenuUi;
  /** Chains exactly as persisted right now. */
  getChains(): Chain[];
  writeChains(chains: Chain[]): Promise<void>;
  /** Models currently offered by the GCMP extension. */
  gcmpModels(): Promise<LmModel[]>;
  importGcmpConfig(): Promise<void>;
  openSettings(): Promise<void>;
  testTarget(target: ProxyTarget): Promise<void>;
  t(message: string, args?: L10nArgs): string;
}

type ActionId = 'add' | 'remove' | 'up' | 'down' | 'test' | 'import' | 'settings' | 'back';

/** Actions are dispatched by tag, never by their (localized) label. */
type ActionItem = QuickPickItem & { action: ActionId };
type ChainItem = QuickPickItem & { chainId: string };
type TargetItem = QuickPickItem & { index: number };
type ModelItem = QuickPickItem & { model?: LmModel };
type StartItem = QuickPickItem & { action: 'import' | 'settings' };

export async function runManageMenu(deps: ManageDeps): Promise<void> {
  for (;;) {
    const chains = deps.getChains();
    if (chains.length === 0) {
      if ((await startMenu(deps)) === 'exit') return;
      continue; // re-read: importing from GCMP populates the chain list
    }
    const chain = await selectChain(deps, chains);
    if (!chain) return;
    await chainMenu(deps, chain.id);
  }
}

/** L1 (empty state): nothing configured yet — offer the two ways to start. */
async function startMenu(deps: ManageDeps): Promise<'imported' | 'exit'> {
  const picked = await deps.ui.select<StartItem>(
    [
      { label: deps.t('Import from GCMP'), action: 'import' },
      { label: deps.t('Open settings.json'), action: 'settings' },
    ],
    { title: deps.t('No chains configured. Import from GCMP or open settings?') }
  );
  if (!picked) return 'exit';
  if (picked.action === 'settings') {
    await guard(deps, () => deps.openSettings());
    return 'exit'; // the user is now editing settings.json by hand
  }
  await guard(deps, () => deps.importGcmpConfig());
  return 'imported';
}

/** L1: pick a chain. */
async function selectChain(deps: ManageDeps, chains: Chain[]): Promise<Chain | undefined> {
  const items: ChainItem[] = chains.map((c) => ({ label: chainLabel(deps, c), description: c.id, chainId: c.id }));
  const picked = await deps.ui.select(items, { title: deps.t('Fallback Router: select chain') });
  if (!picked) return undefined;
  return chains.find((c) => c.id === picked.chainId);
}

/** L2: action menu for one chain, re-shown after every action. */
async function chainMenu(deps: ManageDeps, chainId: string): Promise<void> {
  for (;;) {
    const chain = findChain(deps, chainId);
    if (!chain) return; // chain vanished (re-import / hand edit) -> back to L1
    const picked = await deps.ui.select(actionItems(deps), { title: deps.t('Chain: {name}', { name: chain.name }) });
    if (!picked || picked.action === 'back') return; // Esc == Back: return to L1
    await guard(deps, () => dispatch(deps, chainId, picked.action));
  }
}

async function dispatch(deps: ManageDeps, chainId: string, action: ActionId): Promise<void> {
  switch (action) {
    case 'add':
      return addTarget(deps, chainId);
    case 'remove':
      return removeTarget(deps, chainId);
    case 'up':
      return moveTarget(deps, chainId, -1);
    case 'down':
      return moveTarget(deps, chainId, 1);
    case 'test':
      return testTarget(deps, chainId);
    case 'import':
      return deps.importGcmpConfig();
    case 'settings':
      return deps.openSettings();
    case 'back':
      return; // handled by chainMenu
  }
}

/** L3: pick a GCMP model, or type a vendor/modelId pair by hand. */
async function addTarget(deps: ManageDeps, chainId: string): Promise<void> {
  const chain = findChain(deps, chainId);
  if (!chain) return;
  const models = await deps.gcmpModels();
  const inChain = new Set(chain.targets.map((target) => `${target.vendor}/${target.modelId}`));
  const items: ModelItem[] = [
    ...models.map((m) => ({
      label: m.name && m.name !== m.id ? m.name : m.id,
      description: m.vendor,
      detail: inChain.has(`${m.vendor}/${m.id}`)
        ? `${m.vendor}/${m.id} — ${deps.t('already in chain')}`
        : `${m.vendor}/${m.id}`,
      model: m,
    })),
    { label: deps.t('Manual input (enter vendor & modelId)'), description: deps.t('type vendor & modelId yourself') },
  ];
  const picked = await deps.ui.select(items, {
    title: deps.t('Add target to chain: {name}', { name: chain.name }),
    placeHolder: deps.t('Select a GCMP model, or use manual input'),
    matchOnDescription: true,
  });
  if (!picked) return;

  let vendor: string | undefined;
  let modelId: string | undefined;
  if (picked.model) {
    vendor = picked.model.vendor;
    modelId = picked.model.id;
  } else {
    vendor = (await deps.ui.input(deps.t('proxy vendor (e.g. gcmp.compatible)')))?.trim();
    if (!vendor) return;
    modelId = (await deps.ui.input(deps.t('proxy modelId')))?.trim();
  }
  if (!vendor || !modelId) return;
  const target: ProxyTarget = { kind: 'proxy', vendor, modelId };
  await updateChain(deps, chainId, (c) => ({ ...c, targets: [...c.targets, target] }));
}

async function removeTarget(deps: ManageDeps, chainId: string): Promise<void> {
  const index = await pickTargetIndex(deps, chainId, deps.t('Select target to remove'));
  if (index === undefined) return;
  await updateChain(deps, chainId, (c) => ({ ...c, targets: c.targets.filter((_, i) => i !== index) }));
}

async function moveTarget(deps: ManageDeps, chainId: string, dir: -1 | 1): Promise<void> {
  const index = await pickTargetIndex(deps, chainId, deps.t('Select target to move'));
  if (index === undefined) return;
  const chain = findChain(deps, chainId);
  if (!chain) return;
  const to = index + dir;
  if (to < 0 || to >= chain.targets.length) {
    deps.ui.info(deps.t(dir < 0 ? 'Already the first target.' : 'Already the last target.'));
    return;
  }
  await updateChain(deps, chainId, (c) => {
    const targets = [...c.targets];
    [targets[index], targets[to]] = [targets[to], targets[index]];
    return { ...c, targets };
  });
}

async function testTarget(deps: ManageDeps, chainId: string): Promise<void> {
  const index = await pickTargetIndex(deps, chainId, deps.t('Select target to test'));
  if (index === undefined) return;
  const chain = findChain(deps, chainId);
  const target = chain?.targets[index];
  if (target) await deps.testTarget(target);
}

async function pickTargetIndex(deps: ManageDeps, chainId: string, title: string): Promise<number | undefined> {
  const chain = findChain(deps, chainId);
  if (!chain || chain.targets.length === 0) return undefined;
  const items: TargetItem[] = chain.targets.map((target, index) => ({ label: targetLabel(target), index }));
  const picked = await deps.ui.select(items, { title });
  return picked?.index;
}

/**
 * Mutate the freshly re-read chain and persist the whole list. Re-reading (and
 * merging into the current array) keeps consecutive edits from clobbering each
 * other: the caller's cached config can lag one configuration-change round trip.
 */
async function updateChain(deps: ManageDeps, chainId: string, mutate: (chain: Chain) => Chain): Promise<void> {
  const chains = deps.getChains();
  const index = chains.findIndex((c) => c.id === chainId);
  if (index < 0) return;
  const next = [...chains];
  next[index] = mutate(chains[index]);
  await deps.writeChains(next);
}

function findChain(deps: ManageDeps, chainId: string): Chain | undefined {
  return deps.getChains().find((c) => c.id === chainId);
}

/** Actions that throw are reported instead of silently ending the flow. */
async function guard(deps: ManageDeps, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (e) {
    deps.ui.error(deps.t('Action failed: {message}', { message: e instanceof Error ? e.message : String(e) }));
  }
}

function actionItems(deps: ManageDeps): ActionItem[] {
  const t = deps.t;
  return [
    { label: t('Add target'), action: 'add' },
    { label: t('Remove target'), action: 'remove' },
    { label: t('Move up'), action: 'up' },
    { label: t('Move down'), action: 'down' },
    { label: t('Test this target'), action: 'test' },
    { label: t('Import GCMP config'), action: 'import' },
    { label: t('Open settings.json'), action: 'settings' },
    { label: t('Back to chain list'), action: 'back' },
  ];
}

function chainLabel(deps: ManageDeps, chain: Chain): string {
  const count = chain.targets.length;
  if (count === 0) return deps.t('{name} (no targets)', { name: chain.name });
  if (count === 1) return deps.t('{name} ({count} target, no fallback)', { name: chain.name, count });
  return deps.t('{name} ({count} targets)', { name: chain.name, count });
}

export function targetLabel(target: ProxyTarget): string {
  return `proxy ${target.vendor}/${target.modelId}`;
}
