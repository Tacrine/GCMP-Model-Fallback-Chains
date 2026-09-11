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
