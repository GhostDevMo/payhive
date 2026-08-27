/**
 * Encryption for secrets PayHive has to keep.
 *
 * There is exactly one of these today: the aggregator's access token for a
 * linked bank. It is a long-lived credential to somebody's bank data, so it
 * must not sit in the database in a form that a leaked backup or a stray
 * `SELECT *` would hand over.
 *
 * AES-256-GCM, because it authenticates as well as encrypts: a token that has
 * been tampered with fails to decrypt rather than decrypting into something
 * else. The nonce is random per encryption and stored alongside the ciphertext,
 * which is what makes reusing the same key safe.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsError';
  }
}

/**
 * Derive the key from SECRETS_KEY.
 *
 * Read at call time rather than at import, so a process that never touches an
 * encrypted column does not require the variable to be set — and so tests can
 * set it without controlling module load order.
 */
function key(): Buffer {
  const configured = process.env.SECRETS_KEY;
  if (!configured || configured.length < 32) {
    throw new SecretsError(
      'SECRETS_KEY must be set to at least 32 characters to store linked bank accounts. ' +
        'Generate one with: openssl rand -hex 32',
    );
  }
  // Hashed to exactly 32 bytes so any sufficiently long passphrase works,
  // rather than demanding the operator produce exact key material.
  return createHash('sha256').update(configured).digest();
}

/** Encrypt to `nonce.ciphertext.tag`, all base64url. */
export function encryptSecret(plaintext: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [nonce, encrypted, tag].map((b) => b.toString('base64url')).join('.');
}

export function decryptSecret(stored: string): string {
  const parts = stored.split('.');
  if (parts.length !== 3) throw new SecretsError('Stored secret is malformed');

  const [nonce, encrypted, tag] = parts.map((p) => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv(ALGORITHM, key(), nonce!);
  decipher.setAuthTag(tag!);

  return Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString('utf8');
}
