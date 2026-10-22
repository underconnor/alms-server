import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';

export function encryptSchoolSession(value: unknown,key: Buffer,userId: string,provider: string): string {
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
  const raw = JSON.stringify(value);
  if (!raw || Buffer.byteLength(raw)>256*1024) throw new Error('Invalid school session state');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(`alms-school-session:v1:${userId}:${provider}`));
  const encrypted = Buffer.concat([cipher.update(raw,'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),encrypted.toString('base64url')].join('.');
}

export function decryptSchoolSession(value: string,key: Buffer,userId: string,provider: string): unknown {
  const parts = value.split('.');
  if (parts.length!==4 || parts[0]!=='v1') throw new Error('Unsupported school session format');
  const iv = Buffer.from(parts[1]!,'base64url');
  const tag = Buffer.from(parts[2]!,'base64url');
  if (iv.length!==12 || tag.length!==16 || key.length!==32) throw new Error('Invalid encrypted school session');
  const decipher = createDecipheriv('aes-256-gcm',key,iv);
  decipher.setAAD(Buffer.from(`alms-school-session:v1:${userId}:${provider}`));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[3]!,'base64url')),decipher.final()]).toString('utf8'));
}
