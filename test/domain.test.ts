import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransition,resultStatus } from '../src/domain.js';
import { loadConfig } from '../src/config.js';
import { buildApp,setSessionCookie } from '../src/app.js';
import type { Store } from '../src/store.js';
import { hashToken } from '../src/store.js';
import { projectEvent,validateEvent } from '../src/analytics.js';
import { encryptSchoolSession,decryptSchoolSession } from '../src/crypto.js';
import { randomBytes } from 'node:crypto';
import schema from '../src/contracts/ux-events.schema.json' with { type: 'json' };
import type { Session } from '../src/domain.js';

test('job completion requires a school recognition result',() => {
  assert.equal(resultStatus(null, null),'needs_verification');
  assert.equal(resultStatus({ observedAt: new Date().toISOString(),progressPercent: 100,attendance: 'unknown',recognized: null }, null),'needs_verification');
  assert.equal(resultStatus({ observedAt: new Date().toISOString(),progressPercent: 100,attendance: 'present',recognized: true }, 'ended'),'succeeded');
  assert.equal(canTransition('queued','succeeded'),false);
  assert.equal(canTransition('cancelled','running'),false);
  assert.equal(canTransition('needs_verification','running'),false);
  assert.equal(canTransition('running','cancel_requested'),true);
});

test('production cannot disable secure cookies',() => {
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://unused',NODE_ENV: 'production',COOKIE_SECURE: 'false' }));
});

test('missing credentials fail before database access; unknown SSO remains unavailable',async () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://unused',LOG_LEVEL: 'silent' });
  const app = await buildApp(config,{} as Store);
  assert.equal((await app.inject('/v1/me')).statusCode,401);
  assert.equal((await app.inject('/v1/auth/login')).statusCode,503);
  assert.equal((await app.inject('/healthz')).statusCode,200);
  assert.equal((await app.inject('/readyz')).statusCode,503);
  await app.close();
});

test('opaque cookie uses host-only secure HttpOnly scope and no identity payload',async () => {
  const config = loadConfig({ DATABASE_URL: 'postgres://unused',LOG_LEVEL: 'silent' });
  const app = await buildApp(config,{} as Store);
  const token = 'x'.repeat(43);
  app.get('/test-cookie',async (_req,reply) => { setSessionCookie(reply,config,token,new Date(Date.now()+3600000).toISOString()); return {}; });
  const response = await app.inject('/test-cookie');
  const value = String(response.headers['set-cookie']);
  assert.match(value,/^__Host-alms_session=/);
  assert.match(value,/HttpOnly/); assert.match(value,/Secure/); assert.match(value,/SameSite=Lax/); assert.doesNotMatch(value,/Domain=/);
  assert.notEqual(hashToken(token),token);
  await app.close();
});

test('manual analytics rejects arbitrary properties and replaces client identity with server random IDs',() => {
  const value = structuredClone(schema.examples[0]!);
  validateEvent(value);
  assert.throws(() => validateEvent({ ...value,url: 'https://lms.ssu.ac.kr/private' }));
  assert.throws(() => validateEvent({ ...value,properties: { studentId: 'secret' } }));
  const session = { user: { analyticsId: 'server-random' },analyticsSessionId: 'session-random' } as Session;
  const projected = projectEvent(value,session);
  assert.equal(projected.distinct_id,'server-random');
  assert.equal(projected.properties.session_id,'session-random');
  assert.equal(projected.properties.$process_person_profile,false);
  assert.equal(projected.properties.$geoip_disable,true);
  assert.doesNotMatch(JSON.stringify(projected),/https:|studentId|referrer|user_agent|authorization/);
});

test('encrypted school state cannot be moved to another user or altered',() => {
  const key = randomBytes(32);
  const value = encryptSchoolSession({ cookies: [{ value: 'synthetic-session' }] },key,'user-a','test-provider');
  assert.doesNotMatch(value,/synthetic-session/);
  assert.deepEqual(decryptSchoolSession(value,key,'user-a','test-provider'),{ cookies: [{ value: 'synthetic-session' }] });
  assert.throws(() => decryptSchoolSession(value,key,'user-b','test-provider'));
  assert.throws(() => decryptSchoolSession(value,randomBytes(32),'user-a','test-provider'));
  const segments = value.split('.'); segments[2] = Buffer.alloc(16).toString('base64url');
  assert.throws(() => decryptSchoolSession(segments.join('.'),key,'user-a','test-provider'));
});
