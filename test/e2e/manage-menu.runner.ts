/**
 * Manage-menu integration runner (extension host).
 *
 * Boots the real extension and drives `fallbackrouter.manage` exactly like the
 * command palette does, but with the window surfaces scripted: `showQuickPick`
 * / `showInputBox` / `showErrorMessage` are replaced for the duration of the
 * run (so no widgets pop up), and every call is checked against an expected
 * script. The sequence a user performs is:
 *
 *   chain list ─▶ action menu ─▶ Move down ─▶ target picker
 *              ─▶ action menu ─▶ Add target ─▶ model picker ─▶ 2 inputs
 *              ─▶ action menu ─▶ Back to chain list ─▶ chain list ─▶ Esc
 *
 * Asserts that the action menu is shown again after every action (the bug was
 * that it closed, and that its entries did nothing), that the real config
 * writes landed, and that no error message was raised.
 *
 * Runs inside the host, so labels must come from the extension's own l10n
 * bundle for the active locale instead of hard-coded English strings.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const EXT_ID = 'tacrine.gcmp-model-fallback-chains';
const CHAIN_ID = 'e2e-manage';
const CHAIN_NAME = 'E2E';
const REPO_ROOT = path.resolve(__dirname, '..');
const EVIDENCE_FILE = path.join(REPO_ROOT, '.omo', 'evidence', 'manage-menu-e2e.txt');
const FLOW_TIMEOUT_MS = 20000;

type Bundle = Record<string, string>;
type Translate = (message: string, args?: Record<string, string | number>) => string;

interface PickItem {
  label: string;
}

interface PickOptions {
  title?: string;
}

interface InputOptions {
  prompt?: string;
}

interface ScriptStep {
  title: string;
  /** Label to accept; omitted means the user dismisses the picker. */
  pick?: string;
}

/**
 * The production adapter re-shows a picker that resolved with `undefined` in
 * under 250 ms (host teardown mis-close). A scripted dismissal is instant, so
 * dismissal steps wait past that threshold to pose as a human pressing Esc.
 */
const HUMAN_DISMISS_MS = 400;

/** The same bundle lookup the host performs for the extension under test. */
function loadMessages(): Bundle {
  const dir = path.join(REPO_ROOT, 'l10n');
  const lang = vscode.env.language;
  for (const name of [`bundle.l10n.${lang}.json`, `bundle.l10n.${lang.split('-')[0]}.json`]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as Bundle;
  }
  return {};
}

function makeTranslate(bundle: Bundle): Translate {
  return (message, args) => {
    const template = bundle[message] ?? message;
    if (!args) return template;
    return template.replace(/\{(\w+)\}/g, (m, k) => (k in args ? String(args[k]) : m));
  };
}

export async function run(): Promise<void> {
  const t = makeTranslate(loadMessages());
  const ext = vscode.extensions.getExtension(EXT_ID);
  if (!ext) throw new Error(`extension ${EXT_ID} not found`);
  await ext.activate();

  const cfg = vscode.workspace.getConfiguration('fallbackRouter');
  const original = cfg.get<unknown>('chains');
  const win = vscode.window as unknown as Record<string, unknown>;
  const realPick = win.showQuickPick;
  const realInput = win.showInputBox;
  const realError = win.showErrorMessage;

  const titles: string[] = [];
  const problems: string[] = [];
  const errors: string[] = [];
  const prompts: string[] = [];
  const picked: string[] = [];
  const answers: (string | undefined)[] = ['gcmp.custom', 'e2e-model'];
  let chainsAfterFlow = '';

  const chainTitle = t('Chain: {name}', { name: CHAIN_NAME });
  const script: ScriptStep[] = [
    { title: t('Fallback Router: select chain'), pick: t('{name} ({count} targets)', { name: CHAIN_NAME, count: 2 }) },
    { title: chainTitle, pick: t('Move down') },
    { title: t('Select target to move'), pick: 'proxy gcmp.a/one' },
    { title: chainTitle, pick: t('Add target') },
    { title: t('Add target to chain: {name}', { name: CHAIN_NAME }), pick: t('Manual input (enter vendor & modelId)') },
    { title: chainTitle, pick: t('Back to chain list') },
    { title: t('Fallback Router: select chain') },
  ];

  let step = 0;
  try {
    await cfg.update(
      'chains',
      [
        {
          id: CHAIN_ID,
          name: CHAIN_NAME,
          targets: [
            { kind: 'proxy', vendor: 'gcmp.a', modelId: 'one' },
            { kind: 'proxy', vendor: 'gcmp.b', modelId: 'two' },
          ],
        },
      ],
      vscode.ConfigurationTarget.Global
    );

    const scriptedPick = async (items: PickItem[], options?: PickOptions) => {
      titles.push(options?.title ?? '');
      const expected = script[step++];
      if (!expected) return undefined;
      if ((options?.title ?? '') !== expected.title) {
        problems.push(`picker ${step}: expected "${expected.title}", got "${options?.title ?? ''}"`);
        return undefined;
      }
      if (expected.pick === undefined) {
        await new Promise<void>((resolve) => setTimeout(resolve, HUMAN_DISMISS_MS));
        return undefined;
      }
      const found = items.find((i) => i.label === expected.pick);
      if (!found) {
        problems.push(
          `picker ${step} ("${expected.title}"): no item "${expected.pick}" — offered [${items.map((i) => i.label).join(' | ')}]`
        );
        return undefined;
      }
      picked.push(found.label);
      return found;
    };
    const scriptedInput = async (options?: InputOptions) => {
      prompts.push(options?.prompt ?? '');
      return answers.shift();
    };
    const scriptedError = async (message: string) => {
      errors.push(message);
      return undefined;
    };

    win.showQuickPick = scriptedPick;
    win.showInputBox = scriptedInput;
    win.showErrorMessage = scriptedError;
    const patched = win.showQuickPick === scriptedPick && win.showInputBox === scriptedInput;
    if (!patched) problems.push('vscode.window is not patchable in this host; the scripted UI could not be installed');

    // Fire and forget: the command only resolves once the menu flow ends.
    if (patched) {
      const flow = vscode.commands.executeCommand('fallbackrouter.manage').then(
        () => undefined,
        (e: unknown) => {
          problems.push(`manage command rejected: ${e instanceof Error ? e.message : String(e)}`);
        }
      );
      const timedOut = await Promise.race([
        flow.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), FLOW_TIMEOUT_MS)),
      ]);
      if (timedOut) problems.push(`manage flow did not finish; pickers seen: [${titles.join(' | ')}]`);
    }

    for (let i = 0; i < titles.length; i += 1) {
      if (titles[i] !== script[i]?.title) {
        problems.push(`picker ${i + 1}: expected "${script[i]?.title ?? '<none>'}", got "${titles[i]}"`);
      }
    }
    if (titles.length !== script.length) {
      problems.push(`expected ${script.length} pickers (one after every action), got ${titles.length}`);
    }
    for (const message of errors) problems.push(`unexpected error message: ${message}`);

    interface ChainView {
      id: string;
      targets: { vendor: string; modelId: string }[];
    }
    // The host propagates a configuration write to the extension host
    // asynchronously, so poll briefly instead of asserting on a single read.
    let chains: ChainView[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      chains = vscode.workspace.getConfiguration('fallbackRouter').get<ChainView[]>('chains') ?? [];
      if (chains.some((c) => c.id === CHAIN_ID)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    chainsAfterFlow = JSON.stringify(chains);
    const order = (chains.find((c) => c.id === CHAIN_ID)?.targets ?? []).map((x) => `${x.vendor}/${x.modelId}`);
    if (order.join(',') !== 'gcmp.b/two,gcmp.a/one,gcmp.custom/e2e-model') {
      problems.push(`unexpected chain targets: [${order.join(', ')}] (raw: ${chainsAfterFlow})`);
    }
    if (prompts.length !== 2) problems.push(`expected 2 input prompts, got ${prompts.length}: [${prompts.join(' | ')}]`);
  } finally {
    win.showQuickPick = realPick;
    win.showInputBox = realInput;
    win.showErrorMessage = realError;
    await cfg.update('chains', original, vscode.ConfigurationTarget.Global);
  }

  const lines = [
    `extension: ${EXT_ID}`,
    `language: ${vscode.env.language}`,
    `pickers: ${titles.join(' | ')}`,
    `prompts: ${prompts.join(' | ')}`,
    `picked: ${picked.join(' | ')}`,
    `chains after flow: ${chainsAfterFlow}`,
    `verdict: ${problems.length === 0 ? 'PASS' : 'FAIL'}`,
    ...problems.map((p) => `- ${p}`),
  ];
  fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, lines.join('\n') + '\n', 'utf8');

  if (problems.length > 0) throw new Error(`manage menu e2e failed:\n- ${problems.join('\n- ')}`);
  console.log('manage menu e2e PASS: the action menu re-opened after every action and the edits landed in fallbackRouter.chains');
}
