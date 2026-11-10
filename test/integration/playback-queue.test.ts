import { before, beforeEach, after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { PgStore, hashToken } from '../../src/store.js';
import { migrate } from '../../src/migrations.js';
import { createPlaybackAdmission, jobClaim } from '../../src/playback-authority.js';
import { dispatchOutbox, QUEUE } from '../../src/queue.js';
import { publicPlaybackQueue } from '../../src/playback-queue.js';
import { executeJob } from '../../src/job-runner.js';
import { unavailableSchoolProvider } from '../../src/provider.js';

const url = process.env.TEST_DATABASE_URL;
if (url && !['/alms_test', '/alms_qa'].includes(new URL(url).pathname)) throw new Error('Use isolated test database');
describe('durable receipt-order scheduler and stored queue in isolated PostgreSQL', { skip: !url }, () => {
  let pool: Pool, store: PgStore, boss: PgBoss, schema: string;
  const owners: string[] = [];
  before(async () => { pool = new Pool({ connectionString: url, max: 12, application_name: 'alms-qa-queue' }); await migrate(pool); store = new PgStore(pool); });
  beforeEach(async () => {
    schema = 'qa_queue_' + randomUUID().replaceAll('-', '');
    boss = new PgBoss({ connectionString: url, schema, supervise: false, schedule: false });
    await boss.start(); await boss.createQueue(QUEUE, { retryLimit: 0, expireInSeconds: 21600 });
  });
  afterEach(async () => {
    await boss?.stop({ graceful: false });
    await pool.query('DELETE FROM playback_auth_waits WHERE job_id IN (SELECT id FROM playback_jobs WHERE user_id=ANY($1::uuid[]))', [owners]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [owners]); owners.length = 0;
    // The name is generated locally above, never derived from a request or environment URL.
    if (schema) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  });
  after(async () => { await pool?.end(); });
  async function fixture() {
    const generation = randomUUID(), encryptedSession = 'synthetic-queue-seal-' + randomUUID();
    const session = await store.issueVerifiedSession({ provider: 'queue-qa', subject: randomUUID() }, 3600,
      { provider: 'ssu', seal: () => encryptedSession }); owners.push(session.user.id);
    const owner = session.user.id;
    const create = (lectureId: string, options: { scheduledFor?: string; duration?: number; courseId?: string; key?: string } = {}) => {
      const courseId = options.courseId ?? '10';
      return store.createJob(owner, { courseId, lectureId, scheduledFor: options.scheduledFor ?? new Date().toISOString(),
        idempotencyKey: options.key ?? randomUUID(), requestHash: hashToken('synthetic-queue-' + lectureId) }, {
        almsTokenHash: hashToken(session.token), admission: createPlaybackAdmission({ userId: owner, courseId, lectureId },
          { generation, encryptedSession }, options.duration),
      });
    };
    return { owner, generation, encryptedSession, session, create };
  }
  const metadata = async (id: string) => (await pool.query('SELECT * FROM playback_queue_metadata WHERE job_id=$1', [id])).rows[0];
  const row = async (id: string) => (await pool.query('SELECT to_jsonb(job) AS value FROM playback_jobs job WHERE id=$1', [id])).rows[0]?.value;
  const markDue = (id: string) => pool.query("UPDATE playback_jobs SET scheduled_for=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);

  it('stores only opaque-admission duration; exact idempotency does not rewrite metadata', async () => {
    const f = await fixture(), key = randomUUID(), first = await f.create('20', { duration: 123.5, key }), before = await metadata(first.id);
    assert.equal(before.duration_seconds, 123.5); assert.notEqual(before.dispatch_id, first.id);
    const repeat = await f.create('20', { duration: 999, key }); assert.equal(repeat.id, first.id);
    assert.deepEqual(await metadata(first.id), before);
    const old = await f.create('21'); assert.equal((await metadata(old.id)).duration_seconds, null);
  });
  it('future reservations join only when due; already dispatched head never lets later work overtake', async () => {
    const f = await fixture(), future = await f.create('20', { scheduledFor: new Date(Date.now() + 3600000).toISOString(), duration: 90 });
    const ready = await f.create('21', { duration: 100 }), later = await f.create('22', { duration: 200 });
    assert.equal(await dispatchOutbox(store, boss), 1);
    assert.ok(await boss.getJobById(QUEUE, (await metadata(ready.id)).dispatch_id));
    assert.equal(await boss.getJobById(QUEUE, (await metadata(later.id)).dispatch_id), null);
    assert.equal(await dispatchOutbox(store, boss), 0);
    await markDue(future.id);
    // The oldest receipt is now due. A delayed delivery of the previous head is safely deferred.
    const oldDelivery = (await metadata(ready.id)).dispatch_id;
    assert.equal(await store.claimJob(ready.id, undefined, oldDelivery), null);
    assert.notEqual((await metadata(ready.id)).dispatch_id, oldDelivery);
    assert.equal(await dispatchOutbox(store, boss), 1);
    assert.equal((await store.claimJob(future.id, undefined, (await metadata(future.id)).dispatch_id))?.id, future.id);
  });
  it('concurrent dispatches commit one broker message and exact head lock does not skip forward', async () => {
    const f = await fixture(), head = await f.create('20'), next = await f.create('21'), locker = await pool.connect();
    try {
      await locker.query('BEGIN'); await locker.query('SELECT 1 FROM job_outbox WHERE job_id=$1 FOR UPDATE', [head.id]);
      assert.equal(await dispatchOutbox(store, boss), 0);
      assert.equal(await boss.getJobById(QUEUE, (await metadata(next.id)).dispatch_id), null);
      await locker.query('ROLLBACK');
      assert.deepEqual((await Promise.all([dispatchOutbox(store, boss), dispatchOutbox(store, boss)])).sort(), [0, 1]);
    } finally { await locker.query('ROLLBACK'); locker.release(); }
  });
  it('production claims fence exact transport and global active execution across owners', async () => {
    const a = await fixture(), b = await fixture(), head = await a.create('20'), next = await b.create('20');
    await dispatchOutbox(store, boss);
    assert.equal(await store.claimJob(head.id, undefined, randomUUID()), null);
    const first = await store.claimJob(head.id, undefined, (await metadata(head.id)).dispatch_id); assert.equal(first?.status, 'running');
    assert.equal(await dispatchOutbox(store, boss), 0);
    const before = await row(next.id), delivery = (await metadata(next.id)).dispatch_id;
    assert.equal(await store.claimJob(next.id, undefined, delivery), null);
    assert.deepEqual(await row(next.id), before); assert.notEqual((await metadata(next.id)).dispatch_id, delivery);
    assert.equal(await store.claimJob(head.id, undefined, (await metadata(head.id)).dispatch_id), null);
  });
  it('manual or uncertain live lease blocks dispatch without altering jobs or transport identity', async () => {
    const f = await fixture(), value = await f.create('20'), before = await row(value.id), meta = await metadata(value.id);
    await pool.query("INSERT INTO playback_execution_leases(user_id,generation,course_id,module_item_id,token_hash,owner_kind,expires_at) VALUES($1,$2,'10','20',$3,'manual',clock_timestamp()+interval '1 minute')", [f.owner, f.generation, 'a'.repeat(64)]);
    assert.equal(await dispatchOutbox(store, boss), 0); assert.deepEqual(await row(value.id), before); assert.deepEqual(await metadata(value.id), meta);
    assert.equal(publicPlaybackQueue(await store.getJobQueueSnapshot(f.owner), 'ready').items[0]?.estimateReason, 'execution_blocked');
  });
  it('consumed or missing untouched transports get a new durable ID, while delayed old deliveries cannot claim', async () => {
    const f = await fixture(), value = await f.create('20', { duration: 70 }), before = await row(value.id);
    await dispatchOutbox(store, boss); const first = (await metadata(value.id)).dispatch_id;
    await boss.complete(QUEUE, first, null, { includeQueued: true });
    assert.equal((await boss.getJobById(QUEUE, first))?.state, 'completed');
    assert.equal(await dispatchOutbox(store, boss), 1);
    const second = (await metadata(value.id)).dispatch_id; assert.notEqual(first, second);
    assert.equal(await store.claimJob(value.id, undefined, first), null); assert.deepEqual(await row(value.id), before);
    await boss.cancel(QUEUE, second); assert.equal(await dispatchOutbox(store, boss), 1);
    assert.notEqual((await metadata(value.id)).dispatch_id, second); assert.equal((await metadata(value.id)).duration_seconds, 70);
  });
  it('legacy non-head delivery is deferred without losing its original intent or inventing duration', async () => {
    const f = await fixture(), head = await f.create('20'), later = await f.create('21'), before = await row(later.id);
    await pool.query('DELETE FROM playback_queue_metadata WHERE job_id=$1', [later.id]);
    await pool.query('UPDATE job_outbox SET dispatched_at=clock_timestamp() WHERE job_id=$1', [later.id]);
    await boss.send(QUEUE, { jobId: later.id }, { id: later.id, retryLimit: 0 });
    assert.equal(await store.claimJob(later.id, undefined, later.id), null);
    assert.deepEqual(await row(later.id), before); assert.equal((await metadata(later.id)).duration_seconds, null);
    assert.notEqual((await metadata(later.id)).dispatch_id, later.id);
    await store.cancelJob(f.owner, head.id);
    assert.equal(await dispatchOutbox(store, boss), 1);
    assert.equal((await store.claimJob(later.id, undefined, (await metadata(later.id)).dispatch_id))?.id, later.id);
  });
  it('unknown execution and any prior token evidence are never recycled as untouched intent', async () => {
    const f = await fixture(), unknown = await f.create('20'), touched = await f.create('21'), next = await f.create('22');
    await dispatchOutbox(store, boss); const delivery = (await metadata(unknown.id)).dispatch_id;
    const claimed = (await store.claimJob(unknown.id, undefined, delivery))!;
    await store.transitionJob(jobClaim(claimed), ['running'], 'needs_verification', null, 'PLAYBACK_REPORT_UNKNOWN', { outcome: 'interrupted' });
    await pool.query("UPDATE playback_jobs SET last_execution_token_hash=$2 WHERE id=$1", [touched.id, 'c'.repeat(64)]);
    const beforeUnknown = await row(unknown.id), beforeTouched = await row(touched.id), unknownMeta = await metadata(unknown.id), touchedMeta = await metadata(touched.id);
    await boss.complete(QUEUE, delivery, null, { includeQueued: true });
    assert.equal(await dispatchOutbox(store, boss), 1);
    assert.ok(await boss.getJobById(QUEUE, (await metadata(next.id)).dispatch_id));
    assert.equal(await store.claimJob(unknown.id, undefined, delivery), null);
    assert.equal(await store.claimJob(touched.id, undefined, touchedMeta.dispatch_id), null);
    assert.deepEqual(await row(unknown.id), beforeUnknown); assert.deepEqual(await row(touched.id), beforeTouched);
    assert.deepEqual(await metadata(unknown.id), unknownMeta); assert.deepEqual(await metadata(touched.id), touchedMeta);
  });
  it('broker insertion and outbox marking roll back together after a post-send failure', async () => {
    const f = await fixture(), value = await f.create('20'), meta = await metadata(value.id);
    const name = 'qa_queue_fail_' + randomUUID().replaceAll('-', '');
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic queue write failure'; END $$`);
    try {
      await pool.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON job_outbox FOR EACH ROW WHEN (NEW.job_id='${value.id}'::uuid) EXECUTE FUNCTION ${name}()`);
      await assert.rejects(dispatchOutbox(store, boss));
      assert.equal(await boss.getJobById(QUEUE, meta.dispatch_id), null);
      assert.equal((await pool.query('SELECT dispatched_at FROM job_outbox WHERE job_id=$1', [value.id])).rows[0].dispatched_at, null);
      assert.deepEqual(await metadata(value.id), meta);
    } finally { await pool.query(`DROP TRIGGER IF EXISTS ${name} ON job_outbox`); await pool.query(`DROP FUNCTION ${name}()`); }
    assert.equal(await dispatchOutbox(store, boss), 1);
  });
  it('a lost dispatch commit response does not produce a second broker message', async () => {
    const f = await fixture(), value = await f.create('20'), meta = await metadata(value.id);
    const ambiguous = Object.create(store) as PgStore;
    ambiguous.workerTransaction = async (run, operation) => {
      await store.workerTransaction(run, operation); throw new Error('synthetic response lost after commit');
    };
    await assert.rejects(dispatchOutbox(ambiguous, boss));
    assert.ok(await boss.getJobById(QUEUE, meta.dispatch_id));
    assert.equal(await dispatchOutbox(store, boss), 0); assert.deepEqual(await metadata(value.id), meta);
  });
  it('a lost claim commit response cannot be recycled even after its broker message is consumed', async () => {
    const f = await fixture(), value = await f.create('20'); await dispatchOutbox(store, boss);
    const meta = await metadata(value.id), ambiguous = Object.create(store) as PgStore; let schoolCalls = 0;
    ambiguous.claimJob = async (...args) => { await store.claimJob(...args); throw new Error('synthetic claim response lost after commit'); };
    await executeJob(value.id, ambiguous, { ...unavailableSchoolProvider, play: async () => { schoolCalls++; } }, undefined, 1000, {}, meta.dispatch_id);
    await boss.complete(QUEUE, meta.dispatch_id, null, { includeQueued: true });
    assert.equal(schoolCalls, 0); assert.equal((await row(value.id)).status, 'running');
    assert.equal(await dispatchOutbox(store, boss), 0); assert.deepEqual(await metadata(value.id), meta);
    await pool.query("UPDATE playback_jobs SET heartbeat_at=clock_timestamp()-interval '2 minutes' WHERE id=$1", [value.id]);
    await store.recoverStaleJobs(); const unknown = await row(value.id);
    assert.equal(unknown.status, 'needs_verification'); assert.equal(await dispatchOutbox(store, boss), 0);
    assert.deepEqual(await row(value.id), unknown); assert.deepEqual(await metadata(value.id), meta);
  });
  it('queue snapshot finds old pending work beyond history cap, is complete/count-correct and does not rewrite rows', async () => {
    const f = await fixture(), pending = await f.create('20', { duration: 120 });
    await pool.query(`INSERT INTO playback_jobs(id,user_id,course_id,lecture_id,status,scheduled_for,idempotency_key,request_hash,created_at)
      SELECT gen_random_uuid(),$1,'10','history-'||n,'completed',clock_timestamp(),gen_random_uuid(),'synthetic',clock_timestamp()+interval '1 second'
      FROM generate_series(1,205) n`, [f.owner]);
    const before = (await pool.query('SELECT md5(string_agg(to_jsonb(j)::text,\'\' ORDER BY id)) AS hash FROM playback_jobs j WHERE user_id=$1', [f.owner])).rows[0].hash;
    assert.equal((await store.listJobs(f.owner)).some(value => value.id === pending.id), false);
    const view = await store.getJobQueueSnapshot(f.owner);
    assert.deepEqual(view.counts, { active: 0, waiting: 1, total: 1 }); assert.equal(view.complete, true); assert.equal(view.jobs[0]?.id, pending.id);
    assert.equal((await pool.query('SELECT md5(string_agg(to_jsonb(j)::text,\'\' ORDER BY id)) AS hash FROM playback_jobs j WHERE user_id=$1', [f.owner])).rows[0].hash, before);
  });
  it('queue limit is independent of exact counts and keeps active first with owner/course isolation', async () => {
    const f = await fixture(), foreign = await fixture(); await foreign.create('20');
    const running = await f.create('20'), active = (await store.claimJob(running.id))!;
    await store.recordPlaybackObservation(jobClaim(active), { observedAt: new Date().toISOString(), positionSeconds: 25, durationSeconds: 100, percent: 25, paused: false, ended: false });
    await pool.query(`INSERT INTO playback_jobs(id,user_id,course_id,lecture_id,status,scheduled_for,idempotency_key,request_hash,accepted_generation,created_at)
      SELECT gen_random_uuid(),$1,'10','pending-'||n,'queued',clock_timestamp(),gen_random_uuid(),'synthetic',$2,clock_timestamp()-interval '1 day'
      FROM generate_series(1,201) n`, [f.owner, f.generation]);
    await f.create('other-course', { courseId: '11' });
    const view = await store.getJobQueueSnapshot(f.owner, '10'), response = publicPlaybackQueue(view, 'ready');
    assert.deepEqual(view.counts, { active: 1, waiting: 201, total: 202 }); assert.equal(view.jobs.length, 200); assert.equal(view.hasMore, true); assert.equal(view.complete, false);
    assert.equal(view.jobs[0]?.id, active.id); assert.equal(view.jobs[0]?.playbackProgress?.positionSeconds, 25);
    assert.ok(view.jobs.every(value => value.userId === f.owner && value.courseId === '10'));
    assert.doesNotMatch(JSON.stringify(response), new RegExp(foreign.owner));
  });
  it('proven-unstarted authentication waits remain visible while unknown terminal history is excluded', async () => {
    const f = await fixture(), failed = await f.create('20'), waiting = await f.create('21');
    const active = (await store.claimJob(failed.id))!;
    await store.transitionJob(jobClaim(active), ['running'], 'needs_reauthentication', null, 'AUTH_REQUIRED', { outcome: 'not_started', authenticationWaitReason: 'school_auth_required' });
    const view = await store.getJobQueueSnapshot(f.owner);
    assert.deepEqual(view.counts, { active: 0, waiting: 2, total: 2 }); assert.deepEqual(new Set(view.jobs.map(value => value.id)), new Set([failed.id, waiting.id]));
    assert.ok(publicPlaybackQueue(view, 'ready').items.every(value => value.waitReason === 'authentication_wait' && value.position === null));
  });
});
