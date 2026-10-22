import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { AppError, notFound } from './errors.js';
import { canTransition, type Job, type JobStatus, type ExecutionOutcome, type SchoolResult, type Session, type Todo, type User, type PersonalCompletion } from './domain.js';
import { PgAnalyticsStore, type AnalyticsRepository } from './analytics-store.js';
import { inspectPlaybackAdmission, inspectPlaybackFinalProof, type PlaybackAdmission, type PlaybackFinalProof, type WorkerClaim } from './playback-authority.js';
import { workerTransaction, type WorkerOperation, type WorkerQuery } from './worker-bounds.js';
import { loginAttemptTtlSeconds } from './auth-policy.js';
import { inspectPlaybackTerminationProof, type PlaybackTerminationProof } from './playback-termination.js';
import { playbackAccountLock, playbackAccountLockKey } from './playback-lock.js';
import { publicVerifiedSchoolResult } from './job-verification.js';
import type { LoginClientContext } from './frontend-clients.js';

const iso = (value: Date | string): string => new Date(value).toISOString();
type Row = Record<string, any>;
const userFrom = (r: Row): User => ({ id: r.user_id ?? r.id, displayName: r.display_name, analyticsId: r.analytics_id, analyticsEnabled: r.analytics_enabled });
const todoFrom = (r: Row): Todo => ({ id: r.id, title: r.title, completed: r.completed, dueAt: r.due_at ? iso(r.due_at) : null, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });
const completionFrom = (r: Row): PersonalCompletion => ({ courseId: r.course_id, activityId: r.activity_id, completed: r.completed, updatedAt: iso(r.updated_at) });
const jobFrom = (r: Row): Job => ({ id: r.id, userId: r.user_id, courseId: r.course_id, lectureId: r.lecture_id, status: r.status, scheduledFor: iso(r.scheduled_for), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), schoolResult: r.school_result, errorCode: r.error_code, idempotencyKey: r.idempotency_key, requestHash: r.request_hash, acceptedGeneration: r.accepted_generation ?? null, executionTokenHash: r.execution_token_hash ?? null, executionOutcome: r.execution_outcome ?? null,
  lastExecutionTokenHash: r.last_execution_token_hash ?? null, settledAt: r.settled_at ? iso(r.settled_at) : null,
  ...(r.recovery_reason ? { settlement: r.settlement_result ? { settledAt: iso(r.settled_at), schoolResult: r.settlement_result } : null,
    recovery: { eligible: r.recovery_reason === 'eligible', reason: r.recovery_reason, version: r.recovery_version ?? iso(r.updated_at) } } : {}) });
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');

export interface NewJobInput { courseId: string; lectureId: string; scheduledFor: string; idempotencyKey: string; requestHash: string }
export interface JobAdmissionAuthorization { admission: PlaybackAdmission; almsTokenHash: string }
export interface JobTransitionOptions { outcome?: ExecutionOutcome | null; authority?: PlaybackFinalProof; terminationProof?: PlaybackTerminationProof }
export interface JobSettlementAuthorization { admission: PlaybackAdmission; tokenHash: string; csrfToken: string; schoolResult: SchoolResult }
export interface CompletionAuthorization { tokenHash: string; csrfToken: string }
export interface AuthenticatedSchoolSessionSnapshot { almsSessionValid: boolean; encryptedSchoolSession: string | null }
export interface FrontendAuthCodeInput { codeHash: string; clientId: string; redirectUri: string; codeChallenge: string; sessionTokenHash: string; encryptedToken: string }
const claimValues = (claim: WorkerClaim) => [claim.jobId, claim.userId, claim.courseId, claim.lectureId, claim.acceptedGeneration, claim.executionTokenHash];
const claimWhere = 'id=$1 AND user_id=$2 AND course_id=$3 AND lecture_id=$4 AND accepted_generation=$5 AND execution_token_hash=$6';
const authorityChanged = () => new AppError(409, 'PLAYBACK_AUTHORITY_CHANGED', '학교 인증이나 작업 상태가 바뀌었습니다. 다시 확인해 주세요.');
const jobRecoverySelect = `SELECT job.*, settlement.school_result AS settlement_result,
  to_char(job.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recovery_version,
  CASE WHEN job.settled_at IS NOT NULL THEN 'already_settled'
    WHEN job.status<>'needs_verification' OR job.execution_outcome IS DISTINCT FROM 'interrupted' THEN 'not_interrupted'
    WHEN job.execution_token_hash IS NOT NULL OR EXISTS(SELECT 1 FROM playback_jobs active WHERE active.user_id=job.user_id
      AND (active.execution_token_hash IS NOT NULL OR active.status IN ('running','reconciling','pause_requested','cancel_requested'))) THEN 'execution_active'
    WHEN NOT EXISTS(SELECT 1 FROM playback_execution_terminations termination WHERE termination.job_id=job.id
      AND termination.execution_token_hash=job.last_execution_token_hash AND termination.user_id=job.user_id
      AND termination.course_id=job.course_id AND termination.lecture_id=job.lecture_id
      AND termination.accepted_generation=job.accepted_generation) THEN 'termination_unconfirmed'
    WHEN EXISTS(SELECT 1 FROM playback_execution_leases lease WHERE lease.user_id=job.user_id
      AND lease.expires_at>clock_timestamp()) THEN 'lease_active'
    ELSE 'eligible' END AS recovery_reason
  FROM playback_jobs job LEFT JOIN playback_job_settlements settlement ON settlement.job_id=job.id`;

export interface Store {
  analytics: AnalyticsRepository;
  health(): Promise<void>;
  getSession(tokenHash: string): Promise<Session | null>;
  getAuthenticatedSchoolSession(userId: string, provider: string, tokenHash: string): Promise<AuthenticatedSchoolSessionSnapshot>;
  createLoginAttempt(stateHash: string,bindingHash: string,context?: LoginClientContext): Promise<void>;
  getLoginClientContext?(stateHash: string): Promise<LoginClientContext | null>;
  consumeLoginAttempt(stateHash: string,bindingHash: string): Promise<boolean>;
  createFrontendAuthCode(input: FrontendAuthCodeInput): Promise<void>;
  consumeFrontendAuthCode(codeHash: string,clientId: string,redirectUri: string,codeChallenge: string): Promise<{encryptedToken: string; sessionTokenHash: string} | null>;
  cleanupFrontendAuthCodes?(): Promise<void>;
  issueVerifiedSession(identity: {provider: string; subject: string; displayName?: string},ttlSeconds: number,schoolState?: {provider: string; seal: (userId: string) => string},clientId?: string): Promise<{token: string; csrfToken: string; expiresAt: string; user: User}>;
  deleteSession(tokenHash: string): Promise<void>;
  listCompletions(userId: string, courseId: string): Promise<PersonalCompletion[]>;
  listCompletionsForCourses(userId: string, courseIds: readonly string[]): Promise<PersonalCompletion[]>;
  setCompletion(userId: string, courseId: string, activityId: string, completed: boolean, authorization: CompletionAuthorization): Promise<PersonalCompletion>;
  deleteCompletion(userId: string, courseId: string, activityId: string, authorization: CompletionAuthorization): Promise<void>;
  listTodos(userId: string, limit?: number): Promise<Todo[]>;
  createTodo(userId: string, input: { title: string; dueAt?: string | null }): Promise<Todo>;
  updateTodo(userId: string, id: string, input: { title?: string; completed?: boolean; dueAt?: string | null }): Promise<Todo>;
  deleteTodo(userId: string, id: string): Promise<void>;
  listJobs(userId: string,courseId?: string,limit?: number): Promise<Job[]>;
  getJob(userId: string, id: string): Promise<Job | null>;
  findJobRequest(userId: string, idempotencyKey: string, requestHash: string, operation?: WorkerOperation): Promise<Job | null>;
  createJob(userId: string, input: NewJobInput, authorization: JobAdmissionAuthorization, operation?: WorkerOperation): Promise<Job>;
  cancelJob(userId: string, id: string): Promise<Job>;
  settleJob?(userId: string, id: string, expectedUpdatedAt: string, authorization: JobSettlementAuthorization, operation?: WorkerOperation): Promise<Job>;
  claimJob(id: string, operation?: WorkerOperation): Promise<Job | null>;
  getWorkerJob(claim: WorkerClaim, operation?: WorkerOperation): Promise<Job | null>;
  transitionJob(claim: WorkerClaim, from: JobStatus[], to: JobStatus, result?: SchoolResult | null, error?: string | null, options?: JobTransitionOptions, operation?: WorkerOperation): Promise<Job | null>;
  heartbeat(claim: WorkerClaim, operation?: WorkerOperation): Promise<boolean>;
  recoverStaleJobs(operation?: WorkerOperation): Promise<number>;
  quarantineLegacyJobs(operation?: WorkerOperation): Promise<number>;
}

export class PgStore implements Store {
  readonly analytics: PgAnalyticsStore;
  constructor(public pool: Pool) { this.analytics = new PgAnalyticsStore(pool); }
  async query<T extends QueryResultRow = Row>(sql: string, params: unknown[] = []) { return this.pool.query<T>(sql, params); }
  async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const result = await run(c); await c.query('COMMIT'); return result; }
    catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
  async health() {
    const result = await this.query("SELECT 1 FROM schema_migrations WHERE name IN ('011-playback-job-settlement.sql','012-frontend-clients.sql','013-analytics-frontend-client.sql','014-assignment-operation-recovery.sql')");
    if (result.rowCount !== 4) throw new Error('Database migrations are pending');
  }
  async getSession(tokenHash: string): Promise<Session | null> {
    const { rows: [r] } = await this.query(`SELECT s.*,u.display_name,u.analytics_id,u.analytics_enabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=$1 AND expires_at>now()`, [tokenHash]);
    return r ? { tokenHash: r.token_hash, csrfToken: r.csrf_token, analyticsSessionId: r.analytics_session_id, expiresAt: iso(r.expires_at), user: userFrom(r), clientId: r.client_id ?? null } : null;
  }
  // Internal adapter boundary only. No HTTP route accepts these identity fields from a caller.
  async createLoginAttempt(stateHash: string,bindingHash: string,context?: LoginClientContext) {
    await this.query("INSERT INTO login_attempts(state_hash,binding_hash,expires_at,client_context) VALUES($1,$2,now()+($3::int*interval '1 second'),$4)",[stateHash,bindingHash,loginAttemptTtlSeconds,context ?? null]);
  }
  async getLoginClientContext(stateHash: string): Promise<LoginClientContext | null> {
    const { rows: [row] } = await this.query('SELECT client_context FROM login_attempts WHERE state_hash=$1', [stateHash]);
    return row?.client_context ?? null;
  }
  async createFrontendAuthCode(input: FrontendAuthCodeInput) {
    await this.query(`INSERT INTO frontend_auth_codes(code_hash,client_id,redirect_uri,code_challenge,session_token_hash,encrypted_token,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '60 seconds')`,
    [input.codeHash,input.clientId,input.redirectUri,input.codeChallenge,input.sessionTokenHash,input.encryptedToken]);
  }
  async consumeFrontendAuthCode(codeHash: string,clientId: string,redirectUri: string,codeChallenge: string) {
    const { rows: [row] } = await this.query(`WITH code_grant AS MATERIALIZED (
      SELECT code_hash,expires_at,encrypted_token FROM frontend_auth_codes
      WHERE code_hash=$1 AND client_id=$2 AND redirect_uri=$3 AND code_challenge=$4 AND consumed_at IS NULL FOR UPDATE
    ) UPDATE frontend_auth_codes AS target SET consumed_at=clock_timestamp(),encrypted_token='' FROM code_grant
      WHERE target.code_hash=code_grant.code_hash AND code_grant.expires_at>clock_timestamp()
      RETURNING code_grant.encrypted_token,target.session_token_hash`, [codeHash,clientId,redirectUri,codeChallenge]);
    return row ? { encryptedToken: row.encrypted_token as string, sessionTokenHash: row.session_token_hash as string } : null;
  }
  async cleanupFrontendAuthCodes() {
    await this.query('DELETE FROM frontend_auth_codes WHERE expires_at<=clock_timestamp() OR consumed_at IS NOT NULL');
  }
  async consumeLoginAttempt(stateHash: string,bindingHash: string) {
    // Lock the exact unused binding first. An unchanged tuple can otherwise keep
    // a pre-lock expiry predicate true after its deadline has passed.
    const { rowCount } = await this.query(`WITH attempt AS MATERIALIZED (
      SELECT state_hash,expires_at FROM login_attempts
      WHERE state_hash=$1 AND binding_hash=$2 AND consumed_at IS NULL FOR UPDATE
    ) UPDATE login_attempts AS target SET consumed_at=clock_timestamp() FROM attempt
      WHERE target.state_hash=attempt.state_hash AND attempt.expires_at>clock_timestamp()`,[stateHash,bindingHash]);
    return Boolean(rowCount);
  }
  async getEncryptedSchoolSession(userId: string,provider: string): Promise<string | null> {
    const { rows: [r] } = await this.query('SELECT encrypted_state FROM school_sessions WHERE user_id=$1 AND provider=$2',[userId,provider]);
    return r?.encrypted_state ?? null;
  }
  async getAuthenticatedSchoolSession(userId: string, provider: string, tokenHash: string): Promise<AuthenticatedSchoolSessionSnapshot> {
    // One statement gives the ALMS authority and school seal the same PostgreSQL snapshot.
    const { rows: [r] } = await this.query(`SELECT
      EXISTS(SELECT 1 FROM sessions WHERE user_id=$1 AND token_hash=$3 AND expires_at>clock_timestamp()) AS alms_session_valid,
      (SELECT encrypted_state FROM school_sessions WHERE user_id=$1 AND provider=$2) AS encrypted_school_session`, [userId, provider, tokenHash]);
    return { almsSessionValid: r?.alms_session_valid === true, encryptedSchoolSession: r?.encrypted_school_session ?? null };
  }
  async replaceEncryptedSchoolSession(userId: string, provider: string, previous: string, next: string): Promise<boolean> {
    const { rowCount } = await this.query('UPDATE school_sessions SET encrypted_state=$4,updated_at=now() WHERE user_id=$1 AND provider=$2 AND encrypted_state=$3', [userId,provider,previous,next]);
    return Boolean(rowCount);
  }
  async issueVerifiedSession(identity: { provider: string; subject: string; displayName?: string }, ttlSeconds: number,schoolState?: { provider: string; seal: (userId: string) => string },clientId?: string) {
    return this.transaction(async c => {
      const { rows: [u] } = await c.query(`INSERT INTO users(id,identity_provider,identity_subject,display_name,analytics_id) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(identity_provider,identity_subject) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING *`, [randomUUID(),identity.provider,identity.subject,identity.displayName ?? null,randomUUID()]);
      const token = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
      await c.query('INSERT INTO sessions(token_hash,user_id,csrf_token,analytics_session_id,expires_at,client_id) VALUES($1,$2,$3,$4,$5,$6)', [hashToken(token),u.id,csrfToken,randomUUID(),expiresAt,clientId ?? null]);
      if (schoolState) {
        await c.query('INSERT INTO school_sessions(user_id,provider,encrypted_state) VALUES($1,$2,$3) ON CONFLICT(user_id,provider) DO UPDATE SET encrypted_state=EXCLUDED.encrypted_state,updated_at=now()',[u.id,schoolState.provider,schoolState.seal(u.id)]);
        await c.query('DELETE FROM school_read_cache WHERE user_id=$1 AND provider=$2', [u.id, schoolState.provider]);
      }
      return { token, csrfToken, expiresAt, user: userFrom(u) };
    });
  }
  async deleteSession(hash: string) {
    await this.transaction(async c => {
      const { rows: [session] } = await c.query('DELETE FROM sessions WHERE token_hash=$1 RETURNING user_id', [hash]);
      if (session) await c.query('DELETE FROM school_read_cache WHERE user_id=$1', [session.user_id]);
    });
  }
  async listCompletions(userId: string, courseId: string) {
    const { rows } = await this.query('SELECT course_id,activity_id,completed,updated_at FROM personal_learning_completions WHERE user_id=$1 AND course_id=$2 ORDER BY activity_id', [userId, courseId]);
    return rows.map(completionFrom);
  }
  async listCompletionsForCourses(userId: string, courseIds: readonly string[]) {
    const ids = [...new Set(courseIds)];
    if (ids.length > 100 || ids.some(id => !/^[A-Za-z0-9:_-]{1,200}$/.test(id)))
      throw new AppError(400, 'INVALID_REQUEST', '조회할 강좌를 확인할 수 없습니다.');
    if (!ids.length) return [];
    const { rows } = await this.query('SELECT course_id,activity_id,completed,updated_at FROM personal_learning_completions WHERE user_id=$1 AND course_id=ANY($2::text[]) ORDER BY course_id,activity_id', [userId, ids]);
    return rows.map(completionFrom);
  }
  private async completionTransaction<T>(userId: string, authorization: CompletionAuthorization, run: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(async client => {
      // Lock the same session through COMMIT. A concurrent logout/CSRF change
      // cannot turn a previously checked session into authority for a later write.
      const result = await client.query('SELECT token_hash FROM sessions WHERE user_id=$1 AND token_hash=$2 AND csrf_token=$3 AND expires_at>clock_timestamp() FOR SHARE',
        [userId, authorization.tokenHash, authorization.csrfToken]);
      if (!result.rowCount) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
      const value = await run(client);
      // A completion row lock can delay the mutation past session expiry.
      // Roll back even if that UPDATE/DELETE already ran inside this transaction.
      const final = await client.query('SELECT token_hash FROM sessions WHERE user_id=$1 AND token_hash=$2 AND csrf_token=$3 AND expires_at>clock_timestamp()',
        [userId, authorization.tokenHash, authorization.csrfToken]);
      if (!final.rowCount) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
      return value;
    });
  }
  async setCompletion(userId: string, courseId: string, activityId: string, completed: boolean, authorization: CompletionAuthorization) {
    return this.completionTransaction(userId, authorization, async client => {
      const { rows: [row] } = await client.query(`INSERT INTO personal_learning_completions(user_id,course_id,activity_id,completed)
        SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM sessions WHERE user_id=$1 AND token_hash=$5 AND csrf_token=$6 AND expires_at>clock_timestamp())
        ON CONFLICT(user_id,course_id,activity_id) DO UPDATE SET completed=EXCLUDED.completed,updated_at=clock_timestamp() RETURNING *`,
        [userId, courseId, activityId, completed, authorization.tokenHash, authorization.csrfToken]);
      if (!row) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
      return completionFrom(row);
    });
  }
  async deleteCompletion(userId: string, courseId: string, activityId: string, authorization: CompletionAuthorization) {
    await this.completionTransaction(userId, authorization, async client => {
      // Reset is idempotent. Check expiry at mutation time even when no override exists.
      const { rows: [session] } = await client.query('SELECT expires_at>clock_timestamp() AS active FROM sessions WHERE user_id=$1 AND token_hash=$2 AND csrf_token=$3',
        [userId, authorization.tokenHash, authorization.csrfToken]);
      if (!session?.active) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
      await client.query('DELETE FROM personal_learning_completions WHERE user_id=$1 AND course_id=$2 AND activity_id=$3', [userId, courseId, activityId]);
    });
  }
  async listTodos(userId: string, limit = 500) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 501) throw new RangeError('Invalid TODO read limit');
    const { rows } = await this.query('SELECT * FROM todos WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2', [userId,limit]); return rows.map(todoFrom);
  }
  async createTodo(userId: string, input: { title: string; dueAt?: string | null }) {
    const { rows: [r] } = await this.query('INSERT INTO todos(id,user_id,title,due_at) VALUES($1,$2,$3,$4) RETURNING *', [randomUUID(),userId,input.title,input.dueAt ?? null]); return todoFrom(r!);
  }
  async updateTodo(userId: string, id: string, input: { title?: string; completed?: boolean; dueAt?: string | null }) {
    const assignments: string[] = []; const params: unknown[] = [userId,id];
    for (const [key,column] of [['title','title'],['completed','completed'],['dueAt','due_at']] as const) {
      if (key in input) { params.push(input[key]); assignments.push(`${column}=$${params.length}`); }
    }
    const { rows: [r] } = await this.query(`UPDATE todos SET ${assignments.join(',')},updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING *`, params);
    if (!r) throw notFound(); return todoFrom(r);
  }
  async deleteTodo(userId: string, id: string) { const { rowCount } = await this.query('DELETE FROM todos WHERE user_id=$1 AND id=$2', [userId,id]); if (!rowCount) throw notFound(); }
  async listJobs(userId: string,courseId?: string,limit = 200) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 201) throw new RangeError('Invalid job read limit');
    const { rows } = await this.query(`${jobRecoverySelect} WHERE job.user_id=$1 AND ($2::text IS NULL OR job.course_id=$2) ORDER BY job.created_at DESC,job.id DESC LIMIT $3`,[userId,courseId ?? null,limit]); return rows.map(jobFrom);
  }
  async getJob(userId: string,id: string) { const { rows: [r] } = await this.query(`${jobRecoverySelect} WHERE job.user_id=$1 AND job.id=$2`,[userId,id]); return r ? jobFrom(r) : null; }
  async findJobRequest(userId: string, idempotencyKey: string, requestHash: string, operation?: WorkerOperation) {
    const { rows: [row] } = await this.workerQuery('SELECT * FROM playback_jobs WHERE user_id=$1 AND idempotency_key=$2', [userId, idempotencyKey], operation);
    if (!row) return null;
    if (row.request_hash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '같은 요청 키에 다른 작업이 있습니다.');
    return jobFrom(row);
  }
  async createJob(userId: string, input: NewJobInput, authorization: JobAdmissionAuthorization, operation: WorkerOperation = { timeoutMs: 5000 }) {
    try {
      return await this.workerTransaction(async query => {
        await query(playbackAccountLock, [playbackAccountLockKey(userId)]);
        await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [userId + ':' + input.idempotencyKey]);
        const session = await query('SELECT token_hash FROM sessions WHERE user_id=$1 AND token_hash=$2 AND expires_at>clock_timestamp() FOR SHARE', [userId, authorization?.almsTokenHash]);
        if (!session.rowCount) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
        const { rows: [existing] } = await query<Row>('SELECT * FROM playback_jobs WHERE user_id=$1 AND idempotency_key=$2', [userId,input.idempotencyKey]);
        if (existing) {
          if (existing.request_hash !== input.requestHash) throw new AppError(409,'IDEMPOTENCY_CONFLICT','같은 요청 키에 다른 작업이 있습니다.');
          return jobFrom(existing);
        }
        const proof = inspectPlaybackAdmission(authorization.admission, { userId, courseId: input.courseId, lectureId: input.lectureId });
        const school = await query("SELECT user_id FROM school_sessions WHERE user_id=$1 AND provider='ssu' AND encrypted_state=$2 FOR SHARE", [userId, proof.encryptedSession]);
        if (!school.rowCount) throw authorityChanged();
        const id = randomUUID();
        const status = new Date(input.scheduledFor).getTime() > Date.now() + 1000 ? 'scheduled' : 'queued';
        const { rows: [r] } = await query<Row>(`INSERT INTO playback_jobs(id,user_id,course_id,lecture_id,status,scheduled_for,idempotency_key,request_hash,accepted_generation)
          SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9 WHERE clock_timestamp()<to_timestamp($10::double precision/1000)
            AND EXISTS(SELECT 1 FROM sessions WHERE user_id=$2 AND token_hash=$11 AND expires_at>clock_timestamp()) RETURNING *`,
          [id,userId,input.courseId,input.lectureId,status,input.scheduledFor,input.idempotencyKey,input.requestHash,proof.generation,proof.expiresAt,authorization.almsTokenHash]);
        if (!r) throw authorityChanged();
        await query('INSERT INTO job_outbox(job_id) VALUES($1)', [id]);
        return jobFrom(r);
      }, operation);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new AppError(409,'JOB_ALREADY_ACTIVE','이 강의의 진행 중인 작업을 먼저 확인해 주세요.');
      throw error;
    }
  }
  async cancelJob(userId: string,id: string) {
    return this.transaction(async c => {
      const { rows: [r] } = await c.query('SELECT * FROM playback_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE',[userId,id]);
      if (!r) throw notFound();
      const job = jobFrom(r);
      const next = ['queued','scheduled','paused'].includes(job.status) ? 'cancelled' : 'cancel_requested';
      if (!canTransition(job.status,next)) return job;
      const { rows: [updated] } = await c.query('UPDATE playback_jobs SET status=$2,updated_at=now() WHERE id=$1 RETURNING *',[id,next]);
      return jobFrom(updated);
    });
  }
  async settleJob(userId: string, id: string, expectedUpdatedAt: string, authorization: JobSettlementAuthorization,
    operation: WorkerOperation = { timeoutMs: 5000 }) {
    const schoolResult = publicVerifiedSchoolResult(authorization.schoolResult);
    return this.workerTransaction(async query => {
      await query(playbackAccountLock, [playbackAccountLockKey(userId)]);
      const session = await query('SELECT token_hash FROM sessions WHERE user_id=$1 AND token_hash=$2 AND csrf_token=$3 AND expires_at>clock_timestamp() FOR SHARE',
        [userId, authorization.tokenHash, authorization.csrfToken]);
      if (!session.rowCount) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
      const { rows: [row] } = await query<Row>(`${jobRecoverySelect} WHERE job.user_id=$1 AND job.id=$2 FOR UPDATE OF job`, [userId, id]);
      if (!row) throw notFound();
      if (row.recovery_version !== expectedUpdatedAt) throw new AppError(409, 'JOB_CHANGED', '작업 상태가 바뀌었습니다. 다시 조회해 주세요.');
      const proof = inspectPlaybackAdmission(authorization.admission, { userId, courseId: row.course_id, lectureId: row.lecture_id });
      const school = await query("SELECT user_id FROM school_sessions WHERE user_id=$1 AND provider='ssu' AND encrypted_state=$2 FOR SHARE", [userId, proof.encryptedSession]);
      if (!school.rowCount) throw authorityChanged();
      if (row.recovery_reason !== 'eligible' && row.recovery_reason !== 'already_settled')
        throw new AppError(409, 'JOB_SETTLEMENT_UNSAFE', '실행 종료와 학교 결과를 먼저 확인해 주세요.');
      if (row.recovery_reason === 'eligible') {
        const { rows: [settlement] } = await query<Row>(`INSERT INTO playback_job_settlements(job_id,execution_token_hash,current_generation,school_result)
          SELECT $1,$2,$3,$4::jsonb WHERE clock_timestamp()<to_timestamp($5::double precision/1000) RETURNING job_id`,
          [id, row.last_execution_token_hash, proof.generation, JSON.stringify(schoolResult), proof.expiresAt]);
        if (!settlement) throw authorityChanged();
        const updated = await query(`UPDATE playback_jobs target SET settled_at=settlement.settled_at,settled_execution_token_hash=target.last_execution_token_hash
          FROM playback_job_settlements settlement
          WHERE settlement.job_id=target.id AND target.user_id=$1 AND target.id=$2 AND target.updated_at=$3::timestamptz AND target.settled_at IS NULL
            AND target.status='needs_verification' AND target.execution_outcome='interrupted' AND target.execution_token_hash IS NULL
            AND NOT EXISTS(SELECT 1 FROM playback_execution_leases WHERE user_id=$1 AND expires_at>clock_timestamp())
            AND NOT EXISTS(SELECT 1 FROM playback_jobs active WHERE active.user_id=$1
              AND (active.execution_token_hash IS NOT NULL OR active.status IN ('running','reconciling','pause_requested','cancel_requested')))
          RETURNING target.id`, [userId, id, expectedUpdatedAt]);
        if (updated.rowCount !== 1) throw new AppError(409, 'JOB_SETTLEMENT_UNSAFE', '실행 상태가 바뀌었습니다. 다시 조회해 주세요.');
      }
      // Row/advisory waits may cross either authority deadline; rollback the whole settlement.
      const { rows: [final] } = await query<Row>(`SELECT
        EXISTS(SELECT 1 FROM sessions WHERE user_id=$1 AND token_hash=$2 AND csrf_token=$3 AND expires_at>clock_timestamp()) AS alms_session_valid,
        clock_timestamp()<to_timestamp($4::double precision/1000) AS playback_authority_valid`,
        [userId, authorization.tokenHash, authorization.csrfToken, proof.expiresAt]);
      if (final?.alms_session_valid !== true) throw new AppError(401, 'AUTH_REQUIRED', '다시 로그인해 주세요.');
      if (final.playback_authority_valid !== true) throw authorityChanged();
      const { rows: [current] } = await query<Row>(`${jobRecoverySelect} WHERE job.user_id=$1 AND job.id=$2`, [userId, id]);
      if (!current) throw notFound();
      return jobFrom(current);
    }, operation);
  }
  workerTransaction<T>(run: (query: WorkerQuery) => Promise<T>, operation: WorkerOperation) {
    return workerTransaction(this.pool, run, operation);
  }
  private workerQuery(sql: string, params: unknown[], operation: WorkerOperation = { timeoutMs: 5000 }) {
    return workerTransaction(this.pool, query => query<Row>(sql, params), operation);
  }
  async claimJob(id: string, operation?: WorkerOperation) {
    const tokenHash = hashToken(randomBytes(32).toString('base64url'));
    return this.workerTransaction(async query => {
      const { rows: [scope] } = await query<Row>('SELECT user_id FROM playback_jobs WHERE id=$1', [id]);
      if (!scope) return null;
      await query(playbackAccountLock, [playbackAccountLockKey(scope.user_id)]);
      const { rows: [r] } = await query<Row>(`UPDATE playback_jobs SET status='running',heartbeat_at=clock_timestamp(),updated_at=clock_timestamp(),
        execution_token_hash=$2,last_execution_token_hash=$2
        WHERE id=$1 AND status IN ('queued','scheduled') AND scheduled_for<=clock_timestamp() AND accepted_generation IS NOT NULL
          AND execution_token_hash IS NULL AND settled_at IS NULL RETURNING *`,[id,tokenHash]);
      return r ? jobFrom(r) : null;
    }, operation ?? { timeoutMs: 5000 });
  }
  async getWorkerJob(claim: WorkerClaim, operation?: WorkerOperation) {
    const { rows: [r] } = await this.workerQuery(`SELECT * FROM playback_jobs WHERE ${claimWhere}`, claimValues(claim), operation);
    return r ? jobFrom(r) : null;
  }
  async transitionJob(claim: WorkerClaim, from: JobStatus[], to: JobStatus, result: SchoolResult | null = null, error: string | null = null,
    options: JobTransitionOptions = {}, operation: WorkerOperation = { timeoutMs: 5000 }) {
    if (!from.every(status => canTransition(status,to))) throw new Error('Invalid job transition');
    const success = to === 'completed' || to === 'succeeded';
    if (success && (!result || to === 'completed' && options.outcome !== 'ended'
      || to === 'succeeded' && (result.recognized !== true || !['ended','not_started'].includes(options.outcome ?? '')))) throw authorityChanged();
    const proof = (success || result) ? inspectPlaybackFinalProof(options.authority!, claim) : null;
    return this.workerTransaction(async query => {
      await query(playbackAccountLock, [playbackAccountLockKey(claim.userId)]);
      if (proof) {
        const school = await query("SELECT user_id FROM school_sessions WHERE user_id=$1 AND provider='ssu' AND encrypted_state=$2 AND clock_timestamp()<to_timestamp($3::double precision/1000) FOR SHARE",
          [claim.userId, proof.encryptedSession, proof.expiresAt]);
        if (!school.rowCount) return null;
      }
      const terminal = !['running','reconciling','pause_requested','paused','cancel_requested','queued','scheduled'].includes(to);
      if (terminal && options.terminationProof) {
        const termination = inspectPlaybackTerminationProof(options.terminationProof, claim);
        const { rows: [active] } = await query<Row>(`SELECT id FROM playback_jobs WHERE ${claimWhere}
          AND status=ANY($7::text[]) AND last_execution_token_hash=$6 FOR UPDATE`, [...claimValues(claim), from]);
        if (!active) return null;
        await query(`INSERT INTO playback_execution_terminations(job_id,execution_token_hash,user_id,course_id,lecture_id,accepted_generation,terminated_at)
          VALUES($1,$6,$2,$3,$4,$5,$7) ON CONFLICT(job_id,execution_token_hash) DO NOTHING`, [...claimValues(claim), termination.terminatedAt]);
      }
      const { rows: [r] } = await query<Row>(`UPDATE playback_jobs SET status=$8,school_result=COALESCE($9::jsonb,school_result),error_code=$10,
        execution_outcome=COALESCE($11,execution_outcome),execution_token_hash=CASE WHEN $12 THEN NULL ELSE execution_token_hash END,updated_at=clock_timestamp()
        WHERE ${claimWhere} AND status=ANY($7::text[]) ${proof ? "AND clock_timestamp()<to_timestamp($13::double precision/1000)" : ''} RETURNING *`,
        [...claimValues(claim),from,to,result ? JSON.stringify(result) : null,error,options.outcome ?? null,terminal,...(proof ? [proof.expiresAt] : [])]);
      return r ? jobFrom(r) : null;
    }, operation);
  }
  async heartbeat(claim: WorkerClaim, operation?: WorkerOperation) {
    const result = await this.workerQuery(`UPDATE playback_jobs SET heartbeat_at=clock_timestamp() WHERE ${claimWhere}
      AND status IN ('running','reconciling','cancel_requested') RETURNING id`, claimValues(claim), operation);
    return result.rowCount === 1;
  }
  async recoverStaleJobs(operation?: WorkerOperation) {
    const { rowCount } = await this.workerQuery(`UPDATE playback_jobs SET status='needs_verification',error_code='WORKER_INTERRUPTED',execution_token_hash=NULL,updated_at=clock_timestamp()
      WHERE status IN ('running','reconciling','cancel_requested','pause_requested') AND (heartbeat_at IS NULL OR heartbeat_at<clock_timestamp()-interval '90 seconds')`, [], operation);
    return rowCount ?? 0;
  }
  async quarantineLegacyJobs(operation?: WorkerOperation) {
    const { rowCount } = await this.workerQuery(`UPDATE playback_jobs SET
      status=CASE WHEN status IN ('queued','scheduled','paused') THEN 'needs_reauthentication' ELSE 'needs_verification' END,
      error_code='PLAYBACK_ADMISSION_MISSING',execution_token_hash=NULL,updated_at=clock_timestamp()
      WHERE accepted_generation IS NULL AND status IN ('queued','scheduled','paused','running','reconciling','cancel_requested','pause_requested')`, [], operation);
    return rowCount ?? 0;
  }
}
