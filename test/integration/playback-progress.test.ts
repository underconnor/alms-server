import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { PgStore, hashToken } from '../../src/store.js';
import { migrate } from '../../src/migrations.js';
import { createPlaybackAdmission, jobClaim, type WorkerClaim } from '../../src/playback-authority.js';
import { publicJob } from '../../src/domain.js';
import type { PlaybackObservation } from '../../src/playback-progress.js';
const url = process.env.TEST_DATABASE_URL;
if (url && !['/alms_test','/alms_qa'].includes(new URL(url).pathname)) throw new Error('Use isolated test database');
describe('durable real-playback observations in isolated PostgreSQL', { skip: !url }, () => {
  let pool: Pool, store: PgStore; const owners: string[] = [];
  before(async () => { pool = new Pool({ connectionString: url, max: 8, application_name: 'alms-qa-progress' }); await migrate(pool); store = new PgStore(pool); });
  after(async () => { if (pool) { await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [owners]); await pool.end(); } });
  async function fixture() {
    const generation = randomUUID(), encryptedSession = 'synthetic-progress-school-' + randomUUID();
    const session = await store.issueVerifiedSession({ provider: 'progress-qa', subject: randomUUID() }, 3600,
      { provider: 'ssu', seal: () => encryptedSession }); owners.push(session.user.id);
    const target = { courseId: '10', lectureId: '20' };
    const job = await store.createJob(session.user.id, { ...target, scheduledFor: new Date().toISOString(),
      idempotencyKey: randomUUID(), requestHash: hashToken('synthetic-progress') }, {
      almsTokenHash: hashToken(session.token), admission: createPlaybackAdmission({ userId: session.user.id, ...target }, { generation, encryptedSession }),
    });
    const claim = jobClaim((await store.claimJob(job.id))!); return { owner: session.user.id, job, claim };
  }
  const baseline = Date.now() - 10000;
  const observation = (positionSeconds = 30, millis = 0): PlaybackObservation => ({ observedAt: new Date(baseline + millis).toISOString(),
    positionSeconds, durationSeconds: 100, percent: positionSeconds, paused: false, ended: positionSeconds === 100 });
  const ack = (event: 'playing'|'update'|'ended', millis = 0) => ({ event, acknowledgedAt: new Date(baseline + millis).toISOString() });
  it('persists owner-scoped progress and ACK across stores without changing the job or school result', async () => {
    const f = await fixture(), other = await fixture();
    const before = (await pool.query('SELECT to_jsonb(j) AS row FROM playback_jobs j WHERE id=$1', [f.job.id])).rows[0].row;
    assert.equal((await store.getJob(f.owner, f.job.id))?.playbackProgress, null);
    assert.equal(await store.recordPlaybackReportAck(f.claim, ack('playing')), true);
    assert.equal((await store.getJob(f.owner, f.job.id))?.playbackProgress, null);
    assert.equal(await store.recordPlaybackObservation(f.claim, observation()), true);
    const reloaded = await new PgStore(pool).getJob(f.owner, f.job.id);
    assert.deepEqual(reloaded?.playbackProgress, { ...observation(), lastReport: ack('playing') });
    assert.equal(reloaded?.schoolResult, null); assert.equal(reloaded?.status, 'running');
    assert.equal(await store.getJob(other.owner, f.job.id), null);
    assert.equal((await store.listJobs(f.owner))[0]?.playbackProgress?.percent, 30);
    assert.deepEqual((await pool.query('SELECT to_jsonb(j) AS row FROM playback_jobs j WHERE id=$1', [f.job.id])).rows[0].row, before);
    assert.doesNotMatch(JSON.stringify(publicJob(reloaded!)), /token|userId|acceptedGeneration|synthetic-progress-school/);
  });
  it('rejects every altered owner, target, generation, token and job claim', async () => {
    const f = await fixture(), other = await fixture();
    for (const bad of [{ ...f.claim, jobId: randomUUID() }, { ...f.claim, userId: other.owner }, { ...f.claim, courseId: '11' },
      { ...f.claim, lectureId: '21' }, { ...f.claim, acceptedGeneration: randomUUID() }, { ...f.claim, executionTokenHash: randomBytes(32).toString('hex') }]) {
      assert.equal(await store.recordPlaybackObservation(bad, observation()), false);
      assert.equal(await store.recordPlaybackReportAck(bad, ack('playing')), false);
    }
    assert.equal((await pool.query('SELECT 1 FROM playback_job_progress WHERE job_id=$1', [f.job.id])).rowCount, 0);
  });
  it('rejects malformed or regressing observations and ACK without erasing latest records', async () => {
    const f = await fixture();
    assert.equal(await store.recordPlaybackObservation(f.claim, { ...observation(), percent: 99 }), false);
    assert.equal(await store.recordPlaybackObservation(f.claim, { ...observation(), observedAt: new Date(Date.now()+60000).toISOString() }), false);
    assert.equal(await store.recordPlaybackReportAck(f.claim, { ...ack('playing'), acknowledgedAt: new Date(Date.now()+60000).toISOString() }), false);
    assert.equal(await store.recordPlaybackObservation(f.claim, observation(50, 2000)), true);
    assert.equal(await store.recordPlaybackObservation(f.claim, observation(49, 3000)), false);
    assert.equal(await store.recordPlaybackObservation(f.claim, observation(60, 1000)), false);
    assert.equal(await store.recordPlaybackReportAck(f.claim, ack('update', 2000)), true);
    assert.equal(await store.recordPlaybackReportAck(f.claim, ack('playing', 3000)), false);
    assert.equal(await store.recordPlaybackReportAck(f.claim, ack('ended', 1000)), false);
    assert.equal((await store.getJob(f.owner, f.job.id))?.playbackProgress?.percent, 50);
    assert.equal((await store.getJob(f.owner, f.job.id))?.playbackProgress?.lastReport?.event, 'update');
  });
  it('retains last-known progress after terminal release and rejects late writes', async () => {
    const f = await fixture(); await store.recordPlaybackObservation(f.claim, observation(45));
    await store.transitionJob(f.claim, ['running'], 'failed', null, 'SYNTHETIC_PROGRESS_STOP', { outcome: 'interrupted' });
    assert.equal(await store.recordPlaybackObservation(f.claim, observation(80, 1000)), false);
    assert.equal(await store.recordPlaybackReportAck(f.claim, ack('ended', 1000)), false);
    const job = await store.getJob(f.owner, f.job.id);
    assert.equal(job?.playbackProgress?.percent, 45); assert.equal(job?.playbackProgress?.ended, false); assert.equal(job?.schoolResult, null);
  });
  it('a different execution token cannot inherit an earlier observation or ACK', async () => {
    const f = await fixture(); await store.recordPlaybackObservation(f.claim, observation(60)); await store.recordPlaybackReportAck(f.claim, ack('update'));
    const token = randomBytes(32).toString('hex');
    await pool.query('UPDATE playback_jobs SET execution_token_hash=$2,last_execution_token_hash=$2 WHERE id=$1', [f.job.id, token]);
    const next: WorkerClaim = { ...f.claim, executionTokenHash: token };
    assert.equal((await store.getJob(f.owner, f.job.id))?.playbackProgress, null);
    assert.equal(await store.recordPlaybackObservation(next, observation(0, 1000)), true);
    assert.deepEqual((await store.getJob(f.owner, f.job.id))?.playbackProgress, { ...observation(0, 1000), lastReport: null });
    assert.equal(await store.recordPlaybackReportAck(f.claim, ack('ended', 2000)), false);
  });
  it('a terminal release winning the row lock is rechecked before telemetry can commit', async () => {
    const f = await fixture(), locker = await pool.connect(); let pending: Promise<boolean> | undefined;
    try {
      await locker.query('BEGIN');
      await locker.query("UPDATE playback_jobs SET status='failed',execution_token_hash=NULL WHERE id=$1", [f.job.id]);
      pending = store.recordPlaybackObservation(f.claim, observation(), { timeoutMs: 5000 });
      const deadline = Date.now() + 3000; let waiting = false;
      while (Date.now() < deadline) {
        const count = (await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name='alms-qa-progress' AND wait_event_type='Lock' AND query LIKE '%INSERT INTO playback_job_progress%'" )).rowCount;
        if (count) { waiting = true; break; } await delay(10);
      }
      assert.equal(waiting, true); await locker.query('COMMIT'); assert.equal(await pending, false);
      assert.equal((await pool.query('SELECT 1 FROM playback_job_progress WHERE job_id=$1', [f.job.id])).rowCount, 0);
    } finally { await locker.query('ROLLBACK'); locker.release(); await pending; }
  });
  it('readiness refuses a database missing the additive progress migration', async () => {
    const transaction = await pool.connect();
    try {
      await transaction.query('BEGIN'); await transaction.query("DELETE FROM schema_migrations WHERE name='016-playback-job-progress.sql'");
      await assert.rejects(new PgStore(transaction as unknown as Pool).health(), /migrations are pending/);
    } finally { await transaction.query('ROLLBACK'); transaction.release(); }
  });
});
