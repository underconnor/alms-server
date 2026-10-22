import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedPlaybackIdentity, playbackIsReady, startPlaybackHeartbeat, startReadyPlaybackWorker } from '../src/playback-worker-readiness.js';
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const wait = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

test('SDK identity hashes installed executable bytes and relative paths deterministically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alms-sdk-readiness-'));
  try {
    await mkdir(join(root, 'dist')); await writeFile(join(root, 'package.json'), '{"name":"synthetic"}');
    await writeFile(join(root, 'dist/b.js'), 'b'); await writeFile(join(root, 'dist/a.js'), 'a');
    const first = await installedPlaybackIdentity('a'.repeat(40), root);
    assert.deepEqual(await installedPlaybackIdentity('a'.repeat(40), root), first);
    await writeFile(join(root, 'dist/a.js'), 'changed');
    assert.notEqual((await installedPlaybackIdentity('a'.repeat(40), root)).sdkSha256, first.sdkSha256);
    await assert.rejects(installedPlaybackIdentity('unknown', root), /PLAYBACK_BUILD_IDENTITY_INVALID/);
    await symlink(join(root, 'dist/a.js'), join(root, 'dist/c.js'));
    await assert.rejects(installedPlaybackIdentity('a'.repeat(40), root), /PLAYBACK_BUILD_IDENTITY_INVALID/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('readiness is false for missing, rejected and cancelled readers without returning private failures', async () => {
  assert.equal(await playbackIsReady(), false);
  assert.equal(await playbackIsReady({ isReady: async () => { throw new Error('private-marker'); } }), false);
  const abort = new AbortController(); abort.abort(); let calls = 0;
  assert.equal(await playbackIsReady({ isReady: async () => { calls++; return true; } }, abort.signal), false);
  assert.equal(calls, 0); assert.equal(await playbackIsReady({ isReady: async () => true }), true);
});
test('disabled or aborted worker does not resolve SDK identity, probe, start queue or write heartbeat', async () => {
  for (const disabled of [true, false]) {
    const abort = new AbortController(); if (!disabled) abort.abort();
    let calls = 0; const called = async (): Promise<never> => { calls++; throw Error('called'); };
    const stop = await startReadyPlaybackWorker({ enabled: !disabled, signal: abort.signal, repository: called, probe: called, startQueue: called, failed: () => { calls++; } });
    await stop(); assert.equal(calls, 0);
  }
});
test('readiness is published only after successful probe and queue registration; stop retires it once', async () => {
  const events: string[] = [], gate = wait(), abort = new AbortController();
  const starting = startReadyPlaybackWorker({ enabled: true, signal: abort.signal,
    repository: async () => ({ renew: async () => { events.push('heartbeat'); }, withdraw: async () => { events.push('withdraw'); } }),
    probe: async () => { events.push('probe'); await gate.promise; },
    startQueue: async () => { events.push('queue'); return async () => { events.push('queue-stop'); }; }, failed: () => assert.fail('unexpected failure'),
  });
  await flush(); assert.deepEqual(events, ['probe']); gate.release(); const stop = await starting;
  assert.deepEqual(events, ['probe', 'queue', 'heartbeat']); await Promise.all([stop(), stop()]);
  assert.equal(events.filter(x => x === 'withdraw').length, 1); assert.equal(events.filter(x => x === 'queue-stop').length, 1);
});
test('failed probe or queue never publishes readiness, failed first heartbeat stops the queue', async () => {
  for (const failure of ['probe', 'queue', 'heartbeat']) {
    const events: string[] = [];
    const at = async (name: string) => { events.push(name); if (name === failure) throw Error('synthetic'); };
    await assert.rejects(startReadyPlaybackWorker({ enabled: true, signal: new AbortController().signal,
      repository: async () => ({ renew: () => at('heartbeat'), withdraw: () => at('withdraw') }),
      probe: () => at('probe'), startQueue: async () => { await at('queue'); return () => at('stop'); }, failed: () => assert.fail('unexpected'),
    }));
    if (failure !== 'heartbeat') assert.equal(events.includes('heartbeat'), false);
    else assert.deepEqual(events, ['probe', 'queue', 'heartbeat', 'withdraw', 'stop']);
  }
});
test('shutdown aborts an in-flight initial heartbeat before withdrawing and never renews afterward', async () => {
  const abort = new AbortController(); let signal: AbortSignal | undefined, renews = 0, withdrawals = 0;
  const starting = startPlaybackHeartbeat({ renew: async (_id, value) => { renews++; signal = value; await new Promise(() => {}); }, withdraw: async () => { withdrawals++; } }, abort.signal, () => assert.fail('unexpected'));
  await flush(); abort.abort(); await assert.rejects(starting); assert.equal(signal?.aborted, true);
  await flush(); assert.equal(renews, 1); assert.equal(withdrawals, 1);
});
test('failed heartbeat retires readiness and notifies once without overlapping or retrying', async () => {
  let renews = 0, withdrawals = 0, failures = 0; const failed = wait();
  const stop = await startPlaybackHeartbeat({ renew: async () => { if (++renews > 1) throw Error('synthetic'); }, withdraw: async () => { withdrawals++; } }, new AbortController().signal,
    () => { failures++; failed.release(); }, { intervalMs: 5 });
  // A test-owned timer keeps the loop alive; production heartbeat timers are unref'ed.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await failed.promise; await stop(); await flush(); assert.equal(renews, 2); assert.equal(failures, 1); assert.equal(withdrawals, 1); }
  finally { clearTimeout(keepAlive); await stop(); }
});
