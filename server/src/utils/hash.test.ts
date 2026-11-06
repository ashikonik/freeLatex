import { describe, expect, it } from 'vitest';

import { generateSecret, hashSecret, verifySecret } from './hash.js';

describe('hashSecret', () => {
  it('produces a stable 64-character hex digest', () => {
    const hash = hashSecret('secret');

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret('secret')).toBe(hash);
  });

  it('produces different digests for different inputs', () => {
    expect(hashSecret('a')).not.toBe(hashSecret('b'));
  });

  it('handles unicode input', () => {
    expect(hashSecret('café ☕')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifySecret', () => {
  it('accepts the matching secret', () => {
    expect(verifySecret('correct-horse', hashSecret('correct-horse'))).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(verifySecret('wrong', hashSecret('correct-horse'))).toBe(false);
  });

  it('rejects a malformed stored hash without throwing', () => {
    expect(verifySecret('anything', 'not-a-hex-hash')).toBe(false);
  });

  it('rejects a stored hash of a different length', () => {
    expect(verifySecret('anything', 'abcd')).toBe(false);
  });
});

describe('generateSecret', () => {
  it('prefixes the random value', () => {
    expect(generateSecret('sk_user_')).toMatch(/^sk_user_[0-9a-f]{64}$/);
  });

  it('produces a different value each call', () => {
    expect(generateSecret('rw_')).not.toBe(generateSecret('rw_'));
  });

  it('honours a custom byte length', () => {
    expect(generateSecret('x_', 8)).toMatch(/^x_[0-9a-f]{16}$/);
  });
});
