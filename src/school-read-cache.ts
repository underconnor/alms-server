import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { workerTransaction } from './worker-bounds.js';

export type SchoolCacheScope = { owner: string; provider: string; generation: string; resource: string; encryptedSession: string };
export type SchoolCacheEntry<T = unknown> = { value: T; expiresAt: number };
export interface SchoolReadCache {
  get<T>(scope: SchoolCacheScope): Promise<SchoolCacheEntry<T> | null>;
  put(scope: SchoolCacheScope, value: unknown, ttlMs: number): Promise<boolean>;
  delete(owner: string, provider: string, resource?: string): Promise<void>;
  deleteMany?(owner: string, provider: string, resources: readonly string[], signal?: AbortSignal): Promise<void>;
}
export function schoolCacheTtl(resource: string): number {
  if (resource === 'catalog' || resource.startsWith('catalog:')) return 5 * 60_000;
  if (resource === 'saint:timetable') return 10 * 60_000;
  if (resource.startsWith('course:')) return 2 * 60_000;
  // Activity payloads contain attendance/progress alongside metadata; keep them short-lived.
  return 30_000;
}
const MAX_BYTES = 1024 * 1024;
const MAX_TTL = 10 * 60_000;
const aad = (scope: Pick<SchoolCacheScope, 'owner' | 'provider' | 'generation' | 'resource'>) =>
  Buffer.from(JSON.stringify(['alms-school-read-cache', 1, scope.owner, scope.provider, scope.generation, scope.resource]));
export function sealSchoolRead(value: unknown, key: Buffer, scope: SchoolCacheScope): { encrypted: string; bytes: number } | null {
  if (key.length !== 32) throw new Error('Invalid cache encryption key');
  const raw = JSON.stringify(value);
  if (!raw || Buffer.byteLength(raw) > MAX_BYTES) return null;
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(scope));
  const encrypted = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  return { encrypted: ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.'), bytes: Buffer.byteLength(raw) };
}
export function openSchoolRead(encrypted: string, key: Buffer, scope: SchoolCacheScope): unknown {
  if (key.length !== 32 || encrypted.length > 1_400_000) throw new Error('Invalid encrypted cache');
  const [version, iv64, tag64, payload, extra] = encrypted.split('.');
  if (version !== 'v1' || !iv64 || !tag64 || !payload || extra !== undefined) throw new Error('Invalid encrypted cache');
  const iv = Buffer.from(iv64, 'base64url'), tag = Buffer.from(tag64, 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted cache');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad(scope)); decipher.setAuthTag(tag);
  const raw = Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]);
  if (raw.length > MAX_BYTES) throw new Error('Invalid cache size');
  return JSON.parse(raw.toString('utf8'));
}

/** Ciphertext-only PostgreSQL cache. Each hit still requires the exact current school session. */
export class PgSchoolReadCache implements SchoolReadCache {
  constructor(private readonly pool: Pool, private readonly key: Buffer) {}
  async get<T>(scope: SchoolCacheScope): Promise<SchoolCacheEntry<T> | null> {
    const { rows: [row] } = await this.pool.query(`UPDATE school_read_cache c SET accessed_at=now()
      FROM school_sessions s WHERE c.user_id=$1 AND c.provider=$2 AND c.generation=$3 AND c.resource_key=$4
      AND c.expires_at>now() AND s.user_id=c.user_id AND s.provider=c.provider AND s.encrypted_state=$5
      AND EXISTS(SELECT 1 FROM sessions a WHERE a.user_id=c.user_id AND a.expires_at>now())
      RETURNING c.encrypted_payload,c.expires_at`, [scope.owner, scope.provider, scope.generation, scope.resource, scope.encryptedSession]);
    if (!row) return null;
    try { return { value: openSchoolRead(row.encrypted_payload, this.key, scope) as T, expiresAt: new Date(row.expires_at).getTime() }; }
    catch { await this.delete(scope.owner, scope.provider, scope.resource); return null; }
  }
  async put(scope: SchoolCacheScope, value: unknown, ttlMs: number): Promise<boolean> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL || !scope.resource || scope.resource.length > 512) return false;
    const sealed = sealSchoolRead(value, this.key, scope);
    if (!sealed) return false;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One short write transaction bounds aggregate disk use across instances and users.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('alms:school-read-cache:v1'))");
      const active = await client.query(`SELECT 1 FROM school_sessions s WHERE user_id=$1 AND provider=$2 AND encrypted_state=$3
        AND EXISTS(SELECT 1 FROM sessions a WHERE a.user_id=s.user_id AND a.expires_at>now()) FOR SHARE`, [scope.owner, scope.provider, scope.encryptedSession]);
      if (!active.rowCount) { await client.query('COMMIT'); return false; }
      await client.query('DELETE FROM school_read_cache WHERE expires_at<=now() OR (user_id=$1 AND provider=$2 AND generation<>$3)', [scope.owner, scope.provider, scope.generation]);
      await client.query(`INSERT INTO school_read_cache(user_id,provider,generation,resource_key,encrypted_payload,payload_bytes,stored_bytes,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now()+$8::double precision*interval '1 millisecond')
        ON CONFLICT(user_id,provider,generation,resource_key) DO UPDATE SET encrypted_payload=EXCLUDED.encrypted_payload,payload_bytes=EXCLUDED.payload_bytes,stored_bytes=EXCLUDED.stored_bytes,expires_at=EXCLUDED.expires_at,accessed_at=now()`,
        [scope.owner, scope.provider, scope.generation, scope.resource, sealed.encrypted, sealed.bytes, Buffer.byteLength(sealed.encrypted), ttlMs]);
      await client.query(`WITH ranked AS (SELECT user_id,provider,generation,resource_key,
        row_number() OVER(ORDER BY accessed_at DESC,resource_key) AS n,
        sum(stored_bytes) OVER(ORDER BY accessed_at DESC,resource_key ROWS UNBOUNDED PRECEDING) AS bytes
        FROM school_read_cache WHERE user_id=$1)
        DELETE FROM school_read_cache c USING ranked r WHERE (c.user_id,c.provider,c.generation,c.resource_key)=(r.user_id,r.provider,r.generation,r.resource_key) AND (r.n>100 OR r.bytes>8388608)`, [scope.owner]);
      await client.query(`WITH ranked AS (SELECT user_id,provider,generation,resource_key,
        row_number() OVER(ORDER BY accessed_at DESC,user_id,resource_key) AS n,
        sum(stored_bytes) OVER(ORDER BY accessed_at DESC,user_id,resource_key ROWS UNBOUNDED PRECEDING) AS bytes FROM school_read_cache)
        DELETE FROM school_read_cache c USING ranked r WHERE (c.user_id,c.provider,c.generation,c.resource_key)=(r.user_id,r.provider,r.generation,r.resource_key) AND (r.n>5000 OR r.bytes>134217728)`);
      await client.query('COMMIT'); return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async deleteMany(owner: string, provider: string, resources: readonly string[], signal?: AbortSignal) {
    const unique = [...new Set(resources)];
    if (unique.length > 802 || unique.some(key => !key || key.length > 512)) throw new Error('CACHE_RESOURCE_LIMIT');
    if (!unique.length) return;
    await workerTransaction(this.pool, async query => {
      await query('DELETE FROM school_read_cache WHERE user_id=$1 AND provider=$2 AND resource_key=ANY($3::text[])', [owner, provider, unique]);
    }, { signal, timeoutMs: 5000 });
  }
  async delete(owner: string, provider: string, resource?: string) {
    await this.pool.query('DELETE FROM school_read_cache WHERE user_id=$1 AND provider=$2 AND ($3::text IS NULL OR resource_key=$3)', [owner, provider, resource ?? null]);
  }
}
