import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Job, Session } from '../src/domain.js';
import { publicPlaybackQueue, playbackQueueEstimate, playbackQueueWaitReason, type PlaybackQueueSnapshot } from '../src/playback-queue.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashToken, type Store } from '../src/store.js';
import { playbackClientAccept } from '../src/playback-client-contract.js';
import { unavailableSchoolProvider } from '../src/provider.js';
import { createJobResultCache } from '../src/job-result-cache.js';

const now = '2026-01-01T12:00:00.000Z';
const job = (patch: Partial<Job> = {}): Job => ({ id: randomUUID(), userId: 'synthetic-owner', courseId: '10', lectureId: '20',
  status: 'queued', scheduledFor: now, createdAt: now, updatedAt: now, schoolResult: null, errorCode: null,
  idempotencyKey: randomUUID(), requestHash: 'synthetic-private', acceptedGeneration: 'synthetic-generation',
  executionTokenHash: null, executionOutcome: null, ...patch });
const snapshot = (value: Job): PlaybackQueueSnapshot => ({ jobs: [value], counts: { active: 0, waiting: 1, total: 1 },
  serverTime: now, complete: true, hasMore: false, limit: 200, forecast: { activeCount: 0, activeStatus: null,
    activeObservation: null, blockingLease: false, entries: { [value.id]: { position: 1, priorDuration: 0, unknownPrior: false,
      legacy: false, permissionInvalid: false, priorPermissionInvalid: false, minimumPriorExpiry: null } } } });
const observation = { observedAt: '2026-01-01T11:59:59.000Z', positionSeconds: 20, durationSeconds: 100, percent: 20, paused: false, ended: false };

test('queue estimate uses real remaining seconds and known predecessors, never elapsed-clock interpolation', () => {
  const value = job(), state = snapshot(value);
  assert.deepEqual(playbackQueueEstimate(value, state, 'ready'), { position: 1, estimatedStartAt: now, estimateReason: 'estimated' });
  Object.assign(state.forecast!, { activeCount: 1, activeStatus: 'running', activeObservation: observation });
  Object.assign(state.forecast!.entries[value.id]!, { position: 3, priorDuration: 300 });
  assert.deepEqual(playbackQueueEstimate(value, state, 'ready'), { position: 3, estimatedStartAt: '2026-01-01T12:06:20.000Z', estimateReason: 'estimated' });
});
test('queue estimates withhold unknown duration, stale progress, blocked execution and legacy order', () => {
  const value = job(), state = snapshot(value), entry = state.forecast!.entries[value.id]!;
  entry.unknownPrior = true; assert.equal(playbackQueueEstimate(value, state, 'ready').estimateReason, 'unknown_duration');
  entry.unknownPrior = false; Object.assign(state.forecast!, { activeCount: 1, activeStatus: 'running', activeObservation: { ...observation, observedAt: '2026-01-01T11:59:45Z' } });
  assert.equal(playbackQueueEstimate(value, state, 'ready').estimateReason, 'stale_progress');
  state.forecast!.activeObservation = { ...observation, paused: true }; assert.equal(playbackQueueEstimate(value, state, 'ready').estimatedStartAt, null);
  state.forecast!.activeStatus = 'reconciling'; assert.equal(playbackQueueEstimate(value, state, 'ready').estimateReason, 'execution_blocked');
  state.forecast!.activeCount = 0; entry.legacy = true; assert.equal(playbackQueueEstimate(value, state, 'ready').position, null);
  entry.legacy = false; state.forecast!.blockingLease = true; assert.equal(playbackQueueEstimate(value, state, 'ready').position, null);
});
test('future reservations have no current position, and permission bounds invalidate estimates', () => {
  const value = job({ scheduledFor: '2026-01-01T13:00:00Z' }), state = snapshot(value);
  assert.deepEqual(playbackQueueEstimate(value, state, 'ready'), { position: null, estimatedStartAt: null, estimateReason: 'not_due' });
  value.scheduledFor = now; state.forecast!.entries[value.id]!.permissionInvalid = true;
  assert.equal(playbackQueueEstimate(value, state, 'ready').estimateReason, 'permission_unavailable');
  state.forecast!.entries[value.id]!.permissionInvalid = false;
  state.forecast!.entries[value.id]!.priorDuration = 60;
  state.forecast!.entries[value.id]!.minimumPriorExpiry = '2026-01-01T12:00:30Z';
  assert.equal(playbackQueueEstimate(value, state, 'ready').estimateReason, 'permission_expires_before_start');
  assert.equal(playbackQueueEstimate(value, state, 'unavailable').estimateReason, 'worker_unavailable');
});
test('active and authentication-wait rows are distinct from schedulable queue positions', () => {
  const value = job({ status: 'running' }), state = snapshot(value);
  assert.equal(playbackQueueWaitReason(value, now, 'ready'), null);
  assert.equal(playbackQueueEstimate(value, state, 'ready').position, null);
  value.status = 'queued'; value.authWait = { reason: 'school_auth_required', waitingSince: now, continuedAsJobId: null, canContinue: false };
  assert.equal(playbackQueueWaitReason(value, now, 'ready'), 'authentication_wait');
  assert.equal(playbackQueueEstimate(value, state, 'ready').estimateReason, 'authentication_wait');
});
test('public queue strips private authority and all cross-owner forecast data while preserving exact counts and nullable results', () => {
  const value = job(), state = snapshot(value); state.counts = { active: 0, waiting: 201, total: 201 }; state.complete = false; state.hasMore = true;
  state.forecast!.activeObservation = { privateForeignData: 'synthetic-foreign-secret' };
  const result = publicPlaybackQueue(state, 'ready');
  assert.equal(result.items[0]!.job.schoolResult, null); assert.deepEqual(result.counts, state.counts);
  assert.equal(result.complete, false); assert.equal(result.items.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|synthetic-generation|synthetic-foreign-secret|forecast|executionTokenHash|userId/);
});

async function apiFixture() {
  const token = 'a'.repeat(43), value = job(); let authenticated = true, reads = 0, refreshes = 0;
  const session: Session = { tokenHash: hashToken(token), csrfToken: 'synthetic-csrf', analyticsSessionId: randomUUID(), expiresAt: '2030-01-01T00:00:00Z',
    user: { id: value.userId, displayName: null, analyticsId: randomUUID(), analyticsEnabled: true } };
  const scopes: unknown[] = [];
  const store = { getSession: async () => authenticated ? session : null,
    getJobQueueSnapshot: async (owner: string, course?: string) => { reads++; scopes.push([owner, course]); return snapshot(value); },
  } as unknown as Store;
  const config = loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' });
  const app = await buildApp(config, store, unavailableSchoolProvider, undefined, undefined, undefined,
    createJobResultCache(async () => { refreshes++; throw new Error('queue must not call school refresh'); }));
  return { app, value, scopes, counts: () => ({ reads, refreshes }), logout: () => { authenticated = false; },
    headers: { cookie: '__Host-alms_session=' + token, accept: playbackClientAccept } };
}
test('static queue route preserves owner/course scope and never invokes school-result refresh', async () => {
  const f = await apiFixture();
  try {
    const response = await f.app.inject({ url: '/v1/jobs/queue?courseId=10', headers: f.headers });
    assert.equal(response.statusCode, 200); assert.deepEqual(f.scopes, [['synthetic-owner', '10']]);
    assert.equal(response.json().items[0].job.id, f.value.id); assert.equal(response.json().worker.state, 'disabled');
    assert.deepEqual(f.counts(), { reads: 1, refreshes: 0 });
  } finally { await f.app.close(); }
});
test('queue authentication, modern-client contract, Origin and strict query reject without school access', async () => {
  const f = await apiFixture();
  try {
    assert.equal((await f.app.inject({ url: '/v1/jobs/queue' })).statusCode, 401);
    assert.equal((await f.app.inject({ url: '/v1/jobs/queue', headers: { cookie: f.headers.cookie } })).statusCode, 409);
    assert.equal((await f.app.inject({ url: '/v1/jobs/queue?limit=201', headers: f.headers })).statusCode, 400);
    assert.equal((await f.app.inject({ url: '/v1/jobs/queue', headers: { ...f.headers, origin: 'https://foreign.invalid' } })).statusCode, 403);
    f.logout(); assert.equal((await f.app.inject({ url: '/v1/jobs/queue', headers: f.headers })).statusCode, 401);
    // With playback disabled, historical accepted generations are discovered by one stored read.
    assert.deepEqual(f.counts(), { reads: 1, refreshes: 0 });
  } finally { await f.app.close(); }
});
