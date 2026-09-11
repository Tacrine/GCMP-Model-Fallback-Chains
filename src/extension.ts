import * as vscode from 'vscode';
import { normalizeConfig, extractLegacySecretRefs, ConfigSink } from './config';
import type { RouterConfig, Chain, Target, ProxyTarget } from './types';
import { FallbackRouterProvider } from './provider';
import { OutputLogger, StatusBar } from './observability';
import { importGcmp, GcmpEntry } from './import/importer';

const VENDOR = 'fallbackrouter';
const SECRET_PREFIX = 'fallbackrouter.';

class Sink implements ConfigSink {
  constructor(private readonly logger: OutputLogger) {}
  warn(msg: string): void { this.logger.warn(`[config] ${msg}`); }
  error(msg: string): void { this.logger.error(`[config] ${msg}`); }
}

let logger: OutputLogger;
let statusBar: StatusBar;
let provider: FallbackRouterProvider;
let config: RouterConfig;
let secretRefs: string[] = [];
let activeContext: vscode.ExtensionContext;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // GCMP companion: the model vendors we delegate to are all registered by
  // vicanent.gcmp. Without it, the extension is inert — bail out with an
  // install prompt instead of registering an empty provider.
  const gcmp = vscode.extensions.getExtension('vicanent.gcmp');
  if (!gcmp) {
    const install = await vscode.window.showErrorMessage(
      'Fallback Router chains need the GCMP extension (vicanent.gcmp) to provide model vendors. Install GCMP and reload the window.',
      '去安装 GCMP'
    );
    if (install) {
      await vscode.commands.executeCommand('workbench.extensions.search', 'vicanent.gcmp');
    }
    return;
  }
  if (!gcmp.isActive) await gcmp.activate();

  activeContext = context;
  logger = new OutputLogger(() => loadAllSecrets());
  statusBar = new StatusBar();
  statusBar.show();
  context.subscriptions.push(logger, statusBar);

  config = loadConfig();

  const secretsProvider = () => async () => loadAllSecrets();
  provider = new FallbackRouterProvider({
    getConfig: () => config,
    getSecretsProvider: secretsProvider,
    secrets: context.secrets,
    context,
    logger,
    statusBar,
  });
    void provider.refresh();
  context.subscriptions.push(provider);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('fallbackRouter')) {
        config = loadConfig();
        logger.setLevel(config.logLevel);
          void provider.refresh();
      }
    })
  );

  registerCommands(context);
  void refreshSecrets();
}

async function refreshSecrets(): Promise<void> {
  await logger.refreshSecrets();
}

async function loadAllSecrets(): Promise<string[]> {
  // Secrets are tracked as we set them; SecretStorage has no enumeration API.
  return knownSecrets;
}

let knownSecrets: string[] = [];

function loadConfig(): RouterConfig {
  const raw = vscode.workspace.getConfiguration('fallbackRouter');
  const result = normalizeConfig(raw, new Sink(logger));
  captureLegacyHttpRefs(raw);
  if (result.droppedHttpTargets > 0) void showMigrationNotice(result.droppedHttpTargets);
  return result.config;
}

/** Legacy http targets carried API-key secretRefs that no longer resolve.
   * Capture them (overwrite on each load) so cleanup() can purge leftover
   * secrets even after normalization strips the targets from the config. */
function captureLegacyHttpRefs(raw: vscode.WorkspaceConfiguration): void {
  const refs = extractLegacySecretRefs(raw.get<unknown>('chains'));
  if (refs.length > 0) void activeContext.globalState.update('legacySecretRefs', refs);
}

/** One-time migration banner — shown until migrated.strippedAt is recorded. */
async function showMigrationNotice(dropped: number): Promise<void> {
  if (activeContext.globalState.get<number>('migrated.strippedAt') !== undefined) return;
  const choice = await vscode.window.showInformationMessage(
    `Fallback Router removed ${dropped} legacy http target(s): this GCMP companion routes through proxy targets and GCMP manages provider keys. Re-import chains from GCMP to continue.`,
    '重新导入'
  );
  if (choice === '重新导入') void importGcmpFlow();
  void activeContext.globalState.update('migrated.strippedAt', Date.now());
}

function registerCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('fallbackrouter.manage', () => manage()),
    vscode.commands.registerCommand('fallbackrouter.apply', () => applyChains()),
    vscode.commands.registerCommand('fallbackrouter.warmup', () => warmup()),
        vscode.commands.registerCommand('fallbackrouter.set-default-model', () => setDefaultModel()),
    vscode.commands.registerCommand('fallbackrouter.showDiagnostics', () => showDiagnostics()),
    vscode.commands.registerCommand('fallbackrouter.cleanup', () => cleanup(context))
  );
}

async function manage(): Promise<void> {
  const chains = config.chains;
  if (chains.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'No chains configured. Import from GCMP or open settings?',
      'Import from GCMP',
      'Open settings.json'
    );
    if (choice === 'Import from GCMP') return importGcmpFlow();
    if (choice === 'Open settings.json') return openSettings();
    return;
  }
  const picks = chains.map((c) => ({
    label: `${c.name} (${c.targets.length} targets${c.targets.length === 1 ? ', no fallback' : ''})`,
    chain: c,
  }));
  const picked = await vscode.window.showQuickPick(picks, { title: 'Fallback Router: select chain' });
  if (!picked) return;
  const actions = ['Add target', 'Remove target', 'Move up', 'Move down', 'Test this target', 'Import GCMP config', 'Open settings.json'];
  const action = await vscode.window.showQuickPick(actions, { title: `Chain: ${picked.chain.name}` });
  if (!action) return;
  switch (action) {
    case 'Add target': return addTarget(picked.chain);
    case 'Remove target': return removeTarget(picked.chain);
    case 'Move up': return moveTarget(picked.chain, -1);
    case 'Move down': return moveTarget(picked.chain, 1);
    case 'Test this target': return testTarget(picked.chain);
    case 'Import GCMP config': return importGcmpFlow();
    case 'Open settings.json': return openSettings();
  }
}

async function addTarget(chain: Chain): Promise<void> {
  const updated = { ...chain, targets: [...chain.targets] };
  const vendor = await vscode.window.showInputBox({ prompt: 'proxy vendor (e.g. gcmp.compatible)' });
  if (!vendor) return;
  const modelId = await vscode.window.showInputBox({ prompt: 'proxy modelId' });
  if (!modelId) return;
  updated.targets.push({ kind: 'proxy', vendor, modelId });
  await writeChains(config.chains.map((c) => (c.id === chain.id ? updated : c)));
}

async function removeTarget(chain: Chain): Promise<void> {
  const picks = chain.targets.map((t, i) => ({ label: targetLabel(t), index: i }));
  const picked = await vscode.window.showQuickPick(picks, { title: 'Select target to remove' });
  if (picked === undefined) return;
  const updated = { ...chain, targets: chain.targets.filter((_, i) => i !== picked.index) };
  await writeChains(config.chains.map((c) => (c.id === chain.id ? updated : c)));
}

async function moveTarget(chain: Chain, dir: number): Promise<void> {
  const picks = chain.targets.map((t, i) => ({ label: targetLabel(t), index: i }));
  const picked = await vscode.window.showQuickPick(picks, { title: 'Select target to move' });
  if (picked === undefined) return;
  const i = picked.index;
  const j = i + dir;
  if (j < 0 || j >= chain.targets.length) return;
  const arr = [...chain.targets];
  [arr[i], arr[j]] = [arr[j], arr[i]];
  await writeChains(config.chains.map((c) => (c.id === chain.id ? { ...chain, targets: arr } : c)));
}

async function testTarget(chain: Chain): Promise<void> {
  const picks = chain.targets.map((t, i) => ({ label: targetLabel(t), index: i }));
  const picked = await vscode.window.showQuickPick(picks, { title: 'Select target to test' });
  if (picked === undefined) return;
  const target = chain.targets[picked.index];
  if (target.kind !== 'proxy') return;
  const label = targetLabel(target);
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Testing target...' }, async () => {
    try {
      const models = await vscode.lm.selectChatModels({ vendor: target.vendor, id: target.modelId });
      const m = models.find((x) => x.vendor === target.vendor && x.id === target.modelId);
      if (!m) throw new Error('model not resolvable');
      // Disposable-shaped token (platform requires a dispose() on cleanup).
      const token: vscode.CancellationToken = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose() { /* no-op */ } }),
      };
      const t0 = Date.now();
            const response = await m.sendRequest(
              [{ role: vscode.LanguageModelChatMessageRole.User, name: 'user', content: [new vscode.LanguageModelTextPart('ping')] }],
              {},
              token
            );
      let firstByteMs: number | undefined;
      let text = '';
      for await (const fragment of response.text) {
        if (firstByteMs === undefined) firstByteMs = Date.now() - t0;
        text += fragment;
      }
      const msg = `${label}: ok (firstByte ${firstByteMs}ms, text ${JSON.stringify(text.slice(0, 60))})`;
      logger.info(`[test] ${msg}`);
      void vscode.window.showInformationMessage(msg);
    } catch (e) {
      const msg = `${label}: failed — ${e instanceof Error ? e.message : String(e)}`;
      logger.info(`[test] ${msg}`);
      void vscode.window.showErrorMessage(msg);
    }
  });
}

async function importGcmpFlow(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gcmp');
  const models = cfg.get<GcmpEntry[]>('compatibleModels', []);
  if (models.length === 0) {
    void vscode.window.showWarningMessage('No gcmp.compatibleModels found.');
    return;
  }
  const mode = config.importMode;
  const result = importGcmp(models, mode);
  for (const s of result.skipped) logger.warn(`[import] skipped ${s.entryId}: ${s.reason}`);
  if (result.chains.length === 0) {
    void vscode.window.showErrorMessage('Import produced no valid chains.');
    return;
  }
  const json = JSON.stringify(result.chains, null, 2);
  await vscode.env.clipboard.writeText(json);
  const doc = await vscode.workspace.openTextDocument({ language: 'json', content: `// ${mode} mode: ${result.chains.length} chains / ${result.chains.reduce((a, c) => a + c.targets.length, 0)} targets\n// Copy this into fallbackRouter.chains, then run "Apply imported chains".\n${json}` });
  await vscode.window.showTextDocument(doc);
  void vscode.window.showInformationMessage('Chains generated and copied to clipboard.');
}

async function applyChains(): Promise<void> {
  const clipboard = await vscode.env.clipboard.readText();
  let chains: Chain[];
  try {
    const parsed = JSON.parse(clipboard);
    if (!Array.isArray(parsed)) throw new Error('expected array');
    chains = parsed as Chain[];
  } catch {
    void vscode.window.showErrorMessage('Clipboard does not contain a valid chains array.');
    return;
  }
  // Write-before structural validation.
  const testSink = new Sink(logger);
  const normalized = normalizeConfig({ ...config, chains }, testSink);
  if (normalized.droppedChains > 0 || normalized.config.chains.length !== chains.length) {
    void vscode.window.showErrorMessage('Chains failed structural validation; see log.');
    return;
  }
  const confirm = await vscode.window.showInformationMessage(
    `Apply ${chains.length} chain(s) to fallbackRouter.chains?`,
    { modal: true },
    'Apply'
  );
  if (confirm !== 'Apply') return;
  const old = vscode.workspace.getConfiguration('fallbackRouter').get<Chain[]>('chains');
  await vscode.workspace.getConfiguration('fallbackRouter').update('chains', chains, vscode.ConfigurationTarget.Global);
  // Post-write loopback: wait for onDidChangeConfiguration to recompute, bounded.
  const ok = await waitForModels(chains, 10000);
  if (!ok) {
    // Rollback.
    if (old === undefined) {
      await vscode.workspace.getConfiguration('fallbackRouter').update('chains', undefined, vscode.ConfigurationTarget.Global);
    } else {
      await vscode.workspace.getConfiguration('fallbackRouter').update('chains', old, vscode.ConfigurationTarget.Global);
    }
    void vscode.window.showErrorMessage('Some chains failed to resolve; rolled back.');
    return;
  }
  void vscode.window.showInformationMessage('Chains applied successfully.');
}

async function waitForModels(chains: Chain[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const models = await vscode.lm.selectChatModels({ vendor: VENDOR });
    const ids = new Set(models.map((m) => m.id));
    if (chains.every((c) => ids.has(`fallbackrouter:${c.id}`))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function warmup(): Promise<void> {
  const proxyTargets: ProxyTarget[] = [];
  for (const c of config.chains) for (const t of c.targets) if (t.kind === 'proxy') proxyTargets.push(t);
  if (proxyTargets.length === 0) {
    void vscode.window.showInformationMessage('No proxy targets configured.');
    return;
  }
  for (const t of proxyTargets) {
    try {
      const models = await vscode.lm.selectChatModels({ vendor: t.vendor, id: t.modelId });
      // canSendRequest requires the model provider's LanguageModelAccessInformation
      // (via Extension.languageModelAccessInformation), which we cannot resolve to a
      // vendor-extension id generically; report found count and ids.
      const canSend = 'n/a';
      const msg = `[warmup] ${t.vendor}/${t.modelId}: found=${models.length} canSend=${canSend} ids=[${models.map((m) => m.id).join(', ')}]`;
      logger.info(msg);
      void vscode.window.showInformationMessage(msg);
    } catch (e) {
      logger.warn(`[warmup] ${t.vendor}/${t.modelId}: ${String(e)}`);
    }
  }
}

async function setDefaultModel(): Promise<void> {
  const models = provider.getChains();
  const picks = [...models.values()].map(({ chain, info }) => ({ label: info.name, chain }));
  const picked = await vscode.window.showQuickPick(picks, { title: 'Select composite model as default' });
  if (!picked) return;
  const chainId = `fallbackrouter:${picked.chain.id}`;
  const vendorId = `${VENDOR}/${chainId}`;
  const keys: Record<string, string> = {
    'chat.planAgent.defaultModel': `${picked.chain.name} (fallback)`,
    'chat.exploreAgent.defaultModel': `${picked.chain.name} (fallback)`,
    'chat.utilityModel': vendorId,
  };
  const shown = Object.entries(keys).map(([k, v]) => `${k} = ${v}`).join('\n');
  const confirm = await vscode.window.showInformationMessage(`Will write:\n${shown}`, { modal: true }, 'Write');
  if (confirm !== 'Write') return;
  // Loopback validate.
  const resolvable = await vscode.lm.selectChatModels({ vendor: VENDOR });
  if (!resolvable.some((m) => m.id === chainId)) {
    void vscode.window.showErrorMessage('Model not resolvable; refusing to write.');
    return;
  }
  for (const [k, v] of Object.entries(keys)) {
    await vscode.workspace.getConfiguration().update(k, v, vscode.ConfigurationTarget.Global);
  }
  void vscode.window.showInformationMessage('Default model set.');
}

async function showDiagnostics(): Promise<void> {
  const lines: string[] = ['Fallback Router diagnostics'];
  const selfCheck = await vscode.lm.selectChatModels({ vendor: VENDOR });
  lines.push(`selfCheck: ${selfCheck.map((m) => m.id).join(', ') || 'NONE'}`);
  for (const c of config.chains) {
    lines.push(`chain ${c.name} (${c.id}): ${c.targets.length} targets`);
    for (const t of c.targets) {
      lines.push(`  ${targetLabel(t)}`);
    }
  }
  logger.info(lines.join('\n'));
  const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'markdown' });
  await vscode.window.showTextDocument(doc);
}

async function cleanup(context: vscode.ExtensionContext): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    'Delete all stored API keys and breaker state for Fallback Router?',
    { modal: true },
    'Delete'
  );
  if (confirm !== 'Delete') return;
  // SecretStorage has no enumeration API; delete tracked refs (legacy http
  // target refs captured during config loads) + already-known secret values.
  const refs = new Set<string>(secretRefs);
  const legacy = activeContext.globalState.get<string[]>('legacySecretRefs', []);
  for (const ref of legacy) refs.add(ref);
  for (const ref of refs) {
    const key = SECRET_PREFIX + ref;
    try {
      const v = await context.secrets.get(key);
      if (v) knownSecrets.push(v);
    } catch { /* ignore */ }
    await Promise.resolve(context.secrets.delete(key)).catch(() => { /* ignore */ });
  }
  for (const k of context.globalState.keys()) {
    if (k.startsWith('fallbackrouter.')) await context.globalState.update(k, undefined);
  }
  void vscode.window.showInformationMessage('Fallback Router data cleaned.');
}

function openSettings(): Thenable<void> {
  return vscode.commands.executeCommand('workbench.action.openSettings', 'fallbackRouter');
}

function targetLabel(t: Target): string {
  return `proxy ${t.vendor}/${t.modelId}`;
}

async function writeChains(chains: Chain[]): Promise<void> {
  await vscode.workspace.getConfiguration('fallbackRouter').update('chains', chains, vscode.ConfigurationTarget.Global);
}

export function deactivate(): void { /* cleanup handled via disposables */ }
