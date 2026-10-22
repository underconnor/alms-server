import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { decryptSchoolSession } from '../../src/crypto.js';
import { migrate } from '../../src/migrations.js';
import { unavailableSchoolProvider } from '../../src/provider.js';
import { hashToken, PgStore } from '../../src/store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl && !['/alms_test', '/alms_qa'].includes(new URL(databaseUrl).pathname)) throw new Error('Use an isolated alms_test or alms_qa database');

describe('real PostgreSQL: single-use login window', { skip: !databaseUrl }, () => {
  let pool: Pool; let store: PgStore; let app: FastifyInstance;
  const subject = 'synthetic-window-' + randomUUID();
  const generation = randomUUID();
  const encryptionKey = randomBytes(32);
  const attempts: string[] = [];
  let verifications = 0;
  before(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    store = new PgStore(pool); await migrate(pool);
    app = await buildApp(loadConfig({ DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent',
      SESSION_ENCRYPTION_KEY: encryptionKey.toString('base64') }), store, {
      ...unavailableSchoolProvider,
      auth: { providerId: 'test-window', createLoginUrl: callback => 'https://smartid.ssu.ac.kr/?apiReturnUrl=' + encodeURIComponent(callback),
        verifyCallback: async artifact => {
          verifications++; assert.deepEqual(artifact, { sToken: 'synthetic-window-artifact', sIdno: subject });
          return { subject, schoolSession: { generation } };
        } },
    });
  });
  after(async () => {
    if (app) await app.close();
    if (pool) {
      await pool.query('DELETE FROM login_attempts WHERE state_hash=ANY($1::text[])', [attempts]);
      await pool.query('DELETE FROM users WHERE identity_provider=$1 AND identity_subject=$2', ['test-window', subject]);
      await pool.end();
    }
  });

  it('SQL and both start routes allow the first verified callback after five minutes and still reject another browser, replay and expiry', async () => {
    for (const route of ['/v1/auth/login', '/v1/auth/start']) {
      const login = await app.inject(route);
      assert.equal(login.statusCode, route.endsWith('/start') ? 303 : 200);
      const cookie = String(login.headers['set-cookie']);
      for (const flag of ['HttpOnly', 'Secure', 'SameSite=None', 'Max-Age=900', 'Path=/']) assert.ok(cookie.includes(flag));
      assert.doesNotMatch(cookie, /Domain=|__Host-alms_session=/);
      const destination = route.endsWith('/start') ? login.headers.location! : login.json().url;
      const callback = new URL(new URL(destination).searchParams.get('apiReturnUrl')!);
      const stateHash = hashToken(callback.pathname.split('/').at(-1)!); attempts.push(stateHash);
      const { rows: [created] } = await pool.query('SELECT extract(epoch FROM expires_at-created_at)::int AS ttl FROM login_attempts WHERE state_hash=$1', [stateHash]);
      assert.equal(created.ttl, 900);
      // Model 5m25s of user/school elapsed time without sleeping or changing the database clock.
      await pool.query("UPDATE login_attempts SET created_at=now()-interval '325 seconds',expires_at=now()+interval '575 seconds' WHERE state_hash=$1", [stateHash]);
      const values = new URLSearchParams({ sToken: 'synthetic-window-artifact', sIdno: subject });
      const request = route.endsWith('/start')
        ? { method: 'POST' as const, url: callback.pathname, payload: values.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } }
        : { method: 'GET' as const, url: callback.pathname + '?' + values, headers: {} };
      const before = verifications;
      const wrongBrowser = await app.inject({ ...request, headers: { ...request.headers, accept: 'text/html',
        cookie: '__Host-alms_login=' + randomBytes(32).toString('base64url') } });
      assert.equal(wrongBrowser.statusCode, 303); assert.equal(wrongBrowser.headers.location, 'https://lms.flyjung.kr/#/login?reason=login_expired');
      assert.equal(verifications, before);
      assert.equal((await pool.query('SELECT consumed_at FROM login_attempts WHERE state_hash=$1', [stateHash])).rows[0].consumed_at, null);

      const headers = { ...request.headers, cookie: cookie.split(';')[0]!, accept: 'text/html' };
      const finished = await app.inject({ ...request, headers });
      assert.equal(finished.statusCode, 303); assert.equal(finished.headers.location, 'https://lms.flyjung.kr/');
      assert.equal(verifications, before + 1);
      const returnedCookies = finished.headers['set-cookie'];
      const sessionCookie = (Array.isArray(returnedCookies) ? returnedCookies : [String(returnedCookies)])
        .find(value => value.startsWith('__Host-alms_session='))!.split(';')[0]!;
      const me = await app.inject({ url: '/v1/me', headers: { cookie: sessionCookie } });
      assert.equal(me.statusCode, 200);
      const encrypted = await store.getEncryptedSchoolSession(me.json().user.id, 'test-window'); assert.ok(encrypted);
      assert.deepEqual(decryptSchoolSession(encrypted, encryptionKey, me.json().user.id, 'test-window'), { generation });
      const replay = await app.inject({ ...request, headers });
      assert.equal(replay.statusCode, 303); assert.equal(replay.headers.location, 'https://lms.flyjung.kr/#/login?reason=login_expired');
      assert.doesNotMatch(String(replay.headers['set-cookie']), /__Host-alms_session=/);
      assert.equal(verifications, before + 1);

      const expiredLogin = await app.inject(route);
      const expiredDestination = route.endsWith('/start') ? expiredLogin.headers.location! : expiredLogin.json().url;
      const expiredCallback = new URL(new URL(expiredDestination).searchParams.get('apiReturnUrl')!);
      const expiredState = hashToken(expiredCallback.pathname.split('/').at(-1)!); attempts.push(expiredState);
      await pool.query("UPDATE login_attempts SET created_at=now()-interval '901 seconds',expires_at=now()-interval '1 second' WHERE state_hash=$1", [expiredState]);
      const expiredBefore = (await pool.query('SELECT expires_at FROM login_attempts WHERE state_hash=$1', [expiredState])).rows[0].expires_at;
      const expiredRequest = route.endsWith('/start')
        ? { method: 'POST' as const, url: expiredCallback.pathname, payload: values.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } }
        : { method: 'GET' as const, url: expiredCallback.pathname + '?' + values, headers: {} };
      const expired = await app.inject({ ...expiredRequest, headers: { ...expiredRequest.headers, accept: 'text/html',
        cookie: String(expiredLogin.headers['set-cookie']).split(';')[0]! } });
      assert.equal(expired.statusCode, 303); assert.equal(expired.headers.location, 'https://lms.flyjung.kr/#/login?reason=login_expired');
      assert.doesNotMatch(String(expired.headers['set-cookie']), /__Host-alms_session=/);
      assert.equal(verifications, before + 1);
      const { rows: [expiredAfter] } = await pool.query('SELECT consumed_at,expires_at FROM login_attempts WHERE state_hash=$1', [expiredState]);
      assert.equal(expiredAfter.consumed_at, null); assert.deepEqual(expiredAfter.expires_at, expiredBefore);
    }
  });

  it('wall-clock expiry rejects deadlines at or in the past while a live attempt stays bound and single-use', async () => {
    const client = await pool.connect();
    const transactionStore = new PgStore(client as unknown as Pool);
    try {
      await client.query('BEGIN');
      for (const offset of [-1, 0, 60_000]) {
        const stateHash = hashToken(randomUUID()); const bindingHash = hashToken(randomUUID());
        await transactionStore.createLoginAttempt(stateHash, bindingHash);
        // The deadline uses the running database clock even inside a transaction.
        // A live minute avoids relying on an artificial frozen one-millisecond gap.
        await client.query("UPDATE login_attempts SET expires_at=clock_timestamp()+($2::int*interval '1 millisecond') WHERE state_hash=$1", [stateHash, offset]);
        const { rows: [deadline] } = await client.query('SELECT expires_at::text AS expires_at FROM login_attempts WHERE state_hash=$1', [stateHash]);
        assert.equal(await transactionStore.consumeLoginAttempt(stateHash, hashToken(randomUUID())), false);
        assert.equal(await transactionStore.consumeLoginAttempt(stateHash, bindingHash), offset > 0);
        assert.equal(await transactionStore.consumeLoginAttempt(stateHash, bindingHash), false);
        const { rows: [row] } = await client.query('SELECT consumed_at IS NOT NULL AS consumed,expires_at::text AS expires_at FROM login_attempts WHERE state_hash=$1', [stateHash]);
        assert.equal(row.consumed, offset > 0); assert.equal(row.expires_at, deadline.expires_at);
      }
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
