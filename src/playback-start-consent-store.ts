import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AppError, notFound } from './errors.js';
import { workerTransaction, type WorkerOperation, type WorkerQuery } from './worker-bounds.js';
import type { WorkerClaim } from './playback-authority.js';
import { playbackAccountLock, playbackAccountLockKey } from './playback-lock.js';
import {
  consentFailure,
  inspectConsentSchoolSession,
  startConsentInput,
  type ConsentAuthorization,
  type ConsentSchoolAuthorization,
  type PlaybackStartConsentInput,
  type PlaybackStartConsentReceipt,
  type PlaybackStartAttempt,
} from './playback-start-consent.js';
type Row = Record<string, any>;
const receipt = (r: Row): PlaybackStartConsentReceipt => ({
  id: r.id,
  expiresAt: new Date(r.expires_at).toISOString(),
  courseId: r.course_id,
  lectureIds: [...r.lecture_ids],
});
const changed = () => consentFailure('PLAYBACK_AUTHORITY_CHANGED');
export async function validateConsentSession(query: WorkerQuery, owner: string, auth: ConsentAuthorization) {
  const r = await query(
    `SELECT token_hash FROM sessions WHERE user_id=$1 AND token_hash=$2 AND csrf_token=$3
  AND client_id IS NOT DISTINCT FROM $4::text AND expires_at>clock_timestamp() FOR SHARE`,
    [owner, auth.almsTokenHash, auth.csrfToken, auth.clientId],
  );
  if (r.rowCount !== 1) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
}
function validConsent(r: Row | undefined, generation: string, clientId?: string | null): asserts r is Row {
  if (!r || r.generation !== generation || (clientId !== undefined && r.client_id !== clientId))
    throw consentFailure('PLAYBACK_START_CONSENT_INVALID');
  if (r.revoked === true) throw consentFailure('PLAYBACK_START_CONSENT_REVOKED');
  if (r.valid !== true) throw consentFailure('PLAYBACK_START_CONSENT_EXPIRED');
}
export async function bindPlaybackStartConsent(
  query: WorkerQuery,
  owner: string,
  jobId: string,
  target: { courseId: string; lectureId: string; scheduledFor: string },
  consentId: string,
  generation: string,
  auth: ConsentAuthorization,
) {
  await validateConsentSession(query, owner, auth);
  await query('SELECT id FROM playback_start_consents WHERE id=$1 AND user_id=$2 FOR SHARE', [consentId, owner]);
  const {
    rows: [r],
  } = await query<Row>(
    `SELECT c.*,c.expires_at>clock_timestamp() AS valid,$3::timestamptz<c.expires_at AS schedule_valid,
  EXISTS(SELECT 1 FROM playback_start_consent_revocations revoked WHERE revoked.consent_id=c.id) AS revoked
  FROM playback_start_consents c WHERE c.id=$1 AND c.user_id=$2 FOR SHARE OF c`,
    [consentId, owner, target.scheduledFor],
  );
  validConsent(r, generation, auth.clientId);
  if (r.schedule_valid !== true) throw consentFailure('PLAYBACK_START_CONSENT_SCHEDULE_INVALID');
  if (r.course_id !== target.courseId || !r.lecture_ids.includes(target.lectureId))
    throw consentFailure('PLAYBACK_START_CONSENT_INVALID');
  if (
    (
      await query('SELECT 1 FROM playback_job_start_consents WHERE consent_id=$1 AND course_id=$2 AND lecture_id=$3', [
        consentId,
        target.courseId,
        target.lectureId,
      ])
    ).rowCount
  )
    throw consentFailure('PLAYBACK_START_CONSENT_USED');
  const bound = await query(
    `INSERT INTO playback_job_start_consents(job_id,consent_id,course_id,lecture_id)
  SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM playback_start_consents c WHERE c.id=$2 AND c.user_id=$5
   AND c.expires_at>clock_timestamp() AND $6::timestamptz<c.expires_at AND NOT EXISTS(SELECT 1 FROM playback_start_consent_revocations r WHERE r.consent_id=c.id)) RETURNING job_id`,
    [jobId, consentId, target.courseId, target.lectureId, owner, target.scheduledFor],
  );
  if (bound.rowCount !== 1) throw consentFailure('PLAYBACK_START_CONSENT_EXPIRED');
}
export class PgPlaybackStartConsentRepository {
  constructor(private readonly pool: Pool) {}
  private transaction<T>(run: (query: WorkerQuery) => Promise<T>, operation: WorkerOperation) {
    return workerTransaction(this.pool, run, { ...operation, readCommitted: true });
  }
  async find(
    owner: string,
    requestKey: string,
    auth: ConsentAuthorization,
    operation: WorkerOperation,
    requestHash?: string,
  ) {
    return this.transaction(async (query) => {
      await validateConsentSession(query, owner, auth);
      const {
        rows: [r],
      } = await query<Row>('SELECT * FROM playback_start_consents WHERE user_id=$1 AND idempotency_key=$2', [
        owner,
        requestKey,
      ]);
      if (!r) return null;
      if (r.client_id !== auth.clientId) throw consentFailure('PLAYBACK_START_CONSENT_INVALID');
      if (requestHash !== undefined && r.request_hash !== requestHash)
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '같은 요청 키에 다른 동의 내용이 있습니다.');
      return receipt(r);
    }, operation);
  }
  async create(
    owner: string,
    input: PlaybackStartConsentInput,
    requestKey: string,
    requestHash: string,
    auth: ConsentSchoolAuthorization,
    operation: WorkerOperation,
  ) {
    input = startConsentInput.parse(input);
    return this.transaction(async (query) => {
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [owner + ':start-consent:' + requestKey]);
      await validateConsentSession(query, owner, auth);
      const {
        rows: [existing],
      } = await query<Row>('SELECT * FROM playback_start_consents WHERE user_id=$1 AND idempotency_key=$2', [
        owner,
        requestKey,
      ]);
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '같은 요청 키에 다른 동의 내용이 있습니다.');
        if (existing.client_id !== auth.clientId) throw consentFailure('PLAYBACK_START_CONSENT_INVALID');
        return receipt(existing);
      }
      if (
        !(
          await query(
            "SELECT user_id FROM school_sessions WHERE user_id=$1 AND provider='ssu' AND encrypted_state=$2 FOR SHARE",
            [owner, auth.encryptedSession],
          )
        ).rowCount
      )
        throw changed();
      const {
        rows: [created],
      } = await query<Row>(
        `WITH instant AS (SELECT clock_timestamp() AS t)
    INSERT INTO playback_start_consents(id,user_id,client_id,generation,course_id,lecture_ids,idempotency_key,request_hash,created_at,expires_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,t,date_trunc('milliseconds',t+interval '24 hours') FROM instant RETURNING *`,
        [
          randomUUID(),
          owner,
          auth.clientId,
          auth.generation,
          input.courseId,
          input.lectureIds,
          requestKey,
          requestHash,
        ],
      );
      await validateConsentSession(query, owner, auth);
      return receipt(created!);
    }, operation);
  }
  async revoke(owner: string, id: string, auth: ConsentAuthorization, operation: WorkerOperation) {
    await this.transaction(async (query) => {
      await validateConsentSession(query, owner, auth);
      const {
        rows: [r],
      } = await query<Row>('SELECT client_id FROM playback_start_consents WHERE user_id=$1 AND id=$2 FOR UPDATE', [
        owner,
        id,
      ]);
      if (!r) throw notFound();
      if (r.client_id !== auth.clientId) throw consentFailure('PLAYBACK_START_CONSENT_INVALID');
      await query('INSERT INTO playback_start_consent_revocations(consent_id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
      await validateConsentSession(query, owner, auth);
    }, operation);
  }
  private async inspect(query: WorkerQuery, claim: WorkerClaim, key: Buffer, lease: boolean) {
    const p = [
      claim.jobId,
      claim.userId,
      claim.courseId,
      claim.lectureId,
      claim.acceptedGeneration,
      claim.executionTokenHash,
    ];
    const {
      rows: [job],
    } = await query<Row>(
      `SELECT j.*,binding.consent_id FROM playback_jobs j LEFT JOIN playback_job_start_consents binding ON binding.job_id=j.id
   WHERE j.id=$1 AND j.user_id=$2 AND j.course_id=$3 AND j.lecture_id=$4 AND j.accepted_generation=$5 AND j.execution_token_hash=$6
    AND j.status='running' AND j.settled_at IS NULL FOR SHARE OF j`,
      p,
    );
    if (!job) throw changed();
    if (!job.consent_id) return null;
    // A SELECT that waited for an immutable row lock may retain an older statement
    // snapshot of the separate revocation table. Lock first, then read all facts fresh.
    await query('SELECT id FROM playback_start_consents WHERE id=$1 AND user_id=$2 FOR SHARE', [
      job.consent_id,
      claim.userId,
    ]);
    const {
      rows: [c],
    } = await query<Row>(
      `SELECT c.*,c.expires_at>clock_timestamp() AS valid,
   EXISTS(SELECT 1 FROM playback_start_consent_revocations r WHERE r.consent_id=c.id) AS revoked,
   a.id AS attempt_id,a.state AS attempt_state,a.execution_token_hash AS attempt_token,a.generation AS attempt_generation,
   c.expires_at>a.finished_at AS acknowledged_before_expiry,
   NOT EXISTS(SELECT 1 FROM playback_start_consent_revocations r WHERE r.consent_id=c.id
    AND r.revoked_at<=a.finished_at) AS acknowledged_before_revocation
   FROM playback_start_consents c LEFT JOIN playback_start_attempts a ON a.job_id=$3
   WHERE c.id=$1 AND c.user_id=$2 FOR SHARE OF c`,
      [job.consent_id, claim.userId, claim.jobId],
    );
    // One statement snapshot avoids treating an ACK committed between separate
    // consent/attempt reads as an expired unused permission.
    const attempt = c?.attempt_id
      ? {
          id: c.attempt_id,
          state: c.attempt_state,
          execution_token_hash: c.attempt_token,
          generation: c.attempt_generation,
        }
      : undefined;
    if (
      attempt &&
      (attempt.execution_token_hash !== claim.executionTokenHash ||
        attempt.generation !== claim.acceptedGeneration ||
        attempt.state === 'unknown')
    )
      throw consentFailure('PLAYBACK_START_ATTEMPT_EXISTS');
    // Consumed, acknowledged start permission does not expire or revoke ongoing ordinary playback.
    if (attempt?.state !== 'acknowledged') validConsent(c, claim.acceptedGeneration);
    else {
      if (c?.acknowledged_before_expiry !== true) throw consentFailure('PLAYBACK_START_CONSENT_EXPIRED');
      if (c?.acknowledged_before_revocation !== true) throw consentFailure('PLAYBACK_START_CONSENT_REVOKED');
    }
    if (
      !c ||
      c.generation !== claim.acceptedGeneration ||
      c.course_id !== claim.courseId ||
      !c.lecture_ids.includes(claim.lectureId)
    )
      throw changed();
    const {
      rows: [school],
    } = await query<Row>("SELECT encrypted_state FROM school_sessions WHERE user_id=$1 AND provider='ssu' FOR SHARE", [
      claim.userId,
    ]);
    if (
      inspectConsentSchoolSession(school?.encrypted_state ?? null, key, claim.userId).generation !==
      claim.acceptedGeneration
    )
      throw new AppError(409, 'SCHOOL_SESSION_CHANGED', '학교 인증이 변경됐습니다.');
    if (
      lease &&
      !(
        await query(
          `SELECT 1 FROM playback_execution_leases WHERE user_id=$1 AND generation=$2 AND course_id=$3 AND module_item_id=$4
   AND token_hash=$5 AND owner_kind='worker' AND expires_at>clock_timestamp() FOR SHARE`,
          [claim.userId, claim.acceptedGeneration, claim.courseId, claim.lectureId, claim.executionTokenHash],
        )
      ).rowCount
    )
      throw consentFailure('PLAYBACK_BUSY');
    return { consent: c, attempt };
  }
  async validate(claim: WorkerClaim, key: Buffer, operation: WorkerOperation) {
    await this.transaction(async (q) => {
      await this.inspect(q, claim, key, false);
    }, operation);
  }
  async reserve(claim: WorkerClaim, key: Buffer, operation: WorkerOperation): Promise<PlaybackStartAttempt | null> {
    try {
      return await this.transaction(async (query) => {
        await query(playbackAccountLock, [playbackAccountLockKey(claim.userId)]);
        const current = await this.inspect(query, claim, key, true);
        if (!current) return null;
        if (current.attempt) throw consentFailure('PLAYBACK_START_ATTEMPT_EXISTS');
        const attemptId = randomUUID();
        const inserted = await query(
          `INSERT INTO playback_start_attempts(id,job_id,user_id,generation,course_id,lecture_id,execution_token_hash)
    SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS(SELECT 1 FROM playback_start_consents c WHERE c.id=$8 AND c.expires_at>clock_timestamp()
     AND NOT EXISTS(SELECT 1 FROM playback_start_consent_revocations r WHERE r.consent_id=c.id)) RETURNING id`,
          [
            attemptId,
            claim.jobId,
            claim.userId,
            claim.acceptedGeneration,
            claim.courseId,
            claim.lectureId,
            claim.executionTokenHash,
            current.consent.id,
          ],
        );
        if (inserted.rowCount !== 1) throw consentFailure('PLAYBACK_START_CONSENT_EXPIRED');
        return {
          attemptId,
          consentId: current.consent.id,
          expiresAt: new Date(current.consent.expires_at).toISOString(),
        };
      }, operation);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw consentFailure('PLAYBACK_START_RESERVATION_UNCONFIRMED', 503);
    }
  }
  async recordTransportAck(claim: WorkerClaim, attemptId: string, operation: WorkerOperation) {
    await this.transaction(async (query) => {
      const args = [
        attemptId,
        claim.jobId,
        claim.userId,
        claim.acceptedGeneration,
        claim.courseId,
        claim.lectureId,
        claim.executionTokenHash,
      ];
      const {
        rows: [r],
      } = await query<Row>(
        `SELECT * FROM playback_start_attempts WHERE id=$1 AND job_id=$2 AND user_id=$3 AND generation=$4
    AND course_id=$5 AND lecture_id=$6 AND execution_token_hash=$7 FOR UPDATE`,
        args,
      );
      if (!r) throw changed();
      if (r.transport_ack_received_at) return;
      await query(
        'UPDATE playback_start_attempts SET transport_ack_received_at=clock_timestamp() WHERE id=$1 AND transport_ack_received_at IS NULL',
        [attemptId],
      );
    }, operation);
  }
  async finish(
    claim: WorkerClaim,
    attemptId: string,
    outcome: 'acknowledged' | 'unknown',
    key: Buffer,
    operation: WorkerOperation,
  ) {
    await this.transaction(async (query) => {
      await query(playbackAccountLock, [playbackAccountLockKey(claim.userId)]);
      // Finalizing records the exact reserved attempt's observed outcome, not fresh play permission.
      // Cancellation/revocation/expiry may race a real response and must not erase its ACK.
      const args = [
        attemptId,
        claim.jobId,
        claim.userId,
        claim.acceptedGeneration,
        claim.courseId,
        claim.lectureId,
        claim.executionTokenHash,
      ];
      const {
        rows: [r],
      } = await query<Row>(
        `SELECT * FROM playback_start_attempts WHERE id=$1 AND job_id=$2 AND user_id=$3 AND generation=$4
    AND course_id=$5 AND lecture_id=$6 AND execution_token_hash=$7 FOR UPDATE`,
        args,
      );
      if (!r) throw changed();
      if (r.state === 'unknown' && outcome === 'acknowledged') throw consentFailure('PLAYBACK_START_ATTEMPT_EXISTS');
      if (outcome === 'acknowledged' && !r.transport_ack_received_at)
        throw consentFailure('PLAYBACK_START_ACK_REQUIRED');
      if (r.state === outcome || (r.state === 'acknowledged' && outcome === 'unknown')) return;
      if (r.state !== 'reserved') throw consentFailure('PLAYBACK_START_ATTEMPT_EXISTS');
      await query(
        "UPDATE playback_start_attempts SET state=$2,finished_at=clock_timestamp() WHERE id=$1 AND state='reserved'",
        [attemptId, outcome],
      );
    }, operation);
  }
}
