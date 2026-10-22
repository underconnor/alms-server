import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Only a 60-second authorization-code grant stores this sealed session secret.
// The browser receives the opaque code, then uses S256 to exchange it via JSON.
export function sealFrontendToken(token: string, key: Buffer, codeHash: string, clientId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`alms-frontend-code:v1:${codeHash}:${clientId}`));
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64url')).join('.');
}
export function unsealFrontendToken(value: string, key: Buffer, codeHash: string, clientId: string): string {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Invalid sealed frontend grant');
  const iv = Buffer.from(parts[0]!, 'base64url'), tag = Buffer.from(parts[1]!, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid sealed frontend grant');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(`alms-frontend-code:v1:${codeHash}:${clientId}`));
  decipher.setAuthTag(tag);
  const token = Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64url')), decipher.final()]).toString('utf8');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid sealed frontend grant');
  return token;
}
