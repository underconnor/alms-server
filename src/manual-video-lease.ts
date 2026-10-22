import type { Pool } from 'pg';
import { z } from 'zod';
import { workerTransaction } from './worker-bounds.js';
import { playbackAccountLock, playbackAccountLockKey } from './playback-lock.js';

export interface PlaybackLeaseScope {
  owner: string; generation: string; courseId: string; moduleItemId: string;
  tokenHash: string; kind: 'manual' | 'worker';
}
export interface PlaybackLeaseRepository {
  acquire(scope: PlaybackLeaseScope, authorization: { encryptedSession: string; almsTokenHash?: string }, signal: AbortSignal): Promise<boolean>;
  renew(scope: PlaybackLeaseScope, signal: AbortSignal): Promise<boolean>;
  release(scope: PlaybackLeaseScope, signal: AbortSignal): Promise<void>;
}
const identifier = z.string().regex(/^[1-9]\d{0,15}$/);
const scopeSchema = z.object({ owner: z.uuid(), generation: z.uuid(), courseId: identifier, moduleItemId: identifier,
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/), kind: z.enum(['manual', 'worker']) }).strict();
const values = (scope: PlaybackLeaseScope) => {
  const s = scopeSchema.parse(scope);
  return [s.owner, s.generation, s.courseId, s.moduleItemId, s.tokenHash, s.kind];
};
/** A common short lease for API and future worker executions. No school request occurs in a DB transaction.
 * A new login cannot displace an unexpired lease: its prior school write may still be uncertain. */
export class PgPlaybackLeaseRepository implements PlaybackLeaseRepository {
  constructor(private readonly pool: Pool) {}
  acquire(scope: PlaybackLeaseScope, authorization: { encryptedSession: string; almsTokenHash?: string }, signal: AbortSignal) {
    const params = values(scope);
    if (!authorization.encryptedSession || scope.kind === 'manual' && !/^[a-f0-9]{64}$/.test(authorization.almsTokenHash ?? ''))
      return Promise.resolve(false);
    return workerTransaction(this.pool, async query => {
      await query(playbackAccountLock, [playbackAccountLockKey(scope.owner)]);
      const result = await query(`INSERT INTO playback_execution_leases
        (user_id,generation,course_id,module_item_id,token_hash,owner_kind,expires_at)
        SELECT $1,$2,$3,$4,$5,$6,clock_timestamp()+interval '120 seconds'
        WHERE EXISTS(SELECT 1 FROM school_sessions WHERE user_id=$1 AND provider='ssu' AND encrypted_state=$7)
          AND ($6='worker' OR EXISTS(SELECT 1 FROM sessions WHERE user_id=$1 AND token_hash=$8 AND expires_at>clock_timestamp()))
          AND ($6='worker' OR NOT EXISTS(SELECT 1 FROM playback_jobs WHERE user_id=$1 AND status IN ('running','pause_requested','cancel_requested','reconciling')))
          AND ($6='manual' OR EXISTS(SELECT 1 FROM playback_jobs WHERE user_id=$1 AND course_id=$3 AND lecture_id=$4
            AND accepted_generation=$2 AND execution_token_hash=$5 AND settled_at IS NULL
            AND status IN ('running','reconciling','cancel_requested')))
        ON CONFLICT(user_id) DO UPDATE SET generation=excluded.generation,course_id=excluded.course_id,
          module_item_id=excluded.module_item_id,token_hash=excluded.token_hash,owner_kind=excluded.owner_kind,
          expires_at=excluded.expires_at,updated_at=clock_timestamp()
        WHERE playback_execution_leases.expires_at<=clock_timestamp()
        RETURNING user_id`, [...params, authorization.encryptedSession, authorization.almsTokenHash ?? null]);
      return result.rowCount === 1;
    }, { signal, timeoutMs: 5_000 });
  }
  renew(scope: PlaybackLeaseScope, signal: AbortSignal) {
    return workerTransaction(this.pool, async query => {
      await query(playbackAccountLock, [playbackAccountLockKey(scope.owner)]);
      const result = await query(`UPDATE playback_execution_leases SET expires_at=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp()
        WHERE user_id=$1 AND generation=$2 AND course_id=$3 AND module_item_id=$4 AND token_hash=$5 AND owner_kind=$6
          AND expires_at>clock_timestamp()
          AND ($6='manual' OR EXISTS(SELECT 1 FROM playback_jobs WHERE user_id=$1 AND course_id=$3 AND lecture_id=$4
            AND accepted_generation=$2 AND execution_token_hash=$5 AND settled_at IS NULL
            AND status IN ('running','reconciling','cancel_requested'))) RETURNING user_id`, values(scope));
      return result.rowCount === 1;
    }, { signal, timeoutMs: 5_000 });
  }
  async release(scope: PlaybackLeaseScope, signal: AbortSignal) {
    await workerTransaction(this.pool, async query => {
      await query('DELETE FROM playback_execution_leases WHERE user_id=$1 AND generation=$2 AND course_id=$3 AND module_item_id=$4 AND token_hash=$5 AND owner_kind=$6', values(scope));
    }, { signal, timeoutMs: 5_000 });
  }
}
