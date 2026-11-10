import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { PgStore, hashToken } from '../../src/store.js';
import { migrate } from '../../src/migrations.js';
import { encryptSchoolSession } from '../../src/crypto.js';
import { createPlaybackAdmission, jobClaim } from '../../src/playback-authority.js';
import { PgPlaybackLeaseRepository } from '../../src/manual-video-lease.js';
import { startConsentInput } from '../../src/playback-start-consent.js';
const url = process.env.TEST_DATABASE_URL;
if (url && !['/alms_test', '/alms_qa'].includes(new URL(url).pathname)) throw new Error('Use isolated test database');
describe('exact queue start consent and one-use attempts in isolated PostgreSQL', { skip: !url }, () => {
  let pool: Pool, admin: Pool, store: PgStore;
  const key = randomBytes(32),
    schema = 'v67_start_' + randomUUID().replaceAll('-', '');
  const op = { timeoutMs: 5000 };
  before(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, max: 10, options: `-c search_path=${schema}` });
    await migrate(pool);
    store = new PgStore(pool);
    const tables = [
      'playback_start_consents',
      'playback_start_consent_revocations',
      'playback_job_start_consents',
      'playback_start_attempts',
    ];
    const columns = (
      await pool.query(
        `SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[]) ORDER BY table_name,ordinal_position`,
        [schema, tables],
      )
    ).rows;
    const triggers = (
      await pool.query(
        `SELECT c.relname AS table_name,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
        [schema, tables],
      )
    ).rows;
    const functions = (
      await pool.query(
        `SELECT p.proname,p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=ANY($2::text[]) ORDER BY p.proname`,
        [schema, ['preserve_playback_start_consent', 'preserve_playback_start_attempt']],
      )
    ).rows;
    const counts = Object.fromEntries(
      await Promise.all(
        tables.map(async (table) => [
          table,
          Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n),
        ]),
      ),
    );
    assert.deepEqual(counts, Object.fromEntries(tables.map((table) => [table, 0])));
    assert.equal(triggers.length, 4);
    assert.equal(functions.length, 2);
    console.log(
      'START_CONSENT_CATALOG ' +
        JSON.stringify({ columns, triggers, functions, counts }).replaceAll(schema, 'QA_SCHEMA'),
    );
  });
  after(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function fixture(shortMs?: number) {
    const identity = { provider: 'start-consent-qa', subject: randomUUID() },
      generation = randomUUID();
    const school = (g: string) => ({
      version: 1,
      generation: g,
      lmsExchange: { status: 'ready' },
      identity: { studentId: '90000001' },
      jar: {},
    });
    let sealed = '';
    const session = await store.issueVerifiedSession(identity, 3600, {
      provider: 'ssu',
      seal: (owner) => (sealed = encryptSchoolSession(school(generation), key, owner, 'ssu')),
    });
    const owner = session.user.id,
      auth = { almsTokenHash: hashToken(session.token), csrfToken: session.csrfToken, clientId: null },
      input = startConsentInput.parse({ courseId: '10', lectureIds: ['20', '21'], confirmed: true });
    const requestKey = randomUUID(),
      requestHash = hashToken(JSON.stringify(input));
    let consent;
    if (shortMs !== undefined) {
      const id = randomUUID();
      const {
        rows: [r],
      } = await pool.query(
        `WITH instant AS(SELECT clock_timestamp() AS t) INSERT INTO playback_start_consents(id,user_id,client_id,generation,course_id,lecture_ids,idempotency_key,request_hash,created_at,expires_at)
   SELECT $1,$2,NULL,$3,'10',ARRAY['20','21'],$4,$5,t,t+($6::int*interval '1 millisecond') FROM instant RETURNING *`,
        [id, owner, generation, requestKey, requestHash, shortMs],
      );
      consent = { id: r.id, expiresAt: r.expires_at.toISOString(), courseId: r.course_id, lectureIds: r.lecture_ids };
    } else
      consent = await store.createPlaybackStartConsent(
        owner,
        input,
        requestKey,
        requestHash,
        { ...auth, generation, encryptedSession: sealed },
        op,
      );
    const admission = () =>
      createPlaybackAdmission(
        { userId: owner, courseId: '10', lectureId: '20' },
        { generation, encryptedSession: sealed },
      );
    const create = async (withConsent = true, lectureId = '20') =>
      store.createJob(
        owner,
        {
          courseId: '10',
          lectureId,
          scheduledFor: new Date().toISOString(),
          idempotencyKey: randomUUID(),
          requestHash: hashToken(randomUUID()),
          ...(withConsent ? { startConsentId: consent.id } : {}),
        },
        {
          ...auth,
          admission: createPlaybackAdmission(
            { userId: owner, courseId: '10', lectureId },
            { generation, encryptedSession: sealed },
          ),
        },
      );
    const claim = async () => {
      const job = await create();
      return jobClaim((await store.claimJob(job.id))!);
    };
    const lease = async (c: ReturnType<typeof jobClaim>, kind: 'worker' | 'manual' = 'worker') =>
      new PgPlaybackLeaseRepository(pool).acquire(
        { owner, generation, courseId: c.courseId, moduleItemId: c.lectureId, tokenHash: c.executionTokenHash, kind },
        { encryptedSession: sealed, almsTokenHash: auth.almsTokenHash },
        AbortSignal.timeout(5000),
      );
    const expire = async () => {
      const until = Date.now() + 3000;
      while (Date.now() < until) {
        const {
          rows: [r],
        } = await pool.query(
          'SELECT expires_at<=clock_timestamp() AS expired FROM playback_start_consents WHERE id=$1',
          [consent.id],
        );
        if (r.expired) return;
        await delay(5);
      }
      assert.fail('Expected database consent expiry');
    };
    return {
      identity,
      owner,
      generation,
      auth,
      input,
      consent,
      requestKey,
      requestHash,
      create,
      claim,
      lease,
      expire,
      admission,
      school,
      seal: () => sealed,
    };
  }
  it('issues canonical exact client/session permission once and exposes safe receipt/key lookup', async () => {
    const f = await fixture(),
      again = await store.createPlaybackStartConsent(
        f.owner,
        f.input,
        f.requestKey,
        f.requestHash,
        { ...f.auth, generation: f.generation, encryptedSession: f.seal() },
        op,
      );
    assert.deepEqual(again, f.consent);
    assert.deepEqual(await store.findPlaybackStartConsent(f.owner, f.requestKey, f.auth, op), f.consent);
    const hours = (Date.parse(f.consent.expiresAt) - Date.now()) / 3600000;
    assert.ok(hours > 23.9 && hours <= 24);
    await assert.rejects(
      store.createPlaybackStartConsent(
        f.owner,
        f.input,
        f.requestKey,
        'other',
        { ...f.auth, generation: f.generation, encryptedSession: f.seal() },
        op,
      ),
      { code: 'IDEMPOTENCY_CONFLICT' },
    );
    const other = await fixture();
    assert.equal(await store.findPlaybackStartConsent(other.owner, f.requestKey, other.auth, op), null);
  });
  it('binds one exact manifest target once, returns consent DTO and rolls back duplicate new job/outbox', async () => {
    const f = await fixture(),
      job = await f.create();
    assert.equal(job.startConsent?.id, f.consent.id);
    assert.equal(job.startConsent?.attempt, 'not_attempted');
    assert.equal((await store.getJobRequest(f.owner, job.idempotencyKey, f.auth))?.id, job.id);
    await store.cancelJob(f.owner, job.id);
    await assert.rejects(f.create(), { code: 'PLAYBACK_START_CONSENT_USED' });
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM playback_jobs WHERE user_id=$1', [f.owner])).rows[0].n,
      1,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM job_outbox WHERE job_id=$1', [job.id])).rows[0].n,
      1,
    );
  });
  it('rejects cross-target, cross-client and CSRF binding without leaving a new job', async () => {
    for (const mode of ['target', 'client', 'csrf'] as const) {
      const f = await fixture();
      const auth = {
        ...f.auth,
        ...(mode === 'csrf' ? { csrfToken: 'wrong' } : {}),
        ...(mode === 'client' ? { clientId: 'other-client' } : {}),
      };
      await assert.rejects(
        store.createJob(
          f.owner,
          {
            courseId: '10',
            lectureId: mode === 'target' ? '22' : '20',
            scheduledFor: new Date().toISOString(),
            idempotencyKey: randomUUID(),
            requestHash: hashToken('x'),
            startConsentId: f.consent.id,
          },
          {
            ...auth,
            admission: createPlaybackAdmission(
              { userId: f.owner, courseId: '10', lectureId: mode === 'target' ? '22' : '20' },
              { generation: f.generation, encryptedSession: f.seal() },
            ),
          },
        ),
      );
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM playback_jobs WHERE user_id=$1', [f.owner])).rows[0].n,
        0,
      );
    }
  });
  it('legacy jobs have no start transition and metadata GET remains independent of school state', async () => {
    const f = await fixture(),
      job = await f.create(false),
      claim = jobClaim((await store.claimJob(job.id))!);
    assert.equal(await store.reservePlaybackStart(claim, key, op), null);
    await pool.query('DELETE FROM school_sessions WHERE user_id=$1', [f.owner]);
    assert.equal((await store.getJob(f.owner, job.id))?.startConsent, null);
  });
  it('atomically reserves a single exact live worker attempt; crash/reserved never replays', async () => {
    const f = await fixture(),
      claim = await f.claim();
    assert.equal(await f.lease(claim), true);
    const results = await Promise.allSettled([
      store.reservePlaybackStart(claim, key, op),
      store.reservePlaybackStart(claim, key, op),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM playback_start_attempts WHERE job_id=$1', [claim.jobId]))
        .rows[0].n,
      1,
    );
    await assert.rejects(store.reservePlaybackStart(claim, key, op), { code: 'PLAYBACK_START_ATTEMPT_EXISTS' });
    await assert.rejects(store.reservePlaybackStart({ ...claim, executionTokenHash: 'c'.repeat(64) }, key, op), {
      code: 'PLAYBACK_AUTHORITY_CHANGED',
    });
  });
  it('manual/orphan/expired leases cannot be bypassed by consent', async () => {
    for (const mode of ['manual', 'absent', 'expired'] as const) {
      const f = await fixture(),
        claim = await f.claim();
      if (mode !== 'absent') {
        await pool.query(
          `INSERT INTO playback_execution_leases(user_id,generation,course_id,module_item_id,token_hash,owner_kind,expires_at) VALUES($1,$2,'10','20',$3,$4,clock_timestamp()+interval '1 minute')`,
          [f.owner, f.generation, claim.executionTokenHash, mode === 'manual' ? 'manual' : 'worker'],
        );
        if (mode === 'expired')
          await pool.query(
            "UPDATE playback_execution_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",
            [f.owner],
          );
      }
      await assert.rejects(store.reservePlaybackStart(claim, key, op), { code: 'PLAYBACK_BUSY' });
      assert.equal(
        (await pool.query('SELECT 1 FROM playback_start_attempts WHERE job_id=$1', [claim.jobId])).rowCount,
        0,
      );
    }
  });
  it('logout keeps admitted worker permission but SSO generation change invalidates unused starts', async () => {
    const f = await fixture(),
      claim = await f.claim();
    await f.lease(claim);
    await store.deleteSession(f.auth.almsTokenHash);
    await store.validatePlaybackStartConsent(claim, key, op);
    assert.ok(await store.reservePlaybackStart(claim, key, op));
    const g = await fixture(),
      other = await g.claim();
    await g.lease(other);
    await store.issueVerifiedSession(g.identity, 3600, {
      provider: 'ssu',
      seal: (owner) => encryptSchoolSession(g.school(randomUUID()), key, owner, 'ssu'),
    });
    await assert.rejects(store.reservePlaybackStart(other, key, op), { code: 'SCHOOL_SESSION_CHANGED' });
  });
  it('revoked or expired unused consent fails closed without any reservation', async () => {
    const f = await fixture();
    await store.revokePlaybackStartConsent(f.owner, f.consent.id, f.auth, op);
    await store.revokePlaybackStartConsent(f.owner, f.consent.id, f.auth, op);
    await assert.rejects(f.create(), { code: 'PLAYBACK_START_CONSENT_REVOKED' });
    const g = await fixture(1000),
      claim = await g.claim();
    await g.lease(claim);
    await g.expire();
    await assert.rejects(store.reservePlaybackStart(claim, key, op), { code: 'PLAYBACK_START_CONSENT_EXPIRED' });
  });
  it('records an in-flight ACK after revocation but does not authorize initial media play', async () => {
    const f = await fixture(),
      claim = await f.claim();
    await f.lease(claim);
    const attempt = (await store.reservePlaybackStart(claim, key, op))!;
    await store.revokePlaybackStartConsent(f.owner, f.consent.id, f.auth, op);
    await store.recordPlaybackStartTransportAck(claim, attempt.attemptId, op);
    await store.finishPlaybackStart(claim, attempt.attemptId, 'acknowledged', key, op);
    assert.equal((await store.getJob(f.owner, claim.jobId))?.startConsent?.attempt, 'acknowledged');
    await assert.rejects(store.validatePlaybackStartConsent(claim, key, op), {
      code: 'PLAYBACK_START_CONSENT_REVOKED',
    });
    await store.finishPlaybackStart(claim, attempt.attemptId, 'unknown', key, op);
    assert.equal((await store.getJob(f.owner, claim.jobId))?.startConsent?.attempt, 'acknowledged');
  });
  it('records a late ACK after expiry while preventing first play; after timely ACK expiry/revoke do not stop ordinary reporting', async () => {
    const f = await fixture(1000),
      claim = await f.claim();
    await f.lease(claim);
    const a = (await store.reservePlaybackStart(claim, key, op))!;
    await f.expire();
    await store.recordPlaybackStartTransportAck(claim, a.attemptId, op);
    await store.finishPlaybackStart(claim, a.attemptId, 'acknowledged', key, op);
    await assert.rejects(store.validatePlaybackStartConsent(claim, key, op), {
      code: 'PLAYBACK_START_CONSENT_EXPIRED',
    });
    const g = await fixture(1000),
      current = await g.claim();
    await g.lease(current);
    const b = (await store.reservePlaybackStart(current, key, op))!;
    await store.recordPlaybackStartTransportAck(current, b.attemptId, op);
    await store.finishPlaybackStart(current, b.attemptId, 'acknowledged', key, op);
    await g.expire();
    await store.revokePlaybackStartConsent(g.owner, g.consent.id, g.auth, op);
    await store.validatePlaybackStartConsent(current, key, op);
  });
  it('cancel during native IO preserves exact ACK fact and current claim independently blocks play', async () => {
    const f = await fixture(),
      claim = await f.claim();
    await f.lease(claim);
    const a = (await store.reservePlaybackStart(claim, key, op))!;
    await store.cancelJob(f.owner, claim.jobId);
    await store.recordPlaybackStartTransportAck(claim, a.attemptId, op);
    await store.finishPlaybackStart(claim, a.attemptId, 'acknowledged', key, op);
    await assert.rejects(store.validatePlaybackStartConsent(claim, key, op), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
    assert.equal((await store.getJob(f.owner, claim.jobId))?.startConsent?.attempt, 'acknowledged');
  });
  it('unknown is immutable, target/claim mismatches cannot finalize and original consent cannot be rewritten', async () => {
    const f = await fixture(),
      claim = await f.claim();
    await f.lease(claim);
    const a = (await store.reservePlaybackStart(claim, key, op))!;
    await assert.rejects(
      store.finishPlaybackStart({ ...claim, lectureId: '21' }, a.attemptId, 'acknowledged', key, op),
      { code: 'PLAYBACK_AUTHORITY_CHANGED' },
    );
    await store.finishPlaybackStart(claim, a.attemptId, 'unknown', key, op);
    await assert.rejects(store.finishPlaybackStart(claim, a.attemptId, 'acknowledged', key, op), {
      code: 'PLAYBACK_START_ATTEMPT_EXISTS',
    });
    await assert.rejects(store.reservePlaybackStart(claim, key, op), { code: 'PLAYBACK_START_ATTEMPT_EXISTS' });
    await assert.rejects(
      pool.query("UPDATE playback_start_consents SET lecture_ids=ARRAY['22'] WHERE id=$1", [f.consent.id]),
    );
    await assert.rejects(pool.query('DELETE FROM playback_start_attempts WHERE id=$1', [a.attemptId]));
  });
  it('another registered client cannot inspect or replay a bound approval/admission using only its identifiers', async () => {
    const f = await fixture(),
      job = await f.create();
    const other = await store.issueVerifiedSession(f.identity, 3600, undefined, 'other-client');
    const otherAuth = { almsTokenHash: hashToken(other.token), csrfToken: other.csrfToken, clientId: 'other-client' };
    await assert.rejects(store.findPlaybackStartConsent(f.owner, f.requestKey, otherAuth, op), {
      code: 'PLAYBACK_START_CONSENT_INVALID',
    });
    await assert.rejects(store.getJobRequest(f.owner, job.idempotencyKey, otherAuth), {
      code: 'PLAYBACK_START_CONSENT_INVALID',
    });
    await assert.rejects(store.revokePlaybackStartConsent(f.owner, f.consent.id, otherAuth, op), {
      code: 'PLAYBACK_START_CONSENT_INVALID',
    });
    await assert.rejects(
      store.createJob(
        f.owner,
        {
          courseId: '10',
          lectureId: '20',
          scheduledFor: job.scheduledFor,
          idempotencyKey: job.idempotencyKey,
          requestHash: job.requestHash,
          startConsentId: f.consent.id,
        },
        { ...otherAuth, admission: f.admission() },
      ),
      { code: 'PLAYBACK_START_CONSENT_INVALID' },
    );
  });
  it('reauth continuation binds a new exact manifest without rearming the original granted intent', async () => {
    const f = await fixture(),
      old = await f.claim();
    await store.transitionJob(old, ['running'], 'needs_reauthentication', null, 'AUTH_REQUIRED', {
      outcome: 'not_started',
      authenticationWaitReason: 'school_auth_required',
    });
    const generation = randomUUID();
    let sealed = '';
    const session = await store.issueVerifiedSession(f.identity, 3600, {
      provider: 'ssu',
      seal: (owner) => (sealed = encryptSchoolSession(f.school(generation), key, owner, 'ssu')),
    });
    const auth = { almsTokenHash: hashToken(session.token), csrfToken: session.csrfToken, clientId: null };
    const input = startConsentInput.parse({ courseId: '10', lectureIds: ['20'], confirmed: true });
    const consent = await store.createPlaybackStartConsent(
      f.owner,
      input,
      randomUUID(),
      hashToken(JSON.stringify(input)),
      { ...auth, generation, encryptedSession: sealed },
      op,
    );
    const { playbackContinuationHash } = await import('../../src/playback-continuation-routes.js');
    const result = await store.continueJob(
      f.owner,
      old.jobId,
      old.jobId,
      playbackContinuationHash(old.jobId, consent.id),
      {
        ...auth,
        startConsentId: consent.id,
        admission: createPlaybackAdmission(
          { userId: f.owner, courseId: '10', lectureId: '20' },
          { generation, encryptedSession: sealed },
        ),
      },
    );
    assert.equal(result.originalJob.acceptedGeneration, f.generation);
    assert.equal(result.originalJob.startConsent?.id, f.consent.id);
    assert.equal(result.originalJob.startConsent?.attempt, 'not_attempted');
    assert.equal(result.job.startConsent?.id, consent.id);
    assert.equal(result.originalJob.authWait?.continuedAsJobId, result.job.id);
  });
  it('strict transport ACK fact survives cancel or unknown result without granting replay or play', async () => {
    const f = await fixture(),
      claim = await f.claim();
    await f.lease(claim);
    const a = (await store.reservePlaybackStart(claim, key, op))!;
    await store.recordPlaybackStartTransportAck(claim, a.attemptId, op);
    const first = (
      await pool.query('SELECT transport_ack_received_at FROM playback_start_attempts WHERE id=$1', [a.attemptId])
    ).rows[0].transport_ack_received_at;
    await store.cancelJob(f.owner, claim.jobId);
    await store.finishPlaybackStart(claim, a.attemptId, 'unknown', key, op);
    await store.recordPlaybackStartTransportAck(claim, a.attemptId, op);
    const row = (
      await pool.query('SELECT state,transport_ack_received_at FROM playback_start_attempts WHERE id=$1', [a.attemptId])
    ).rows[0];
    assert.equal(row.state, 'unknown');
    assert.deepEqual(row.transport_ack_received_at, first);
    await assert.rejects(store.validatePlaybackStartConsent(claim, key, op), { code: 'PLAYBACK_AUTHORITY_CHANGED' });
    await assert.rejects(
      store.recordPlaybackStartTransportAck({ ...claim, executionTokenHash: 'd'.repeat(64) }, a.attemptId, op),
      { code: 'PLAYBACK_AUTHORITY_CHANGED' },
    );
    await assert.rejects(
      pool.query('UPDATE playback_start_attempts SET transport_ack_received_at=NULL WHERE id=$1', [a.attemptId]),
    );
  });
  it('final verified ACK requires the separate strict transport ACK fact', async () => {
    const f = await fixture(),
      claim = await f.claim();
    await f.lease(claim);
    const a = (await store.reservePlaybackStart(claim, key, op))!;
    await assert.rejects(store.finishPlaybackStart(claim, a.attemptId, 'acknowledged', key, op), {
      code: 'PLAYBACK_START_ACK_REQUIRED',
    });
    assert.equal((await store.getJob(f.owner, claim.jobId))?.startConsent?.attempt, 'reserved');
    await store.recordPlaybackStartTransportAck(claim, a.attemptId, op);
    await store.finishPlaybackStart(claim, a.attemptId, 'acknowledged', key, op);
    assert.equal((await store.getJob(f.owner, claim.jobId))?.startConsent?.attempt, 'acknowledged');
  });
  it('a reserved or unknown start can never become an authentication continuation', async () => {
    for (const outcome of ['reserved', 'unknown'] as const) {
      const f = await fixture(),
        claim = await f.claim();
      await f.lease(claim);
      const a = (await store.reservePlaybackStart(claim, key, op))!;
      if (outcome === 'unknown') await store.finishPlaybackStart(claim, a.attemptId, 'unknown', key, op);
      await assert.rejects(
        store.transitionJob(claim, ['running'], 'needs_reauthentication', null, 'AUTH_REQUIRED', {
          outcome: 'not_started',
          authenticationWaitReason: 'school_auth_required',
        }),
        { code: 'PLAYBACK_AUTHORITY_CHANGED' },
      );
      const job = await store.getJob(f.owner, claim.jobId);
      assert.equal(job?.status, 'running');
      assert.equal(job?.authWait, null);
      assert.equal((await pool.query('SELECT 1 FROM playback_auth_waits WHERE job_id=$1', [claim.jobId])).rowCount, 0);
    }
  });
  it('rejects consent-backed schedules at or after the public expiry atomically while retaining legacy schedules', async () => {
    for (const offset of [0, 60000]) {
      const f = await fixture(),
        scheduledFor = new Date(Date.parse(f.consent.expiresAt) + offset).toISOString();
      const input = {
        courseId: '10',
        lectureId: '20',
        scheduledFor,
        idempotencyKey: randomUUID(),
        requestHash: hashToken(randomUUID()),
        startConsentId: f.consent.id,
      };
      await assert.rejects(store.createJob(f.owner, input, { ...f.auth, admission: f.admission() }), {
        code: 'PLAYBACK_START_CONSENT_SCHEDULE_INVALID',
      });
      assert.equal((await pool.query('SELECT 1 FROM playback_jobs WHERE user_id=$1', [f.owner])).rowCount, 0);
      assert.equal(
        (await pool.query('SELECT 1 FROM playback_job_start_consents WHERE consent_id=$1', [f.consent.id])).rowCount,
        0,
      );
      const legacy = await store.createJob(
        f.owner,
        { ...input, startConsentId: undefined, idempotencyKey: randomUUID() },
        { ...f.auth, admission: f.admission() },
      );
      assert.equal(legacy.status, 'scheduled');
      assert.equal(legacy.startConsent, null);
    }
  });
  it('an over-expiry future continuation preserves the old scheduled intent and creates no child', async () => {
    const f = await fixture(),
      scheduledFor = new Date(Date.now() + 36 * 3600000).toISOString();
    const future = await store.createJob(
      f.owner,
      { courseId: '10', lectureId: '20', scheduledFor, idempotencyKey: randomUUID(), requestHash: hashToken('future') },
      { ...f.auth, admission: f.admission() },
    );
    const cause = await f.create(false, '21'),
      claim = jobClaim((await store.claimJob(cause.id))!);
    await store.transitionJob(claim, ['running'], 'needs_reauthentication', null, 'AUTH_REQUIRED', {
      outcome: 'not_started',
      authenticationWaitReason: 'school_auth_required',
    });
    const generation = randomUUID();
    let sealed = '';
    const session = await store.issueVerifiedSession(f.identity, 3600, {
      provider: 'ssu',
      seal: (owner) => (sealed = encryptSchoolSession(f.school(generation), key, owner, 'ssu')),
    });
    const auth = { almsTokenHash: hashToken(session.token), csrfToken: session.csrfToken, clientId: null };
    const input = startConsentInput.parse({ courseId: '10', lectureIds: ['20'], confirmed: true });
    const consent = await store.createPlaybackStartConsent(
      f.owner,
      input,
      randomUUID(),
      hashToken(JSON.stringify(input)),
      { ...auth, generation, encryptedSession: sealed },
      op,
    );
    const before = (await pool.query('SELECT to_jsonb(j) AS row FROM playback_jobs j WHERE id=$1', [future.id])).rows[0]
      .row;
    const { playbackContinuationHash } = await import('../../src/playback-continuation-routes.js');
    await assert.rejects(
      store.continueJob(f.owner, future.id, future.id, playbackContinuationHash(future.id, consent.id), {
        ...auth,
        startConsentId: consent.id,
        admission: createPlaybackAdmission(
          { userId: f.owner, courseId: '10', lectureId: '20' },
          { generation, encryptedSession: sealed },
        ),
      }),
      { code: 'PLAYBACK_START_CONSENT_SCHEDULE_INVALID' },
    );
    assert.deepEqual(
      (await pool.query('SELECT to_jsonb(j) AS row FROM playback_jobs j WHERE id=$1', [future.id])).rows[0].row,
      before,
    );
    assert.equal((await store.getJob(f.owner, future.id))?.authWait?.continuedAsJobId, null);
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM playback_jobs WHERE user_id=$1', [f.owner])).rows[0].n,
      2,
    );
  });
  it('negative receipts require permanently invalid original permission, never a valid grant, USED or uncertain school state', async () => {
    for (const mode of ['expired', 'revoked', 'retired', 'valid', 'used', 'missing', 'corrupt', 'not-ready'] as const) {
      const f = await fixture(mode === 'expired' ? 1000 : undefined),
        requestKey = randomUUID();
      if (mode === 'expired') await f.expire();
      if (mode === 'revoked') await store.revokePlaybackStartConsent(f.owner, f.consent.id, f.auth, op);
      if (mode === 'used') await f.create();
      if (mode === 'missing') await pool.query('DELETE FROM school_sessions WHERE user_id=$1', [f.owner]);
      if (mode === 'corrupt')
        await pool.query("UPDATE school_sessions SET encrypted_state='synthetic-corrupt' WHERE user_id=$1", [f.owner]);
      if (mode === 'retired' || mode === 'not-ready')
        await store.issueVerifiedSession(f.identity, 3600, {
          provider: 'ssu',
          seal: (owner) =>
            encryptSchoolSession(
              { ...f.school(randomUUID()), ...(mode === 'not-ready' ? { lmsExchange: { status: 'failed' } } : {}) },
              key,
              owner,
              'ssu',
            ),
        });
      const result = await store.getJobRequest(f.owner, requestKey, f.auth, op, {
        startConsentId: f.consent.id,
        encryptionKey: key,
      });
      if (['expired', 'revoked', 'retired'].includes(mode))
        assert.deepEqual(result, { requestStatus: 'not_admitted', requestKey, startConsentId: f.consent.id });
      else assert.equal(result, null, mode);
      assert.equal(await store.getJobRequest(f.owner, randomUUID(), f.auth), null);
    }
  });
  it('accepted exact-key jobs win over invalid permission and mismatched lookup IDs; foreign owner/client never get negative proof', async () => {
    const f = await fixture(),
      job = await f.create();
    await store.revokePlaybackStartConsent(f.owner, f.consent.id, f.auth, op);
    await store.cancelJob(f.owner, job.id);
    const existing = await store.getJobRequest(f.owner, job.idempotencyKey, f.auth, op, {
      startConsentId: randomUUID(),
      encryptionKey: key,
    });
    assert.ok(existing && 'id' in existing);
    assert.equal(existing.id, job.id);
    assert.equal(existing.status, 'cancelled');
    const other = await fixture();
    assert.equal(
      await store.getJobRequest(other.owner, randomUUID(), other.auth, op, {
        startConsentId: f.consent.id,
        encryptionKey: key,
      }),
      null,
    );
    const session = await store.issueVerifiedSession(f.identity, 3600, undefined, 'other-client');
    await assert.rejects(
      store.getJobRequest(
        f.owner,
        randomUUID(),
        { almsTokenHash: hashToken(session.token), csrfToken: session.csrfToken, clientId: 'other-client' },
        op,
        { startConsentId: f.consent.id, encryptionKey: key },
      ),
      { code: 'PLAYBACK_START_CONSENT_INVALID' },
    );
  });
  it('proof waits for an earlier original admission and observes its accepted job instead of inventing absence', async () => {
    const f = await fixture(),
      requestKey = randomUUID(),
      locker = await pool.connect();
    const rr = new Pool({ connectionString: url, max: 1, options: `-c search_path=${schema}` });
    await rr.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const inspectingStore = new PgStore(rr);
    let original: Promise<any> | undefined, inspection: Promise<any> | undefined;
    const waitBy = async (pid: number) => {
      const until = Date.now() + 2500;
      while (Date.now() < until) {
        const {
          rows: [row],
        } = await pool.query('SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [pid]);
        if (row) return Number(row.pid);
        await delay(5);
      }
      assert.fail('Expected exact backend lock wait');
    };
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM playback_start_consents WHERE id=$1 FOR UPDATE', [f.consent.id]);
      const pid = Number((await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      original = store
        .createJob(
          f.owner,
          {
            courseId: '10',
            lectureId: '20',
            scheduledFor: new Date().toISOString(),
            idempotencyKey: requestKey,
            requestHash: hashToken('delayed-accepted'),
            startConsentId: f.consent.id,
          },
          { ...f.auth, admission: f.admission() },
        )
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      const createPid = await waitBy(pid);
      inspection = inspectingStore.getJobRequest(f.owner, requestKey, f.auth, op, {
        startConsentId: f.consent.id,
        encryptionKey: key,
      });
      await waitBy(createPid);
      await locker.query('COMMIT');
      const accepted = await original;
      assert.ok(accepted.value);
      const result = await inspection;
      assert.equal(result.id, accepted.value.id);
      assert.equal(result.startConsent.id, f.consent.id);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      await original;
      await inspection;
      await rr.end();
    }
  });
  it('expired-permission proof and original admission serialize; late original bind cannot commit or create outbox', async () => {
    const f = await fixture(1500),
      requestKey = randomUUID(),
      input = {
        courseId: '10',
        lectureId: '20',
        scheduledFor: new Date().toISOString(),
        idempotencyKey: requestKey,
        requestHash: hashToken('delayed-expired'),
        startConsentId: f.consent.id,
      },
      locker = await pool.connect();
    let original: Promise<any> | undefined, inspection: Promise<any> | undefined;
    const waitBy = async (pid: number) => {
      const until = Date.now() + 2500;
      while (Date.now() < until) {
        const {
          rows: [row],
        } = await pool.query('SELECT pid FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [pid]);
        if (row) return Number(row.pid);
        await delay(5);
      }
      assert.fail('Expected exact backend lock wait');
    };
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM playback_start_consents WHERE id=$1 FOR UPDATE', [f.consent.id]);
      const pid = Number((await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      original = store.createJob(f.owner, input, { ...f.auth, admission: f.admission() }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const createPid = await waitBy(pid);
      inspection = store.getJobRequest(f.owner, requestKey, f.auth, op, {
        startConsentId: f.consent.id,
        encryptionKey: key,
      });
      await waitBy(createPid);
      await f.expire();
      await locker.query('COMMIT');
      assert.equal((await original).error.code, 'PLAYBACK_START_CONSENT_EXPIRED');
      assert.deepEqual(await inspection, { requestStatus: 'not_admitted', requestKey, startConsentId: f.consent.id });
      await assert.rejects(store.createJob(f.owner, input, { ...f.auth, admission: f.admission() }), {
        code: 'PLAYBACK_START_CONSENT_EXPIRED',
      });
      assert.equal((await pool.query('SELECT 1 FROM playback_jobs WHERE user_id=$1', [f.owner])).rowCount, 0);
      assert.equal(
        (
          await pool.query('SELECT 1 FROM job_outbox o JOIN playback_jobs j ON j.id=o.job_id WHERE j.user_id=$1', [
            f.owner,
          ])
        ).rowCount,
        0,
      );
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      await original;
      await inspection;
    }
  });
  it('negative proof also prevents a late authentication continuation with its original revoked consent', async () => {
    const f = await fixture(),
      old = await f.claim();
    await store.transitionJob(old, ['running'], 'needs_reauthentication', null, 'AUTH_REQUIRED', {
      outcome: 'not_started',
      authenticationWaitReason: 'school_auth_required',
    });
    const generation = randomUUID();
    let sealed = '';
    const session = await store.issueVerifiedSession(f.identity, 3600, {
      provider: 'ssu',
      seal: (owner) => (sealed = encryptSchoolSession(f.school(generation), key, owner, 'ssu')),
    });
    const auth = { almsTokenHash: hashToken(session.token), csrfToken: session.csrfToken, clientId: null },
      input = startConsentInput.parse({ courseId: '10', lectureIds: ['20'], confirmed: true });
    const consent = await store.createPlaybackStartConsent(
      f.owner,
      input,
      randomUUID(),
      hashToken(JSON.stringify(input)),
      { ...auth, generation, encryptedSession: sealed },
      op,
    );
    await store.revokePlaybackStartConsent(f.owner, consent.id, auth, op);
    const before = (await pool.query('SELECT to_jsonb(j) AS row FROM playback_jobs j WHERE id=$1', [old.jobId])).rows[0]
      .row;
    assert.deepEqual(
      await store.getJobRequest(f.owner, old.jobId, auth, op, { startConsentId: consent.id, encryptionKey: key }),
      { requestStatus: 'not_admitted', requestKey: old.jobId, startConsentId: consent.id },
    );
    const { playbackContinuationHash } = await import('../../src/playback-continuation-routes.js');
    await assert.rejects(
      store.continueJob(f.owner, old.jobId, old.jobId, playbackContinuationHash(old.jobId, consent.id), {
        ...auth,
        startConsentId: consent.id,
        admission: createPlaybackAdmission(
          { userId: f.owner, courseId: '10', lectureId: '20' },
          { generation, encryptedSession: sealed },
        ),
      }),
      { code: 'PLAYBACK_START_CONSENT_REVOKED' },
    );
    assert.deepEqual(
      (await pool.query('SELECT to_jsonb(j) AS row FROM playback_jobs j WHERE id=$1', [old.jobId])).rows[0].row,
      before,
    );
    assert.equal((await store.getJob(f.owner, old.jobId))?.authWait?.continuedAsJobId, null);
    assert.equal((await pool.query('SELECT 1 FROM playback_jobs WHERE user_id=$1', [f.owner])).rowCount, 1);
  });
  it('consent operations and FIFO admissions use read committed while ordinary transactions preserve the pool default', async () => {
    const f = await fixture(),
      rr = new Pool({ connectionString: url, max: 1, options: `-c search_path=${schema}` });
    try {
      await rr.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      assert.equal(
        (await rr.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation,
        'repeatable read',
      );
      const reader = new PgStore(rr),
        levels: string[] = [];
      const original = reader.workerTransaction.bind(reader);
      reader.workerTransaction = ((run: any, operation: any) =>
        original(async (query) => {
          levels.push((await query('SHOW transaction_isolation')).rows[0]!.transaction_isolation);
          return run(query);
        }, operation)) as typeof reader.workerTransaction;
      await store.revokePlaybackStartConsent(f.owner, f.consent.id, f.auth, op);
      const proof = await reader.getJobRequest(f.owner, randomUUID(), f.auth, op, {
        startConsentId: f.consent.id,
        encryptionKey: key,
      });
      assert.ok(proof && 'requestStatus' in proof);
      await assert.rejects(
        reader.createJob(
          f.owner,
          {
            courseId: '10',
            lectureId: '20',
            scheduledFor: new Date().toISOString(),
            idempotencyKey: randomUUID(),
            requestHash: hashToken('rr'),
            startConsentId: f.consent.id,
          },
          { ...f.auth, admission: f.admission() },
        ),
        { code: 'PLAYBACK_START_CONSENT_REVOKED' },
      );
      assert.deepEqual(levels, ['read committed', 'read committed']);
      // A failed transaction destroys its connection; prime the replacement too.
      await rr.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await reader.createJob(
        f.owner,
        {
          courseId: '10',
          lectureId: '21',
          scheduledFor: new Date().toISOString(),
          idempotencyKey: randomUUID(),
          requestHash: hashToken('legacy-rr'),
        },
        {
          ...f.auth,
          admission: createPlaybackAdmission(
            { userId: f.owner, courseId: '10', lectureId: '21' },
            { generation: f.generation, encryptedSession: f.seal() },
          ),
        },
      );
      assert.equal(levels.at(-1), 'read committed');
      // Queue admission now also needs a fresh snapshot after the scheduler lock.
      // Generic transactions still inherit the configured pool isolation level.
      await reader.workerTransaction(async query => {
        assert.equal((await query('SHOW transaction_isolation')).rows[0]!.transaction_isolation, 'repeatable read');
      }, op);
      assert.equal(levels.at(-1), 'repeatable read');
      assert.equal(
        (await rr.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation,
        'repeatable read',
      );
    } finally {
      await rr.end();
    }
  });
  it('validation reads revocation after a blocked immutable-consent lock, even with a repeatable-read pool default', async () => {
    const f = await fixture(),
      claim = await f.claim();
    await f.lease(claim);
    const rr = new Pool({ connectionString: url, max: 1, options: `-c search_path=${schema}` }),
      locker = await pool.connect();
    let pending: Promise<any> | undefined;
    try {
      await rr.query('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const validator = new PgStore(rr);
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM playback_start_consents WHERE id=$1 FOR UPDATE', [f.consent.id]);
      await locker.query('INSERT INTO playback_start_consent_revocations(consent_id) VALUES($1)', [f.consent.id]);
      const pid = Number((await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      pending = validator.validatePlaybackStartConsent(claim, key, op).then(
        () => ({ allowed: true }),
        (error) => ({ error }),
      );
      const until = Date.now() + 2500;
      let blocked = false;
      while (Date.now() < until) {
        if (
          (await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))', [pid])).rowCount
        ) {
          blocked = true;
          break;
        }
        await delay(5);
      }
      assert.equal(blocked, true, 'Validator must wait for exact pending revocation');
      await locker.query('COMMIT');
      assert.equal((await pending).error.code, 'PLAYBACK_START_CONSENT_REVOKED');
      assert.equal(
        (await pool.query('SELECT 1 FROM playback_start_attempts WHERE job_id=$1', [claim.jobId])).rowCount,
        0,
      );
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      await pending;
      await rr.end();
    }
  });
});
