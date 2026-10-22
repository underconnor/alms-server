import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { errors, type Adapter, type AdapterPayload } from 'oidc-provider';
import type { Session } from '../domain.js';
import { AppError } from '../errors.js';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const mcpDenied = () => new AppError(401, 'MCP_AUTH_REQUIRED', 'ALMS MCP 연결을 다시 승인해 주세요.');
export interface Authorization {
  id: string; userId: string; sessionTokenHash: string; clientId: string; resource: string; scopes: string[]; expiresAt: string;
}
const models = new Set(['Grant', 'Session', 'AccessToken', 'AuthorizationCode', 'RefreshToken', 'Interaction', 'ReplayDetection']);
export class McpAuthorizationRepository {
  private key: Buffer;
  constructor(private pool: Pool, key: Buffer) {
    if (key.length !== 32) throw new Error('Invalid MCP encryption key');
    this.key = createHmac('sha256', key).update('alms:mcp:oauth-storage:v1').digest();
  }
  async health() {
    const { rows: [row] } = await this.pool.query(`SELECT
      EXISTS(SELECT 1 FROM schema_migrations WHERE name='015-mcp-authorization.sql') AS migration,
      to_regclass('mcp_authorizations') IS NOT NULL AS authorizations,
      to_regclass('mcp_consent_challenges') IS NOT NULL AS challenges,
      to_regclass('mcp_oauth_objects') IS NOT NULL AS objects,
      EXISTS(SELECT 1 FROM pg_constraint c WHERE c.contype='f' AND c.conrelid=to_regclass('mcp_authorizations')
        AND c.confrelid=to_regclass('sessions') AND c.confdeltype='c'
        AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='approved_session_hash')]::smallint[]
        AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='token_hash')]::smallint[]) AS session_binding,
      EXISTS(SELECT 1 FROM pg_constraint c WHERE c.contype='f' AND c.conrelid=to_regclass('mcp_consent_challenges')
        AND c.confrelid=to_regclass('sessions') AND c.confdeltype='c'
        AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='session_token_hash')]::smallint[]) AS challenge_binding`);
    if (!row || !['migration', 'authorizations', 'challenges', 'objects', 'session_binding', 'challenge_binding'].every(key => row[key] === true))
      throw new Error('MCP authorization migrations are pending or invalid');
  }
  private seal(model: string, id: string, payload: AdapterPayload) {
    const text = JSON.stringify(payload); if (Buffer.byteLength(text) > 256 * 1024) throw new Error('MCP OAuth object too large');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(['alms-mcp', 1, model, id])));
    const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
  }
  private open(model: string, id: string, value: string): AdapterPayload {
    const [version, iv, tag, encrypted, extra] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !encrypted || extra !== undefined || value.length > 360000) throw new Error('Invalid MCP OAuth object');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(JSON.stringify(['alms-mcp', 1, model, id]))); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8')) as AdapterPayload;
  }
  adapter(model: string): Adapter {
    if (!models.has(model)) throw new Error('Unsupported MCP OAuth model');
    const find = async (column: 'id_hash' | 'uid_hash', value: string) => {
      const { rows: [row] } = await this.pool.query(`SELECT id_hash,payload_enc,consumed_at FROM mcp_oauth_objects WHERE model=$1 AND ${column}=$2 AND expires_at>clock_timestamp()`, [model, digest(value)]);
      if (!row) return undefined;
      const payload = this.open(model, row.id_hash, row.payload_enc);
      return row.consumed_at ? { ...payload, consumed: Math.floor(new Date(row.consumed_at).getTime() / 1000) } : payload;
    };
    return {
      upsert: async (id, payload, expiresIn) => {
        const lifetime = expiresIn ?? 86400;
        if (!Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > 604800) throw new Error('Invalid MCP OAuth lifetime');
        const hash = digest(id);
        await this.pool.query(`INSERT INTO mcp_oauth_objects(model,id_hash,payload_enc,grant_hash,uid_hash,expires_at)
          VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6::int*interval '1 second')
          ON CONFLICT(model,id_hash) DO UPDATE SET payload_enc=EXCLUDED.payload_enc,grant_hash=EXCLUDED.grant_hash,
            uid_hash=EXCLUDED.uid_hash,expires_at=EXCLUDED.expires_at`,
        [model, hash, this.seal(model, hash, payload), payload.grantId ? digest(payload.grantId) : model === 'Grant' ? hash : null,
          payload.uid ? digest(payload.uid) : null, lifetime]);
      },
      find: id => find('id_hash', id), findByUid: uid => find('uid_hash', uid), findByUserCode: async () => undefined,
      consume: async id => {
        const { rowCount } = await this.pool.query(`UPDATE mcp_oauth_objects SET consumed_at=clock_timestamp()
          WHERE model=$1 AND id_hash=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp()`, [model, digest(id)]);
        if (rowCount !== 1) {
          const previous = await find('id_hash', id);
          if (previous?.grantId) await this.revoke(previous.grantId);
          throw new errors.InvalidGrant('token already consumed or expired');
        }
      },
      destroy: async id => { await this.pool.query('DELETE FROM mcp_oauth_objects WHERE model=$1 AND id_hash=$2', [model, digest(id)]); },
      revokeByGrantId: grantId => this.revoke(grantId),
    };
  }
  async find(grantId: string): Promise<Authorization | null> {
    const { rows: [r] } = await this.pool.query(`SELECT a.* FROM mcp_authorizations a JOIN sessions s ON s.token_hash=a.approved_session_hash AND s.user_id=a.user_id
      WHERE a.grant_hash=$1 AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp()`, [digest(grantId)]);
    return r ? { id: r.id, userId: r.user_id, sessionTokenHash: r.approved_session_hash, clientId: r.client_id, resource: r.resource, scopes: r.scopes,
      expiresAt: new Date(r.expires_at).toISOString() } : null;
  }
  async challenge(interaction: string, session: Session): Promise<string> {
    const nonce = randomBytes(32).toString('base64url');
    const { rowCount } = await this.pool.query(`INSERT INTO mcp_consent_challenges(interaction_hash,nonce_hash,user_id,session_token_hash,expires_at)
      SELECT $1,$2,$3,$4,LEAST(expires_at,clock_timestamp()+interval '10 minutes') FROM sessions
      WHERE token_hash=$4 AND user_id=$3 AND csrf_token=$5 AND expires_at>clock_timestamp()
      ON CONFLICT(interaction_hash) DO UPDATE SET nonce_hash=EXCLUDED.nonce_hash,user_id=EXCLUDED.user_id,
        session_token_hash=EXCLUDED.session_token_hash,expires_at=EXCLUDED.expires_at WHERE mcp_consent_challenges.consumed_at IS NULL`,
    [digest(interaction), digest(nonce), session.user.id, session.tokenHash, session.csrfToken]);
    if (rowCount !== 1) throw mcpDenied(); return nonce;
  }
  async authorize(interaction: string, nonce: string, session: Session, grantId: string, clientId: string, resource: string): Promise<Authorization> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [active] } = await c.query(`SELECT expires_at FROM sessions WHERE token_hash=$1 AND user_id=$2 AND csrf_token=$3 AND expires_at>clock_timestamp() FOR SHARE`,
        [session.tokenHash, session.user.id, session.csrfToken]);
      if (!active) throw mcpDenied();
      await this.consumeChallenge(c, interaction, nonce, session);
      const id = randomUUID();
      await c.query(`INSERT INTO mcp_authorizations(id,grant_hash,user_id,approved_session_hash,client_id,resource,scopes,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,ARRAY['alms:read']::text[],$7)`, [id, digest(grantId), session.user.id, session.tokenHash, clientId, resource, active.expires_at]);
      await c.query('COMMIT');
      return { id, userId: session.user.id, sessionTokenHash: session.tokenHash, clientId, resource, scopes: ['alms:read'], expiresAt: new Date(active.expires_at).toISOString() };
    } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  }
  async deny(interaction: string, nonce: string, session: Session) {
    const { rowCount } = await this.pool.query(`UPDATE mcp_consent_challenges challenge SET consumed_at=clock_timestamp() FROM sessions s
      WHERE challenge.interaction_hash=$1 AND challenge.nonce_hash=$2 AND challenge.user_id=$3 AND challenge.session_token_hash=$4
        AND challenge.consumed_at IS NULL AND challenge.expires_at>clock_timestamp()
        AND s.token_hash=challenge.session_token_hash AND s.user_id=challenge.user_id AND s.csrf_token=$5 AND s.expires_at>clock_timestamp()`,
    [digest(interaction), digest(nonce), session.user.id, session.tokenHash, session.csrfToken]);
    if (rowCount !== 1) throw mcpDenied();
  }
  private async consumeChallenge(c: PoolClient, interaction: string, nonce: string, session: Session) {
    const { rowCount } = await c.query(`UPDATE mcp_consent_challenges SET consumed_at=clock_timestamp()
      WHERE interaction_hash=$1 AND nonce_hash=$2 AND user_id=$3 AND session_token_hash=$4
        AND consumed_at IS NULL AND expires_at>clock_timestamp()`, [digest(interaction), digest(nonce), session.user.id, session.tokenHash]);
    if (rowCount !== 1) throw mcpDenied();
  }
  async revoke(grantId: string) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE mcp_authorizations SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE grant_hash=$1', [digest(grantId)]);
      await c.query('DELETE FROM mcp_oauth_objects WHERE grant_hash=$1', [digest(grantId)]);
      await c.query('COMMIT');
    } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  }
  async cleanup() {
    await this.pool.query('DELETE FROM mcp_oauth_objects WHERE expires_at<=clock_timestamp()');
    await this.pool.query('DELETE FROM mcp_consent_challenges WHERE expires_at<=clock_timestamp()');
  }
}
