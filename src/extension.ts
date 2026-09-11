import * as vscode from 'vscode';
import { normalizeConfig, ConfigSink } from './config';
import type { RouterConfig, Chain, Target, ProxyTarget } from './types';
import { FallbackRouterProvider } from './provider';
import { OutputLogger, StatusBar } from './observability';
import { importGcmp, GcmpEntry } from './import/importer';
import { HttpTransport } from './transport/httpTransport';
import { redact } from './util/redact';

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
  provider.refresh();
  context.subscriptions.push(provider);

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('fallbackRouter')) {
        config = loadConfig();
        logger.setLevel(config.logLevel);
        provider.refresh();
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
  return result.config;
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
  const kind = await vscode.window.showQuickPick(['http', 'proxy'], { title: 'Target kind' });
  if (!kind) return;
  const updated = { ...chain, targets: [...chain.targets] };
  if (kind === 'http') {
    const baseUrl = await vscode.window.showInputBox({ prompt: 'baseUrl', value: 'https://host/v1' });
    if (!baseUrl) return;
    const model = await vscode.window.showInputBox({ prompt: 'model' });
    if (!model) return;
    const secretRef = await vscode.window.showInputBox({ prompt: 'secretRef (key name)', value: `gcmp.${model}` });
    if (!secretRef) return;
    const apiType = await vscode.window.showQuickPick(['chat-completions', 'responses'], { title: 'apiType' });
    updated.targets.push({ kind: 'http', baseUrl, model, secretRef, apiType: (apiType ?? 'chat-completions') as 'chat-completions' | 'responses' });
  } else {
    const vendor = await vscode.window.showInputBox({ prompt: 'proxy vendor (e.g. gcmp.compatible)' });
    if (!vendor) return;
    const modelId = await vscode.window.showInputBox({ prompt: 'proxy modelId' });
    if (!modelId) return;
    updated.targets.push({ kind: 'proxy', vendor, modelId });
  }
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
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Testing target...' }, async () => {
    if (target.kind === 'http') {
      const t = new HttpTransport({ logger, getSecret: async (r) => activeContext.secrets.get(SECRET_PREFIX + r), secretsToRedact: () => Promise.resolve(secretRefs) });
      const r = await t.probe(target);
      const msg = `${targetLabel(target)}: ${r.ok ? 'ok' : 'failed'} — ${r.message} (firstByte ${r.firstByteMs}ms, toolCalling=${r.toolCalling})`;
      logger.info(`[test] ${msg}`);
      void vscode.window.showInformationMessage(msg);
    } else {
      void vscode.window.showInformationMessage(`Proxy target ${target.vendor}/${target.modelId}: run warmup to test`);
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

async function setApiKey(): Promise<void> {
  const httpTargets: { chain: Chain; target: Target }[] = [];
  for (const c of config.chains) for (const t of c.targets) if (t.kind === 'http') httpTargets.push({ chain: c, target: t });
  if (httpTargets.length === 0) {
    void vscode.window.showInformationMessage('No http targets configured.');
    return;
  }
  const picks = httpTargets.map((x) => ({ label: targetLabel(x.target), ref: x.target.kind === 'http' ? x.target.secretRef : '' }));
  const picked = await vscode.window.showQuickPick(picks, { title: 'Select target to set API key' });
  if (!picked) return;
  const key = await vscode.window.showInputBox({ prompt: 'API key (stored in SecretStorage)', password: true });
  if (key === undefined || key === '') return;
  await activeContext.secrets.store(SECRET_PREFIX + picked.ref, key);
  if (!secretRefs.includes(picked.ref)) secretRefs.push(picked.ref);
  if (key.length >= 4 && !knownSecrets.includes(key)) knownSecrets.push(key);
  void vscode.window.showInformationMessage(`API key stored for ${picked.ref}`);
  await refreshSecrets();
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
  // SecretStorage has no enumeration API; delete keys for configured http targets + tracked refs.
  const refs = new Set<string>(secretRefs);
  for (const c of config.chains) for (const t of c.targets) if (t.kind === 'http') refs.add(t.secretRef);
  for (const ref of refs) await Promise.resolve(context.secrets.delete(SECRET_PREFIX + ref)).catch(() => {});
  for (const k of context.globalState.keys()) {
    if (k.startsWith('fallbackrouter.')) await context.globalState.update(k, undefined);
  }
  void vscode.window.showInformationMessage('Fallback Router data cleaned.');
}

function openSettings(): Thenable<void> {
  return vscode.commands.executeCommand('workbench.action.openSettings', 'fallbackRouter');
}

function targetLabel(t: Target): string {
  return t.kind === 'http' ? `${t.model} @ ${t.baseUrl}` : `proxy ${t.vendor}/${t.modelId}`;
}

async function writeChains(chains: Chain[]): Promise<void> {
  await vscode.workspace.getConfiguration('fallbackRouter').update('chains', chains, vscode.ConfigurationTarget.Global);
}

export function deactivate(): void { /* cleanup handled via disposables */ }
