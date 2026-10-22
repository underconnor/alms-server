import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ManualVideoService } from '../src/manual-video-service.js';
import type { PlaybackLeaseRepository } from '../src/manual-video-lease.js';
import type { ManualVideoContext, PreparedManualVideo } from '../src/manual-video-types.js';
import { AppError } from '../src/errors.js';
import { manualVideoObservationTiming } from '../src/manual-video-timing.js';

const context: ManualVideoContext = { owner: randomUUID(), sessionHash: 'a'.repeat(64), courseId: '10', moduleItemId: '20' };
const observation = { positionSeconds: 0, durationSeconds: 600, playbackRate: 1, paused: false, ended: false, seeking: false, visible: true };
const noop = async () => {};
const signal = () => AbortSignal.timeout(5_000);
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  let now = 0, acquire = true, renew = true, reports = 0, observations = 0, closed = 0, released = 0;
  const driver: PreparedManualVideo = { generation: randomUUID(), encryptedSession: 'opaque', baseline: 0, validate: noop,
    observe: () => { observations++; }, report: async event => { reports++; return { transport: 'acknowledged',
      school: { observedAt: new Date().toISOString(), progressPercent: 0, attendance: 'unknown', recognized: null }, state: event === 'unload' || event === 'ended' ? 'closed' : 'ready' }; }, close: () => { closed++; } };
  const leases: PlaybackLeaseRepository = { acquire: async () => acquire, renew: async () => renew, release: async () => { released++; } };
  const school = { prepare: async () => driver }, service = new ManualVideoService(leases, school, () => now);
  return { service, driver, school, leases, setAcquire: (value: boolean) => { acquire = value; }, setRenew: (value: boolean) => { renew = value; },
    advance: (ms: number) => { now += ms; }, counts: () => ({ reports, observations, closed, released }),
    start: () => service.start(context, noop, signal()),
    observe: (s: { playbackId: string; nonce: string }, sequence = 1) => service.observe(context, s.playbackId, { nonce: s.nonce, sequence, observation }, noop, signal()),
    report: (s: { playbackId: string; nonce: string }, reportSequence = 1, event: 'playing' | 'update' | 'unload' | 'ended' = 'playing') => service.report(context, s.playbackId, { nonce: s.nonce, reportSequence, event }, noop, signal()) };
}

test('prepare and heartbeats do not report; only explicit reports return fresh school evidence', async () => {
  const f = fixture(); try {
    const s = await f.start(); assert.equal(s.maxInitialPositionSeconds, 0); assert.equal(s.nonce.length, 43);
    await f.observe(s); assert.equal(f.counts().reports, 0);
    const result = await f.report(s); assert.equal(result.report, 'acknowledged'); assert.equal(result.schoolResult.recognized, null);
    assert.equal(result.state, 'ready'); assert.doesNotMatch(JSON.stringify(result), /nonce|opaque|generation|sessionHash/);
    await f.report(s, 2, 'unload'); assert.equal(f.counts().released, 1);
  } finally { await f.service.close(); }
});
test('prepare advertises timing only for supported installed SDK and exact driver, and snapshots its capability', async () => {
  const legacy = fixture();
  try {
    const s = await legacy.start(); assert.equal('observationTiming' in s, false);
    legacy.driver.observationTiming = 'client_monotonic_v1';
    await assert.rejects(legacy.service.observe(context, s.playbackId, { nonce: s.nonce, sequence: 1,
      observation: { ...observation, capturedAtMs: 0 } }, noop, signal()), { code: 'PLAYBACK_OBSERVATION_INVALID' });
    assert.equal(legacy.counts().observations, 0); assert.equal(legacy.counts().reports, 0);
    await legacy.observe(s);
  } finally { await legacy.service.close(); }
  const capable = fixture(); capable.driver.observationTiming = 'client_monotonic_v1';
  const expected = manualVideoObservationTiming(capable.driver);
  const received: unknown[] = []; capable.driver.observe = value => received.push(value);
  try {
    const s = await capable.start(); assert.equal(s.observationTiming, expected);
    const value = { ...observation, capturedAtMs: 123.125 };
    const pending = capable.service.observe(context, s.playbackId, { nonce: s.nonce, sequence: 1, observation: value }, noop, signal());
    if (expected) { await pending; assert.deepEqual(received, [value]); assert.notEqual(received[0], value); }
    else { await assert.rejects(pending, { code: 'PLAYBACK_OBSERVATION_INVALID' }); assert.deepEqual(received, []); }
    assert.equal(capable.counts().reports, 0);
  } finally { await capable.service.close(); }
});
test('owner, ALMS session, target and execution nonce all bind a manual lifetime', async () => {
  const f = fixture(); try {
    const s = await f.start();
    for (const wrong of [{ ...context, owner: randomUUID() }, { ...context, sessionHash: 'b'.repeat(64) }, { ...context, courseId: '11' }, { ...context, moduleItemId: '21' }])
      await assert.rejects(f.service.observe(wrong, s.playbackId, { nonce: s.nonce, sequence: 1, observation }, noop, signal()), { code: 'NOT_FOUND' });
    await assert.rejects(f.service.observe(context, s.playbackId, { nonce: 'x'.repeat(43), sequence: 1, observation }, noop, signal()), { code: 'NOT_FOUND' });
    assert.equal(f.counts().observations, 0); assert.equal(f.counts().reports, 0);
  } finally { await f.service.close(); }
});
test('same owner starts, lost lease and stale or duplicated observation sequences are rejected', async () => {
  const f = fixture(); try {
    const s = await f.start(); await assert.rejects(f.start(), { code: 'PLAYBACK_BUSY' });
    await assert.rejects(f.observe(s, 2), { code: 'PLAYBACK_OBSERVATION_INVALID' }); await f.observe(s);
    await assert.rejects(f.observe(s), { code: 'PLAYBACK_OBSERVATION_INVALID' });
    f.setRenew(false); await assert.rejects(f.observe(s, 2), { code: 'PLAYBACK_SESSION_EXPIRED' });
    await assert.rejects(f.report(s), { code: 'NOT_FOUND' }); assert.equal(f.counts().reports, 0);
  } finally { await f.service.close(); }
  const denied = fixture(); denied.setAcquire(false);
  try { await assert.rejects(denied.start(), { code: 'PLAYBACK_BUSY' }); assert.equal(denied.counts().closed, 1); }
  finally { await denied.service.close(); }
});
test('separate report queue allows heartbeat progress while a school response is pending', async () => {
  const f = fixture(), wait = gate(), original = f.driver.report; f.driver.report = async (...args) => { await wait.promise; return original(...args); };
  try {
    const s = await f.start(); await f.observe(s); const pending = f.report(s); await flush();
    await assert.rejects(f.report(s), { code: 'PLAYBACK_OBSERVATION_INVALID' });
    f.advance(5_000); await f.observe(s, 2); assert.equal(f.counts().observations, 2);
    wait.release(); assert.equal((await pending).report, 'acknowledged');
    await assert.rejects(f.report(s, 1), { code: 'PLAYBACK_OBSERVATION_INVALID' });
    await assert.rejects(f.report(s, 2, 'update'), { code: 'PLAYBACK_OBSERVATION_INVALID' });
  } finally { wait.release(); await f.service.close(); }
});
test('logout and generation failure prevent observations and report success', async () => {
  for (const reason of ['logout', 'generation']) {
    const f = fixture(); try {
      const s = await f.start();
      const reject = async () => { throw new AppError(reason === 'logout' ? 401 : 409, reason === 'logout' ? 'AUTH_REQUIRED' : 'SCHOOL_SESSION_CHANGED', 'fixed'); };
      if (reason === 'generation') f.driver.validate = reject;
      await assert.rejects(f.service.observe(context, s.playbackId, { nonce: s.nonce, sequence: 1, observation }, reason === 'logout' ? reject : noop, signal()),
        { code: reason === 'logout' ? 'AUTH_REQUIRED' : 'SCHOOL_SESSION_CHANGED' });
      assert.equal(f.counts().observations, 0); assert.equal(f.counts().reports, 0);
    } finally { await f.service.close(); }
  }
});
test('stop during report withholds late success and preserves lease until its bounded expiry', async () => {
  const f = fixture(), wait = gate(), original = f.driver.report; f.driver.report = async (...args) => { await wait.promise; return original(...args); };
  try {
    const s = await f.start(); await f.observe(s); const pending = f.report(s); const rejected = assert.rejects(pending, { code: 'PLAYBACK_REPORT_UNKNOWN' });
    await flush(); await f.service.stop(context, s.playbackId, s.nonce, noop); await rejected;
    assert.equal(f.counts().released, 0); wait.release(); await flush();
    await assert.rejects(f.observe(s, 2), { code: 'NOT_FOUND' }); assert.equal(f.counts().released, 0);
  } finally { wait.release(); await f.service.close(); }
});
test('unknown acknowledgement closes the lifetime, retains its lease and preserves explicit fresh school evidence', async () => {
  const f = fixture(), original = f.driver.report; f.driver.report = async (...args) => ({ ...await original(...args), transport: 'unknown', state: 'closed' });
  try {
    const s = await f.start(); await f.observe(s); const r = await f.report(s); assert.equal(r.report, 'unknown'); assert.equal(r.state, 'closed');
    assert.equal(r.schoolResult.recognized, null); assert.equal(f.counts().released, 0); await assert.rejects(f.report(s, 2), { code: 'NOT_FOUND' });
  } finally { await f.service.close(); }
});
test('missing heartbeats, shutdown and late preparation cannot retain a usable lifecycle', async () => {
  const f = fixture(); const s = await f.start(); f.advance(15_001); await assert.rejects(f.observe(s), { code: 'PLAYBACK_SESSION_EXPIRED' });
  await f.service.close(); await assert.rejects(f.start(), { code: 'PLAYBACK_SESSION_EXPIRED' });
  const late = fixture(), wait = gate(); late.school.prepare = async () => { await wait.promise; return late.driver; };
  const ctl = new AbortController(), pending = late.service.start(context, noop, ctl.signal), rejected = assert.rejects(pending, { code: 'VIDEO_REPORT_UNAVAILABLE' });
  await flush(); ctl.abort(); await rejected; wait.release(); await flush(); assert.equal(late.counts().closed, 1); assert.equal(late.counts().reports, 0); await late.service.close();
});

test('central and registrar shutdown calls share one lease cleanup promise', async () => {
  const f = fixture(), wait = gate(); let releases = 0;
  f.leases.release = async () => { releases++; await wait.promise; };
  await f.start(); const first = f.service.close(), second = f.service.close(); assert.equal(first, second);
  await flush(); assert.equal(releases, 1); wait.release(); await first;
  assert.equal(f.service.close(), first); await second; assert.equal(releases, 1);
});
