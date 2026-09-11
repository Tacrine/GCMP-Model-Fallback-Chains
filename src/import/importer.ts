import type { ApiType, Chain, HttpTarget } from './types';

export interface GcmpEntry {
  id: string;
  name?: string;
  provider?: string;
  sdkMode?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  capabilities?: { toolCalling?: boolean; imageInput?: boolean };
  baseUrl?: string;
  model?: string;
  modelsEndpoint?: string;
  customHeader?: Record<string, string>;
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

function mapApiType(sdkMode?: string): ApiType | undefined {
  if (sdkMode === 'openai') return 'chat-completions';
  if (sdkMode === 'openai-responses') return 'responses';
  return undefined;
}

/** Pure import from gcmp.compatibleModels entries. */
export function importGcmp(entries: readonly GcmpEntry[], mode: 'family' | 'exact'): ImportResult {
  const skipped: { entryId: string; reason: string }[] = [];
  const chains = new Map<string, HttpTarget[]>();

  for (const e of entries) {
    if (!e.baseUrl || !e.model) {
      skipped.push({ entryId: e.id, reason: 'missing baseUrl or model' });
      continue;
    }
    const apiType = mapApiType(e.sdkMode);
    if (!apiType) {
      skipped.push({ entryId: e.id, reason: `invalid sdkMode ${JSON.stringify(e.sdkMode)}` });
      continue;
    }
    const secretRef = `gcmp.${e.provider ?? e.id}`;
    const target: HttpTarget = {
      kind: 'http',
      baseUrl: e.baseUrl,
      apiType,
      model: e.model, // preserved verbatim (e.g. futureppo maps grok-4.6)
      secretRef,
      maxInputTokens: e.maxInputTokens ?? 128000,
      maxOutputTokens: e.maxOutputTokens ?? 4096,
      toolCalling: e.capabilities?.toolCalling !== false,
      imageInput: e.capabilities?.imageInput === true,
      customHeader: e.customHeader && Object.keys(e.customHeader).length ? { ...e.customHeader } : {},
      modelsEndpoint: e.modelsEndpoint,
    };
    const groupKey = mode === 'exact' ? sanitizeChainId(e.model) : familyName(e.model);
    if (!chains.has(groupKey)) chains.set(groupKey, []);
    chains.get(groupKey)!.push(target);
  }

  const out: Chain[] = [];
  // Preserve first-appearance order of groups.
  for (const [key, targets] of chains) {
    out.push({ id: key, name: key, targets });
  }
  return { chains: out, skipped };
}
