import { describe, it, expect } from 'vitest';
import { redact, redactUnknown } from '../src/util/redact';

const SENTINEL = 'sk-test-sentinel-key-123456';

describe('redact', () => {
  it('replaces secret substrings with ***', () => {
    const out = redact(`Authorization: Bearer ${SENTINEL} and again ${SENTINEL}`, [SENTINEL]);
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain('***');
  });

  it('scrubs common auth header value patterns', () => {
    const out = redact('authorization: Bearer abcdefghijklm123', []);
    expect(out.toLowerCase()).not.toContain('abcdefghijklm123');
    expect(out).toContain('***');
  });

  it('leaves text without secrets untouched', () => {
    expect(redact('plain text', ['zzz'])).toBe('plain text');
  });

  it('ignores too-short secrets', () => {
    expect(redact('ab', ['ab'])).toBe('ab');
  });
});

describe('redactUnknown', () => {
  it('deep-redacts nested objects and arrays', () => {
    const input = { key: `Bearer ${SENTINEL}`, list: [`x-${SENTINEL}`], num: 5, nested: { deep: SENTINEL } };
    const out = redactUnknown(input, [SENTINEL]);
    const json = JSON.stringify(out);
    expect(json).not.toContain(SENTINEL);
    expect(JSON.parse(json).num).toBe(5);
  });
});
