import { describe, it, expect } from 'vitest';
import { importGcmp, familyName, sanitizeChainId, type GcmpEntry } from '../src/import/importer';
import { normalizeConfig } from '../src/config';

function entry(id: string, provider: string, sdkMode: string, baseUrl: string, model: string, modelsEndpoint?: string): GcmpEntry {
  return {
    id,
    name: id,
    provider,
    sdkMode,
    baseUrl,
    model,
    maxInputTokens: 128000,
    maxOutputTokens: 4096,
    capabilities: { toolCalling: true, imageInput: false },
    customHeader: { 'user-agent': 'codex-tui' },
    modelsEndpoint,
  };
}

const ENTRIES: GcmpEntry[] = [
  entry('幻城/Auto', '幻城', 'openai', 'https://api.hcnsec.cn/v1', 'auto', '/v1/models'),
  entry('辉哥/grok-4.6', '辉哥', 'openai-responses', 'https://lzhiyu.ccwu.cc/v1', 'grok-4.6', '/v1/models'),
  entry('AgentRouter/gpt-5.6-sol', 'AgentRouter', 'openai-responses', 'https://agentrouter.org/v1', 'gpt-5.6-sol'),
  entry('AgentRouter/deepseek-v4-flash', 'AgentRouter', 'openai-responses', 'https://agentrouter.org/v1', 'deepseek-v4-flash'),
  entry('星见雅/gpt-5.6-sol', '星见雅', 'openai-responses', 'https://new.xinjianya.top/v1', 'gpt-5.6-sol', '/v1/models'),
  entry('星见雅/deepseek-v4-pro', '星见雅', 'openai', 'https://new.xinjianya.top/v1', 'deepseek-ai/deepseek-v4-pro-0813', '/v1/models'),
  entry('AgentRouter/glm-5.3', 'AgentRouter', 'openai-responses', 'https://agentrouter.org/v1', 'glm-5.3', '/v1/models'),
  entry('futureppo/deepseek-v4-flash', 'futureppo', 'openai', 'https://api2.futureppo.top/v1', 'grok-4.6', '/v1/models'),
  entry('初叶/deepseek-v4-flash', '初叶', 'openai', 'https://ai.chuyel.top/v1', 'deepseek-v4-flash-0731', '/v1/models'),
];

const emptySink = { warn: () => {}, error: () => {} };

describe('familyName', () => {
  it('extracts family names deterministically', () => {
    expect(familyName('deepseek-ai/deepseek-v4-pro-0813')).toBe('deepseek');
    expect(familyName('auto')).toBe('auto');
    expect(familyName('glm-5.3')).toBe('glm');
    expect(familyName('gpt-5.6-sol')).toBe('gpt');
    expect(familyName('grok-4.6')).toBe('grok');
  });
});

describe('sanitizeChainId', () => {
  it('sanitizes non-word chars', () => {
    expect(sanitizeChainId('deepseek-ai/deepseek-v4-pro-0813')).toBe('deepseek-ai_deepseek-v4-pro-0813');
  });
});

describe('importGcmp', () => {
  it('imports 9 targets preserving customHeader and modelsEndpoint', () => {
    const r = importGcmp(ENTRIES, 'family');
    const allTargets = r.chains.flatMap((c) => c.targets);
    expect(allTargets).toHaveLength(9);
    for (const t of allTargets) {
      expect(t.kind).toBe('http');
      expect(t.customHeader).toBeTruthy();
      if (t.kind === 'http') expect(Object.keys(t.customHeader ?? {})).toContain('user-agent');
    }
    const withEp = r.chains.flatMap((c) => c.targets).filter((t) => t.kind === 'http' && t.modelsEndpoint);
    expect(withEp).toHaveLength(7);
  });

  it('family mode yields 5 chains / 9 targets with correct grouping', () => {
    const r = importGcmp(ENTRIES, 'family');
    expect(r.chains).toHaveLength(5);
    const ids = r.chains.map((c) => c.id).sort();
    expect(ids).toEqual(['auto', 'deepseek', 'glm', 'gpt', 'grok']);
    const byId = new Map(r.chains.map((c) => [c.id, c.targets.length]));
    expect(byId.get('auto')).toBe(1);
    expect(byId.get('grok')).toBe(2);
    expect(byId.get('gpt')).toBe(2);
    expect(byId.get('deepseek')).toBe(3);
    expect(byId.get('glm')).toBe(1);
    // futureppo (model grok-4.6) must be in grok family, not deepseek
    const grok = r.chains.find((c) => c.id === 'grok')!;
    const grokModels = grok.targets.map((t) => (t.kind === 'http' ? t.model : ''));
    expect(grokModels).toEqual(['grok-4.6', 'grok-4.6']);
    const deep = r.chains.find((c) => c.id === 'deepseek')!;
    expect(deep.targets.map((t) => (t.kind === 'http' ? t.model : ''))).toEqual(['deepseek-v4-flash', 'deepseek-v4-flash-0731', 'deepseek-ai/deepseek-v4-pro-0813']);
  });

  it('exact mode yields 7 chains / 9 targets', () => {
    const r = importGcmp(ENTRIES, 'exact');
    expect(r.chains).toHaveLength(7);
    expect(r.chains.flatMap((c) => c.targets)).toHaveLength(9);
  });

  it('keeps futureppo model verbatim as grok-4.6', () => {
    const r = importGcmp(ENTRIES, 'family');
    const future = r.chains.flatMap((c) => c.targets).find((t) => t.kind === 'http' && t.secretRef === 'gcmp.futureppo');
    expect((future as { model: string }).model).toBe('grok-4.6');
  });

  it('skips entries missing baseUrl/model or with invalid sdkMode', () => {
    const bad: GcmpEntry[] = [
      entry('a', 'p', 'openai', '', 'm'),
      entry('b', 'p', 'weird', 'https://x/v1', 'm'),
    ];
    const r = importGcmp(bad, 'family');
    expect(r.chains).toHaveLength(0);
    expect(r.skipped).toHaveLength(2);
  });

  it('import -> validate roundtrip is accepted by loadConfig', () => {
    const r = importGcmp(ENTRIES, 'family');
    const res = normalizeConfig({ chains: r.chains }, emptySink);
    expect(res.droppedChains).toBe(0);
    expect(res.config.chains).toHaveLength(r.chains.length);
  });
});
