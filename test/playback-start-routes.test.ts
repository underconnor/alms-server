import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { PlaybackStartService, type PreparedPlaybackStart } from '../src/playback-start-service.js';
import type { Store } from '../src/store.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import { SchoolVideoPlaybackStartError } from '@alms/ssu-api';
import { playbackStartFailureDiagnostic, rememberPlaybackStartDiagnostic } from '../src/playback-start-diagnostics.js';

const base = '/v1/courses/10/activities/20/playback-start-confirmations';
const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
const headers = { cookie: '__Host-alms_session=' + 'a'.repeat(43), origin: 'https://lms.flyjung.kr', 'x-csrf-token': 'synthetic-csrf' };
const observation = { positionSeconds: 4, durationSeconds: 600, playbackRate: 1, paused: true, ended: false, seeking: false, visible: true };
async function fixture(available = true) {
  const diagnosticLogs: unknown[] = [];
  let owner: string | null = randomUUID(), csrf = 'synthetic-csrf', prepares = 0, confirms = 0, released = 0;
  const store = { getSession: async () => owner ? { tokenHash: 'a'.repeat(64), csrfToken: csrf, user: { id: owner } } : null } as unknown as Store;
  const driver: PreparedPlaybackStart = { generation: randomUUID(),
    authority: async (validate, signal) => { signal.throwIfAborted(); await validate(); return { generation: driver.generation, encryptedSession: 'private-encrypted' }; }, close: () => {},
    confirmStart: async (_value, validate, signal) => { signal.throwIfAborted(); await validate(); confirms++; return { transport: 'acknowledged',
      school: { observedAt: new Date().toISOString(), progressPercent: 1, attendance: 'unknown', recognized: null } }; } };
  const service = new PlaybackStartService({ acquire: async () => true, renew: async () => true, release: async () => { released++; } },
    { prepare: async () => { prepares++; return driver; } });
  const app = await buildApp(config, store, unavailableSchoolProvider, undefined, undefined, undefined, undefined, available ? service : undefined);
  app.addHook('onRequest', async request => { request.log.warn = ((value: unknown) => { diagnosticLogs.push(value); }) as typeof request.log.warn; });
  return { app, service, driver, store, diagnosticLogs, counts: () => ({ prepares, confirms, released }), logout: () => { owner = null; }, changeOwner: () => { owner = randomUUID(); },
    changeCsrf: () => { csrf = 'replaced-csrf'; }, post: (url = base, payload: unknown = {}) => app.inject({ method: 'POST', url, headers, payload: payload as object }) };
}

test('prepare and confirm enforce session cookie, exact allowed Origin and CSRF before any school driver call', async () => {
  const f = await fixture(); try {
    for (const url of [base, `${base}/${randomUUID()}/confirm`]) {
      assert.equal((await f.app.inject({ method: 'POST', url, payload: {} })).statusCode, 401);
      assert.equal((await f.app.inject({ method: 'POST', url, headers: { cookie: headers.cookie, origin: headers.origin }, payload: {} })).statusCode, 403);
      assert.equal((await f.app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://foreign.invalid' }, payload: {} })).statusCode, 403);
    }
    assert.deepEqual(f.counts(), { prepares: 0, confirms: 0, released: 0 });
  } finally { await f.app.close(); }
});

test('strict confirmation accepts only paused visible 1x native observation, never school URL or cumulative progress', async () => {
  const f = await fixture(); try {
    for (const [url, body] of [[base + '?owner=x', {}], [base.replace('/10/', '/0/'), {}], [base, { confirmed: true }], [base, { schoolUrl: 'https://private.invalid' }]] as const)
      assert.equal((await f.post(url, body)).statusCode, 400);
    const prepared = (await f.post()).json(), url = `${base}/${prepared.confirmationId}/confirm`;
    for (const value of [{ ...observation, cumulativeSeconds: 600 }, { ...observation, capturedAtMs: 0 }, { ...observation, paused: false }, { ...observation, visible: false },
      { ...observation, seeking: true }, { ...observation, ended: true }, { ...observation, playbackRate: 2 }, { ...observation, positionSeconds: -1 }, { ...observation, durationSeconds: 0 }])
      assert.equal((await f.post(url, { nonce: prepared.nonce, observation: value })).statusCode, 400);
    for (const body of [{ nonce: prepared.nonce, observation, force_cancel: true }, { nonce: 'invalid', observation }, { nonce: prepared.nonce }, { nonce: prepared.nonce, observation, owner: randomUUID() }])
      assert.equal((await f.post(url, body)).statusCode, 400);
    assert.equal(f.counts().confirms, 0);
    assert.equal((await f.post(url, { nonce: prepared.nonce, observation })).statusCode, 200);
  } finally { await f.app.close(); }
});

test('HTTP prepare does not write; confirm returns only fresh school evidence and duplicated confirm does not write again', async () => {
  const f = await fixture(); try {
    const response = await f.post(), prepared = response.json(); assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(f.counts().confirms, 0); assert.equal(f.counts().released, 0);
    const url = `${base}/${prepared.confirmationId}/confirm`, body = { nonce: prepared.nonce, observation }, result = await f.post(url, body);
    assert.equal(result.statusCode, 200); assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.json().state, 'confirmed');
    assert.equal(result.json().schoolResult.recognized, null); assert.equal(result.json().schoolResult.attendance, 'unknown');
    assert.doesNotMatch(result.body, /private-encrypted|nonce|generation|sessionHash|tokenHash/);
    const repeated = await f.post(url, body); assert.equal(repeated.statusCode, 200); assert.deepEqual(repeated.json(), result.json());
    assert.deepEqual(f.counts(), { prepares: 1, confirms: 1, released: 1 });
  } finally { await f.app.close(); }
});

test('other account, changed target, wrong nonce and logout cannot use a captured confirmation', async () => {
  const f = await fixture(); try {
    const prepared = (await f.post()).json(), url = `${base}/${prepared.confirmationId}/confirm`, body = { nonce: prepared.nonce, observation };
    assert.equal((await f.post(url.replace('/20/', '/21/'), body)).statusCode, 404);
    assert.equal((await f.post(url, { ...body, nonce: 'x'.repeat(43) })).statusCode, 404);
    f.changeOwner(); assert.equal((await f.post(url, body)).statusCode, 404);
    f.logout(); assert.equal((await f.post(url, body)).statusCode, 401); assert.equal(f.counts().confirms, 0);
  } finally { await f.app.close(); }
});

test('session changes during live validation prevent a prepared confirmation from writing', async () => {
  const f = await fixture(); try {
    const prepared = (await f.post()).json(), url = `${base}/${prepared.confirmationId}/confirm`, body = { nonce: prepared.nonce, observation }, original = f.driver.authority;
    f.driver.authority = async (...args) => { f.changeCsrf(); return original(...args); };
    const result = await f.post(url, body); assert.equal(result.statusCode, 401); assert.equal(result.json().error.code, 'AUTH_REQUIRED');
    assert.equal(f.counts().confirms, 0); assert.equal(f.counts().released, 0);
  } finally { await f.app.close(); }
});

test('unknown school transmission remains verification_required and has no success time or release', async () => {
  const f = await fixture(), original = f.driver.confirmStart;
  f.driver.confirmStart = async (...args) => ({ ...await original(...args), transport: 'unknown' });
  try {
    const prepared = (await f.post()).json(), url = `${base}/${prepared.confirmationId}/confirm`, body = { nonce: prepared.nonce, observation };
    const result = await f.post(url, body); assert.equal(result.statusCode, 200); assert.equal(result.json().state, 'verification_required');
    assert.equal(result.json().confirmedAt, null); assert.equal(result.json().schoolResult.recognized, null);
    assert.equal((await f.post(url, body)).statusCode, 200); assert.equal(f.counts().confirms, 1); assert.equal(f.counts().released, 0);
  } finally { await f.app.close(); }
});

test('unknown confirmation logs a fixed diagnostic once while its cached response and uncertain lease stay unchanged', async () => {
  const f = await fixture(), original = f.driver.confirmStart;
  f.driver.confirmStart = async (...args) => {
    const result = { ...await original(...args), transport: 'unknown' as const };
    rememberPlaybackStartDiagnostic(result, { stage: 'transmission', code: 'unexpected_response', mayHaveWritten: true, responseFailure: 'ack_result_rejected' });
    return result;
  };
  try {
    const prepared = (await f.post()).json(), url = `${base}/${prepared.confirmationId}/confirm`, body = { nonce: prepared.nonce, observation };
    const result = await f.post(url, body), repeat = await f.post(url, body);
    assert.equal(result.statusCode, 200); assert.equal(result.json().state, 'verification_required'); assert.equal(result.json().confirmedAt, null);
    assert.deepEqual(repeat.json(), result.json()); assert.equal(f.counts().confirms, 1); assert.equal(f.counts().released, 0);
    assert.deepEqual(f.diagnosticLogs, [{ event: 'school_video_start_failed', stage: 'transmission', code: 'unexpected_response', mayHaveWritten: true, responseFailure: 'ack_result_rejected' }]);
    assert.doesNotMatch(result.body, /stage|mayHaveWritten|responseFailure|generation|token|nonce/);
  } finally { await f.app.close(); }
});

test('normalized school authentication failure logs its private fixed cause without changing HTTP auth handling', async () => {
  const f = await fixture();
  f.driver.confirmStart = async () => {
    const error = new SchoolVideoPlaybackStartError('authentication_required', 'refresh', true);
    Object.assign(error, { body: 'private-body', url: 'private-url', token: 'private-token' });
    rememberPlaybackStartDiagnostic(error, playbackStartFailureDiagnostic(error)); throw error;
  };
  try {
    const prepared = (await f.post()).json(), url = `${base}/${prepared.confirmationId}/confirm`, body = { nonce: prepared.nonce, observation };
    const result = await f.post(url, body), repeat = await f.post(url, body);
    assert.equal(result.statusCode, 401); assert.equal(result.json().error.code, 'SCHOOL_AUTH_REQUIRED'); assert.equal(repeat.statusCode, 409);
    assert.equal(f.counts().released, 0);
    assert.deepEqual(f.diagnosticLogs, [{ event: 'school_video_start_failed', stage: 'refresh', code: 'authentication_required', mayHaveWritten: true }]);
    assert.doesNotMatch(JSON.stringify(f.diagnosticLogs) + result.body, /private|body|url|token/);
    assert.doesNotMatch(result.body, /stage|mayHaveWritten|responseFailure/);
  } finally { await f.app.close(); }
});

test('post-driver ALMS authority failure keeps HTTP 401 and logs the already observed transport rejection once', async () => {
  const f = await fixture(), original = f.driver.confirmStart;
  f.driver.confirmStart = async (...args) => {
    const answer = { ...await original(...args), transport: 'unknown' as const };
    rememberPlaybackStartDiagnostic(answer, { stage: 'transmission', code: 'unexpected_response', mayHaveWritten: true, responseFailure: 'ack_result_rejected' });
    f.changeCsrf(); return answer;
  };
  try {
    const prepared = (await f.post()).json(), url = `${base}/${prepared.confirmationId}/confirm`, body = { nonce: prepared.nonce, observation };
    const result = await f.post(url, body);
    assert.equal(result.statusCode, 401); assert.equal(result.json().error.code, 'AUTH_REQUIRED');
    assert.equal(f.counts().confirms, 1); assert.equal(f.counts().released, 0);
    assert.deepEqual(f.diagnosticLogs, [{ event: 'school_video_start_failed', stage: 'transmission', code: 'unexpected_response', mayHaveWritten: true, responseFailure: 'ack_result_rejected' }]);
    assert.doesNotMatch(result.body, /stage|mayHaveWritten|responseFailure/);
  } finally { await f.app.close(); }
});

test('a route logger failure cannot change an uncertain confirmation into a failed or successful HTTP result', async () => {
  const f = await fixture(), original = f.driver.confirmStart;
  f.driver.confirmStart = async (...args) => {
    const result = { ...await original(...args), transport: 'unknown' as const };
    rememberPlaybackStartDiagnostic(result, { stage: 'transmission', code: 'upstream_unavailable', mayHaveWritten: true }); return result;
  };
  f.app.addHook('onRequest', async request => { request.log.warn = () => { throw new Error('private-logger-failure'); }; });
  try {
    const prepared = (await f.post()).json(), url = `${base}/${prepared.confirmationId}/confirm`, body = { nonce: prepared.nonce, observation };
    const result = await f.post(url, body), repeat = await f.post(url, body);
    assert.equal(result.statusCode, 200); assert.equal(result.json().state, 'verification_required'); assert.deepEqual(repeat.json(), result.json());
    assert.equal(f.counts().confirms, 1); assert.equal(f.counts().released, 0);
  } finally { await f.app.close(); }
});

test('unavailable integration explicitly rejects confirmation routes without enabling worker playback', async () => {
  const f = await fixture(false); try {
    for (const url of [base, `${base}/${randomUUID()}/confirm`]) {
      const result = await f.post(url, url === base ? {} : { nonce: 'a'.repeat(43), observation });
      assert.equal(result.statusCode, 503); assert.equal(result.json().error.code, 'PLAYBACK_START_UNAVAILABLE');
    }
    assert.equal(unavailableSchoolProvider.capabilities.playback, false); assert.equal(f.counts().confirms, 0); assert.equal(f.counts().prepares, 0);
  } finally { await f.service.close(); await f.app.close(); }
});

test('request cancellation during pending authentication cannot perform a later school start', async () => {
  const f = await fixture(); let interrupted: (() => void) | undefined, unblock!: () => void, confirmationUrl: string | undefined;
  const wait = new Promise<void>(resolve => { unblock = resolve; }), original = f.store.getSession;
  f.app.addHook('onRequest', async request => { if (request.url === confirmationUrl) interrupted = () => request.raw.emit('aborted'); });
  try {
    const prepared = (await f.post()).json(), url = `${base}/${prepared.confirmationId}/confirm`; confirmationUrl = url;
    f.store.getSession = async hash => { await wait; return original(hash); };
    const pending = f.post(url, { nonce: prepared.nonce, observation });
    for (let i = 0; i < 12 && !interrupted; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(interrupted); interrupted(); unblock(); const result = await pending;
    assert.equal(f.counts().confirms, 0); assert.equal(f.counts().released, 0); assert.equal(result.statusCode, 503);
  } finally { unblock(); await f.app.close(); }
});
