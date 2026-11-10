import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PgStore, hashToken } from '../../src/store.js';
import { migrate } from '../../src/migrations.js';
import { createPlaybackAdmission, createPlaybackFinalProof, jobClaim } from '../../src/playback-authority.js';
import { playbackContinuationHash } from '../../src/playback-continuation-routes.js';
import type { AuthenticationWaitReason } from '../../src/playback-auth-wait.js';
import { dispatchOutbox } from '../../src/queue.js';
import type { PgBoss } from 'pg-boss';
import type { Job } from '../../src/domain.js';
const url = process.env.TEST_DATABASE_URL;
if (url && !['/alms_test','/alms_qa'].includes(new URL(url).pathname)) throw new Error('Use isolated test database');
describe('durable authentication waits and explicit continuations in isolated PostgreSQL', { skip: !url }, () => {
  let pool: Pool, store: PgStore; const owners: string[] = [];
  before(async () => { pool = new Pool({ connectionString: url, max: 10, application_name: 'alms-qa-continuation' }); await migrate(pool); store = new PgStore(pool); });
  after(async () => { if (pool) {
    await pool.query('DELETE FROM playback_auth_waits WHERE job_id IN (SELECT id FROM playback_jobs WHERE user_id=ANY($1::uuid[]))', [owners]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [owners]); await pool.end();
  } });
  async function fixture(reason: AuthenticationWaitReason = 'school_auth_required') {
    const identity = { provider: 'auth-wait-qa', subject: randomUUID() }, generation = randomUUID(), seal = 'synthetic-school-' + randomUUID();
    const session = await store.issueVerifiedSession(identity, 3600, { provider: 'ssu', seal: () => seal }); owners.push(session.user.id);
    const owner = session.user.id;
    const create = async (lectureId: string, accepted = generation, scheduledFor = new Date().toISOString()) => store.createJob(owner,
      { courseId: '10', lectureId, scheduledFor, idempotencyKey: randomUUID(), requestHash: hashToken('synthetic-initial-' + randomUUID()) }, {
        almsTokenHash: hashToken(session.token), admission: createPlaybackAdmission({ userId: owner, courseId: '10', lectureId }, { generation: accepted, encryptedSession: seal }),
      });
    const failed = await create('20'), queued = await create('21'), future = await create('22', generation, new Date(Date.now() + 3600000).toISOString());
    const anotherGeneration = await create('23', randomUUID()), claim = jobClaim((await store.claimJob(failed.id))!);
    const fail = async () => store.transitionJob(claim, ['running'], reason === 'school_auth_required' ? 'needs_reauthentication' : 'needs_verification', null,
      reason === 'school_auth_required' ? 'AUTH_REQUIRED' : 'SCHOOL_SESSION_CHANGED', { outcome: 'not_started', authenticationWaitReason: reason });
    const login = async () => {
      const nextGeneration = randomUUID(), nextSeal = 'synthetic-new-school-' + randomUUID();
      const next = await store.issueVerifiedSession(identity, 3600, { provider: 'ssu', seal: () => nextSeal });
      return { generation: nextGeneration, seal: nextSeal, tokenHash: hashToken(next.token), csrfToken: next.csrfToken, clientId: null,
        admission: (job: Job) => createPlaybackAdmission({ userId: owner, courseId: job.courseId, lectureId: job.lectureId }, { generation: nextGeneration, encryptedSession: nextSeal }) };
    };
    return { owner, session, generation, seal, failed, queued, future, anotherGeneration, claim, fail, login };
  }
  const row = async (id: string) => (await pool.query('SELECT to_jsonb(j) AS row FROM playback_jobs j WHERE id=$1', [id])).rows[0]?.row;
  const auth = (fresh: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['login']>>, job: Job) => ({ admission: fresh.admission(job), almsTokenHash: fresh.tokenHash, csrfToken: fresh.csrfToken, clientId: fresh.clientId });
  it('marks only untouched same-owner/generation intents and blocks already-dispatched claims without rewriting pending rows', async () => {
    const f = await fixture(), before = await row(f.queued.id), other = await fixture();
    const sent: string[] = [], boss = { send: async (_q: string, data: { jobId: string }, options: { id: string }) => { sent.push(data.jobId); return options.id; } } as unknown as PgBoss;
    // Reproduce a legacy delivery accepted before the current execution began.
    // The new head-only dispatcher deliberately cannot dispatch another job while one runs.
    await pool.query('UPDATE job_outbox SET dispatched_at=clock_timestamp() WHERE job_id=$1', [f.queued.id]);
    await f.fail(); assert.deepEqual(await row(f.queued.id), before);
    assert.equal((await store.getJob(f.owner, f.queued.id))?.authWait?.reason, 'school_auth_required');
    assert.equal((await store.getJob(f.owner, f.queued.id))?.authWait?.canContinue, false);
    assert.equal((await store.getJob(f.owner, f.failed.id))?.authenticationContinuationEligible, true);
    assert.equal((await store.getJob(f.owner, f.future.id))?.status, 'scheduled');
    assert.equal((await store.getJob(f.owner, f.anotherGeneration.id))?.authWait, null); assert.equal((await store.getJob(other.owner, other.queued.id))?.authWait, null);
    assert.equal(await store.claimJob(f.queued.id), null);
    await pool.query('UPDATE job_outbox SET dispatched_at=NULL WHERE job_id=$1', [f.queued.id]); sent.length = 0;
    await dispatchOutbox(store, boss); assert.equal(sent.includes(f.queued.id), false);
    assert.equal((await pool.query('SELECT dispatched_at FROM job_outbox WHERE job_id=$1', [f.queued.id])).rows[0]?.dispatched_at, null);
  });
  it('generation conflicts stay distinct from expiry and preserve pending history', async () => {
    const f = await fixture('school_session_changed'), before = await row(f.future.id); await f.fail();
    const failed = await store.getJob(f.owner, f.failed.id); assert.equal(failed?.status, 'needs_verification');
    assert.equal(failed?.errorCode, 'SCHOOL_SESSION_CHANGED'); assert.equal(failed?.authWait?.reason, 'school_session_changed');
    assert.deepEqual(await row(f.future.id), before); assert.equal(await store.claimJob(f.queued.id), null);
  });
  it('explicit continuation atomically preserves old authority/error evidence and creates one normal child/outbox', async () => {
    const f = await fixture(); await f.fail(); const fresh = await f.login(), idem = randomUUID();
    const result = await store.continueJob(f.owner, f.queued.id, idem, playbackContinuationHash(f.queued.id), auth(fresh, f.queued));
    assert.equal(result.originalJob.status, 'cancelled'); assert.equal(result.originalJob.acceptedGeneration, f.generation);
    assert.equal(result.originalJob.authWait?.continuedAsJobId, result.job.id); assert.equal(result.originalJob.authenticationContinuationEligible, false);
    assert.equal(result.job.acceptedGeneration, fresh.generation); assert.equal(result.job.status, 'queued');
    assert.equal((await pool.query('SELECT 1 FROM job_outbox WHERE job_id=$1 AND dispatched_at IS NULL', [result.job.id])).rowCount, 1);
    const own = await store.continueJob(f.owner, f.failed.id, randomUUID(), playbackContinuationHash(f.failed.id), auth(fresh, f.failed));
    assert.equal(own.originalJob.errorCode, 'AUTH_REQUIRED');
    const marker = (await pool.query('SELECT original_status,original_error_code FROM playback_auth_waits WHERE job_id=$1', [f.failed.id])).rows[0];
    assert.equal(marker.original_status, 'needs_reauthentication'); assert.equal(marker.original_error_code, 'AUTH_REQUIRED');
    assert.equal(await store.claimJob(f.queued.id), null);
  });
  it('future schedules survive and are not claimed early', async () => {
    const f = await fixture(); await f.fail(); const fresh = await f.login();
    const result = await store.continueJob(f.owner, f.future.id, randomUUID(), playbackContinuationHash(f.future.id), auth(fresh, f.future));
    assert.equal(result.job.scheduledFor, f.future.scheduledFor); assert.equal(result.job.status, 'scheduled'); assert.equal(await store.claimJob(result.job.id), null);
  });
  it('exact-key readback survives completion and another key cannot produce a second child', async () => {
    const f = await fixture(); await f.fail(); const fresh = await f.login(), idem = randomUUID(), hash = playbackContinuationHash(f.queued.id), authorization = auth(fresh, f.queued);
    const result = await store.continueJob(f.owner, f.queued.id, idem, hash, authorization), claim = jobClaim((await store.claimJob(result.job.id))!);
    await store.transitionJob(claim, ['running'], 'reconciling');
    await store.transitionJob(claim, ['reconciling'], 'completed', { observedAt: new Date().toISOString(), progressPercent: 100, attendance: 'unknown', recognized: null }, null,
      { outcome: 'ended', authority: createPlaybackFinalProof(claim, { generation: fresh.generation, encryptedSession: fresh.seal }) });
    const replay = await store.continueJob(f.owner, f.queued.id, idem, hash, authorization); assert.equal(replay.job.id, result.job.id); assert.equal(replay.job.status, 'completed');
    assert.equal((await store.findJobContinuation(f.owner, f.queued.id, idem, hash, authorization))?.job.id, result.job.id);
    await assert.rejects(store.continueJob(f.owner, f.queued.id, randomUUID(), hash, auth(fresh, f.queued)), { code: 'PLAYBACK_ALREADY_CONTINUED' });
    await assert.rejects(store.findJobContinuation(f.owner, f.future.id, idem, playbackContinuationHash(f.future.id), authorization), { code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('two concurrent keys for one parent create one child and relation', async () => {
    const f = await fixture(); await f.fail(); const fresh = await f.login();
    const results = await Promise.allSettled([randomUUID(), randomUUID()].map(idem => store.continueJob(f.owner, f.queued.id, idem, playbackContinuationHash(f.queued.id), auth(fresh, f.queued))));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
    assert.equal((await pool.query('SELECT 1 FROM playback_auth_waits WHERE job_id=$1 AND continued_job_id IS NOT NULL', [f.queued.id])).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM playback_jobs WHERE user_id=$1 AND lecture_id='21'", [f.owner])).rowCount, 2);
  });
  it('wrong session/client/CSRF, stale school seal or unchanged generation leaves the old intent intact', async () => {
    for (const mode of ['csrf','client','seal','generation','logout'] as const) {
      const f = await fixture(); await f.fail(); const fresh = await f.login(), before = await row(f.queued.id), authorization = auth(fresh, f.queued);
      if (mode === 'csrf') authorization.csrfToken = 'wrong'; if (mode === 'client') authorization.clientId = 'unregistered' as never;
      if (mode === 'seal') authorization.admission = createPlaybackAdmission({ userId: f.owner, courseId: '10', lectureId: '21' }, { generation: fresh.generation, encryptedSession: 'synthetic-stale' });
      if (mode === 'generation') authorization.admission = createPlaybackAdmission({ userId: f.owner, courseId: '10', lectureId: '21' }, { generation: f.generation, encryptedSession: fresh.seal });
      if (mode === 'logout') await store.deleteSession(fresh.tokenHash);
      await assert.rejects(store.continueJob(f.owner, f.queued.id, randomUUID(), playbackContinuationHash(f.queued.id), authorization));
      assert.deepEqual(await row(f.queued.id), before); assert.equal((await store.getJob(f.owner, f.queued.id))?.authWait?.continuedAsJobId, null);
      assert.equal((await pool.query("SELECT 1 FROM playback_jobs WHERE user_id=$1 AND lecture_id='21'", [f.owner])).rowCount, 1);
    }
  });
  it('unknown/interrupted and historical unmarked failures cannot mark or continue pending work', async () => {
    const f = await fixture();
    await assert.rejects(store.transitionJob(f.claim, ['running'], 'needs_verification', null, 'PLAYBACK_REPORT_UNKNOWN', { outcome: 'interrupted', authenticationWaitReason: 'school_auth_required' }), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
    await store.transitionJob(f.claim, ['running'], 'needs_verification', null, 'PLAYBACK_REPORT_UNKNOWN', { outcome: 'interrupted' });
    assert.equal((await store.getJob(f.owner, f.queued.id))?.authWait, null); const fresh = await f.login();
    await assert.rejects(store.continueJob(f.owner, f.failed.id, randomUUID(), playbackContinuationHash(f.failed.id), auth(fresh, f.failed)), { code: 'PLAYBACK_CONTINUATION_UNAVAILABLE' });
    assert.equal((await pool.query('SELECT 1 FROM playback_auth_waits WHERE job_id=ANY($1::uuid[])', [[f.failed.id, f.queued.id]])).rowCount, 0);
  });
  it('foreign owners, cancellation and manual leases cannot consume a wait', async () => {
    const f = await fixture(); await f.fail(); const other = await fixture(), otherFresh = await other.login();
    await assert.rejects(store.continueJob(other.owner, f.queued.id, randomUUID(), playbackContinuationHash(f.queued.id), auth(otherFresh, f.queued)), { code: 'NOT_FOUND' });
    await store.cancelJob(f.owner, f.queued.id); const fresh = await f.login();
    await assert.rejects(store.continueJob(f.owner, f.queued.id, randomUUID(), playbackContinuationHash(f.queued.id), auth(fresh, f.queued)), { code: 'PLAYBACK_CONTINUATION_UNAVAILABLE' });
    const before = await row(f.future.id);
    await pool.query("INSERT INTO playback_execution_leases(user_id,generation,course_id,module_item_id,token_hash,owner_kind,expires_at) VALUES($1,$2,'10','20',$3,'manual',clock_timestamp()+interval '1 minute')", [f.owner, fresh.generation, 'a'.repeat(64)]);
    await assert.rejects(store.continueJob(f.owner, f.future.id, randomUUID(), playbackContinuationHash(f.future.id), auth(fresh, f.future)), { code: 'PLAYBACK_BUSY' }); assert.deepEqual(await row(f.future.id), before);
  });
  it('another waiting intent can queue behind a proven active worker of the same current generation', async () => {
    const f = await fixture(); await f.fail(); const fresh = await f.login();
    const first = await store.continueJob(f.owner, f.queued.id, randomUUID(), playbackContinuationHash(f.queued.id), auth(fresh, f.queued));
    const running = (await store.claimJob(first.job.id))!;
    await pool.query("INSERT INTO playback_execution_leases(user_id,generation,course_id,module_item_id,token_hash,owner_kind,expires_at) VALUES($1,$2,'10','21',$3,'worker',clock_timestamp()+interval '1 minute')", [f.owner, fresh.generation, running.executionTokenHash]);
    const next = await store.continueJob(f.owner, f.failed.id, randomUUID(), playbackContinuationHash(f.failed.id), auth(fresh, f.failed));
    assert.equal(next.job.status, 'queued'); assert.equal((await store.getJob(f.owner, running.id))?.status, 'running');
    assert.equal((await pool.query('SELECT token_hash FROM playback_execution_leases WHERE user_id=$1', [f.owner])).rows[0]?.token_hash, running.executionTokenHash);
  });
  it('old-generation, orphan and uncertain worker leases cannot bypass the continuation guard', async () => {
    for (const mode of ['old-generation','orphan','uncertain'] as const) {
      const f = await fixture(); await f.fail(); const fresh = await f.login();
      let leaseGeneration = mode === 'old-generation' ? f.generation : fresh.generation, leaseToken = 'b'.repeat(64), lecture = '20';
      if (mode === 'uncertain') {
        const child = await store.continueJob(f.owner, f.queued.id, randomUUID(), playbackContinuationHash(f.queued.id), auth(fresh, f.queued));
        const running = (await store.claimJob(child.job.id))!; leaseToken = running.executionTokenHash!; lecture = '21';
        await store.transitionJob(jobClaim(running), ['running'], 'needs_verification', null, 'PLAYBACK_REPORT_UNKNOWN', { outcome: 'interrupted' });
      }
      await pool.query("INSERT INTO playback_execution_leases(user_id,generation,course_id,module_item_id,token_hash,owner_kind,expires_at) VALUES($1,$2,'10',$3,$4,'worker',clock_timestamp()+interval '1 minute')", [f.owner, leaseGeneration, lecture, leaseToken]);
      const before = await row(f.failed.id);
      await assert.rejects(store.continueJob(f.owner, f.failed.id, randomUUID(), playbackContinuationHash(f.failed.id), auth(fresh, f.failed)), { code: 'PLAYBACK_BUSY' });
      assert.deepEqual(await row(f.failed.id), before);
    }
  });
  it('a child insert failure rolls back old-intent retirement, relation and outbox atomically', async () => {
    const f = await fixture(); await f.fail(); const fresh = await f.login(), before = await row(f.queued.id);
    const name = 'qa_continue_' + randomUUID().replaceAll('-', '');
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic child failure' USING ERRCODE='23514'; END $$`);
    try {
      await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON playback_jobs FOR EACH ROW WHEN (NEW.user_id='${f.owner}'::uuid) EXECUTE FUNCTION ${name}()`);
      try {
        await assert.rejects(store.continueJob(f.owner, f.queued.id, randomUUID(), playbackContinuationHash(f.queued.id), auth(fresh, f.queued)), { code: '23514' });
        assert.deepEqual(await row(f.queued.id), before);
        assert.equal((await store.getJob(f.owner, f.queued.id))?.authWait?.continuedAsJobId, null);
        assert.equal((await pool.query("SELECT 1 FROM playback_jobs WHERE user_id=$1 AND lecture_id='21'", [f.owner])).rowCount, 1);
      } finally { await pool.query(`DROP TRIGGER ${name} ON playback_jobs`); }
    } finally { await pool.query(`DROP FUNCTION ${name}()`); }
  });
  it('original waiting evidence and committed child pointers are immutable', async () => {
    const f = await fixture(); await f.fail(); const fresh = await f.login();
    const result = await store.continueJob(f.owner, f.queued.id, randomUUID(), playbackContinuationHash(f.queued.id), auth(fresh, f.queued));
    await assert.rejects(pool.query("UPDATE playback_auth_waits SET reason='school_session_changed' WHERE job_id=$1", [f.queued.id]));
    await assert.rejects(pool.query('UPDATE playback_auth_waits SET continued_job_id=NULL,continued_at=NULL WHERE job_id=$1', [f.queued.id]));
    assert.equal((await store.getJob(f.owner, f.queued.id))?.authWait?.continuedAsJobId, result.job.id);
  });
});
