import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Hash an API key or share token for storage and lookup.
 *
 * These are high-entropy random strings, not user passwords, so a single
 * SHA-256 pass is the right trade-off — there is nothing to brute-force.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Compare a candidate secret against a stored hash in constant time.
 *
 * Guards against an attacker timing responses to discover a hash byte by byte.
 */
export function verifySecret(candidate: string, storedHash: string): boolean {
  const candidateHash = Buffer.from(hashSecret(candidate), 'hex');
  const expectedHash = Buffer.from(storedHash, 'hex');

  if (candidateHash.length !== expectedHash.length) {
    return false;
  }
  return timingSafeEqual(candidateHash, expectedHash);
}

/**
 * Generate a cryptographically random secret with the given prefix.
 *
 * Uses 32 bytes of entropy from the OS CSPRNG — enough that share links
 * cannot be guessed.
 */
export function generateSecret(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('hex')}`;
}
