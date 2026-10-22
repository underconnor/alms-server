import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {parseUsaintIdentity, SchoolError} from '@alms/ssu-api';
import {createSchoolProvider} from '../src/school-adapter.js';
import {buildApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import type {Store} from '../src/store.js';

test('failed callback logs fixed navigation once, keeps its response and issues no session or additional school request', async () => {
  for (const accept of ['application/json', 'text/html']) {
    const records: unknown[] = [], attempts = new Map<string, string>(); let issued = 0, verify = 0, fetches = 0;
    const provider = createSchoolProvider(true, async () => { fetches++; throw new Error('No network allowed'); }, {
      prepare: async () => {}, exchange: async () => {throw new SchoolError('unexpected_response');},
      verify: async () => {
        verify++;
        return parseUsaintIdentity('<script>location="/webSSO/sso.jsp?token=private-token";</script>', '90000001');
      },
    });
    const store = {createLoginAttempt: async (state: string, binding: string) => {attempts.set(state, binding);},
      consumeLoginAttempt: async (state: string, binding: string) => {if (attempts.get(state) !== binding) return false; attempts.delete(state); return true;},
      issueVerifiedSession: async () => {issued++; throw new Error('No session expected');}} as unknown as Store;
    const app = await buildApp(loadConfig({DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent',
      SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64')}), store, provider);
    app.addHook('onRequest', async request => {request.log.warn = ((record: unknown) => records.push(record)) as typeof request.log.warn;});
    try {
      const start = await app.inject('/v1/auth/login');
      const callback = new URL(new URL(start.json().url).searchParams.get('apiReturnUrl')!);
      const cookie = String(start.headers['set-cookie']).split(';')[0]!;
      const response = await app.inject({url: callback.pathname + '?' + new URLSearchParams({sToken: 'private-token', sIdno: '90000001'}), headers: {cookie, accept}});
      assert.equal(response.statusCode, accept === 'text/html' ? 303 : 401);
      if (accept === 'text/html') assert.equal(response.headers.location, 'https://lms.flyjung.kr/#/login?reason=school_auth_failed');
      else assert.equal(response.json().error.code, 'SCHOOL_AUTH_FAILED');
      assert.equal(records.length, 1);
      const record = records[0] as Record<string, unknown>;
      assert.equal(record.event, 'auth_callback_failed'); assert.equal(record.stage, 'school_identity');
      assert.equal(record.code, 'authentication_required'); assert.equal(record.identityShape, 'missing_both');
      assert.equal(record.portalShape, 'literal_navigation');
      assert.deepEqual(record.portalNavigation, {scriptPlacement: 'outer_statement', scriptTarget: 'saint_sso_entry', formTarget: 'none', metaRefreshTarget: 'none'});
      assert.equal(verify, 1); assert.equal(issued, 0); assert.equal(fetches, 0); assert.equal(attempts.size, 0);
      for (const value of ['private-token', '90000001', callback.pathname, cookie, '/webSSO/sso.jsp']) {
        assert.equal(JSON.stringify(records).includes(value), false);
        assert.equal((response.body + JSON.stringify(response.headers)).includes(value), false);
      }
      assert.doesNotMatch(response.body + JSON.stringify(response.headers), /portalNavigation|scriptPlacement|__Host-alms_session=/);
    } finally {await app.close();}
  }
});
