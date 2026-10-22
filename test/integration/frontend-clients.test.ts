import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtemp, readdir, copyFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {migrate} from '../../src/migrations.js';
import {hashToken, PgStore} from '../../src/store.js';
import {loadConfig} from '../../src/config.js';
import {buildApp} from '../../src/app.js';
import {sealFrontendToken, unsealFrontendToken} from '../../src/frontend-token-seal.js';

const url = process.env.TEST_DATABASE_URL;
if (url && !['/alms_test','/alms_qa'].includes(new URL(url).pathname)) throw new Error('Use isolated alms_test or alms_qa');
describe('real PostgreSQL: frontend client binding and PKCE authorization codes', {skip: !url}, () => {
  let admin: Pool, pool: Pool, store: PgStore, beforeLegacy: unknown;
  const schema = 'v43_clients_' + randomUUID().replaceAll('-','');
  const key = randomBytes(32), legacyToken = randomBytes(32).toString('base64url'), legacyUser = randomUUID();
  const codeHash = () => hashToken(randomBytes(32).toString('base64url'));
  before(async () => {
    admin = new Pool({connectionString: url}); await admin.query('CREATE SCHEMA ' + schema);
    pool = new Pool({connectionString: url, max: 5, options: '-c search_path=' + schema});
    const old = await mkdtemp(join(tmpdir(),'alms-v43-old-migrations-'));
    try {
      for (const name of await readdir('migrations')) if (/^0(?:0[1-9]|1[01])-.*\.sql$/.test(name)) await copyFile(join('migrations',name),join(old,name));
      await migrate(pool,old);
      await pool.query("INSERT INTO users(id,identity_provider,identity_subject,display_name,analytics_id) VALUES($1,'synthetic-legacy',$2,'Synthetic legacy',$3)",[legacyUser,randomUUID(),randomUUID()]);
      await pool.query("INSERT INTO sessions(token_hash,user_id,csrf_token,analytics_session_id,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 hour')",
        [hashToken(legacyToken),legacyUser,randomBytes(32).toString('base64url'),randomUUID()]);
      beforeLegacy = (await pool.query('SELECT row_to_json(s) AS value FROM sessions s')).rows[0].value;
      await migrate(pool); await migrate(pool); store = new PgStore(pool);
    } finally { await rm(old,{recursive:true,force:true}); }
  });
  after(async () => { await pool?.end(); if (admin) { await admin.query('DROP SCHEMA ' + schema + ' CASCADE'); await admin.end(); } });
  async function grant(clientId = 'pages-web') {
    const session = await store.issueVerifiedSession({provider:'synthetic-client',subject:randomUUID()},3600,undefined,clientId);
    const hash = codeHash(), challenge = randomBytes(32).toString('base64url');
    const uri = 'https://synthetic.github.io/alms/#/auth/callback';
    const encryptedToken = sealFrontendToken(session.token,key,hash,clientId);
    await store.createFrontendAuthCode({codeHash:hash,clientId,redirectUri:uri,codeChallenge:challenge,sessionTokenHash:hashToken(session.token),encryptedToken});
    return {hash,clientId,uri,challenge,session,encryptedToken};
  }
  it('migrations preserve existing cookie sessions and readiness rejects missing client, analytics or recovery schema', async () => {
    const current = (await pool.query("SELECT to_jsonb(s)-'client_id' AS value FROM sessions s WHERE token_hash=$1",[hashToken(legacyToken)])).rows[0].value;
    assert.deepEqual(current,beforeLegacy); await store.health();
    const app = await buildApp(loadConfig({DATABASE_URL:url!,LOG_LEVEL:'silent'}),store);
    try { const response = await app.inject({url:'/v1/me',headers:{cookie:'__Host-alms_session='+legacyToken}});
      assert.equal(response.statusCode,200); assert.deepEqual(response.json().client,{id:'alms-web',authMode:'cookie'});
    } finally { await app.close(); }
    const transaction = await pool.connect();
    try { for (const name of ['012-frontend-clients.sql','013-analytics-frontend-client.sql','014-assignment-operation-recovery.sql']) {
      await transaction.query('BEGIN'); await transaction.query('DELETE FROM schema_migrations WHERE name=$1',[name]);
      await assert.rejects(new PgStore(transaction as unknown as Pool).health(),/migrations are pending/); await transaction.query('ROLLBACK');
    }} finally { await transaction.query('ROLLBACK'); transaction.release(); }
  });
  it('stores the exact registered login context while browser binding and single use remain mandatory', async () => {
    const state = codeHash(), binding = codeHash(), context = {clientId:'pages-web',redirectUri:'https://synthetic.github.io/alms/#/auth/callback',clientState:randomBytes(32).toString('base64url'),codeChallenge:randomBytes(32).toString('base64url')};
    await store.createLoginAttempt(state,binding,context); assert.deepEqual(await store.getLoginClientContext(state),context);
    assert.equal(await store.consumeLoginAttempt(state,codeHash()),false);
    const results = await Promise.all([store.consumeLoginAttempt(state,binding),store.consumeLoginAttempt(state,binding)]);
    assert.equal(results.filter(Boolean).length,1); assert.deepEqual(await store.getLoginClientContext(state),context);
  });
  it('one exact PKCE exchange consumes a code once and erases its persisted encrypted token', async () => {
    const g = await grant();
    for (const [client,uri,challenge] of [['wrong-client',g.uri,g.challenge],[g.clientId,g.uri+'/',g.challenge],[g.clientId,g.uri,'wrong-challenge']])
      assert.equal(await store.consumeFrontendAuthCode(g.hash,client!,uri!,challenge!),null);
    const results = await Promise.all(Array.from({length:4},()=>store.consumeFrontendAuthCode(g.hash,g.clientId,g.uri,g.challenge)));
    assert.equal(results.filter(Boolean).length,1); const consumed = results.find(Boolean)!;
    assert.equal(unsealFrontendToken(consumed.encryptedToken,key,g.hash,g.clientId),g.session.token);
    assert.throws(()=>unsealFrontendToken(consumed.encryptedToken,key,g.hash,'another-client'));
    assert.equal((await pool.query('SELECT encrypted_token FROM frontend_auth_codes WHERE code_hash=$1',[g.hash])).rows[0].encrypted_token,'');
    assert.equal(await store.consumeFrontendAuthCode(g.hash,g.clientId,g.uri,g.challenge),null);
  });
  it('an expired authorization code and a deleted session cannot authorize an exchange', async () => {
    const g = await grant(); await pool.query("UPDATE frontend_auth_codes SET expires_at=clock_timestamp()-interval '1 second' WHERE code_hash=$1",[g.hash]);
    assert.equal(await store.consumeFrontendAuthCode(g.hash,g.clientId,g.uri,g.challenge),null);
    const revoked = await grant(); await store.deleteSession(hashToken(revoked.session.token));
    assert.equal((await pool.query('SELECT 1 FROM frontend_auth_codes WHERE code_hash=$1',[revoked.hash])).rowCount,0);
    assert.equal(await store.consumeFrontendAuthCode(revoked.hash,revoked.clientId,revoked.uri,revoked.challenge),null);
  });
  it('a real row-lock wait cannot authorize an exchange after the code wall-clock deadline', async () => {
    const g = await grant(), consumer = await pool.connect(), blocker = await pool.connect();
    let pending: ReturnType<PgStore['consumeFrontendAuthCode']> | undefined, blocking = false;
    try {
      await pool.query("UPDATE frontend_auth_codes SET expires_at=clock_timestamp()+interval '1 second' WHERE code_hash=$1",[g.hash]);
      await consumer.query('BEGIN'); const pid = (await consumer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await blocker.query('BEGIN'); blocking = true; await blocker.query('SELECT code_hash FROM frontend_auth_codes WHERE code_hash=$1 FOR UPDATE',[g.hash]);
      pending = new PgStore(consumer as unknown as Pool).consumeFrontendAuthCode(g.hash,g.clientId,g.uri,g.challenge); void pending.catch(()=>undefined);
      let waiting = false;
      for(let i=0;i<200&&!waiting;i++) {waiting=(await pool.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting===true;
        if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));}
      assert.equal(waiting,true); let expired=false;
      for(let i=0;i<200&&!expired;i++) {expired=(await blocker.query('SELECT clock_timestamp()>expires_at AS expired FROM frontend_auth_codes WHERE code_hash=$1',[g.hash])).rows[0].expired;
        if(!expired)await new Promise(resolve=>setTimeout(resolve,10));}
      assert.equal(expired,true); await blocker.query('COMMIT'); blocking=false; assert.equal(await pending,null);
      assert.equal((await consumer.query('SELECT consumed_at FROM frontend_auth_codes WHERE code_hash=$1',[g.hash])).rows[0].consumed_at,null);
    } finally {if(blocking)await blocker.query('ROLLBACK');await pending?.catch(()=>undefined);await consumer.query('ROLLBACK');consumer.release();blocker.release();}
  });
  it('cleanup only removes expired and consumed grants while keeping a live unconsumed grant and sessions', async () => {
    const live=await grant(),expired=await grant(),consumed=await grant();
    await pool.query("UPDATE frontend_auth_codes SET expires_at=clock_timestamp()-interval '1 second' WHERE code_hash=$1",[expired.hash]);
    await store.consumeFrontendAuthCode(consumed.hash,consumed.clientId,consumed.uri,consumed.challenge);
    await store.cleanupFrontendAuthCodes();
    assert.equal((await pool.query('SELECT 1 FROM frontend_auth_codes WHERE code_hash=$1',[live.hash])).rowCount,1);
    assert.equal((await pool.query('SELECT 1 FROM frontend_auth_codes WHERE code_hash=ANY($1::text[])',[[expired.hash,consumed.hash]])).rowCount,0);
    assert.ok(await store.getSession(hashToken(live.session.token)));
  });
});
