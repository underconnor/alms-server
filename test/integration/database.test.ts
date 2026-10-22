import { after,before,describe,it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomBytes,randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createPlaybackAdmission, createPlaybackFinalProof, jobClaim, type WorkerClaim } from '../../src/playback-authority.js';
import type { PreparedPlayback } from '../../src/provider.js';
import type { NewJobInput } from '../../src/store.js';
import { PgStore,hashToken } from '../../src/store.js';
import { migrate } from '../../src/migrations.js';
import { executeJob } from '../../src/job-runner.js';
import { workerTransaction, workerPgOptions } from '../../src/worker-bounds.js';
import { unavailableSchoolProvider,type SchoolProvider } from '../../src/provider.js';
import { createQueueClient,startWorker,QUEUE } from '../../src/queue.js';
import { decryptSchoolSession } from '../../src/crypto.js';
import { AppError } from '../../src/errors.js';
import { createSchoolProvider } from '../../src/school-adapter.js';
import { LmsExchangeError, type LearningxClient } from '@alms/ssu-api';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && !['/alms_test','/alms_qa'].includes(new URL(databaseUrl).pathname)) throw new Error('Use an isolated alms_test or alms_qa database');
const waitFor = async (predicate: () => Promise<boolean>,timeout = 5000) => {
  const end = Date.now()+timeout;
  while (Date.now()<end) { if (await predicate()) return; await delay(15); }
  assert.fail('Condition did not become true before deadline');
};
const sessionCookieFrom = (value: string | string[] | undefined) => {
  const cookie = (Array.isArray(value) ? value : value ? [value] : [])
    .find(item => item.startsWith('__Host-alms_session='));
  assert.ok(cookie, 'The verified callback must issue the ALMS session cookie');
  return cookie.split(';')[0]!;
};

describe('real PostgreSQL: migrations, auth, ownership and durable jobs',{ skip: !databaseUrl },() => {
  let pool: Pool; let store: PgStore; let app: FastifyInstance;
  let a: Awaited<ReturnType<PgStore['issueVerifiedSession']>>;
  let b: Awaited<ReturnType<PgStore['issueVerifiedSession']>>;
  const authUsers: string[] = [];
  const generations = new Map<string, string>();
  const preparedClaims = new WeakMap<PreparedPlayback, WorkerClaim>();
  const generationFor = (owner: string) => { if (!generations.has(owner)) generations.set(owner, randomUUID()); return generations.get(owner)!; };
  const admission = async (owner: string, courseId: string, lectureId: string) => createPlaybackAdmission({ userId: owner, courseId, lectureId },
    { generation: generationFor(owner), encryptedSession: (await store.getEncryptedSchoolSession(owner, 'ssu'))! });
  const createAuthorizedJob = async (owner: string, input: NewJobInput, token = a.token) => store.createJob(owner, input,
    { admission: await admission(owner, input.courseId, input.lectureId), almsTokenHash: hashToken(token) });
  const proof = async (claim: WorkerClaim) => createPlaybackFinalProof(claim,
    { generation: generationFor(claim.userId), encryptedSession: (await store.getEncryptedSchoolSession(claim.userId, 'ssu'))! });
  const testProvider: SchoolProvider = {
    capabilities: { schoolAuthentication: false,schoolRead: false,playback: true,pauseResume: false },
    authorizePlayback: async (context, target, options) => { await options.validate(); return admission(context.userId, target.courseId, target.lectureId); },
    preparePlayback: async context => { const prepared = { alreadyRecognized: false, handle: {}, dispose: async () => {} }; preparedClaims.set(prepared, context.claim); return prepared; },
    validatePlayback: async prepared => proof(preparedClaims.get(prepared)!),
    play: async () => {},
    playbackLearningStatus: async () => ({ observedAt: new Date().toISOString(),progressPercent: 100,attendance: 'present',recognized: true }),
  };
  before(async () => {
    pool = new Pool({ connectionString: databaseUrl,max: 10 }); store = new PgStore(pool);
    await migrate(pool); await migrate(pool);
    a = await store.issueVerifiedSession({ provider: 'integration-test',subject: randomUUID() },3600,{provider:'ssu',seal:()=> 'synthetic-school-a'});
    b = await store.issueVerifiedSession({ provider: 'integration-test',subject: randomUUID() },3600,{provider:'ssu',seal:()=> 'synthetic-school-b'});
    app = await buildApp(loadConfig({ DATABASE_URL: databaseUrl,LOG_LEVEL: 'silent' }),store,testProvider,undefined,undefined,{isReady:async()=>true});
  });
  after(async () => {
    if (app) await app.close();
    if (pool) {
      if (a && b) {
        const owners=[a.user.id,b.user.id,...authUsers];
        const jobs=await pool.query('SELECT id FROM playback_jobs WHERE user_id=ANY($1::uuid[])',[owners]);
        if (jobs.rowCount) {
          const cleanupQueue=createQueueClient(databaseUrl!); cleanupQueue.on('error',() => {});
          try { await cleanupQueue.start(); await cleanupQueue.deleteJob(QUEUE,jobs.rows.map(row => row.id)); }
          finally { await cleanupQueue.stop(); }
        }
        await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[owners]);
      }
      await pool.end();
    }
  });
  const headers = (session: typeof a) => ({ cookie: '__Host-alms_session=' + session.token,origin: 'https://lms.flyjung.kr','x-csrf-token': session.csrfToken,accept: 'application/json; alms-playback=2' });
  const makeJob = (lecture = randomUUID()) => createAuthorizedJob(a.user.id,{ courseId: 'synthetic-course',lectureId: lecture,scheduledFor: new Date().toISOString(),idempotencyKey: randomUUID(),requestHash: hashToken(lecture) });

  it('persists only a session hash; auth, CSRF and origin are enforced',async () => {
    assert.equal((await app.inject('/v1/me')).statusCode,401);
    const me = await app.inject({ url: '/v1/me',headers: headers(a) });
    assert.equal(me.statusCode,200); assert.equal(me.json().user.id,a.user.id);
    assert.equal(me.headers['access-control-allow-origin'],'https://lms.flyjung.kr');
    const row = await pool.query('SELECT token_hash FROM sessions WHERE user_id=$1',[a.user.id]);
    assert.equal(row.rows[0].token_hash,hashToken(a.token)); assert.notEqual(row.rows[0].token_hash,a.token);
    assert.equal((await app.inject({ method: 'POST',url: '/v1/todos',headers: { cookie: headers(a).cookie,origin: headers(a).origin },payload: { title: 'CSRF missing' } })).statusCode,403);
    assert.equal((await app.inject({ method: 'POST',url: '/v1/todos',headers: { ...headers(a),origin: 'https://evil.example' },payload: { title: 'bad origin' } })).statusCode,403);
    assert.equal((await app.inject({ method: 'POST',url: '/v1/todos',headers: headers(a),payload: { title: 'forged owner',userId: b.user.id } })).statusCode,400);
    assert.equal((await app.inject({ method: 'PATCH',url: '/v1/me/preferences',headers: headers(a),payload: { analyticsEnabled: true } })).statusCode,200);
    const analytics=(await app.inject({ url: '/v1/me',headers: headers(a) })).json().analytics;
    assert.equal(analytics.collection,'required'); assert.equal(analytics.configured,false); assert.equal(analytics.enabled,true); assert.equal(analytics.delivery,'local');
  });
  it('real TODO CRUD remains isolated across users',async () => {
    const made = await app.inject({ method: 'POST',url: '/v1/todos',headers: headers(a),payload: { title: 'private test task' } });
    assert.equal(made.statusCode,201); const todo = made.json();
    assert.equal((await app.inject({ url: '/v1/todos',headers: headers(b) })).json().items.some((t: any) => t.id===todo.id),false);
    assert.equal((await app.inject({ method: 'PATCH',url: '/v1/todos/'+todo.id,headers: headers(b),payload: { completed: true } })).statusCode,404);
    assert.equal((await app.inject({ method: 'DELETE',url: '/v1/todos/'+todo.id,headers: headers(b) })).statusCode,404);
    const updated = await app.inject({ method: 'PATCH',url: '/v1/todos/'+todo.id,headers: headers(a),payload: { completed: true } });
    assert.equal(updated.json().completed,true);
    assert.equal((await app.inject({ method: 'DELETE',url: '/v1/todos/'+todo.id,headers: headers(a) })).statusCode,204);
  });
  it('real list caps distinguish exact boundaries from truncation within owner and course scope', async () => {
    const own = await store.issueVerifiedSession({ provider: 'integration-test', subject: randomUUID() }, 3600);
    const foreign = await store.issueVerifiedSession({ provider: 'integration-test', subject: randomUUID() }, 3600);
    authUsers.push(own.user.id, foreign.user.id);
    const ownHeaders = headers(own);
    for (const [url, limit] of [['/v1/todos', 500], ['/v1/jobs?courseId=cap-course-a', 200]] as const) {
      const response = await app.inject({ url, headers: ownHeaders });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { items: [], complete: true, hasMore: false, limit });
    }
    const todos = await pool.query(`INSERT INTO todos(id,user_id,title)
      SELECT gen_random_uuid(),$1,'synthetic TODO '||n FROM generate_series(1,500) AS n RETURNING id`, [own.user.id]);
    await pool.query("INSERT INTO todos(id,user_id,title) VALUES(gen_random_uuid(),$1,'foreign TODO')", [foreign.user.id]);
    const exactTodos = await app.inject({ url: '/v1/todos', headers: ownHeaders });
    assert.equal(exactTodos.json().items.length, 500); assert.equal(exactTodos.json().complete, true); assert.equal(exactTodos.json().hasMore, false);
    assert.deepEqual(exactTodos.json().items.map((item: { id: string }) => item.id), todos.rows.map(row => row.id).sort().reverse());
    assert.equal((await store.listTodos(own.user.id)).length, 500);
    await pool.query("INSERT INTO todos(id,user_id,title) VALUES(gen_random_uuid(),$1,'sentinel TODO')", [own.user.id]);
    const truncatedTodos = await app.inject({ url: '/v1/todos', headers: ownHeaders });
    assert.equal(truncatedTodos.json().items.length, 500); assert.equal(truncatedTodos.json().complete, false); assert.equal(truncatedTodos.json().hasMore, true);
    assert.equal((await store.listTodos(own.user.id, 501)).length, 501);
    assert.equal(truncatedTodos.json().items.some((item: { title: string }) => item.title === 'foreign TODO'), false);

    const jobs = await pool.query(`INSERT INTO playback_jobs(id,user_id,course_id,lecture_id,status,scheduled_for,idempotency_key,request_hash)
      SELECT gen_random_uuid(),$1,'cap-course-a',n::text,'cancelled',now(),gen_random_uuid(),'synthetic-private-hash'
      FROM generate_series(1,200) AS n RETURNING id`, [own.user.id]);
    for (const [userId, courseId] of [[own.user.id, 'cap-course-b'], [foreign.user.id, 'cap-course-a']])
      await pool.query(`INSERT INTO playback_jobs(id,user_id,course_id,lecture_id,status,scheduled_for,idempotency_key,request_hash)
        VALUES(gen_random_uuid(),$1,$2,'outside-scope','cancelled',now(),gen_random_uuid(),'synthetic-private-hash')`, [userId, courseId]);
    const exactJobs = await app.inject({ url: '/v1/jobs?courseId=cap-course-a', headers: ownHeaders });
    assert.equal(exactJobs.statusCode, 200); assert.equal(exactJobs.json().items.length, 200);
    assert.equal(exactJobs.json().complete, true); assert.equal(exactJobs.json().hasMore, false);
    assert.deepEqual(exactJobs.json().items.map((item: { id: string }) => item.id), jobs.rows.map(row => row.id).sort().reverse());
    assert.equal((await store.listJobs(own.user.id, 'cap-course-a')).length, 200);
    assert.equal((await app.inject({ url: '/v1/jobs', headers: ownHeaders })).json().hasMore, true);
    await pool.query(`INSERT INTO playback_jobs(id,user_id,course_id,lecture_id,status,scheduled_for,idempotency_key,request_hash)
      VALUES(gen_random_uuid(),$1,'cap-course-a','sentinel','cancelled',now(),gen_random_uuid(),'synthetic-private-hash')`, [own.user.id]);
    const truncatedJobs = await app.inject({ url: '/v1/jobs?courseId=cap-course-a', headers: ownHeaders });
    assert.equal(truncatedJobs.statusCode, 200); assert.equal(truncatedJobs.json().items.length, 200);
    assert.equal(truncatedJobs.json().complete, false); assert.equal(truncatedJobs.json().hasMore, true);
    assert.equal((await store.listJobs(own.user.id, 'cap-course-a', 201)).length, 201);
    assert.equal(truncatedJobs.json().items.every((item: { courseId: string; lectureId: string }) => item.courseId === 'cap-course-a' && item.lectureId !== 'outside-scope'), true);
  });
  it('school jar refresh is scoped to the owner and cannot overwrite a newer login', async () => {
    const issued = await store.issueVerifiedSession({ provider: 'integration-test', subject: randomUUID() }, 3600,
      { provider: 'synthetic', seal: () => 'synthetic-encrypted-original' });
    authUsers.push(issued.user.id);
    assert.equal(await store.replaceEncryptedSchoolSession(b.user.id, 'synthetic', 'synthetic-encrypted-original', 'wrong-owner'), false);
    assert.equal(await store.replaceEncryptedSchoolSession(issued.user.id, 'other-provider', 'synthetic-encrypted-original', 'wrong-provider'), false);
    assert.equal(await store.replaceEncryptedSchoolSession(issued.user.id, 'synthetic', 'synthetic-encrypted-original', 'synthetic-new-login'), true);
    assert.equal(await store.replaceEncryptedSchoolSession(issued.user.id, 'synthetic', 'synthetic-encrypted-original', 'stale-jar'), false);
    assert.equal(await store.getEncryptedSchoolSession(issued.user.id, 'synthetic'), 'synthetic-new-login');
  });
  it('concurrent idempotent job creates return one durable job and reject different work',async () => {
    const payload = { courseId: 'synthetic-course',lectureId: randomUUID(),scheduledFor: new Date(Date.now()+60000).toISOString() };
    const h = { ...headers(a),'idempotency-key': randomUUID() };
    const responses = await Promise.all([1,2].map(() => app.inject({ method: 'POST',url: '/v1/jobs',headers: h,payload })));
    assert.equal(responses[0]!.statusCode,202); assert.equal(responses[1]!.statusCode,202);
    const id = responses[0]!.json().id; assert.equal(responses[1]!.json().id,id);
    assert.equal((await app.inject({ method: 'POST',url: '/v1/jobs',headers: h,payload: { ...payload,lectureId: randomUUID() } })).statusCode,409);
    assert.equal((await app.inject({ method: 'POST',url: '/v1/jobs',headers: { ...h,'idempotency-key': randomUUID() },payload })).statusCode,409);
    assert.equal((await app.inject({ url: '/v1/jobs/'+id,headers: headers(b) })).statusCode,404);
    assert.equal((await app.inject({ method: 'POST',url: '/v1/jobs/'+id+'/cancel',headers: headers(b) })).statusCode,404);
    assert.equal((await app.inject({ method: 'POST',url: '/v1/jobs/'+id+'/cancel',headers: headers(a) })).json().status,'cancelled');
    assert.equal(await store.claimJob(id),null);
  });
  it('aborting a row-lock-blocked success CAS cancels the SQL instead of committing after the lock is released', async () => {
    const job = await makeJob(); const claim = jobClaim((await store.claimJob(job.id))!); await store.transitionJob(claim, ['running'], 'reconciling');
    const workerPool = new Pool({ connectionString: databaseUrl, max: 1, application_name: 'alms-test-worker-cancel', ...workerPgOptions });
    const workerStore = new PgStore(workerPool); const locker = await pool.connect(); const abort = new AbortController();
    try {
      await locker.query('BEGIN'); await locker.query('SELECT id FROM playback_jobs WHERE id=$1 FOR UPDATE', [job.id]);
      const pending = workerStore.transitionJob(claim, ['reconciling'], 'succeeded', { observedAt: new Date().toISOString(), progressPercent: 100, attendance: 'present', recognized: true }, null, { outcome: 'ended', authority: await proof(claim) }, { signal: abort.signal, timeoutMs: 5000 }).then(() => null, error => error);
      await waitFor(async () => Boolean((await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name='alms-test-worker-cancel' AND wait_event_type='Lock'")).rowCount));
      abort.abort(); assert.ok(await pending);
      await locker.query('ROLLBACK');
      await waitFor(async () => !(await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name='alms-test-worker-cancel' AND state='active'")).rowCount);
      await delay(50);
      const current = await store.getJob(a.user.id, job.id);
      assert.equal(current?.status, 'reconciling'); assert.equal(current?.schoolResult, null);
    } finally { abort.abort(); await locker.query('ROLLBACK'); locker.release(); await workerPool.end(); }
  });
  it('aborting after UPDATE but before COMMIT rolls back the uncommitted recognized result', async () => {
    const job = await makeJob(); const claim = jobClaim((await store.claimJob(job.id))!); await store.transitionJob(claim, ['running'], 'reconciling');
    const abort = new AbortController(); let updated!: () => void; const entered = new Promise<void>(resolve => { updated = resolve; });
    const pending = workerTransaction(pool, async query => {
      await query("UPDATE playback_jobs SET status='succeeded' WHERE id=$1", [job.id]); updated();
      await new Promise<void>(() => {});
    }, { signal: abort.signal, timeoutMs: 5000 }).then(() => null, error => error);
    await entered; abort.abort(); assert.ok(await pending);
    assert.equal((await store.getJob(a.user.id, job.id))?.status, 'reconciling');
  });
  it('worker SQL limits are transaction-local and do not change the API pool defaults', async () => {
    const apiBefore = (await pool.query('SHOW statement_timeout')).rows[0].statement_timeout;
    const workerPool = new Pool({ connectionString: databaseUrl, max: 1, ...workerPgOptions });
    try {
      assert.equal((await workerPool.query('SHOW statement_timeout')).rows[0].statement_timeout, '5s');
      await assert.rejects(workerTransaction(workerPool, async query => {
        const result = await query("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock, current_setting('idle_in_transaction_session_timeout') AS idle");
        assert.deepEqual(result.rows[0], { statement: '500ms', lock: '500ms', idle: '500ms' });
        await query("SELECT set_config('statement_timeout','20',true)");
        // A server-side timeout rejects well before the JS transaction deadline.
        await assert.rejects(query('SELECT pg_sleep(10)'), (error: any) => error.code === '57014');
        throw new Error('synthetic transaction is deliberately aborted after SQL timeout');
      }, { timeoutMs: 500 }), /synthetic transaction is deliberately aborted after SQL timeout/);
      assert.equal((await workerPool.query('SHOW statement_timeout')).rows[0].statement_timeout, '5s');
      assert.equal((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout, apiBefore);
    } finally { await workerPool.end(); }
  });
  it('logout leaves school state and scheduled jobs intact and does not become a worker session requirement', async () => {
    const issued = await store.issueVerifiedSession({ provider: 'integration-test', subject: randomUUID() }, 3600, { provider: 'ssu', seal: () => 'synthetic-worker-school-state' });
    authUsers.push(issued.user.id);
    const create = (when: number) => createAuthorizedJob(issued.user.id, { courseId: 'synthetic-course', lectureId: randomUUID(), scheduledFor: new Date(when).toISOString(), idempotencyKey: randomUUID(), requestHash: randomUUID() }, issued.token);
    const now = await create(Date.now()); const scheduled = await create(Date.now() + 60_000);
    await store.deleteSession(hashToken(issued.token));
    assert.equal(await store.getSession(hashToken(issued.token)), null);
    assert.equal(await store.getEncryptedSchoolSession(issued.user.id, 'ssu'), 'synthetic-worker-school-state');
    await executeJob(now.id, store, testProvider);
    assert.equal((await store.getJob(issued.user.id, now.id))?.status, 'succeeded');
    assert.equal((await store.getJob(issued.user.id, scheduled.id))?.status, 'scheduled');
  });
  it('unavailable playback fails explicitly; time passing cannot mark success',async () => {
    const job = await makeJob();
    await executeJob(job.id,store,unavailableSchoolProvider);
    const got = await store.getJob(a.user.id,job.id);
    assert.equal(got?.status,'failed'); assert.equal(got?.errorCode,'PLAYBACK_UNAVAILABLE'); assert.equal(got?.schoolResult,null);
  });
  it('a synthetic playback adapter must supply a school result for success',async () => {
    const job = await makeJob(); let reads=0;
    await executeJob(job.id,store,{ ...testProvider,playbackLearningStatus: async () => { reads++; return { observedAt: new Date().toISOString(),progressPercent: 100,attendance: 'unknown',recognized: null }; } });
    assert.equal(reads,1); assert.equal((await store.getJob(a.user.id,job.id))?.status,'completed');
    assert.equal((await store.getJob(a.user.id,job.id))?.schoolResult?.recognized,null);
    const success = await makeJob(); await executeJob(success.id,store,testProvider);
    assert.equal((await store.getJob(a.user.id,success.id))?.status,'succeeded');
  });
  it('running cancellation stops the adapter before persisting cancelled and rereads school status',async () => {
    const job = await makeJob(); let stopped=false; let started=false; let reads=0;
    const provider = { ...testProvider,
      play: async (_prepared: unknown,signal: AbortSignal) => { started=true; await new Promise<void>(resolve => { signal.addEventListener('abort',() => { stopped=true; resolve(); },{ once: true }); }); },
      playbackLearningStatus: async () => { reads++; assert.equal(stopped,true); return { observedAt: new Date().toISOString(),progressPercent: 3,attendance: 'pending' as const,recognized: false }; },
    };
    const running = executeJob(job.id,store,provider,undefined,10);
    await waitFor(async () => started);
    assert.equal((await store.cancelJob(a.user.id,job.id)).status,'cancel_requested');
    await running;
    assert.equal(stopped,true); assert.equal(reads,1); assert.equal((await store.getJob(a.user.id,job.id))?.status,'cancelled');
  });
  it('concurrent queue deliveries cannot execute a job twice',async () => {
    const job = await makeJob(); let plays=0;
    await Promise.all([1,2].map(() => executeJob(job.id,store,{ ...testProvider,play: async () => { plays++; await delay(20); } })));
    assert.equal(plays,1); assert.equal((await store.getJob(a.user.id,job.id))?.status,'succeeded');
  });
  it('cancellation winning a completion CAS is finalized with a fresh school read',async () => {
    for (const cancelBefore of ['reconciling','succeeded'] as const) {
      const job = await makeJob(); let reads=0; let cancelled=false;
      const original = store.transitionJob.bind(store);
      store.transitionJob = async (claim,from,to,result,error,options,operation) => {
        if (claim.jobId===job.id && to===cancelBefore && !cancelled) { cancelled=true; await store.cancelJob(a.user.id,claim.jobId); }
        return original(claim,from,to,result,error,options,operation);
      };
      try {
        await executeJob(job.id,store,{ ...testProvider,playbackLearningStatus: async () => { reads++; return { observedAt: new Date().toISOString(),progressPercent: 100,attendance: 'present',recognized: true }; } });
        assert.equal((await store.getJob(a.user.id,job.id))?.status,'cancelled');
        assert.equal(cancelled,true); assert.equal(reads,cancelBefore==='reconciling' ? 1 : 2);
      } finally { store.transitionJob=original; }
    }
  });
  it('lecture identity and job listing include the course scope',async () => {
    const lectureId=randomUUID();
    const one=await createAuthorizedJob(a.user.id,{ courseId: 'course-a',lectureId,scheduledFor: new Date(Date.now()+60000).toISOString(),idempotencyKey: randomUUID(),requestHash: 'one' });
    const two=await createAuthorizedJob(a.user.id,{ courseId: 'course-b',lectureId,scheduledFor: new Date(Date.now()+60000).toISOString(),idempotencyKey: randomUUID(),requestHash: 'two' });
    const response=await app.inject({ url: '/v1/jobs?courseId=course-a',headers: headers(a) });
    assert.equal(response.statusCode,200); assert.ok(response.json().items.some((j: any) => j.id===one.id));
    assert.equal(response.json().items.some((j: any) => j.id===two.id),false);
    await store.cancelJob(a.user.id,one.id); await store.cancelJob(a.user.id,two.id);
  });
  it('interrupted work requires verification and is never replayed automatically',async () => {
    const job = await makeJob(); await store.claimJob(job.id);
    await pool.query("UPDATE playback_jobs SET heartbeat_at=now()-interval '2 minutes' WHERE id=$1",[job.id]);
    assert.equal(await store.recoverStaleJobs(),1);
    let played=false; await executeJob(job.id,store,{ ...testProvider,play: async () => { played=true; } });
    assert.equal(played,false); assert.equal((await store.getJob(a.user.id,job.id))?.status,'needs_verification');
  });
  it('pg-boss consumes the actual SQL outbox and records unavailable provider failure',async () => {
    const job = await makeJob(); const boss = createQueueClient(databaseUrl!); const controller = new AbortController();
    let queueError=false; boss.on('error',() => { queueError=true; });
    const stop = await startWorker(store,boss,unavailableSchoolProvider,controller.signal);
    try { await waitFor(async () => (await store.getJob(a.user.id,job.id))?.status==='failed',10000); assert.equal(queueError,false); }
    finally { controller.abort(); await stop(); }
  });
  it('SSO callback consumes a browser-bound nonce, verifies identity and encrypts the session in SQL',async () => {
    const encryptionKey = randomBytes(32);
    const subject = 'synthetic-' + randomUUID(); let verifications=0;
    const authApp = await buildApp(loadConfig({ DATABASE_URL: databaseUrl,LOG_LEVEL: 'silent',SESSION_ENCRYPTION_KEY: encryptionKey.toString('base64') }),store,{
      ...unavailableSchoolProvider,
      auth: { providerId: 'test-sso',createLoginUrl: callback => 'https://smartid.ssu.ac.kr/Symtra_sso/smln.asp?apiReturnUrl=' + encodeURIComponent(callback),
        verifyCallback: async ({ sToken,sIdno }) => { verifications++; assert.equal(sToken,'synthetic-token'); return { subject: sIdno,displayName: 'Synthetic test',schoolSession: { cookies: [{ value: 'synthetic-school-session' }] } }; } },
    });
    try {
      const login = await authApp.inject('/v1/auth/start'); assert.equal(login.statusCode,303);
      const bindingCookie = String(login.headers['set-cookie']); assert.match(bindingCookie,/HttpOnly/); assert.match(bindingCookie,/Secure/); assert.match(bindingCookie,/SameSite=None/);
      const callback = new URL(new URL(login.headers.location!).searchParams.get('apiReturnUrl')!);
      const request = { method: 'POST' as const,url: callback.pathname + callback.search,headers: { cookie: bindingCookie.split(';')[0]!,'content-type': 'application/x-www-form-urlencoded' },payload: new URLSearchParams({ sToken: 'synthetic-token',sIdno: subject }).toString() };
      const finished = await authApp.inject(request); assert.equal(finished.statusCode,303); assert.equal(finished.headers.location,'https://lms.flyjung.kr/');
      const sessionCookie = sessionCookieFrom(finished.headers['set-cookie']);
      const me = await authApp.inject({ url: '/v1/me',headers: { cookie: sessionCookie } });
      assert.equal(me.statusCode,200); authUsers.push(me.json().user.id);
      const encrypted = await store.getEncryptedSchoolSession(me.json().user.id,'test-sso'); assert.ok(encrypted); assert.doesNotMatch(encrypted,/synthetic-school-session/);
      assert.deepEqual(decryptSchoolSession(encrypted,encryptionKey,me.json().user.id,'test-sso'),{ cookies: [{ value: 'synthetic-school-session' }] });
      assert.equal((await authApp.inject(request)).statusCode,401); assert.equal(verifications,1);
    } finally { await authApp.close(); }
  });
  it('LMS certificate diagnosis is encrypted in SQL and absent from callback, me and request logs',async () => {
    const encryptionKey = randomBytes(32),subject = String(randomInt(90000000,99999999));
    const evidence = { reason: 'school_rejection_page',httpStatus: 200,finalOrigin: 'lms',
      iframeCount: 0,scriptCount: 0,formCount: 0,frameCandidateCount: 0,hasSchoolRejectionText: true };
    const failure = Object.assign(new LmsExchangeError('authentication_required','certificate'), {
      certificateEvidence: { ...evidence,body: 'synthetic-private-school-html',
        url: 'https://lms.ssu.ac.kr/?synthetic-private-token',cookie: 'synthetic-private-cookie' },
    });
    const provider = createSchoolProvider(true,undefined,{
      prepare: async () => {},
      exchange: async () => { throw failure; },
      verify: async () => ({ studentId: subject,displayName: 'Synthetic diagnostics',department: null,status: null }),
    });
    const authApp = await buildApp(loadConfig({ DATABASE_URL: databaseUrl,LOG_LEVEL: 'silent',
      SESSION_ENCRYPTION_KEY: encryptionKey.toString('base64') }),store,provider);
    const logs: unknown[] = [];
    authApp.addHook('onRequest',async request => {
      for (const level of ['info','warn','error'] as const) {
        request.log[level] = ((...values: unknown[]) => { logs.push(values); }) as typeof request.log.info;
      }
    });
    try {
      const login = await authApp.inject('/v1/auth/start'); assert.equal(login.statusCode,303);
      const callback = new URL(new URL(login.headers.location!).searchParams.get('apiReturnUrl')!);
      callback.searchParams.set('sToken','synthetic-private-callback-token'); callback.searchParams.set('sIdno',subject);
      const finished = await authApp.inject({ url: callback.pathname+callback.search,
        headers: { cookie: String(login.headers['set-cookie']).split(';')[0]!,accept: 'text/html' } });
      assert.equal(finished.statusCode,303); assert.equal(finished.headers.location,'https://lms.flyjung.kr/');
      const sessionCookie = sessionCookieFrom(finished.headers['set-cookie']);
      const me = await authApp.inject({ url: '/v1/me',headers: { cookie: sessionCookie } });
      assert.equal(me.statusCode,200); authUsers.push(me.json().user.id);
      const encrypted = await store.getEncryptedSchoolSession(me.json().user.id,'ssu'); assert.ok(encrypted);
      const decrypted = decryptSchoolSession(encrypted,encryptionKey,me.json().user.id,'ssu') as { lmsExchange: unknown };
      assert.deepEqual(decrypted.lmsExchange, { status: 'failed',stage: 'certificate',code: 'authentication_required',certificateEvidence: evidence });
      assert.doesNotMatch(encrypted,/certificateEvidence|school_rejection_page/);
      assert.doesNotMatch(JSON.stringify(decrypted),/synthetic-private-school-html|synthetic-private-token|synthetic-private-cookie/);
      const publicOutput = JSON.stringify({ headers: finished.headers,body: finished.body,me: me.json(),logs });
      assert.doesNotMatch(publicOutput,/certificateEvidence|lmsExchange|school_rejection_page|synthetic-private/);
      assert.equal(publicOutput.includes(subject),false);
      assert.equal(me.json().capabilities.schoolRead,false); assert.equal(me.json().capabilities.playback,false);
      assert.ok(logs.some(values => JSON.stringify(values).includes('/v1/auth/callback/:state')));
    } finally { await authApp.close(); }
  });
  it('Canvas frame diagnosis stays encrypted and private after either exchange outcome',async () => {
    for (const fails of [false,true]) {
      const encryptionKey=randomBytes(32),subject=String(randomInt(90000000,99999999));
      const frameEvidence={ httpStatus: 200,formCount: 1,iframeCount: 0,inlineScriptCount: 2,
        hasLoginCryption: true,hasCanvasLoginForm: true,learningxTokenPresent: true,canvasSessionCookiePresent: false };
      const provider=createSchoolProvider(true,undefined,{
        prepare: async () => {},
        exchange: async (_http,_input,options) => {
          const raw={ ...frameEvidence,body: 'synthetic-private-frame-html',token: 'synthetic-private-canvas-token',
            cookie: 'synthetic-private-canvas-cookie',url: 'https://canvas.ssu.ac.kr/?synthetic-private-query' };
          await options?.onCanvasFrame?.(raw);
          if (fails) throw new LmsExchangeError('unexpected_response','canvas_form');
          return {} as LearningxClient;
        },
        verify: async () => ({ studentId: subject,displayName: 'Synthetic frame diagnosis',department: null,status: null }),
      });
      const authApp=await buildApp(loadConfig({ DATABASE_URL: databaseUrl,LOG_LEVEL: 'silent',
        SESSION_ENCRYPTION_KEY: encryptionKey.toString('base64') }),store,provider);
      const logs: unknown[]=[];
      authApp.addHook('onRequest',async request => {
        for (const level of ['info','warn','error'] as const) {
          request.log[level]=((...values: unknown[]) => { logs.push(values); }) as typeof request.log.info;
        }
      });
      try {
        const login=await authApp.inject('/v1/auth/start'); assert.equal(login.statusCode,303);
        const callback=new URL(new URL(login.headers.location!).searchParams.get('apiReturnUrl')!);
        callback.searchParams.set('sToken','synthetic-private-frame-callback-token'); callback.searchParams.set('sIdno',subject);
        const finished=await authApp.inject({ url: callback.pathname+callback.search,
          headers: { cookie: String(login.headers['set-cookie']).split(';')[0]!,accept: 'text/html' } });
        assert.equal(finished.statusCode,303); assert.equal(finished.headers.location,'https://lms.flyjung.kr/');
        const sessionCookie=sessionCookieFrom(finished.headers['set-cookie']);
        const me=await authApp.inject({ url: '/v1/me',headers: { cookie: sessionCookie } });
        assert.equal(me.statusCode,200); authUsers.push(me.json().user.id);
        const encrypted=await store.getEncryptedSchoolSession(me.json().user.id,'ssu'); assert.ok(encrypted);
        const decrypted=decryptSchoolSession(encrypted,encryptionKey,me.json().user.id,'ssu') as { lmsExchange: unknown };
        assert.deepEqual(decrypted.lmsExchange,{
          ...(fails ? { status: 'failed',stage: 'canvas_form',code: 'unexpected_response' } : { status: 'ready' }),
          canvasFrameEvidence: frameEvidence,
        });
        assert.doesNotMatch(encrypted,/canvasFrameEvidence|hasLoginCryption|synthetic-private/);
        assert.doesNotMatch(JSON.stringify(decrypted),/synthetic-private/);
        const publicOutput=JSON.stringify({ headers: finished.headers,body: finished.body,me: me.json(),logs });
        assert.doesNotMatch(publicOutput,/canvasFrameEvidence|hasLoginCryption|hasCanvasLoginForm|learningxTokenPresent|canvasSessionCookiePresent|lmsExchange|synthetic-private/);
        assert.equal(publicOutput.includes(subject),false);
        assert.ok(logs.some(values => JSON.stringify(values).includes('/v1/auth/callback/:state')));
      } finally { await authApp.close(); }
    }
  });
  it('callback rejects an absent binding, wrong browser, extra fields and expired nonce',async () => {
    let verifications=0;
    const authApp = await buildApp(loadConfig({ DATABASE_URL: databaseUrl,LOG_LEVEL: 'silent',SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64') }),store,{
      ...unavailableSchoolProvider,
      auth: { providerId: 'test-reject',createLoginUrl: callback => 'https://smartid.ssu.ac.kr/?apiReturnUrl=' + encodeURIComponent(callback),verifyCallback: async () => { verifications++; throw new Error('Must not execute'); } },
    });
    try {
      const login = await authApp.inject('/v1/auth/login');
      const callback = new URL(new URL(login.json().url).searchParams.get('apiReturnUrl')!);
      callback.searchParams.set('sToken','synthetic-token'); callback.searchParams.set('sIdno','synthetic-student');
      const url = callback.pathname + callback.search;
      const binding = String(login.headers['set-cookie']).split(';')[0]!;
      assert.equal((await authApp.inject(url)).statusCode,401);
      assert.equal((await authApp.inject({ url,headers: { cookie: '__Host-alms_login=' + randomBytes(32).toString('base64url') } })).statusCode,401);
      assert.equal((await authApp.inject({ url: url+'&userId=forged',headers: { cookie: binding } })).statusCode,400);
      await pool.query("UPDATE login_attempts SET expires_at=now()-interval '1 second' WHERE state_hash=$1",[hashToken(callback.pathname.split('/').at(-1)!)]);
      assert.equal((await authApp.inject({ url,headers: { cookie: binding } })).statusCode,401);
      assert.equal(verifications,0);
    } finally { await authApp.close(); }
  });
  it('a failed or mismatched school identity never receives an ALMS session',async () => {
    const authApp = await buildApp(loadConfig({ DATABASE_URL: databaseUrl,LOG_LEVEL: 'silent',SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64') }),store,{
      ...unavailableSchoolProvider,
      auth: { providerId: 'test-mismatch',createLoginUrl: callback => 'https://smartid.ssu.ac.kr/?apiReturnUrl=' + encodeURIComponent(callback),verifyCallback: async () => ({ subject: 'different-person',schoolSession: {} }) },
    });
    try {
      const login = await authApp.inject('/v1/auth/login'); const callback = new URL(new URL(login.json().url).searchParams.get('apiReturnUrl')!);
      callback.searchParams.set('sToken','synthetic-token'); callback.searchParams.set('sIdno','synthetic-student');
      const response = await authApp.inject({ url: callback.pathname+callback.search,headers: { cookie: String(login.headers['set-cookie']).split(';')[0]! } });
      assert.equal(response.statusCode,401); assert.doesNotMatch(String(response.headers['set-cookie']),/__Host-alms_session/);
    } finally { await authApp.close(); }
  });
  it('a school outage consumes its SQL nonce and a new login can complete',async () => {
    let fail=true;
    const subject='synthetic-retry-'+randomUUID();
    const authApp=await buildApp(loadConfig({ DATABASE_URL: databaseUrl,LOG_LEVEL: 'silent',SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64') }),store,{
      ...unavailableSchoolProvider,
      auth: { providerId: 'test-retry',createLoginUrl: callback => 'https://smartid.ssu.ac.kr/?apiReturnUrl='+encodeURIComponent(callback),
        verifyCallback: async () => { if (fail) throw new AppError(502,'SCHOOL_UPSTREAM_UNAVAILABLE','synthetic failure'); return { subject,schoolSession: {} }; } },
    });
    const begin=async () => {
      const login=await authApp.inject('/v1/auth/login');
      const returned=new URL(login.json().url).searchParams.get('apiReturnUrl')!;
      assert.equal(new URL(returned).search,'');
      const callback=new URL(returned+'?'+new URLSearchParams({ sToken: 'synthetic-token',sIdno: subject }));
      return { url: callback.pathname+callback.search,headers: { cookie: String(login.headers['set-cookie']).split(';')[0]!,accept: 'text/html' } };
    };
    try {
      const first=await begin();
      const unavailable=await authApp.inject(first);
      assert.equal(unavailable.statusCode,303); assert.equal(unavailable.headers.location,'https://lms.flyjung.kr/#/login?reason=school_upstream_unavailable');
      assert.doesNotMatch(String(unavailable.headers['set-cookie']),/__Host-alms_session=/);
      assert.equal((await authApp.inject(first)).headers.location,'https://lms.flyjung.kr/#/login?reason=login_expired');
      const next=await begin(); assert.notEqual(next.url,first.url); assert.notEqual(next.headers.cookie,first.headers.cookie);
      fail=false;
      const finished=await authApp.inject(next); assert.equal(finished.statusCode,303); assert.equal(finished.headers.location,'https://lms.flyjung.kr/');
      const cookie=sessionCookieFrom(finished.headers['set-cookie']);
      const me=await authApp.inject({ url: '/v1/me',headers: { cookie } });
      assert.equal(me.statusCode,200); authUsers.push(me.json().user.id);
    } finally { await authApp.close(); }
  });
  it('logout revokes the stored session and expired sessions cannot authenticate',async () => {
    const response = await app.inject({ method: 'POST',url: '/v1/auth/logout',headers: headers(a) });
    assert.equal(response.statusCode,204); assert.equal((await app.inject({ url: '/v1/me',headers: headers(a) })).statusCode,401);
    await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[hashToken(b.token)]);
    assert.equal((await app.inject({ url: '/v1/me',headers: headers(b) })).statusCode,401);
  });
});
