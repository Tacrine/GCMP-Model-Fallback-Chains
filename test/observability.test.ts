import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscodeMock from './helpers/vscode-mock';

vi.mock('vscode', () => vscodeMock);

import { OutputLogger, StatusBar } from '../src/observability';

const SENTINEL = 'sk-sentinel-redaction-key-0000';

function makeLogger(secrets: string[] = [SENTINEL]) {
  const l = new OutputLogger(async () => secrets);
  return l;
}

describe('OutputLogger', () => {
  beforeEach(() => vscodeMock.__resetSinks());

  it('suppresses all output at level off', async () => {
    const l = makeLogger();
    l.setLevel('off');
    await l.refreshSecrets();
    l.info('should not appear');
    expect(vscodeMock.__channelLines()).toHaveLength(0);
  });

  it('filters below configured level', async () => {
    const l = makeLogger();
    l.setLevel('error');
    await l.refreshSecrets();
    l.info('info-hidden');
    l.error('error-shown');
    const lines = vscodeMock.__channelLines().join('\n');
    expect(lines).not.toContain('info-hidden');
    expect(lines).toContain('error-shown');
  });

  it('redacts secret values in every sink line', async () => {
    const l = makeLogger();
    l.setLevel('debug');
    await l.refreshSecrets();
    l.error(`Authorization: Bearer ${SENTINEL}`);
    const lines = vscodeMock.__channelLines().join('\n');
    expect(lines).not.toContain(SENTINEL);
    expect(lines).toContain('***');
  });
});

describe('StatusBar', () => {
  it('updates text with chain and position / open state', () => {
    vscodeMock.__resetSinks();
    const s = new StatusBar();
    s.setChain('deepseek', '2/3');
    expect(vscodeMock.__statusText()).toBe('FR: deepseek · 2/3');
    s.setChain('deepseek', undefined, 'open');
    expect(vscodeMock.__statusText()).toBe('FR: deepseek · open');
    s.setChain(undefined);
    expect(vscodeMock.__statusText()).toBe('FR: idle');
    s.dispose();
  });
});
