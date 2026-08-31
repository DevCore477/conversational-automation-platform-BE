import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encryptSecret(plain: string, encryptionKey: string): string {
  if (!encryptionKey) {
    return plain;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, deriveKey(encryptionKey), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(stored: string, encryptionKey: string): string {
  if (!encryptionKey || !stored.startsWith('v1:')) {
    return stored;
  }
  const [, ivB64, tagB64, dataB64] = stored.split(':');
  const decipher = createDecipheriv(ALGO, deriveKey(encryptionKey), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

export function maskToken(token: string): string {
  if (token.length <= 12) {
    return '***';
  }
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}
