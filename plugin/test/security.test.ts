/**
 * Plugin security module unit tests
 * Covers: content sanitization, URL detection, message validation, nonce/timestamp
 */

import { describe, it, expect } from 'vitest';
import { sanitizeContent, detectUrls, validateMessage } from '../src/security';
import { createHmac, randomBytes } from 'node:crypto';

function makeMsg(overrides: Record<string, unknown> = {}) {
  const base = {
    id: randomBytes(8).toString('hex'),
    from: 'agent-a',
    to: 'agent-b',
    type: 'text' as const,
    content: 'hello',
    conversation_id: 'conv-test-1',
    timestamp: Date.now(),
    nonce: randomBytes(16).toString('hex'),
    signature: '',
    ...overrides,
  };
  return base;
}

function signMsg(msg: ReturnType<typeof makeMsg>, key: string): string {
  const turnMaterial = (msg as any).turn_number === undefined ? '' : `|${(msg as any).turn_number}`;
  const material = `${msg.id}|${msg.from}|${msg.to}|${msg.type}|${msg.content}|${msg.conversation_id}${turnMaterial}|${msg.timestamp}|${msg.nonce}`;
  return createHmac('sha256', key).update(material).digest('hex');
}

// ─── sanitizeContent ──────────────────────────────────────────────────────────

describe('sanitizeContent', () => {
  it('removes zero-width characters', () => {
    expect(sanitizeContent('hello\u200Bworld')).toBe('helloworld');
    expect(sanitizeContent('\uFEFFtest')).toBe('test');
  });

  it('removes directional control characters', () => {
    expect(sanitizeContent('hello\u202Eworld')).toBe('helloworld');
    expect(sanitizeContent('a\u2066b\u2069c')).toBe('abc');
  });

  it('normalizes to NFC', () => {
    const decomposed = 'e\u0301'; // é decomposed
    const result = sanitizeContent(decomposed);
    expect(result).toBe('\u00e9'); // é composed
  });

  it('leaves normal text unchanged', () => {
    expect(sanitizeContent('hello world 你好')).toBe('hello world 你好');
  });
});

// ─── detectUrls ──────────────────────────────────────────────────────────────

describe('detectUrls', () => {
  it('detects http/https URLs', () => {
    const urls = detectUrls('visit https://example.com and http://test.org/path');
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('https://example.com');
    expect(urls[1]).toContain('http://test.org/path');
  });

  it('detects data: URIs', () => {
    const urls = detectUrls('data:text/html,<script>alert(1)</script>');
    expect(urls).toHaveLength(1);
  });

  it('returns empty for plain text', () => {
    expect(detectUrls('just plain text')).toEqual([]);
  });
});

// ─── validateMessage ─────────────────────────────────────────────────────────

describe('validateMessage', () => {
  const KEY = 'test-session-key';

  it('valid message passes validation', () => {
    const msg = makeMsg();
    msg.signature = signMsg(msg, KEY);
    const result = validateMessage(msg, KEY);
    expect(result.id).toBe(msg.id);
  });

  it('bad signature throws', () => {
    const msg = makeMsg({ signature: 'bad'.repeat(21) + 'x' });
    expect(() => validateMessage(msg, KEY)).toThrow('bad signature');
  });

  it('stale timestamp throws', () => {
    const msg = makeMsg({ timestamp: Date.now() - 6 * 60 * 1000 });
    msg.signature = signMsg(msg, KEY);
    expect(() => validateMessage(msg, KEY)).toThrow('stale message');
  });

  it('replayed nonce throws', () => {
    const msg = makeMsg();
    msg.signature = signMsg(msg, KEY);
    validateMessage(msg, KEY); // first call ok
    const msg2 = { ...msg, id: randomBytes(8).toString('hex'), timestamp: Date.now() };
    msg2.signature = signMsg(msg2, KEY);
    // same nonce, different msg
    const msg3 = { ...msg2, nonce: msg.nonce };
    msg3.signature = signMsg(msg3, KEY);
    expect(() => validateMessage(msg3, KEY)).toThrow('replayed nonce');
  });

  it('unsupported message type throws', () => {
    const msg = makeMsg({ type: 'exec' });
    msg.signature = signMsg(msg, KEY);
    expect(() => validateMessage(msg, KEY)).toThrow('unsupported message type');
  });

  it('content too long throws', () => {
    const msg = makeMsg({ content: 'x'.repeat(2001) });
    msg.signature = signMsg(msg, KEY);
    expect(() => validateMessage(msg, KEY)).toThrow('content too long');
  });

  it('control characters in content throws', () => {
    const msg = makeMsg({ content: 'hello\x00world' });
    msg.signature = signMsg(msg, KEY);
    expect(() => validateMessage(msg, KEY)).toThrow('control chars');
  });

  it('invalid routing fields throws', () => {
    expect(() => validateMessage({ id: 123 }, KEY)).toThrow();
  });

  it('empty conversation_id throws', () => {
    const msg = makeMsg({ conversation_id: '  ' });
    msg.signature = signMsg(msg, KEY);
    expect(() => validateMessage(msg, KEY)).toThrow('invalid content fields');
  });
});
