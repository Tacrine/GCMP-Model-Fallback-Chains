/**
 * T1 spike runner — extension-host nested LM delegation gate.
 *
 * Runs inside the VS Code extension host via @vscode/test-electron.
 * Plain-assert runner (no mocha): assertions that fail throw, which makes
 * runTests exit non-zero. The gate verdict (PASS/FAIL) is written to
 * .omo/evidence/task-1-gcmp-companion-refactor.txt before any throw.
 *
 * Purpose: prove the platform allows nested LM delegation — an extension
 * (fallbackrouter) selecting models via vscode.lm.selectChatModels and
 * streaming a real sendRequest through a chain. The echo provider needs no
 * API keys (Metis #2 / oracle #1).
 *
 * Must NOT import provider.ts — the extension is activated by id only, so the
 * exercised path is the real bundled code (oracle round-2 #2).
 *
 * Gate verdict (plan T1):
 *   PASS = extension chain produced >= 1 text part AND original config restored.
 *   FAIL = NoPermissions / Blocked / platform rejection / 0 output (FAIL-a)
 *          — evidence is written, then run() throws (non-zero exit, stop signal).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const EXT_ID = 'tacrine.gcmp-model-fallback-chains';
const ECHO_VENDOR = 'spike-test';
const ECHO_MODEL = 'echo-1';
const CHAIN_ID = 'spike';
const EVIDENCE_FILE = path.resolve(__dirname, '..', '.omo', 'evidence', 'task-1-gcmp-companion-refactor.txt');

interface ProbeOutcome {
  found: boolean;
  textParts: string[];
  partShapes: string[];
  error?: string;
  code?: string;
}

/** Keyless echo provider: no API key needed, returns a fixed 2-part stream. */
class EchoProvider implements vscode.LanguageModelChatProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> = this.emitter.event;

  async provideLanguageModelChatInformation(
    _options: { silent?: boolean },
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    return [
      {
        id: ECHO_MODEL,
        name: 'Spike Echo',
        family: ECHO_VENDOR,
        version: '1',
        maxInputTokens: 32000,
        maxOutputTokens: 32000,
        capabilities: { toolCalling: false, imageInput: false },
      },
    ];
  }

  async provideLanguageModelChatResponse(
    _model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const text = messages
      .map((m) => m.content.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : '')).join(''))
      .join(' ');
    const echoText = `echo:${text}`;
    progress.report(new vscode.LanguageModelTextPart(echoText));
    progress.report(new vscode.LanguageModelTextPart(` ${echoText}`));
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    _text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    return 1;
  }
}

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 250
): Promise<T | undefined> {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch {
      // transient (e.g. LM service warming up): retry
    }
    if (Date.now() - start > timeoutMs) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Bypass the extension entirely: can the platform delegate to a provider
 * registered by another extension? Also records the REAL part shape of the
 * streamed response (does a text part expose `.kind`?).
 */
async function directProbe(): Promise<ProbeOutcome> {
  const out: ProbeOutcome = { found: false, textParts: [], partShapes: [] };
  try {
    // Diagnostic: what does the platform see at all (any vendor)?
    const all = await vscode.lm.selectChatModels({});
    out.partShapes.push(`all visible models: ${JSON.stringify(all.map((m) => `${m.vendor}/${m.id}`))}`);
    const models = await waitFor(
      async () => {
        const arr = await vscode.lm.selectChatModels({ vendor: ECHO_VENDOR, id: ECHO_MODEL });
        return arr.length > 0 ? arr : undefined;
      },
      20000
    );
    if (!models || models.length === 0) {
      out.error = `echo model ${ECHO_VENDOR}/${ECHO_MODEL} not visible to vscode.lm.selectChatModels`;
      return out;
    }
    out.found = true;
    const model = models[0];
    const cts = new vscode.CancellationTokenSource();
    const resp = await model.sendRequest(
      [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('ping from spike')] }],
      {},
      cts.token
    );
    for await (const p of resp.stream) {
      const shape =
        `keys=[${Object.keys(p as object).join(',')}]` +
        ` kind=${JSON.stringify((p as { kind?: unknown }).kind)}` +
        ` instanceofText=${p instanceof vscode.LanguageModelTextPart}` +
        ` ctor=${(p as object).constructor?.name ?? '?'}`;
      out.partShapes.push(shape);
      if (p instanceof vscode.LanguageModelTextPart) out.textParts.push(p.value);
      else if (typeof (p as { value?: unknown }).value === 'string') out.textParts.push((p as { value: string }).value);
    }
    return out;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    out.code = (e as { code?: unknown }).code as string | undefined;
    return out;
  }
}

/** Real end-to-end path: fallbackrouter:spike chain -> ProxyTransport -> echo provider. */
async function extensionChainProbe(): Promise<ProbeOutcome> {
  const out: ProbeOutcome = { found: false, textParts: [], partShapes: [] };
  try {
    // Diagnostic: replicate ProxyTransport.send internals with the same token shape
    // the router hands to lmAdapter, to isolate where NotFound originates.
    const diag: string[] = [];
    try {
      const echo = await vscode.lm.selectChatModels({ vendor: ECHO_VENDOR, id: ECHO_MODEL });
      diag.push(`proxy-resolve selectChatModels(${ECHO_VENDOR}/${ECHO_MODEL}) -> ${echo.length} model(s)`);
      if (echo.length > 0) {
        // Mimic the router Cancel object that lmAdapter casts to CancellationToken.
        // NOTE: a bare fn return crashes platform cleanup ($acceptResponseDone ->
        // _parentListener?.dispose). Use a Disposable-shaped return to validate
        // what the platform actually requires from onCancellationRequested.
        const fakeToken = {
          isCancellationRequested: false,
          onCancellationRequested: (_fn: () => void) => ({ dispose: () => undefined }),
        };
        try {
          const resp = await Promise.race([
            echo[0].sendRequest(
              [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('ping from spike')] }],
              {},
              fakeToken as unknown as vscode.CancellationToken
            ),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('proxy-send sendRequest timed out after 30s')), 30000)),
          ]);
          let n = 0;
          for await (const p of resp.stream) {
            n++;
            diag.push(`proxy-send stream part ${n}: keys=[${Object.keys(p as object).join(',')}] ctor=${(p as object).constructor?.name ?? '?'}`);
          }
          diag.push(`proxy-send stream consumed: ${n} parts`);
        } catch (e) {
          diag.push(`proxy-send sendRequest FAILED: ${e instanceof Error ? e.message : String(e)} code=${(e as { code?: unknown }).code as string ?? 'undefined'}`);
        }
      }
    } catch (e) {
      diag.push(`proxy-resolve FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
    out.partShapes.push(...diag);

    const models = await waitFor(
      async () => {
        const arr = await vscode.lm.selectChatModels({ vendor: 'fallbackrouter', id: `fallbackrouter:${CHAIN_ID}` });
        return arr.length > 0 ? arr : undefined;
      },
      30000
    );
    if (!models || models.length === 0) {
      out.error = `fallbackrouter:${CHAIN_ID} never appeared after writing chains config`;
      return out;
    }
    out.found = true;
    const model = models[0];
    const cts = new vscode.CancellationTokenSource();
    // Safety: never hang the harness if the router wedges.
    const guard = setTimeout(() => cts.cancel(), 90000);
    try {
      console.log(`[spike] ext-chain sendRequest begin (${new Date().toISOString()})`);
      const resp = await model.sendRequest(
        [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('ping from spike')] }],
        {},
        cts.token
      );
      console.log(`[spike] ext-chain sendRequest resolved (${new Date().toISOString()})`);
      for await (const p of resp.stream) {
        if (p instanceof vscode.LanguageModelTextPart) out.textParts.push(p.value);
        else out.partShapes.push(`unexpected part ctor=${(p as object).constructor?.name ?? '?'}`);
        console.log(`[spike] ext-chain stream part (${new Date().toISOString()})`);
      }
      console.log(`[spike] ext-chain stream ended (${new Date().toISOString()})`);
    } finally {
      clearTimeout(guard);
    }
    return out;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    out.code = (e as { code?: unknown }).code as string | undefined;
    return out;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function run(): Promise<void> {
  const lines: string[] = [];
  const version = vscode.version;
  lines.push(`vscode.version=${version}`);

  // 1. Register the keyless echo provider (vendor 'spike-test', model 'echo-1').
  const echo = new EchoProvider();
  const echoSub = vscode.lm.registerLanguageModelChatProvider(ECHO_VENDOR, echo);
  lines.push(`echo provider registered: vendor=${ECHO_VENDOR} model=${ECHO_MODEL}`);

  let restoreOk = false;
  try {
    // 2. Direct platform probe (bypasses the extension): nested delegation at all?
    const direct = await directProbe();
    lines.push(`direct probe: found=${direct.found} textParts=${direct.textParts.length}`);
    for (const s of direct.partShapes) lines.push(`  part: ${s}`);
    if (direct.error) lines.push(`  direct error: ${direct.error} code=${direct.code}`);

    // 3. Activate the real extension explicitly. activationEvents
    //    'onLanguageModelChatProvider:fallbackrouter' only fires when a requester
    //    asks, so without activate() the composite chain would never run.
    const ext = vscode.extensions.getExtension(EXT_ID);
    if (!ext) throw new Error(`extension ${EXT_ID} not found`);
    await ext.activate();
    lines.push(`extension activated explicitly: ${EXT_ID}`);

    // 4. Backup chains, write the spike chain, wait for fallbackrouter:spike.
    const cfg = vscode.workspace.getConfiguration('fallbackRouter');
    const originalChains = cfg.get<unknown>('chains');
    lines.push(`original chains: ${JSON.stringify(originalChains)}`);
    const spikeChains = [
      { id: CHAIN_ID, name: 'spike', targets: [{ kind: 'proxy', vendor: ECHO_VENDOR, modelId: ECHO_MODEL }] },
    ];
    await cfg.update('chains', spikeChains, vscode.ConfigurationTarget.Global);
    lines.push(`wrote spike chain: ${JSON.stringify(spikeChains)}`);

    try {
      const chainProbe = await extensionChainProbe();
      lines.push(`extension chain probe: found=${chainProbe.found} textParts=${chainProbe.textParts.length}`);
      for (const s of chainProbe.partShapes) lines.push(`  diag: ${s}`);
      for (const t of chainProbe.textParts) lines.push(`  text: ${t}`);
      if (chainProbe.error) lines.push(`  chain error: ${chainProbe.error} code=${chainProbe.code}`);

      const passed = chainProbe.found && chainProbe.textParts.length >= 1;
      lines.push(`gate: ${passed ? 'PASS' : 'FAIL'}`);
      lines.push(`chain text blocks >= 1: ${chainProbe.textParts.length >= 1}`);
      if (!passed) {
        lines.push('verdict: FAIL-a (0 output / platform delegation rejected) — plan stop signal');
      }
      fs.writeFileSync(EVIDENCE_FILE, lines.join('\n') + '\n', 'utf8');

      if (!passed) {
        // Plan T1 FAIL-a: evidence already written, exit non-zero (stop the plan).
        throw new Error(
          `T1 gate FAIL: extension chain produced ${chainProbe.textParts.length} text parts` +
            (chainProbe.error ? ` (${chainProbe.error} code=${chainProbe.code})` : '')
        );
      }
    } finally {
      // 5. Restore the original config and assert it round-tripped.
      await cfg.update('chains', originalChains, vscode.ConfigurationTarget.Global);
      const restored = cfg.get<unknown>('chains');
      restoreOk = deepEqual(restored, originalChains);
      lines.push(`config restored: ${restoreOk}`);
      fs.writeFileSync(EVIDENCE_FILE, lines.join('\n') + '\n', 'utf8');
    }
  } finally {
    echoSub.dispose();
  }

  if (!restoreOk) throw new Error('T1 config restore assertion failed');
  console.log(`T1 spike PASS (vscode ${version}): fallbackrouter:${CHAIN_ID} streamed text blocks via nested delegation`);
}
