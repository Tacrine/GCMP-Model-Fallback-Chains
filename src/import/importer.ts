import type { Chain, ProxyTarget } from '../types';

/**
 * Minimal shape of a live `vscode.LanguageModelChat` as seen by import.
 * Deliberately structural so the pure import logic runs without VS Code.
 */
export interface LmModelLike {
  readonly vendor: string;
  readonly id: string;
  readonly name?: string;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface ImportResult {
  chains: Chain[];
  skipped: { entryId: string; reason: string }[];
}

const SANITIZE_RE = /[^a-zA-Z0-9_-]/g;

/**
 * Family name: strip a leading `vendor/` segment, then take the fragment before
 * the first `-`; if no `-`, the whole (lowercased) segment.
 */
export function familyName(model: string): string {
  let s = model;
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  const dash = s.indexOf('-');
  s = dash >= 0 ? s.slice(0, dash) : s;
  return s.toLowerCase();
}

export function sanitizeChainId(s: string): string {
  return s.replace(SANITIZE_RE, '_');
}

/**
 * Build proxy chains from live `vscode.lm.selectChatModels()` results.
 *
 * Every generated target carries the model's ACTUAL vendor id (e.g.
  * `gcmp.deepseek`) - never a wildcard vendor selector. Capability fields
 * (toolCalling/imageInput/tokens) are intentionally NOT written at import
 * time: they are merged at runtime by refresh() (T3).
 */
export function importFromLm(liveModels: readonly LmModelLike[], mode: 'family' | 'exact'): ImportResult {
  const skipped: { entryId: string; reason: string }[] = [];
  const chains = new Map<string, ProxyTarget[]>();

  for (const m of liveModels) {
    if (!m.vendor || !m.id) {
      skipped.push({ entryId: m.id || m.vendor || '<unknown>', reason: 'missing vendor or id' });
      continue;
    }
    if (m.vendor === 'fallbackrouter') {
      // Recursion guard: never import our own composite models into a chain.
      skipped.push({ entryId: m.id, reason: 'self vendor (fallbackrouter)' });
      continue;
    }
    const target: ProxyTarget = { kind: 'proxy', vendor: m.vendor, modelId: m.id };
    const groupKey = mode === 'exact' ? sanitizeChainId(m.id) : familyName(m.id);
    if (!chains.has(groupKey)) chains.set(groupKey, []);
    chains.get(groupKey)!.push(target);
  }

  const out: Chain[] = [];
  // Preserve first-appearance order of groups; within a group sort targets
  // deterministically by vendor then modelId so draft chain order is stable.
  for (const [key, targets] of chains) {
    targets.sort((a, b) =>
      a.vendor < b.vendor ? -1 : a.vendor > b.vendor ? 1 : a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0
    );
    out.push({ id: key, name: key, targets });
  }
  return { chains: out, skipped };
}