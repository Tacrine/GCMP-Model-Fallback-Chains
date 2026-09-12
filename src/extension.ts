import * as vscode from 'vscode';
import { normalizeConfig, extractLegacySecretRefs, shouldShowMigrationNotice, ConfigSink } from './config';
import type { RouterConfig, Chain, Target, ProxyTarget } from './types';
import { FallbackRouterProvider } from './provider';
import { OutputLogger, StatusBar } from './observability';
import { importFromLm, type LmModelLike } from './import/importer';

const VENDOR = 'fallbackrouter';

class Sink implements ConfigSink {
  constructor(private readonly logger: OutputLogger) {}
  warn(msg: string): void { this.logger.warn(`[config] ${msg}`); }
  error(msg: string): void { this.logger.error(`[config] ${msg}`); }
}

let logger: OutputLogger;
let statusBar: StatusBar;
let provider: FallbackRouterProvider;
let config: RouterConfig;
let activeContext: vscode.ExtensionContext;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // GCMP companion: the model vendors we delegate to are all registered by
  // vicanent.gcmp. Without it, the extension is inert — bail out with an
  // install prompt instead of registering an empty provider.
  const gcmp = vscode.extensions.getExtension('vicanent.gcmp');
  if (!gcmp) {
    const install = await vscode.window.showErrorMessage(
      vscode.l10n.t('Fallback Router chains need the GCMP extension (vicanent.gcmp) to provide model vendors. Install GCMP and reload the window.'),
      vscode.l10n.t('去安装 GCMP')
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
  if (!shouldShowMigrationNotice(activeContext.globalState.get<number>('migrated.strippedAt'))) return;
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
      vscode.l10n.t('No chains configured. Import from GCMP or open settings?'),
      vscode.l10n.t('Import from GCMP'),
      vscode.l10n.t('Open settings.json')
    );
    if (choice === vscode.l10n.t('Import from GCMP')) return importGcmpFlow();
    if (choice === vscode.l10n.t('Open settings.json')) return openSettings();
    return;
  }
  const picks = chains.map((c) => ({
    label: `${c.name} (${c.targets.length} targets${c.targets.length === 1 ? ', no fallback' : ''})`,
    chain: c,
  }));
  const picked = await vscode.window.showQuickPick(picks, { title: vscode.l10n.t('Fallback Router: select chain') });
  if (!picked) return;
  const actions = [
    vscode.l10n.t('Add target'),
    vscode.l10n.t('Remove target'),
    vscode.l10n.t('Move up'),
    vscode.l10n.t('Move down'),
    vscode.l10n.t('Test this target'),
    vscode.l10n.t('Import GCMP config'),
    vscode.l10n.t('Open settings.json'),
  ];
  const action = await vscode.window.showQuickPick(actions, { title: `Chain: ${picked.chain.name}` });
  if (!action) return;
  switch (action) {
    case vscode.l10n.t('Add target'): return addTarget(picked.chain);
    case vscode.l10n.t('Remove target'): return removeTarget(picked.chain);
    case vscode.l10n.t('Move up'): return moveTarget(picked.chain, -1);
    case vscode.l10n.t('Move down'): return moveTarget(picked.chain, 1);
    case vscode.l10n.t('Test this target'): return testTarget(picked.chain);
    case vscode.l10n.t('Import GCMP config'): return importGcmpFlow();
    case vscode.l10n.t('Open settings.json'): return openSettings();
  }
}

async function addTarget(chain: Chain): Promise<void> {
  const updated = { ...chain, targets: [...chain.targets] };
  // Offer a picker over the live GCMP models first, with manual input kept as
  // a fallback entry so both flows coexist. Selecting a model pre-fills its
  // actual vendor id (e.g. gcmp.deepseek) and model id — no typing required.
  const declared = declaredGcmpVendors();
  const all = await vscode.lm.selectChatModels({});
  const live = all.filter((m) => m.vendor.startsWith('gcmp.') && declared.has(m.vendor));
  const inChain = new Set(chain.targets.map((t) => `${t.vendor}/${t.modelId}`));
  const MANUAL = vscode.l10n.t('Manual input (enter vendor & modelId)');
  const picks: vscode.QuickPickItem[] = [
    ...live.map((m) => ({
      label: m.name && m.name !== m.id ? `${m.name}` : m.id,
      description: m.vendor,
      detail: inChain.has(`${m.vendor}/${m.id}`) ? `${m.vendor}/${m.id} — ${vscode.l10n.t('already in chain')}` : `${m.vendor}/${m.id}`,
      model: m,
    })),
    { label: MANUAL, description: vscode.l10n.t('type vendor & modelId yourself') },
  ];
  const picked = await vscode.window.showQuickPick(picks, {
    title: vscode.l10n.t('Add target to chain: {name}', { name: chain.name }),
    placeHolder: vscode.l10n.t('Select a GCMP model, or use manual input'),
    matchOnDescription: true,
  });
  if (!picked) return;
  let vendor: string | undefined;
  let modelId: string | undefined;
  const model = (picked as { model?: LmModelLike }).model;
  if (model) {
    vendor = model.vendor;
    modelId = model.id;
  } else {
    vendor = await vscode.window.showInputBox({ prompt: vscode.l10n.t('proxy vendor (e.g. gcmp.compatible)') });
    if (!vendor) return;
    modelId = await vscode.window.showInputBox({ prompt: vscode.l10n.t('proxy modelId') });
    if (!modelId) return;
  }
  updated.targets.push({ kind: 'proxy', vendor, modelId });
  await writeChains(config.chains.map((c) => (c.id === chain.id ? updated : c)));
}

async function removeTarget(chain: Chain): Promise<void> {
  const picks = chain.targets.map((t, i) => ({ label: targetLabel(t), index: i }));
  const picked = await vscode.window.showQuickPick(picks, { title: vscode.l10n.t('Select target to remove') });
  if (picked === undefined) return;
  const updated = { ...chain, targets: chain.targets.filter((_, i) => i !== picked.index) };
  await writeChains(config.chains.map((c) => (c.id === chain.id ? updated : c)));
}

async function moveTarget(chain: Chain, dir: number): Promise<void> {
  const picks = chain.targets.map((t, i) => ({ label: targetLabel(t), index: i }));
  const picked = await vscode.window.showQuickPick(picks, { title: vscode.l10n.t('Select target to move') });
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
  const picked = await vscode.window.showQuickPick(picks, { title: vscode.l10n.t('Select target to test') });
  if (picked === undefined) return;
  const target = chain.targets[picked.index];
  if (target.kind !== 'proxy') return;
  const label = targetLabel(target);
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Testing target...') }, async () => {
    try {
      const models = await vscode.lm.selectChatModels({ vendor: target.vendor, id: target.modelId });
      const m = models.find((x) => x.vendor === target.vendor && x.id === target.modelId);
      if (!m) throw new Error(vscode.l10n.t('model not resolvable'));
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

/** Live GCMP vendor list declared by the vicanent.gcmp package. Used to reject
 * 'gcmp.*'-prefix impostors (e.g. a hypothetical `gcmp-bridge` extension)
 * whose vendors are not actually contributed by GCMP. */
function declaredGcmpVendors(): Set<string> {
  const gcmpExt = vscode.extensions.getExtension('vicanent.gcmp');
  const providers = (gcmpExt?.packageJSON?.contributes?.languageModelChatProviders ?? []) as { vendor?: string }[];
  const vendors = new Set<string>();
  for (const p of providers) if (typeof p?.vendor === 'string' && p.vendor !== '') vendors.add(p.vendor);
  return vendors;
}

/** Best-effort open of the GCMP setup surface (config/settings/provider command
 * if GCMP contributes one, else settings.json). */
async function openGcmpSetup(): Promise<void> {
  const gcmpExt = vscode.extensions.getExtension('vicanent.gcmp');
  const cmds = ((gcmpExt?.packageJSON?.contributes?.commands as { command?: string }[] | undefined) ?? [])
    .map((c) => c?.command)
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
  const target = cmds.find((c) => /config|setting|provider/i.test(c));
  if (target) await vscode.commands.executeCommand(target);
  else await vscode.commands.executeCommand('workbench.action.openSettingsJson');
}

export async function importGcmpFlow(): Promise<void> {
  const declared = declaredGcmpVendors();
  const all = await vscode.lm.selectChatModels({});
  const live: LmModelLike[] = all.filter((m) => m.vendor.startsWith('gcmp.') && declared.has(m.vendor));
  if (live.length === 0) {
    const choice = await vscode.window.showWarningMessage(
      '未找到可用的 GCMP 供应商模型，请先配置 GCMP 供应商后重试。',
      '打开配置'
    );
    if (choice === '打开配置') await openGcmpSetup();
    return;
  }
  const mode = vscode.workspace.getConfiguration('fallbackRouter').get<'family' | 'exact'>('importMode', 'family');
  const result = importFromLm(live, mode);
  for (const s of result.skipped) logger.warn(`[import] skipped ${s.entryId}: ${s.reason}`);
  if (result.chains.length === 0) {
    void vscode.window.showErrorMessage('未生成可用的代理链。');
    return;
  }
  const ok = await writeImportChains(result.chains);
  const summary = `从 GCMP 导入 ${result.chains.length} 条链 / ${result.chains.reduce((a, c) => a + c.targets.length, 0)} 个目标 (${mode} 模式)`;
  if (ok) {
      logger?.info(`[import] ${summary}`);
    void vscode.window.showInformationMessage(`${summary} — 已写入配置。`);
  } else {
    void vscode.window.showErrorMessage(`${summary} — 部分链无法解析，已回滚。`);
  }
}

async function applyChains(): Promise<void> {
  const clipboard = await vscode.env.clipboard.readText();
  let chains: Chain[];
  try {
    const parsed = JSON.parse(clipboard);
    if (!Array.isArray(parsed)) throw new Error('expected array');
    chains = parsed as Chain[];
  } catch {
    void vscode.window.showErrorMessage(vscode.l10n.t('Clipboard does not contain a valid chains array.'));
    return;
  }
  // Write-before structural validation.
  const testSink = new Sink(logger);
  const normalized = normalizeConfig({ ...config, chains }, testSink);
  if (normalized.droppedChains > 0 || normalized.config.chains.length !== chains.length) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Chains failed structural validation; see log.'));
    return;
  }
  const confirm = await vscode.window.showInformationMessage(
    vscode.l10n.t('Apply {count} chain(s) to fallbackRouter.chains?', { count: chains.length }),
    { modal: true },
    vscode.l10n.t('Apply')
  );
  if (confirm !== vscode.l10n.t('Apply')) return;
    const ok = await writeImportChains(chains);
    if (!ok) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Some chains failed to resolve; rolled back.'));
      return;
    }
    void vscode.window.showInformationMessage(vscode.l10n.t('Chains applied successfully.'));
  }

  /** Directly write chains to fallbackRouter.chains (Global), then verify the
   * provider picked them up via the waitForModels loopback, rolling back on
   * failure. Shared by importGcmpFlow and applyChains. */
  export async function writeImportChains(chains: Chain[], timeoutMs = 10000): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration('fallbackRouter');
    const old = cfg.get<Chain[]>('chains');
    await cfg.update('chains', chains, vscode.ConfigurationTarget.Global);
    // Post-write loopback: wait for onDidChangeConfiguration to recompute, bounded.
    const ok = await waitForModels(chains, timeoutMs);
    if (!ok) {
      if (old === undefined) {
        await cfg.update('chains', undefined, vscode.ConfigurationTarget.Global);
      } else {
        await cfg.update('chains', old, vscode.ConfigurationTarget.Global);
      }
    }
    return ok;
  }

  export async function waitForModels(chains: Chain[], timeoutMs: number): Promise<boolean> {
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
    void vscode.window.showInformationMessage(vscode.l10n.t('No proxy targets configured.'));
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
  const picked = await vscode.window.showQuickPick(picks, { title: vscode.l10n.t('Select composite model as default') });
  if (!picked) return;
  const chainId = `fallbackrouter:${picked.chain.id}`;
  const vendorId = `${VENDOR}/${chainId}`;
  const keys: Record<string, string> = {
    'chat.planAgent.defaultModel': `${picked.chain.name} (fallback)`,
    'chat.exploreAgent.defaultModel': `${picked.chain.name} (fallback)`,
    'chat.utilityModel': vendorId,
  };
  const shown = Object.entries(keys).map(([k, v]) => `${k} = ${v}`).join('\n');
  const confirm = await vscode.window.showInformationMessage(vscode.l10n.t('Will write:\n{shown}', { shown }), { modal: true }, vscode.l10n.t('Write'));
  if (confirm !== vscode.l10n.t('Write')) return;
  // Loopback validate.
  const resolvable = await vscode.lm.selectChatModels({ vendor: VENDOR });
  if (!resolvable.some((m) => m.id === chainId)) {
    void vscode.window.showErrorMessage(vscode.l10n.t('Model not resolvable; refusing to write.'));
    return;
  }
  for (const [k, v] of Object.entries(keys)) {
    await vscode.workspace.getConfiguration().update(k, v, vscode.ConfigurationTarget.Global);
  }
  void vscode.window.showInformationMessage(vscode.l10n.t('Default model set.'));
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

export async function cleanup(context: vscode.ExtensionContext): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    vscode.l10n.t('Delete all stored API keys and breaker state for Fallback Router?'),
    { modal: true },
    vscode.l10n.t('Delete')
  );
  if (confirm !== vscode.l10n.t('Delete')) return;
  // (a) Deletion iterates ONLY over ref NAMES captured at migration time
  // (T3, globalState 'legacySecretRefs'). Known secret VALUES (knownSecrets)
  // are merged into the redaction list but are values, not keys — they must
  // never drive the delete loop (momus #5).
  const legacy = context.globalState.get<string[]>('legacySecretRefs', []);
  for (const ref of legacy) {
    const key = `fallbackrouter.${ref}`;
    try {
      const v = await context.secrets.get(key);
      if (v) knownSecrets.push(v);
    } catch { /* ignore */ }
    await Promise.resolve(context.secrets.delete(key)).catch(() => { /* ignore */ });
  }
  // (b) Clear the captured refs -> a second run finds nothing (idempotent).
  await context.globalState.update('legacySecretRefs', undefined);
  // (c) Breaker state persists under globalState keys 'fallbackrouter.breaker.*'.
  for (const k of context.globalState.keys()) {
    if (k.startsWith('fallbackrouter.')) await context.globalState.update(k, undefined);
  }
  void vscode.window.showInformationMessage(vscode.l10n.t('Fallback Router data cleaned.'));
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
