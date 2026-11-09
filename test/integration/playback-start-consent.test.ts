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
});
