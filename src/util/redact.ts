/**
 * Single source of redaction truth shared by every output sink
 * (output channel, status bar, diagnostics, error objects).
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    // Replace Authorization/api-key header values too.
    out = out.split(secret).join('***');
  }
  // Best-effort scrub of common auth header value patterns.
  out = out.replace(
    /(authorization|api-key|x-api-key)\s*[:=]\s*(?:bearer\s+)?[A-Za-z0-9._\-+/=]{6,}/gi,
    (m, key) => `${key}: ***`
  );
  return out;
}

/** Deep-redact unknown values, returning a JSON-safe clone. */
export function redactUnknown(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactUnknown(v, secrets));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) {
      out[k] = redactUnknown(o[k], secrets);
    }
    return out;
  }
  return value;
}
