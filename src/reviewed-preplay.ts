import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError, notFound } from './errors.js';
import type { Job, SchoolResult } from './domain.js';
import { inspectPlaybackAdmission, type PlaybackAdmission } from './playback-authority.js';
import { publicVerifiedSchoolResult } from './job-verification.js';
import { playbackAccountLock, playbackAccountLockKey } from './playback-lock.js';
import { playbackQueueLock } from './playback-queue-policy.js';
import { bindPlaybackStartConsent, validateConsentSession } from './playback-start-consent-store.js';
import type { ConsentAuthorization } from './playback-start-consent.js';
import { workerTransaction, type WorkerOperation, type WorkerQuery } from './worker-bounds.js';

type Row = Record<string, any>;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewedPreplaySource = Object.freeze({
  commit: '5a34c091011498757d6ecd2a7da8b5d7761db3a1',
  archiveSha256: '66658249a904dde001ab892cac1ba9d3e8c49f60aa2131972ac6cc955d4d9839',
  manifestSha256: '30f574888fbbf2a97d5be5a102bff1d420ba5dc352bf4531c72bd8826bd3b48e',
  workerImageSha256: '61a6db4b70a3d36da3d8c0537d59114a8b8195f67baeecd4317b692464b38449',
});
export const reviewedPreplayPermitInput = z.object({
  parentId: z.uuid(), expectedVersion: z.iso.datetime({ offset: true }), originalFingerprint: sha256,
  evidenceSha256: sha256, expiresAt: z.iso.datetime({ offset: true }),
  source: z.object({
    commit: z.literal(reviewedPreplaySource.commit), archiveSha256: z.literal(reviewedPreplaySource.archiveSha256),
    manifestSha256: z.literal(reviewedPreplaySource.manifestSha256), workerImageSha256: z.literal(reviewedPreplaySource.workerImageSha256),
  }).strict(),
}).strict();
export type ReviewedPreplayPermitInput = z.infer<typeof reviewedPreplayPermitInput>;
export type ReviewedPreplayRetryInput = { expectedVersion: string; startConsentId: string; idempotencyKey: string; requestHash: string };
export type ReviewedPreplayAuthorization = ConsentAuthorization & { admission: PlaybackAdmission; schoolResult: SchoolResult };
export type ReviewedPreplayRetryResult = { originalJob: Job; job: Job; retried: true };
export type ReviewedPreplayEligibility = { eligible: boolean; version: string; retriedAsJobId: string | null };
const fail = (code = 'PLAYBACK_REVIEWED_PREPLAY_INELIGIBLE') => new AppError(409, code, '검토된 미시작 요청과 새 수강 권한을 다시 확인해 주세요.');
const version = `to_char(job.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const parentSelect = `SELECT job.*,${version} AS original_version,
  reviewed_preplay_job_fingerprint(job) AS original_fingerprint,
  validate_reviewed_preplay_parent(job) AS eligible FROM playback_jobs job WHERE job.user_id=$1 AND job.id=$2`;

export class PgReviewedPreplayRepository {
  constructor(private readonly pool: Pool, private readonly readJob: (query: WorkerQuery, owner: string, id: string) => Promise<Job | null>) {}
  private transaction<T>(run: (query: WorkerQuery) => Promise<T>, operation: WorkerOperation) {
    return workerTransaction(this.pool, run, { ...operation, readCommitted: true });
  }
  /** Trusted, private operator boundary. Never exposed through Store/HTTP/MCP or inferred from a status. */
  async registerPermit(input: ReviewedPreplayPermitInput, operation: WorkerOperation = { timeoutMs: 5000 }): Promise<{ id: string; parentId: string; expiresAt: string }> {
    const value = reviewedPreplayPermitInput.parse(input);
    return this.transaction(async query => {
      const scope = await query<Row>('SELECT user_id FROM playback_jobs WHERE id=$1', [value.parentId]);
      if (!scope.rows[0]) throw notFound();
      await query(playbackAccountLock, [playbackAccountLockKey(scope.rows[0].user_id)]);
      const { rows: [old] } = await query<Row>(parentSelect + ' FOR UPDATE OF job', [scope.rows[0].user_id, value.parentId]);
      if (!old || old.eligible !== true) throw fail();
      if (old.original_version !== value.expectedVersion || old.original_fingerprint !== value.originalFingerprint) throw fail('JOB_CHANGED');
      const existing = await query<Row>('SELECT * FROM playback_preplay_review_permits WHERE parent_job_id=$1 AND expires_at>clock_timestamp() ORDER BY created_at DESC,id DESC LIMIT 1', [value.parentId]);
      if (existing.rows[0]) {
        const p = existing.rows[0];
        if (p.original_fingerprint !== value.originalFingerprint || p.evidence_sha256 !== value.evidenceSha256
          || new Date(p.expires_at).toISOString() !== new Date(value.expiresAt).toISOString()) throw fail();
        return { id: p.id, parentId: value.parentId, expiresAt: new Date(p.expires_at).toISOString() };
      }
      const result = await query<Row>(`INSERT INTO playback_preplay_review_permits
        (id,parent_job_id,user_id,course_id,lecture_id,accepted_generation,original_version,original_fingerprint,
          source_commit,source_archive_sha256,source_manifest_sha256,worker_image_sha256,evidence_sha256,expires_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
        WHERE $14::timestamptz>clock_timestamp() AND $14::timestamptz<=clock_timestamp()+interval '24 hours' RETURNING id,expires_at`,
        [randomUUID(), value.parentId, old.user_id, old.course_id, old.lecture_id, old.accepted_generation,
          value.expectedVersion, value.originalFingerprint, value.source.commit, value.source.archiveSha256,
          value.source.manifestSha256, value.source.workerImageSha256, value.evidenceSha256, value.expiresAt]);
      if (!result.rows[0]) throw fail();
      return { id: result.rows[0].id, parentId: value.parentId, expiresAt: new Date(result.rows[0].expires_at).toISOString() };
    }, operation);
  }
  async eligibility(owner: string, parentId: string, auth: ConsentAuthorization, operation: WorkerOperation = { timeoutMs: 5000 }): Promise<ReviewedPreplayEligibility | null> {
    return this.transaction(async query => {
      await validateConsentSession(query, owner, auth);
      const { rows: [row] } = await query<Row>(`SELECT ${version} AS version,release.child_job_id,
        CASE WHEN permit.id IS NOT NULL AND release.id IS NULL AND permit.expires_at>clock_timestamp()
          THEN validate_reviewed_preplay_parent(job) AND permit.original_version=job.updated_at
            AND permit.original_fingerprint=reviewed_preplay_job_fingerprint(job)
          ELSE false END AS eligible
        FROM playback_jobs job LEFT JOIN LATERAL (SELECT p.* FROM playback_preplay_review_permits p
          WHERE p.parent_job_id=job.id ORDER BY p.created_at DESC,p.id DESC LIMIT 1) permit ON true
        LEFT JOIN playback_preplay_releases release ON release.id=job.reviewed_preplay_release_id
        WHERE job.user_id=$1 AND job.id=$2`, [owner, parentId]);
      await validateConsentSession(query, owner, auth);
      return row ? { eligible: row.eligible === true, version: row.version, retriedAsJobId: row.child_job_id ?? null } : null;
    }, operation);
  }
  private async result(query: WorkerQuery, owner: string, parentId: string, key: string, auth: ConsentAuthorization, requestHash?: string): Promise<ReviewedPreplayRetryResult | null> {
    const { rows: [existing] } = await query<Row>('SELECT id,request_hash FROM playback_jobs WHERE user_id=$1 AND idempotency_key=$2', [owner, key]);
    if (!existing) return null;
    if (requestHash !== undefined && existing.request_hash !== requestHash) throw fail('IDEMPOTENCY_CONFLICT');
    const { rows: [relation] } = await query<Row>(`SELECT child_job_id,client_id FROM playback_preplay_releases
      WHERE user_id=$1 AND parent_job_id=$2 AND request_key=$3 AND child_job_id=$4`, [owner, parentId, key, existing.id]);
    if (!relation) throw fail('IDEMPOTENCY_CONFLICT');
    if (relation.client_id !== auth.clientId) throw fail('PLAYBACK_START_CONSENT_INVALID');
    const originalJob = await this.readJob(query, owner, parentId), job = await this.readJob(query, owner, relation.child_job_id);
    if (!originalJob || !job) throw fail();
    return { originalJob, job, retried: true };
  }
  async find(owner: string, parentId: string, key: string, auth: ConsentAuthorization, operation: WorkerOperation = { timeoutMs: 5000 }, requestHash?: string) {
    return this.transaction(async query => {
      await validateConsentSession(query, owner, auth);
      const result = await this.result(query, owner, parentId, key, auth, requestHash);
      await validateConsentSession(query, owner, auth);
      return result;
    }, operation);
  }
  async retry(owner: string, parentId: string, input: ReviewedPreplayRetryInput, auth: ReviewedPreplayAuthorization,
    operation: WorkerOperation = { timeoutMs: 5000 }): Promise<ReviewedPreplayRetryResult> {
    z.object({ expectedVersion: z.iso.datetime({ offset: true }), startConsentId: z.uuid(), idempotencyKey: z.uuid(), requestHash: sha256 }).strict().parse(input);
    try {
      return await this.transaction(async query => {
        await query(playbackQueueLock);
        await query(playbackAccountLock, [playbackAccountLockKey(owner)]);
        await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [owner + ':' + input.idempotencyKey]);
        await validateConsentSession(query, owner, auth);
        const existing = await this.result(query, owner, parentId, input.idempotencyKey, auth, input.requestHash);
        if (existing) { await validateConsentSession(query, owner, auth); return existing; }
        const { rows: [old] } = await query<Row>(parentSelect + ' FOR UPDATE OF job', [owner, parentId]);
        if (!old) throw notFound();
        if (old.reviewed_preplay_release_id) throw fail('PLAYBACK_REVIEWED_PREPLAY_ALREADY_RETRIED');
        if (old.original_version !== input.expectedVersion) throw fail('JOB_CHANGED');
        const { rows: [permit] } = await query<Row>(`SELECT *,expires_at>clock_timestamp() AS valid
          FROM playback_preplay_review_permits WHERE parent_job_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE`, [parentId]);
        if (old.eligible !== true || !permit || permit.valid !== true || permit.original_fingerprint !== old.original_fingerprint
          || new Date(permit.original_version).getTime() !== new Date(old.updated_at).getTime()) throw fail();
        const schoolResult = publicVerifiedSchoolResult(auth.schoolResult);
        if (schoolResult.evidence?.completed !== false) throw fail('PLAYBACK_REVIEWED_PREPLAY_STATUS_UNKNOWN');
        const proof = inspectPlaybackAdmission(auth.admission, { userId: owner, courseId: old.course_id, lectureId: old.lecture_id });
        if (proof.generation === old.accepted_generation) throw fail('PLAYBACK_REAUTHENTICATION_REQUIRED');
        const school = await query("SELECT user_id FROM school_sessions WHERE user_id=$1 AND provider='ssu' AND encrypted_state=$2 FOR SHARE", [owner, proof.encryptedSession]);
        if (!school.rowCount) throw fail('PLAYBACK_AUTHORITY_CHANGED');
        const staleClaim = await query(`SELECT 1 FROM playback_jobs active WHERE active.user_id=$1
          AND (active.execution_token_hash IS NOT NULL OR active.status IN ('running','reconciling','pause_requested','cancel_requested'))
          AND NOT (active.accepted_generation=$2 AND active.execution_token_hash IS NOT NULL
            AND active.status IN ('running','reconciling') AND active.heartbeat_at>clock_timestamp()-interval '90 seconds')`, [owner,proof.generation]);
        if (staleClaim.rowCount) throw fail('PLAYBACK_BUSY');
        // A proven current-generation worker may run ahead of this fresh request in the FIFO.
        const busy = await query(`SELECT 1 FROM playback_execution_leases lease WHERE lease.user_id=$1 AND lease.expires_at>clock_timestamp()
          AND NOT (lease.owner_kind='worker' AND lease.generation=$2 AND EXISTS(
            SELECT 1 FROM playback_jobs active WHERE active.user_id=lease.user_id AND active.course_id=lease.course_id
              AND active.lecture_id=lease.module_item_id AND active.accepted_generation=lease.generation
              AND active.execution_token_hash=lease.token_hash AND active.status IN ('running','reconciling')
              AND active.heartbeat_at>clock_timestamp()-interval '90 seconds'))`, [owner, proof.generation]);
        if (busy.rowCount) throw fail('PLAYBACK_BUSY');
        const childId = randomUUID(), releaseId = randomUUID();
        const scheduledFor = new Date(Math.max(Date.now(), new Date(old.scheduled_for).getTime())).toISOString();
        const status = Date.parse(scheduledFor) > Date.now() + 1000 ? 'scheduled' : 'queued';
        await query(`INSERT INTO playback_preplay_releases
          (id,parent_job_id,child_job_id,permit_id,user_id,course_id,lecture_id,previous_generation,current_generation,client_id,start_consent_id,request_key,request_hash)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [releaseId,parentId,childId,permit.id,owner,old.course_id,old.lecture_id,old.accepted_generation,proof.generation,auth.clientId,input.startConsentId,input.idempotencyKey,input.requestHash]);
        const marked = await query(`UPDATE playback_jobs SET reviewed_preplay_release_id=$3 WHERE user_id=$1 AND id=$2
          AND reviewed_preplay_release_id IS NULL AND updated_at=$4::timestamptz
          AND reviewed_preplay_job_fingerprint(playback_jobs)=$5 RETURNING id`, [owner,parentId,releaseId,input.expectedVersion,permit.original_fingerprint]);
        if (marked.rowCount !== 1) throw fail('JOB_CHANGED');
        const created = await query(`INSERT INTO playback_jobs(id,user_id,course_id,lecture_id,status,scheduled_for,idempotency_key,request_hash,accepted_generation,created_at)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp() WHERE clock_timestamp()<to_timestamp($10::double precision/1000) RETURNING id`,
          [childId,owner,old.course_id,old.lecture_id,status,scheduledFor,input.idempotencyKey,input.requestHash,proof.generation,proof.expiresAt]);
        if (created.rowCount !== 1) throw fail('PLAYBACK_AUTHORITY_CHANGED');
        await bindPlaybackStartConsent(query,owner,childId,{courseId:old.course_id,lectureId:old.lecture_id,scheduledFor},input.startConsentId,proof.generation,auth);
        await query('INSERT INTO job_outbox(job_id) VALUES($1)', [childId]);
        await query('INSERT INTO playback_queue_metadata(job_id,duration_seconds,dispatch_id) VALUES($1,$2,$3)', [childId,proof.durationSeconds,randomUUID()]);
        const result = await this.result(query,owner,parentId,input.idempotencyKey,auth,input.requestHash);
        if (!result) throw fail();
        await validateConsentSession(query,owner,auth);
        const valid = await query(`SELECT clock_timestamp()<to_timestamp($1::double precision/1000)
          AND EXISTS(SELECT 1 FROM playback_preplay_review_permits WHERE id=$2 AND expires_at>clock_timestamp())
          AND EXISTS(SELECT 1 FROM playback_start_consents c WHERE id=$3 AND expires_at>clock_timestamp()
            AND NOT EXISTS(SELECT 1 FROM playback_start_consent_revocations r WHERE r.consent_id=c.id)) AS valid`, [proof.expiresAt,permit.id,input.startConsentId]);
        if (valid.rows[0]?.valid !== true) throw fail('PLAYBACK_AUTHORITY_CHANGED');
        return result;
      }, operation);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw fail('JOB_ALREADY_ACTIVE');
      throw error;
    }
  }
}
