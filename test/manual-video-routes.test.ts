import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { ManualVideoService } from '../src/manual-video-service.js';
import type { Store } from '../src/store.js';
import type { PreparedManualVideo } from '../src/manual-video-types.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import { manualVideoObservationTiming } from '../src/manual-video-timing.js';
import { fixture as schoolFixture, context as schoolContext } from './helpers/school-video-fixture.js';

const base = '/v1/courses/10/activities/20/manual-playback';
const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
const headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43), origin: 'https://lms.flyjung.kr', 'x-csrf-token': 'synthetic-csrf' };
const observation = { positionSeconds: 0, durationSeconds: 600, playbackRate: 1, paused: false, ended: false, seeking: false, visible: true };
async function fixture(available = true) {
  let owner: string | null = randomUUID(), prepares = 0, reports = 0;
  const store = { getSession: async () => owner ? { tokenHash: 'a'.repeat(64), csrfToken: 'synthetic-csrf', user: { id: owner } } : null } as unknown as Store;
  const driver: PreparedManualVideo = { generation: randomUUID(), encryptedSession: 'private-encrypted', baseline: 0, validate: async () => {}, observe: () => {}, close: () => {},
    report: async event => { reports++; return { transport: 'acknowledged', state: event === 'unload' ? 'closed' : 'ready',
      school: { observedAt: new Date().toISOString(), progressPercent: 0, attendance: 'unknown', recognized: null } }; } };
  const service = new ManualVideoService({ acquire: async () => true, renew: async () => true, release: async () => {} },
    { prepare: async () => { prepares++; return driver; } });
  const app = await buildApp(config, store, unavailableSchoolProvider, undefined, available ? service : undefined);
  return { app, service, driver, store, counts: () => ({ prepares, reports }), logout: () => { owner = null; }, changeOwner: () => { owner = randomUUID(); },
    post: (url = base, payload: unknown = {}) => app.inject({ method: 'POST', url, headers, payload: payload as object }) };
}
test('all manual POSTs enforce cookie, origin and CSRF before preparation', async () => {
  const f = await fixture(); try {
    for (const url of [base, `${base}/${randomUUID()}/observations`, `${base}/${randomUUID()}/reports`, `${base}/${randomUUID()}/stop`]) {
      assert.equal((await f.app.inject({ method: 'POST', url, payload: {} })).statusCode, 401);
      assert.equal((await f.app.inject({ method: 'POST', url, headers: { cookie: headers.cookie, origin: headers.origin }, payload: {} })).statusCode, 403);
      assert.equal((await f.app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://foreign.invalid' }, payload: {} })).statusCode, 403);
    }
    assert.deepEqual(f.counts(), { prepares: 0, reports: 0 });
  } finally { await f.app.close(); }
});
test('only exact numeric targets and strict observation/report schemas reach the service', async () => {
  const f = await fixture(); try {
    for (const [url, value] of [[base + '?owner=x', {}], [base.replace('/10/', '/0/'), {}], [base, { owner: randomUUID() }], [base, { schoolUrl: 'https://private.invalid' }]] as const)
      assert.equal((await f.post(url, value)).statusCode, 400);
    const start = (await f.post()).json(), path = `${base}/${start.playbackId}`;
    for (const value of [{ ...observation, cumulativeSeconds: 1 }, { ...observation, visible: false }, { ...observation, seeking: true }, { ...observation, playbackRate: 2 }])
      assert.equal((await f.post(path + '/observations', { nonce: start.nonce, sequence: 1, observation: value })).statusCode, 400);
    assert.equal((await f.post(path + '/reports', { nonce: start.nonce, reportSequence: 1, event: 'force_cancel' })).statusCode, 400);
    assert.equal((await f.post(path + '/reports', { nonce: start.nonce, reportSequence: 1, event: 'playing', cumulativeTime: 600 })).statusCode, 400);
    assert.equal(f.counts().reports, 0);
  } finally { await f.app.close(); }
});
test('HTTP lifecycle separates preparation/observations from report and returns no-store fresh evidence', async () => {
  const f = await fixture(); try {
    const prepared = await f.post(), start = prepared.json(), path = `${base}/${start.playbackId}`;
    assert.equal(prepared.statusCode, 200); assert.equal(prepared.headers['cache-control'], 'no-store'); assert.equal(start.state, 'ready');
    assert.equal((await f.post(path + '/observations', { nonce: start.nonce, sequence: 1, observation })).statusCode, 200);
    assert.equal(f.counts().reports, 0);
    const report = await f.post(path + '/reports', { nonce: start.nonce, reportSequence: 1, event: 'playing' });
    assert.equal(report.statusCode, 200); assert.equal(report.json().schoolResult.recognized, null);
    assert.doesNotMatch(report.body, /private-|nonce|generation|encrypted|tokenHash/);
    assert.equal((await f.post(path + '/stop', { nonce: start.nonce })).json().state, 'closed');
    assert.equal((await f.post(path + '/reports', { nonce: start.nonce, reportSequence: 2, event: 'update' })).statusCode, 404);
    assert.equal(f.counts().reports, 1);
  } finally { await f.app.close(); }
});
test('manual snapshot timestamps are bounded and optional without extending report or restart input', async () => {
  const f = await fixture(); const received: unknown[] = [];
  f.driver.observationTiming = 'client_monotonic_v1'; f.driver.observe = value => received.push(value);
  try {
    const start = (await f.post()).json(), path = `${base}/${start.playbackId}`;
    assert.equal(start.observationTiming, manualVideoObservationTiming(f.driver));
    for (const capturedAtMs of [-1, Number.MAX_SAFE_INTEGER + 1, null, '10', {}, NaN, Infinity]) {
      const result = await f.post(path + '/observations', { nonce: start.nonce, sequence: 1, observation: { ...observation, capturedAtMs } });
      assert.equal(result.statusCode, 400); assert.deepEqual(received, []);
    }
    assert.equal((await f.post(path + '/observations', { nonce: start.nonce, sequence: 1, capturedAtMs: 0, observation })).statusCode, 400);
    const value = { ...observation, capturedAtMs: 125.25 };
    const result = await f.post(path + '/observations', { nonce: start.nonce, sequence: 1, observation: value });
    assert.equal(result.statusCode, start.observationTiming ? 200 : 409);
    assert.deepEqual(received, start.observationTiming ? [value] : []);
    assert.equal((await f.post(path + '/reports', { nonce: start.nonce, reportSequence: 1, event: 'playing', capturedAtMs: 0 })).statusCode, 400);
    assert.equal(f.counts().reports, 0);
  } finally { await f.app.close(); }
});
test('a different owner or expired ALMS session cannot use a captured playback ID and nonce', async () => {
  const f = await fixture(); try {
    const start = (await f.post()).json(), path = `${base}/${start.playbackId}/observations`, body = { nonce: start.nonce, sequence: 1, observation };
    f.changeOwner(); assert.equal((await f.post(path, body)).statusCode, 404);
    f.logout(); assert.equal((await f.post(path, body)).statusCode, 401); assert.equal(f.counts().reports, 0);
  } finally { await f.app.close(); }
});
test('unavailable integration is explicit and does not change worker playback capability', async () => {
  const f = await fixture(false); try {
    const r = await f.post(); assert.equal(r.statusCode, 503); assert.equal(r.json().error.code, 'VIDEO_REPORT_UNAVAILABLE');
    assert.equal(unavailableSchoolProvider.capabilities.playback, false); assert.equal(f.counts().prepares, 0);
  } finally { await f.service.close(); await f.app.close(); }
});
test('authentication DB deadline blocks late preparation instead of holding the request indefinitely', async t => {
  const f = await fixture(), native = globalThis.setTimeout; let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; }), original = f.store.getSession;
  t.mock.method(globalThis, 'setTimeout', (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => native(fn, ms === 5_000 ? 30 : ms, ...args));
  f.store.getSession = async hash => { await wait; return original(hash); };
  try {
    const response = await f.post(); assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'VIDEO_REPORT_UNAVAILABLE');
    release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.counts().prepares, 0);
  } finally { release(); await f.app.close(); }
});
test('optional manual trace header permits allowed-origin preflight but never authenticates a request', async () => {
  const f = await fixture(), rows: Record<string, unknown>[] = [];
  f.app.addHook('onRequest', async request => { request.log.info = ((row: Record<string, unknown>) => rows.push(row)) as typeof request.log.info; });
  try {
    const preflight = await f.app.inject({ method: 'OPTIONS', url: base, headers: { origin: headers.origin,
      'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-alms-trace-id' } });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], headers.origin);
    assert.match(String(preflight.headers['access-control-allow-headers']), /X-ALMS-Trace-Id/i);
    const foreign = await f.app.inject({ method: 'OPTIONS', url: base, headers: { origin: 'https://foreign.invalid',
      'access-control-request-method': 'POST', 'access-control-request-headers': 'x-alms-trace-id' } });
    assert.equal(foreign.headers['access-control-allow-origin'], undefined);
    const traceId = randomUUID();
    const response = await f.app.inject({ method: 'POST', url: base, headers: { 'x-alms-trace-id': traceId }, payload: {} });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(rows.filter(row => row.event === 'manual_transport').map(row => [row.traceId, row.role, row.stage, row.statusCode]),
      [[traceId, 'prepare', 'received', null], [traceId, 'prepare', 'completed', 401]]);
    assert.equal(f.counts().prepares, 0);
  } finally { await f.app.close(); }
});
test('actual installed SDK rejection stays classified through dispose, normalization and the authenticated route logger', async () => {
  const school = await schoolFixture(), rows: Record<string, unknown>[] = [];
  const store = { getSession: async () => ({ tokenHash: schoolContext.sessionHash, csrfToken: 'synthetic-csrf', user: { id: schoolContext.owner } }) } as unknown as Store;
  const service = new ManualVideoService({ acquire: async () => true, renew: async () => true, release: async () => {} }, school.school);
  const app = await buildApp(config, store, unavailableSchoolProvider, undefined, service);
  app.addHook('onRequest', async request => { request.log.info = ((row: Record<string, unknown>) => rows.push(row)) as typeof request.log.info; });
  try {
    const prepared = await app.inject({ method: 'POST', url: base, headers, payload: {} });
    assert.equal(prepared.statusCode, 200); const start = prepared.json();
    assert.equal(start.observationTiming, 'client_monotonic_v1');
    const traceId = randomUUID();
    const rejected = await app.inject({ method: 'POST', url: `${base}/${start.playbackId}/observations`,
      headers: { ...headers, 'x-alms-trace-id': traceId }, payload: { nonce: start.nonce, sequence: 1,
        observation: { ...observation, positionSeconds: 1 } } });
    assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().error.code, 'PLAYBACK_OBSERVATION_INVALID');
    assert.deepEqual(rows.filter(row => row.event === 'manual_observation_rejected'),
      [{ event: 'manual_observation_rejected', traceId, kind: 'initial_position' }]);
    assert.deepEqual(rows.filter(row => row.event === 'manual_transport').map(row => [row.traceId, row.stage, row.statusCode]),
      [[traceId, 'received', null], [traceId, 'completed', 409]]);
    assert.doesNotMatch(JSON.stringify(rows) + rejected.body, /90000001|synthetic-video|positionSeconds|capturedAtMs|private-encrypted/);
    assert.equal(school.counts().reports, 0);
  } finally { await app.close(); }
});
test('real SDK timed snapshots survive compressed arrival intervals while the legacy guard remains strict', async t => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  for (const timed of [true, false]) {
    clock = 0;
    const school = await schoolFixture(), rows: Record<string, unknown>[] = [];
    const store = { getSession: async () => ({ tokenHash: schoolContext.sessionHash, csrfToken: 'synthetic-csrf', user: { id: schoolContext.owner } }) } as unknown as Store;
    const service = new ManualVideoService({ acquire: async () => true, renew: async () => true, release: async () => {} }, school.school, () => clock);
    const app = await buildApp(config, store, unavailableSchoolProvider, undefined, service);
    app.addHook('onRequest', async request => { request.log.info = ((row: Record<string, unknown>) => rows.push(row)) as typeof request.log.info; });
    try {
      const prepared = await app.inject({ method: 'POST', url: base, headers, payload: {} });
      assert.equal(prepared.statusCode, 200); const start = prepared.json();
      assert.equal(start.observationTiming, 'client_monotonic_v1');
      for (let sequence = 1; sequence <= 30; sequence++) {
        const capturedAtMs = (sequence - 1) * 5000;
        clock = capturedAtMs + (sequence === 28 ? 2400 : 300);
        const response = await app.inject({ method: 'POST', url: `${base}/${start.playbackId}/observations`,
          headers: { ...headers, 'x-alms-trace-id': randomUUID() }, payload: { nonce: start.nonce, sequence,
            observation: { ...observation, paused: sequence === 1, positionSeconds: Math.max(0, sequence - 2) * 5,
              ...(timed ? { capturedAtMs } : {}) } } });
        if (!timed && sequence === 29) {
          assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, 'PLAYBACK_OBSERVATION_INVALID');
          assert.deepEqual(rows.filter(row => row.event === 'manual_observation_rejected').map(row => row.kind), ['pair_progress']);
          break;
        }
        assert.equal(response.statusCode, 200, `timed=${timed}, sequence=${sequence}`);
      }
      if (timed) assert.deepEqual(rows.filter(row => row.event === 'manual_observation_rejected'), []);
      assert.equal(school.counts().reports, 0);
    } finally { await app.close(); }
  }
});
