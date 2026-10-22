import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PlaybackStartService, type PreparedPlaybackStart } from '../src/playback-start-service.js';
import type { PlaybackLeaseRepository, PlaybackLeaseScope } from '../src/manual-video-lease.js';
import type { ManualVideoContext } from '../src/manual-video-types.js';
import { AppError } from '../src/errors.js';
import { rememberPlaybackStartDiagnostic, takePlaybackStartDiagnostic } from '../src/playback-start-diagnostics.js';

const context: ManualVideoContext = { owner: randomUUID(), sessionHash: 'a'.repeat(64), courseId: '10', moduleItemId: '20' };
const observation = { positionSeconds: 4, durationSeconds: 600, playbackRate: 1, paused: true, ended: false, seeking: false, visible: true };
const noop = async () => {};
const signal = () => AbortSignal.timeout(5_000);
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture() {
  let now = 1_000, acquire = true, renew = true, prepares = 0, confirms = 0, closed = 0, acquired = 0, released = 0;
  let capturedScope: PlaybackLeaseScope | undefined;
  const driver: PreparedPlaybackStart = { generation: randomUUID(),
    authority: async (validate, current) => { current.throwIfAborted(); await validate(); return { generation: driver.generation, encryptedSession: 'opaque-school-session' }; },
    confirmStart: async (_observation, validate, current) => { current.throwIfAborted(); await validate(); confirms++; return { transport: 'acknowledged',
      school: { observedAt: new Date().toISOString(), progressPercent: 1, attendance: 'unknown', recognized: null } }; },
    close: () => { closed++; } };
  const leases: PlaybackLeaseRepository = { acquire: async scope => { acquired++; capturedScope = scope; return acquire; }, renew: async () => renew,
    release: async scope => { assert.deepEqual(scope, capturedScope); released++; } };
  const school = { prepare: async () => { prepares++; return driver; } }, service = new PlaybackStartService(leases, school, () => now);
  return { service, driver, leases, school, advance: (ms: number) => { now += ms; }, setAcquire: (value: boolean) => { acquire = value; }, setRenew: (value: boolean) => { renew = value; },
    counts: () => ({ prepares, confirms, closed, acquired, released }), scope: () => capturedScope,
    prepare: () => service.prepare(context, noop, signal()),
    confirm: (s: { confirmationId: string; nonce: string }, validate = noop, current = signal()) => service.confirm(context, s.confirmationId, s.nonce, observation, validate, current) };
}

test('preparing reads authority but makes no start write or shared lease; explicit confirmation returns fresh unknown attendance', async () => {
  const f = fixture(); try {
    const prepared = await f.prepare(); assert.equal(prepared.nonce.length, 43); assert.equal(Date.parse(prepared.expiresAt), 121_000);
    assert.equal(f.counts().confirms, 0); assert.equal(f.counts().acquired, 0);
    const result = await f.confirm(prepared); assert.equal(result.state, 'confirmed'); assert.equal(result.confirmedAt, new Date(1_000).toISOString());
    assert.equal(result.schoolResult.recognized, null); assert.equal(result.schoolResult.attendance, 'unknown'); assert.equal(result.schoolResult.progressPercent, 1);
    assert.equal(f.counts().confirms, 1); assert.equal(f.counts().released, 1);
    assert.deepEqual(f.scope(), { owner: context.owner, generation: f.driver.generation, courseId: context.courseId, moduleItemId: context.moduleItemId,
      tokenHash: f.scope()!.tokenHash, kind: 'manual' }); assert.match(f.scope()!.tokenHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), /nonce|generation|sessionHash|opaque-school-session/);
  } finally { await f.service.close(); }
});

test('captured confirmation cannot be used by a different owner, ALMS session, target, identifier or nonce', async () => {
  const f = fixture(); try {
    const prepared = await f.prepare();
    for (const wrong of [{ ...context, owner: randomUUID() }, { ...context, sessionHash: 'b'.repeat(64) }, { ...context, courseId: '11' }, { ...context, moduleItemId: '21' }])
      await assert.rejects(f.service.confirm(wrong, prepared.confirmationId, prepared.nonce, observation, noop, signal()), { code: 'NOT_FOUND' });
    await assert.rejects(f.service.confirm(context, randomUUID(), prepared.nonce, observation, noop, signal()), { code: 'NOT_FOUND' });
    await assert.rejects(f.service.confirm(context, prepared.confirmationId, 'x'.repeat(43), observation, noop, signal()), { code: 'NOT_FOUND' });
    assert.equal(f.counts().confirms, 0); assert.equal(f.counts().acquired, 0);
    assert.equal((await f.confirm(prepared)).state, 'confirmed');
  } finally { await f.service.close(); }
});

test('concurrent confirmation and later duplicate response never produce a second school write or lease', async () => {
  const f = fixture(), wait = gate(), original = f.driver.confirmStart;
  f.driver.confirmStart = async (...args) => { await wait.promise; return original(...args); };
  try {
    const prepared = await f.prepare(), pending = f.confirm(prepared); await flush();
    await assert.rejects(f.confirm(prepared), { code: 'PLAYBACK_START_CONSUMED' });
    assert.equal(f.counts().acquired, 1); wait.release(); const result = await pending;
    assert.deepEqual(await f.confirm(prepared), result); assert.equal(f.counts().confirms, 1); assert.equal(f.counts().acquired, 1); assert.equal(f.counts().released, 1);
    const revoke = async () => { throw new AppError(401, 'AUTH_REQUIRED', 'fixed'); };
    await assert.rejects(f.confirm(prepared, revoke), { code: 'AUTH_REQUIRED' }); assert.equal(f.counts().confirms, 1);
  } finally { wait.release(); await f.service.close(); }
});

test('an explicit unknown answer consumes the confirmation and keeps its common lease without synthesizing success', async () => {
  const f = fixture(), original = f.driver.confirmStart;
  f.driver.confirmStart = async (...args) => ({ ...await original(...args), transport: 'unknown' });
  try {
    const prepared = await f.prepare(), result = await f.confirm(prepared);
    assert.equal(result.state, 'verification_required'); assert.equal(result.confirmedAt, null); assert.equal(result.schoolResult.recognized, null);
    assert.deepEqual(await f.confirm(prepared), result); assert.equal(f.counts().confirms, 1); assert.equal(f.counts().released, 0);
  } finally { await f.service.close(); }
});

test('shared execution busy and loss of lease before entry prevent a school start and release only this acquired claim', async () => {
  for (const mode of ['busy', 'lost'] as const) {
    const f = fixture(); try {
      const prepared = await f.prepare(); if (mode === 'busy') f.setAcquire(false); else f.setRenew(false);
      await assert.rejects(f.confirm(prepared), { code: mode === 'busy' ? 'PLAYBACK_BUSY' : 'PLAYBACK_START_EXPIRED' });
      assert.equal(f.counts().confirms, 0); assert.equal(f.counts().released, mode === 'busy' ? 0 : 1);
      await assert.rejects(f.confirm(prepared), { code: 'PLAYBACK_START_CONSUMED' }); assert.equal(f.counts().acquired, 1);
    } finally { await f.service.close(); }
  }
});

test('logout or school generation change is checked again after lease acquisition and before school entry', async () => {
  for (const mode of ['logout', 'generation'] as const) {
    const f = fixture(); let live = true;
    const validate = async () => { if (!live && mode === 'logout') throw new AppError(401, 'AUTH_REQUIRED', 'fixed'); };
    const original = f.driver.authority;
    f.driver.authority = async (...args) => { const proof = await original(...args); if (!live && mode === 'generation') return { ...proof, generation: randomUUID() }; return proof; };
    f.leases.acquire = async () => { live = false; return true; }; f.leases.release = async () => {};
    try {
      const prepared = await f.prepare(); await assert.rejects(f.confirm(prepared, validate), { code: mode === 'logout' ? 'AUTH_REQUIRED' : 'PLAYBACK_START_EXPIRED' });
      assert.equal(f.counts().confirms, 0);
    } finally { await f.service.close(); }
  }
});

test('lease failure after an unknown write withholds a result and does not replay or release uncertain execution', async () => {
  const f = fixture(), original = f.driver.confirmStart;
  f.driver.confirmStart = async (...args) => { const answer = await original(...args); f.setRenew(false); return { ...answer, transport: 'unknown' }; };
  try {
    const prepared = await f.prepare(); await assert.rejects(f.confirm(prepared), { code: 'PLAYBACK_START_EXPIRED' });
    assert.equal(f.counts().confirms, 1); assert.equal(f.counts().released, 0);
    await assert.rejects(f.confirm(prepared), { code: 'PLAYBACK_START_CONSUMED' }); assert.equal(f.counts().confirms, 1);
  } finally { await f.service.close(); }
});

test('post-driver lease authority failure preserves the observed rejection diagnostic and original error without retry or release', async () => {
  const f = fixture(), original = f.driver.confirmStart;
  f.driver.confirmStart = async (...args) => {
    const answer = { ...await original(...args), transport: 'unknown' as const };
    rememberPlaybackStartDiagnostic(answer, { stage: 'transmission', code: 'unexpected_response', mayHaveWritten: true, responseFailure: 'ack_result_rejected' });
    f.setRenew(false); return answer;
  };
  try {
    const prepared = await f.prepare();
    await assert.rejects(f.confirm(prepared), error => {
      assert.equal((error as AppError).code, 'PLAYBACK_START_EXPIRED');
      assert.deepEqual(takePlaybackStartDiagnostic(error), { stage: 'transmission', code: 'unexpected_response', mayHaveWritten: true, responseFailure: 'ack_result_rejected' });
      return true;
    });
    assert.equal(f.counts().confirms, 1); assert.equal(f.counts().released, 0);
    await assert.rejects(f.confirm(prepared), { code: 'PLAYBACK_START_CONSUMED' }); assert.equal(f.counts().confirms, 1);
  } finally { await f.service.close(); }
});

test('expired and shutdown confirmation cannot enter the school; fresh confirmation stays independent', async () => {
  const f = fixture(); try {
    const prepared = await f.prepare(); f.advance(120_000); await assert.rejects(f.confirm(prepared), { code: 'PLAYBACK_START_EXPIRED' });
    assert.equal(f.counts().confirms, 0); assert.equal(f.counts().acquired, 0);
    const fresh = await f.prepare(); await f.service.close(); await assert.rejects(f.confirm(fresh), { code: 'NOT_FOUND' });
    await assert.rejects(f.prepare(), { code: 'PLAYBACK_START_UNAVAILABLE' }); assert.equal(f.counts().confirms, 0);
  } finally { await f.service.close(); }
});

test('caller cancellation before school entry consumes only this confirmation and never authorizes a late answer', async () => {
  const f = fixture(), wait = gate(), original = f.driver.authority; let hold = false;
  f.driver.authority = async (...args) => { if (hold) await wait.promise; return original(...args); };
  try {
    const prepared = await f.prepare(); hold = true; const controller = new AbortController(), pending = f.confirm(prepared, noop, controller.signal);
    const rejected = assert.rejects(pending, { code: 'PLAYBACK_START_UNAVAILABLE' }); await flush(); controller.abort(); await rejected;
    wait.release(); await flush(); assert.equal(f.counts().confirms, 0); assert.equal(f.counts().acquired, 0);
    hold = false; await assert.rejects(f.confirm(prepared), { code: 'PLAYBACK_START_CONSUMED' });
  } finally { wait.release(); await f.service.close(); }
});

test('abort during a possible write retains uncertainty and discards a late successful driver response', async () => {
  const f = fixture(), wait = gate(), original = f.driver.confirmStart;
  f.driver.confirmStart = async (...args) => { const result = await original(...args); await wait.promise; return result; };
  try {
    const prepared = await f.prepare(), controller = new AbortController(), pending = f.confirm(prepared, noop, controller.signal);
    const rejected = assert.rejects(pending, { code: 'PLAYBACK_START_UNAVAILABLE' }); await flush(); assert.equal(f.counts().confirms, 1);
    controller.abort(); await rejected; assert.equal(f.counts().released, 0);
    wait.release(); await flush(); await assert.rejects(f.confirm(prepared), { code: 'PLAYBACK_START_CONSUMED' });
    assert.equal(f.counts().confirms, 1); assert.equal(f.counts().released, 0);
  } finally { wait.release(); await f.service.close(); }
});

test('shutdown interrupts pending start and does not release a possibly written lease or retain a late result', async () => {
  const f = fixture(), wait = gate(), original = f.driver.confirmStart;
  f.driver.confirmStart = async (...args) => { const result = await original(...args); await wait.promise; return result; };
  const prepared = await f.prepare(), pending = f.confirm(prepared), rejected = assert.rejects(pending, { code: 'PLAYBACK_START_UNAVAILABLE' });
  await flush(); await f.service.close(); await rejected; wait.release(); await flush();
  assert.equal(f.counts().confirms, 1); assert.equal(f.counts().released, 0);
  await assert.rejects(f.confirm(prepared), { code: 'NOT_FOUND' });
});

test('late preparation after cancellation closes its private driver and does not leave a usable confirmation', async () => {
  const f = fixture(), wait = gate(); f.school.prepare = async () => { await wait.promise; return f.driver; };
  const controller = new AbortController(), pending = f.service.prepare(context, noop, controller.signal), rejected = assert.rejects(pending, { code: 'PLAYBACK_START_UNAVAILABLE' });
  await flush(); controller.abort(); await rejected; wait.release(); await flush();
  assert.equal(f.counts().closed, 1); assert.equal(f.counts().confirms, 0); assert.equal(f.counts().acquired, 0); await f.service.close();
});

test('operation deadline never exposes late acknowledgement or retries the confirmation', async t => {
  const f = fixture(), wait = gate(), original = f.driver.confirmStart, native = globalThis.setTimeout;
  f.driver.confirmStart = async (...args) => { const result = await original(...args); await wait.promise; return result; };
  t.mock.method(globalThis, 'setTimeout', (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => native(fn, ms === 90_000 ? 25 : ms, ...args));
  try {
    const prepared = await f.prepare(); await assert.rejects(f.confirm(prepared), { code: 'PLAYBACK_START_UNAVAILABLE' });
    wait.release(); await flush(); await assert.rejects(f.confirm(prepared), { code: 'PLAYBACK_START_CONSUMED' });
    assert.equal(f.counts().confirms, 1); assert.equal(f.counts().released, 0);
  } finally { wait.release(); await f.service.close(); }
});
