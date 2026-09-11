# Changelog

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
