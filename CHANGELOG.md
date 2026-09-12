# Changelog

## [0.2.0] - 2026-09-14

### Breaking changes
- Now a **GCMP companion extension**: declared `extensionDependencies: ["vicanent.gcmp"]`, engine floor raised to VS Code ≥ 1.125. GCMP ≥ 0.28.x required.
- **Deleted the HTTP transport** (`chat-completions`/`responses` native streaming, `src/transport/httpTransport.ts`, `src/convert/`). Every target is now a `proxy` target; legacy `http` targets are stripped on config load (counted in `droppedHttpTargets`) and re-import via **Manage → Import GCMP config** is required.
- **Deleted `setApiKey`** (`fallbackrouter.setApiKey` command) and all key management: the extension no longer touches or stores any API key. Keys are configured in GCMP. `fallbackrouter.cleanup` now purges legacy `fallbackrouter.*` secrets captured during migration (reference list in globalState `legacySecretRefs`, idempotent) plus breaker state.
- **Config changes**: `fallbackRouter.timeouts` removed along with the HTTP stack; `chains` targets accept `kind: "proxy"` only. `importMode` stays (`family` | `exact`).
- **Import rewired**: Import GCMP config now reads **live** `vscode.lm.selectChatModels` results (intersection-filtered against GCMP's declared vendors, `fallbackrouter` vendor excluded) instead of static model lists, and writes `fallbackRouter.chains` directly with loopback verification and rollback.
- **Capabilities merged live**: chain `maxInputTokens` / `toolCalling` / `imageInput` come from realtime chat-model metadata (conservative defaults when metadata is absent).

## [0.1.0] - 2026-09-11

### Added
- Composite language model provider (`fallbackrouter` vendor) exposing model chains.
- Ordered fallback chains with per-target backoff retry and per-target circuit breaker.
- Two transports:
  - Proxy transport (delegates to existing BYOK providers like GCMP).
  - HTTP transport (native streaming `chat-completions` and `responses`).
- Hybrid mid-stream policy: silent switch before first part, visible notice after text, abort after tool call.
- GCMP config importer with family/exact grouping.
- Manage, apply, warmup, setApiKey, set-default-model, diagnostics, cleanup commands.
- Observability: output channel logging, status bar, diagnostics command, redaction.
- Mock upstream + deterministic fault injection QA (`npm run qa:faults`).

### Documentation
- README (Chinese-primary with English summary): problem statement, wiring steps
  (model picker vs `chat.planAgent.defaultModel` / `chat.exploreAgent.defaultModel` /
  `chat.utilityModel`), configuration overview, A1 (proxy) vs A2 (http) tradeoffs,
  command reference, security notes, honest limits, troubleshooting.
- `docs/configuration.md`: full field reference tables for `fallbackRouter.*` settings,
  chain/target schemas, wall-clock and rate-limit semantics, GCMP import behavior,
  `managementCommand` deprecation note.
