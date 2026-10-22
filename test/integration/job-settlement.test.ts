import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { PgStore, hashToken } from '../../src/store.js';
import { migrate } from '../../src/migrations.js';
import { createPlaybackAdmission, jobClaim } from '../../src/playback-authority.js';
import { createPlaybackTerminationProof } from '../../src/playback-termination.js';
import { PgPlaybackLeaseRepository } from '../../src/manual-video-lease.js';
import { playbackAccountLock, playbackAccountLockKey } from '../../src/playback-lock.js';

const url = process.env.TEST_DATABASE_URL;
if (url && !['/alms_test', '/alms_qa'].includes(new URL(url).pathname)) throw new Error('Use isolated test database');
const schoolResult = { observedAt: '2026-10-03T00:00:00Z', progressPercent: 5.7, attendance: 'unknown' as const, recognized: null };
const closed = { runtimeStopped: true, dispatchFenced: true, callbacksDrained: true } as const;
describe('explicit interrupted job settlement in isolated PostgreSQL', { skip: !url }, () => {
  let pool: Pool, store: PgStore, admin: Pool;
  const schema = 'v41_settlement_' + randomUUID().replaceAll('-', '');
  before(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, max: 10, application_name: 'alms-qa-v41-settlement', options: `-c search_path=${schema}` });
    await migrate(pool); store = new PgStore(pool);
  });
  after(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
  async function fixture() {
    const generation = randomUUID(), encryptedSession = 'synthetic-settlement-seal-' + randomUUID();
    const identity = { provider: 'settlement-qa', subject: randomUUID() };
    const session = await store.issueVerifiedSession(identity, 3600, { provider: 'ssu', seal: () => encryptedSession });
    const userId = session.user.id;
    const input = { courseId: '10', lectureId: '20', scheduledFor: new Date().toISOString(), idempotencyKey: randomUUID(), requestHash: hashToken('synthetic-settlement') };
    const admission = createPlaybackAdmission({ userId, courseId: input.courseId, lectureId: input.lectureId }, { generation, encryptedSession });
    const authorization = { admission, tokenHash: hashToken(session.token), csrfToken: session.csrfToken, schoolResult };
    const job = await store.createJob(userId, input, { admission, almsTokenHash: authorization.tokenHash });
    const claim = jobClaim((await store.claimJob(job.id))!);
    const terminate = async (withProof = true) => store.transitionJob(claim, ['running'], 'needs_verification', null, 'PLAYBACK_REPORT_UNKNOWN',
      { outcome: 'interrupted', ...(withProof ? { terminationProof: createPlaybackTerminationProof(claim, closed) } : {}) });
    const current = async () => (await store.getJob(userId, job.id))!;
    const settle = async (auth = authorization, version?: string) => store.settleJob(userId, job.id, version ?? (await current()).recovery!.version, auth);
    return { userId, identity, session, generation, encryptedSession, authorization, input, job, claim, terminate, current, settle };
  }
  async function counts(jobId: string) { return (await pool.query(`SELECT
    (SELECT count(*)::int FROM playback_execution_terminations WHERE job_id=$1) AS terminations,
    (SELECT count(*)::int FROM playback_job_settlements WHERE job_id=$1) AS settlements`, [jobId])).rows[0]; }
  async function waitForLock(contains: string) {
    const until = Date.now() + 2000;
    while (Date.now() < until) {
      if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name='alms-qa-v41-settlement' AND wait_event_type='Lock' AND query LIKE $1", ['%' + contains + '%'])).rowCount) return;
      await delay(5);
    }
    assert.fail('Expected isolated settlement lock wait');
  }
  it('has no historical or stale recovery backfill and rejects token absence as termination', async () => {
    const f = await fixture(); await f.terminate(false);
    assert.equal((await f.current()).recovery?.reason, 'termination_unconfirmed');
    await assert.rejects(f.settle(), (error: any) => error.code === 'JOB_SETTLEMENT_UNSAFE');
    const stale = await fixture();
    await pool.query("UPDATE playback_jobs SET heartbeat_at=clock_timestamp()-interval '2 minutes' WHERE id=$1", [stale.job.id]);
    await store.recoverStaleJobs();
    assert.equal((await stale.current()).settledAt, null);
    assert.deepEqual(await counts(f.job.id), { terminations: 0, settlements: 0 });
    assert.deepEqual(await counts(stale.job.id), { terminations: 0, settlements: 0 });
  });
  it('preserves original failure/history/generation while current authorization settles and a new key admits another job', async () => {
    const f = await fixture(); await f.terminate(); const before = await f.current();
    const nextGeneration = randomUUID(), nextSeal = 'synthetic-fresh-school-seal';
    const session = await store.issueVerifiedSession(f.identity, 3600, { provider: 'ssu', seal: () => nextSeal });
    const admission = createPlaybackAdmission({ userId: f.userId, courseId: '10', lectureId: '20' }, { generation: nextGeneration, encryptedSession: nextSeal });
    const authorization = { admission, tokenHash: hashToken(session.token), csrfToken: session.csrfToken, schoolResult };
    const settled = await f.settle(authorization);
    for (const key of ['status', 'errorCode', 'executionOutcome', 'schoolResult', 'updatedAt', 'acceptedGeneration'] as const) assert.deepEqual(settled[key], before[key]);
    assert.equal(settled.status, 'needs_verification'); assert.equal(settled.executionOutcome, 'interrupted');
    assert.equal(settled.recovery?.reason, 'already_settled'); assert.equal(settled.recovery?.eligible, false);
    assert.equal(settled.settledAt, settled.settlement?.settledAt); assert.deepEqual(settled.settlement?.schoolResult, schoolResult);
    assert.equal((await pool.query('SELECT current_generation FROM playback_job_settlements WHERE job_id=$1', [f.job.id])).rows[0].current_generation, nextGeneration);
    const replay = await store.createJob(f.userId, f.input, { admission, almsTokenHash: authorization.tokenHash });
    assert.equal(replay.id, f.job.id); assert.equal(replay.acceptedGeneration, f.generation);
    const fresh = await store.createJob(f.userId, { ...f.input, idempotencyKey: randomUUID() }, { admission, almsTokenHash: authorization.tokenHash });
    assert.notEqual(fresh.id, f.job.id); assert.equal(fresh.acceptedGeneration, nextGeneration);
    assert.equal(await store.getWorkerJob(f.claim), null); assert.equal(await store.heartbeat(f.claim), false);
    assert.equal(await store.transitionJob(f.claim, ['running'], 'reconciling'), null);
  });
  it('rejects forged and mismatched termination proof; stale finalization cannot insert a late proof', async () => {
    const f = await fixture();
    const wrong = createPlaybackTerminationProof({ ...f.claim, executionTokenHash: 'b'.repeat(64) }, closed);
    await assert.rejects(store.transitionJob(f.claim, ['running'], 'needs_verification', null, null, { outcome: 'interrupted', terminationProof: wrong }));
    await pool.query("UPDATE playback_jobs SET heartbeat_at=clock_timestamp()-interval '2 minutes' WHERE id=$1", [f.job.id]); await store.recoverStaleJobs();
    assert.equal(await f.terminate(), null); assert.deepEqual(await counts(f.job.id), { terminations: 0, settlements: 0 });
  });
  it('keeps unexpired uncertain lease holds, then rejects old late acquire/renew after exact termination', async () => {
    const f = await fixture(), leases = new PgPlaybackLeaseRepository(pool);
    const scope = { owner: f.userId, generation: f.generation, courseId: '10', moduleItemId: '20', tokenHash: f.claim.executionTokenHash, kind: 'worker' as const };
    assert.equal(await leases.acquire(scope, { encryptedSession: f.encryptedSession }, AbortSignal.timeout(5000)), true);
    await f.terminate(); assert.equal((await f.current()).recovery?.reason, 'lease_active');
    await assert.rejects(f.settle(), (error: any) => error.code === 'JOB_SETTLEMENT_UNSAFE');
    await pool.query("UPDATE playback_execution_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1", [f.userId]);
    assert.equal((await f.current()).recovery?.eligible, true); await f.settle();
    assert.equal(await leases.acquire(scope, { encryptedSession: f.encryptedSession }, AbortSignal.timeout(5000)), false);
    assert.equal(await leases.renew(scope, AbortSignal.timeout(5000)), false);
  });
  it('blocks another live claim for the same account and does not settle until its cancellation', async () => {
    const f = await fixture(); await f.terminate();
    const next = await store.createJob(f.userId, { ...f.input, lectureId: '21', idempotencyKey: randomUUID() },
      { admission: createPlaybackAdmission({ userId: f.userId, courseId: '10', lectureId: '21' }, { generation: f.generation, encryptedSession: f.encryptedSession }), almsTokenHash: f.authorization.tokenHash });
    const other = jobClaim((await store.claimJob(next.id))!);
    assert.equal((await f.current()).recovery?.reason, 'execution_active');
    await assert.rejects(f.settle(), (error: any) => error.code === 'JOB_SETTLEMENT_UNSAFE');
    await store.transitionJob(other, ['running'], 'needs_verification', null, 'synthetic-stop', { outcome: 'interrupted' });
    await f.settle(); assert.equal((await f.current()).recovery?.reason, 'already_settled');
  });
  it('checks ownership, exact version, CSRF, logout and fresh school seal without creating settlement rows', async () => {
    const f = await fixture(), other = await fixture(); await f.terminate();
    await assert.rejects(store.settleJob(other.userId, f.job.id, (await f.current()).recovery!.version, other.authorization), (error: any) => error.code === 'NOT_FOUND');
    await assert.rejects(f.settle(f.authorization, '2026-01-01T00:00:00.000000Z'), (error: any) => error.code === 'JOB_CHANGED');
    await assert.rejects(f.settle({ ...f.authorization, csrfToken: 'synthetic-wrong' }), (error: any) => error.code === 'AUTH_REQUIRED');
    await store.replaceEncryptedSchoolSession(f.userId, 'ssu', f.encryptedSession, 'synthetic-new-seal');
    await assert.rejects(f.settle(), (error: any) => error.code === 'PLAYBACK_AUTHORITY_CHANGED');
    await store.deleteSession(f.authorization.tokenHash);
    await assert.rejects(f.settle(), (error: any) => error.code === 'AUTH_REQUIRED');
    assert.deepEqual(await counts(f.job.id), { terminations: 1, settlements: 0 });
  });
  it('uses microsecond version CAS and stores the exact SQL settlement timestamp across concurrent duplicates', async () => {
    const f = await fixture(); await f.terminate(); const stale = (await f.current()).recovery!.version;
    await pool.query("UPDATE playback_jobs SET updated_at=date_trunc('milliseconds',updated_at)+interval '1 microsecond' WHERE id=$1", [f.job.id]);
    await assert.rejects(f.settle(f.authorization, stale), (error: any) => error.code === 'JOB_CHANGED');
    const latest = (await f.current()).recovery!.version; assert.match(latest, /\.\d{6}Z$/);
    const [one, two] = await Promise.all([f.settle(f.authorization, latest), f.settle(f.authorization, latest)]);
    assert.equal(one.settledAt, two.settledAt); assert.deepEqual(await counts(f.job.id), { terminations: 1, settlements: 1 });
    const exact = (await pool.query(`SELECT job.settled_at=record.settled_at AS matches,
      to_char(job.settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS job_stamp,
      to_char(record.settled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS record_stamp
      FROM playback_jobs job JOIN playback_job_settlements record ON record.job_id=job.id WHERE job.id=$1`, [f.job.id])).rows[0];
    assert.equal(exact.matches, true); assert.equal(exact.job_stamp, exact.record_stamp); assert.match(exact.job_stamp, /\.\d{6}Z$/);
  });
  it('preserves immutable proof and settlement records; an active status can never use a settled marker', async () => {
    const f = await fixture(); await f.terminate(); await f.settle();
    for (const table of ['playback_execution_terminations', 'playback_job_settlements']) {
      await assert.rejects(pool.query(`UPDATE ${table} SET job_id=job_id WHERE job_id=$1`, [f.job.id]));
      await assert.rejects(pool.query(`DELETE FROM ${table} WHERE job_id=$1`, [f.job.id]));
    }
    await assert.rejects(pool.query("UPDATE playback_jobs SET status='running' WHERE id=$1", [f.job.id]));
    await assert.rejects(pool.query('UPDATE playback_jobs SET settled_at=NULL,settled_execution_token_hash=NULL WHERE id=$1', [f.job.id]));
    assert.equal((await f.current()).status, 'needs_verification');
  });
  it('requires a non-null exact settlement token and prevents an old attempt record from settling a newer attempt', async () => {
    const f = await fixture(); await f.terminate();
    await pool.query(`INSERT INTO playback_job_settlements(job_id,execution_token_hash,current_generation,school_result)
      VALUES($1,$2,$3,$4::jsonb)`, [f.job.id, f.claim.executionTokenHash, f.generation, JSON.stringify(schoolResult)]);
    await assert.rejects(pool.query(`UPDATE playback_jobs job SET settled_at=record.settled_at,settled_execution_token_hash=NULL
      FROM playback_job_settlements record WHERE job.id=$1 AND record.job_id=job.id`, [f.job.id]));
    const newerToken = 'f'.repeat(64);
    await pool.query(`INSERT INTO playback_execution_terminations(job_id,execution_token_hash,user_id,course_id,lecture_id,accepted_generation,terminated_at)
      VALUES($1,$2,$3,'10','20',$4,clock_timestamp())`, [f.job.id, newerToken, f.userId, f.generation]);
    await pool.query('UPDATE playback_jobs SET last_execution_token_hash=$2 WHERE id=$1', [f.job.id, newerToken]);
    await assert.rejects(pool.query(`UPDATE playback_jobs job SET settled_at=record.settled_at,settled_execution_token_hash=job.last_execution_token_hash
      FROM playback_job_settlements record WHERE job.id=$1 AND record.job_id=job.id`, [f.job.id]));
    assert.equal((await f.current()).settledAt, null);
  });
  it('rechecks session expiry after a real row wait and rolls back both settlement writes', async () => {
    const f = await fixture(); await f.terminate();
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1", [f.authorization.tokenHash]);
    const locker = await pool.connect(); let pending: Promise<unknown> | undefined;
    try {
      await locker.query('BEGIN'); await locker.query('SELECT id FROM playback_jobs WHERE id=$1 FOR UPDATE', [f.job.id]);
      pending = f.settle().then(() => null, error => error); await waitForLock('AS recovery_version');
      await delay(1050); await locker.query('COMMIT'); assert.equal((await pending as any)?.code, 'AUTH_REQUIRED');
      assert.deepEqual(await counts(f.job.id), { terminations: 1, settlements: 0 });
    } finally { await locker.query('ROLLBACK'); locker.release(); await pending; }
  });
  it('aborts a blocked settlement without late mutation', async () => {
    const f = await fixture(); await f.terminate(); const version = (await f.current()).recovery!.version;
    const locker = await pool.connect(), controller = new AbortController(); let pending: Promise<unknown> | undefined;
    try {
      await locker.query('BEGIN'); await locker.query(playbackAccountLock, [playbackAccountLockKey(f.userId)]);
      pending = store.settleJob(f.userId, f.job.id, version, f.authorization, { signal: controller.signal, timeoutMs: 5000 }).then(() => null, error => error);
      await waitForLock('pg_advisory_xact_lock'); controller.abort(); assert.ok(await pending);
      await locker.query('COMMIT'); await delay(20); assert.deepEqual(await counts(f.job.id), { terminations: 1, settlements: 0 });
    } finally { controller.abort(); await locker.query('ROLLBACK'); locker.release(); await pending; }
    const settled = await f.settle(); assert.equal(settled.recovery?.reason, 'already_settled');
  });
  it('serializes an absent-lease acquisition with settlement under the same owner lock', async () => {
    const f = await fixture(); await f.terminate(); const version = (await f.current()).recovery!.version;
    const leases = new PgPlaybackLeaseRepository(pool), locker = await pool.connect();
    const scope = { owner: f.userId, generation: f.generation, courseId: '10', moduleItemId: '20',
      tokenHash: hashToken('synthetic-manual-lease'), kind: 'manual' as const };
    let acquire: Promise<boolean> | undefined, settle: Promise<unknown> | undefined;
    try {
      await locker.query('BEGIN'); await locker.query(playbackAccountLock, [playbackAccountLockKey(f.userId)]);
      acquire = leases.acquire(scope, { encryptedSession: f.encryptedSession, almsTokenHash: f.authorization.tokenHash }, AbortSignal.timeout(5000));
      await waitForLock('pg_advisory_xact_lock');
      settle = store.settleJob(f.userId, f.job.id, version, f.authorization).then(() => null, error => error);
      await delay(20); await locker.query('COMMIT');
      assert.equal(await acquire, true); assert.equal((await settle as any)?.code, 'JOB_SETTLEMENT_UNSAFE');
      assert.deepEqual(await counts(f.job.id), { terminations: 1, settlements: 0 });
      await leases.release(scope, AbortSignal.timeout(5000)); assert.equal((await f.settle()).recovery?.reason, 'already_settled');
      // A subsequent manual lease is safe because the old exact claim is permanently fenced.
      assert.equal(await leases.acquire(scope, { encryptedSession: f.encryptedSession, almsTokenHash: f.authorization.tokenHash }, AbortSignal.timeout(5000)), true);
      assert.equal(await store.heartbeat(f.claim), false); await leases.release(scope, AbortSignal.timeout(5000));
    } finally { await locker.query('ROLLBACK'); locker.release(); await acquire; await settle; }
  });
  it('expires fresh admission across a real school-seal lock and preserves the old failure', async t => {
    const f = await fixture(); await f.terminate(); const now = Date.now.bind(Date);
    t.mock.method(Date, 'now', () => now() - 29_800);
    const admission = createPlaybackAdmission({ userId: f.userId, courseId: '10', lectureId: '20' }, { generation: f.generation, encryptedSession: f.encryptedSession });
    t.mock.restoreAll(); const locker = await pool.connect(); let pending: Promise<unknown> | undefined;
    try {
      await locker.query('BEGIN'); await locker.query("SELECT user_id FROM school_sessions WHERE user_id=$1 AND provider='ssu' FOR UPDATE", [f.userId]);
      pending = f.settle({ ...f.authorization, admission }).then(() => null, error => error);
      await waitForLock('school_sessions'); await delay(220); await locker.query('COMMIT');
      assert.equal((await pending as any)?.code, 'PLAYBACK_AUTHORITY_CHANGED');
      assert.deepEqual(await counts(f.job.id), { terminations: 1, settlements: 0 }); assert.equal((await f.current()).status, 'needs_verification');
    } finally { t.mock.restoreAll(); await locker.query('ROLLBACK'); locker.release(); await pending; }
  });
  it('separates final school authority expiry from a still valid ALMS login and rolls back settlement writes', async t => {
    const f = await fixture(); await f.terminate(); const now = Date.now.bind(Date);
    await pool.query(`CREATE FUNCTION delay_v41_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.job_id='${f.job.id}'::uuid THEN PERFORM pg_sleep(0.4); END IF; RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER delay_v41_settlement_insert BEFORE INSERT ON playback_job_settlements FOR EACH ROW EXECUTE FUNCTION delay_v41_settlement()');
    t.mock.method(Date, 'now', () => now() - 29_800);
    const admission = createPlaybackAdmission({ userId: f.userId, courseId: '10', lectureId: '20' }, { generation: f.generation, encryptedSession: f.encryptedSession });
    t.mock.restoreAll();
    try {
      await assert.rejects(f.settle({ ...f.authorization, admission }), (error: any) => error.code === 'PLAYBACK_AUTHORITY_CHANGED' && error.statusCode === 409);
      assert.ok(await store.getSession(f.authorization.tokenHash)); assert.deepEqual(await counts(f.job.id), { terminations: 1, settlements: 0 });
    } finally { t.mock.restoreAll(); await pool.query('DROP TRIGGER delay_v41_settlement_insert ON playback_job_settlements'); await pool.query('DROP FUNCTION delay_v41_settlement()'); }
  });
  it('rechecks a school seal changed while waiting instead of storing a stale authorization', async () => {
    const f = await fixture(); await f.terminate(); const locker = await pool.connect(); let pending: Promise<unknown> | undefined;
    try {
      await locker.query('BEGIN'); await locker.query("UPDATE school_sessions SET encrypted_state='synthetic-rotated-seal' WHERE user_id=$1 AND provider='ssu'", [f.userId]);
      pending = f.settle().then(() => null, error => error); await waitForLock('school_sessions'); await locker.query('COMMIT');
      assert.equal((await pending as any)?.code, 'PLAYBACK_AUTHORITY_CHANGED'); assert.deepEqual(await counts(f.job.id), { terminations: 1, settlements: 0 });
    } finally { await locker.query('ROLLBACK'); locker.release(); await pending; }
  });

});
