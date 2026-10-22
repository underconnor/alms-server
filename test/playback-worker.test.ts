import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createPlaybackFinalProof, claimMatchesJob, inspectPlaybackFinalProof, type WorkerClaim } from '../src/playback-authority.js';
import type { JobTransitionOptions } from '../src/store.js';
import type { PgBoss } from 'pg-boss';
import type { WorkerQuery } from '../src/worker-bounds.js';
import type { Job, JobStatus, SchoolResult } from '../src/domain.js';
import type { PreparedPlayback, SchoolProvider } from '../src/provider.js';
import { AppError } from '../src/errors.js';
import type { PgStore } from '../src/store.js';
import { executeJob } from '../src/job-runner.js';
import { startWorker } from '../src/queue.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  let job: Job | null = {
    id: 'synthetic-job', userId: 'synthetic-owner', courseId: 'synthetic-course', lectureId: 'synthetic-lecture',
    status: 'queued', scheduledFor: '2026-10-01T00:00:00Z', createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z', schoolResult: null, errorCode: null,
    idempotencyKey: 'synthetic-key', requestHash: 'synthetic-hash', acceptedGeneration: randomUUID(), executionTokenHash: null, executionOutcome: null,
  };
  const store = {
    async claimJob() {
      if (!job || job.status !== 'queued') return null;
      job.status = 'running'; job.executionTokenHash = randomBytes(32).toString('hex'); return { ...job };
    },
    async getWorkerJob(claim: WorkerClaim) { return job && claimMatchesJob(claim, job) ? { ...job } : null; },
    async transitionJob(claim: WorkerClaim, from: JobStatus[], to: JobStatus, result?: SchoolResult | null, error?: string | null, options: JobTransitionOptions = {}) {
      if (!job || !claimMatchesJob(claim, job) || !from.includes(job.status)) return null;
      if (result) inspectPlaybackFinalProof(options.authority!, claim);
      job = { ...job, status: to, schoolResult: result ?? job.schoolResult, errorCode: error ?? null, executionOutcome: options.outcome ?? job.executionOutcome,
        executionTokenHash: ['running','reconciling','pause_requested','cancel_requested'].includes(to) ? job.executionTokenHash : null };
      return { ...job };
    },
    async heartbeat(claim: WorkerClaim) { return Boolean(job && claimMatchesJob(claim, job)); },
    async quarantineLegacyJobs() { return 0; },
    async recoverStaleJobs() { return 0; },
    async workerTransaction<T>(run: (query: WorkerQuery) => Promise<T>) {
      return run((async () => ({ rows: [], rowCount: 0 })) as unknown as WorkerQuery);
    },
  };
  return {
    store: store as unknown as PgStore,
    current: () => job,
    mark(status: JobStatus) { if (job) job.status = status; },
    remove() { job = null; },
  };
}

function prepared(overrides: Partial<PreparedPlayback> = {}): PreparedPlayback {
  return { alreadyRecognized: false, handle: {}, dispose: async () => {}, ...overrides };
}

function provider(overrides: Partial<SchoolProvider> = {}): SchoolProvider {
  const claims = new WeakMap<PreparedPlayback, WorkerClaim>();
  const prepare = overrides.preparePlayback ?? (async () => prepared());
  const validate = overrides.validatePlayback;
  return {
    capabilities: { schoolAuthentication: false, schoolRead: false, playback: true, pauseResume: false },
    play: async () => {},
    playbackLearningStatus: async () => ({ observedAt: '2026-10-01T00:00:00Z', progressPercent: 100, attendance: 'present', recognized: true }),
    ...overrides,
    preparePlayback: async (context, target, signal) => {
      const value = await prepare(context, target, signal);
      if (!claims.has(value)) claims.set(value, context.claim);
      return value;
    },
    validatePlayback: async (value, signal) => {
      const override = await validate?.(value, signal);
      const claim = claims.get(value)!;
      return override ?? createPlaybackFinalProof(claim, { generation: claim.acceptedGeneration, encryptedSession: 'synthetic-seal' });
    },
  };
}

async function queueFixture(store: PgStore, school: SchoolProvider, shutdown: AbortSignal) {
  let handler!: (jobs: Array<{ data: { jobId: string }; signal: AbortSignal }>) => Promise<void>;
  const boss = {
    async start() {}, async createQueue() {}, async stop() {},
    async work(_name: string, _options: unknown, callback: typeof handler) { handler = callback; },
  } as unknown as PgBoss;
  const stop = await startWorker(store, boss, school, shutdown);
  return { stop, deliver: (signal: AbortSignal) => handler([{ data: { jobId: 'synthetic-job' }, signal }]) };
}

test('recovery during playback preparation prevents the old worker from starting the runtime', async () => {
  const f = fixture(); let plays = 0;
  await executeJob('synthetic-job', f.store, provider({
    preparePlayback: async () => { f.mark('needs_verification'); return prepared(); },
    play: async () => { plays++; },
  }));
  assert.equal(plays, 0);
  assert.equal(f.current()?.status, 'needs_verification');
});

test('a job removed during preparation cannot start playback', async () => {
  const f = fixture(); let plays = 0;
  await executeJob('synthetic-job', f.store, provider({
    preparePlayback: async () => { f.remove(); return prepared(); },
    play: async () => { plays++; },
  }));
  assert.equal(plays, 0);
  assert.equal(f.current(), null);
});

test('an already aborted queue claim never starts playback', async () => {
  const f = fixture(); let plays = 0;
  const queue = new AbortController(); queue.abort('claim_lost');
  const worker = await queueFixture(f.store, provider({ play: async () => { plays++; } }), new AbortController().signal);
  try {
    await worker.deliver(queue.signal);
    assert.equal(plays, 0);
    assert.equal(f.current()?.status, 'queued');
    assert.equal(f.current()?.schoolResult, null);
  } finally { await worker.stop(); }
});

for (const abortSource of ['queue', 'shutdown'] as const) {
  test(`${abortSource} abort stops the adapter and waits for runtime cleanup before recording interruption`, async () => {
    const f = fixture(); const started = deferred(); const cleaned = deferred();
    const queue = new AbortController(); const shutdown = new AbortController();
    let runtimeSignal: AbortSignal | undefined; let reads = 0;
    const worker = await queueFixture(f.store, provider({
      play: async (_prepared, signal) => {
        runtimeSignal = signal; started.resolve(); await cleaned.promise;
      },
      playbackLearningStatus: async () => { reads++; return { observedAt: '2026-10-01T00:00:00Z', progressPercent: null, attendance: 'unknown', recognized: null }; },
    }), shutdown.signal);
    const running = worker.deliver(queue.signal);
    try {
      await started.promise;
      (abortSource === 'queue' ? queue : shutdown).abort('interrupted');
      assert.equal(runtimeSignal?.aborted, true);
      assert.equal(f.current()?.status, 'running');
      cleaned.resolve(); await running;
      assert.equal(f.current()?.status, 'needs_verification');
      assert.equal(f.current()?.errorCode, 'WORKER_INTERRUPTED');
      assert.equal(f.current()?.schoolResult, null);
      assert.equal(reads, 0);
    } finally { cleaned.resolve(); await running; await worker.stop(); }
  });
}

test('an active queue claim still finishes only after reading the recognized school result', async () => {
  const f = fixture(); let reads = 0;
  const worker = await queueFixture(f.store, provider({ playbackLearningStatus: async () => {
    reads++; return { observedAt: '2026-10-01T00:00:00Z', progressPercent: 100, attendance: 'present', recognized: true };
  } }), new AbortController().signal);
  try {
    await worker.deliver(new AbortController().signal);
    assert.equal(reads, 1);
    assert.equal(f.current()?.status, 'succeeded');
  } finally { await worker.stop(); }
});

const recognized: SchoolResult = {
  observedAt: '2026-10-01T00:00:00Z', progressPercent: 100, attendance: 'present', recognized: true,
};

function aborted(signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
}

test('preparation receives the job abort signal and its late handle is disposed without playback', async () => {
  const f = fixture(); const entered = deferred(); const release = deferred(); const shutdown = new AbortController();
  let prepareSignal: AbortSignal | undefined; let plays = 0; let disposals = 0;
  const running = executeJob('synthetic-job', f.store, provider({
    preparePlayback: async (_context, _target, signal) => {
      prepareSignal = signal; entered.resolve(); await release.promise;
      return prepared({ dispose: async () => { disposals++; } });
    },
    play: async () => { plays++; },
  }), shutdown.signal, 2);
  await entered.promise; shutdown.abort();
  assert.equal(prepareSignal?.aborted, true);
  assert.equal(f.current()?.status, 'running');
  release.resolve(); await running;
  assert.equal(plays, 0); assert.equal(disposals, 1);
  assert.equal(f.current()?.status, 'needs_verification');
});

test('the exact prepared handle is played once and cleanup precedes success', async () => {
  const f = fixture(); const disposing = deferred(); const cleaned = deferred(); let seen: PreparedPlayback | undefined;
  const value = prepared({ dispose: async () => { disposing.resolve(); await cleaned.promise; } });
  const running = executeJob('synthetic-job', f.store, provider({
    preparePlayback: async () => value,
    play: async current => { seen = current; },
  }), undefined, 2);
  await disposing.promise;
  assert.equal(seen, value); assert.equal(f.current()?.status, 'reconciling');
  cleaned.resolve(); await running;
  assert.equal(f.current()?.status, 'succeeded');
});

test('a prepared runtime cannot be lent to a second job or disposed by that job', async () => {
  const first = fixture(); const second = fixture(); const playing = deferred(); const finish = deferred();
  let plays = 0; let disposals = 0;
  const value = prepared({ dispose: async () => { disposals++; } });
  const school = provider({
    preparePlayback: async () => value,
    play: async () => { plays++; playing.resolve(); await finish.promise; },
  });
  const active = executeJob('synthetic-job', first.store, school);
  await playing.promise;
  await executeJob('synthetic-job', second.store, school);
  assert.equal(plays, 1); assert.equal(disposals, 0);
  assert.equal(second.current()?.status, 'needs_verification');
  finish.resolve(); await active;
  assert.equal(disposals, 1); assert.equal(first.current()?.status, 'succeeded');
});

for (const replacement of ['removed', 'succeeded', 'reconciling', 'pause_requested'] as const) {
  test(`running poll aborts when its job becomes ${replacement}`, async () => {
    const f = fixture(); const playing = deferred(); let signal: AbortSignal | undefined; let disposed = false; let reads = 0;
    const running = executeJob('synthetic-job', f.store, provider({
      play: async (_prepared, value) => { signal = value; playing.resolve(); await aborted(value); },
      preparePlayback: async () => prepared({ dispose: async () => { disposed = true; } }),
      playbackLearningStatus: async () => { reads++; return recognized; },
    }), undefined, 2);
    await playing.promise;
    if (replacement === 'removed') f.remove(); else f.mark(replacement);
    await running;
    assert.equal(signal?.aborted, true); assert.equal(disposed, true); assert.equal(reads, 0);
    assert.equal(f.current()?.status, replacement === 'removed' ? undefined
      : replacement === 'pause_requested' || replacement === 'reconciling' ? 'needs_verification' : replacement);
  });
}

for (const replacement of ['removed', 'running', 'needs_verification'] as const) {
  test(`reconciling poll aborts result reads when the claim becomes ${replacement}`, async () => {
    const f = fixture(); const reading = deferred(); let resultSignal: AbortSignal | undefined; let disposed = false;
    const running = executeJob('synthetic-job', f.store, provider({
      preparePlayback: async () => prepared({ dispose: async () => { disposed = true; } }),
      playbackLearningStatus: async (_prepared, signal) => {
        assert.ok(signal); resultSignal = signal; reading.resolve(); await aborted(signal); return recognized;
      },
    }), undefined, 2);
    await reading.promise;
    if (replacement === 'removed') f.remove(); else f.mark(replacement);
    await running;
    assert.equal(resultSignal?.aborted, true); assert.equal(disposed, true);
    assert.notEqual(f.current()?.status, 'succeeded');
    assert.equal(f.current()?.schoolResult ?? null, null);
  });
}

test('a heartbeat failure aborts playback and awaits disposal before marking uncertainty', async () => {
  const f = fixture(); const playing = deferred(); const disposing = deferred(); const cleanup = deferred(); let fail = false;
  f.store.heartbeat = async () => { if (fail) throw new Error('synthetic DB unavailable'); return true; };
  const running = executeJob('synthetic-job', f.store, provider({
    preparePlayback: async () => prepared({ dispose: async () => { disposing.resolve(); await cleanup.promise; } }),
    play: async (_prepared, signal) => { playing.resolve(); await aborted(signal); },
  }), undefined, 2);
  await playing.promise; fail = true; await disposing.promise;
  assert.equal(f.current()?.status, 'running');
  cleanup.resolve(); await running;
  assert.equal(f.current()?.status, 'needs_verification');
  assert.equal(f.current()?.errorCode, 'WORKER_INTERRUPTED');
});

test('a changed login generation stops playback and records reauthentication only after disposal', async () => {
  for (const code of ['AUTH_REQUIRED', 'SCHOOL_AUTH_REQUIRED']) {
  const f = fixture(); const playing = deferred(); let generation = 1; let disposed = false;
  const value = prepared({ dispose: async () => { disposed = true; } });
  const running = executeJob('synthetic-job', f.store, provider({
    preparePlayback: async () => value,
    validatePlayback: async (actual, signal) => {
      assert.equal(actual, value); signal.throwIfAborted();
      if (generation !== 1) throw new AppError(401, code, 'synthetic login changed');
    },
    play: async (_prepared, signal) => { playing.resolve(); await aborted(signal); },
  }), undefined, 2);
  await playing.promise; generation = 2; await running;
  assert.equal(disposed, true);
  assert.equal(f.current()?.status, 'needs_reauthentication');
  assert.equal(f.current()?.errorCode, 'AUTH_REQUIRED');
  }
});

test('cleanup failure keeps a cancellation uncertain and does not read a result or claim cancellation', async () => {
  const f = fixture(); let reads = 0;
  await executeJob('synthetic-job', f.store, provider({
    preparePlayback: async () => prepared({ dispose: async () => { throw new Error('synthetic cleanup failure'); } }),
    play: async () => { f.mark('cancel_requested'); },
    playbackLearningStatus: async () => { reads++; return recognized; },
  }));
  assert.equal(reads, 0);
  assert.equal(f.current()?.status, 'needs_verification');
  assert.equal(f.current()?.errorCode, 'PLAYBACK_CLEANUP_FAILED');
});

for (const late of [false, true]) {
  test(`a ${late ? 'late aborted' : 'direct'} unknown report keeps cancellation uncertain even when a fresh read could recognize it`, async () => {
    const f = fixture(); let reads = 0; let disposed = false;
    await executeJob('synthetic-job', f.store, provider({
      preparePlayback: async () => prepared({ dispose: async () => { disposed = true; } }),
      play: async (_prepared, signal) => {
        f.mark('cancel_requested');
        if (late) {
          await aborted(signal);
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'synthetic uncertain report');
      },
      playbackLearningStatus: async () => { reads++; return recognized; },
    }), undefined, 2);
    assert.equal(disposed, true);
    assert.equal(reads, 0);
    assert.equal(f.current()?.status, 'needs_verification');
    assert.equal(f.current()?.errorCode, 'PLAYBACK_REPORT_UNKNOWN');
    assert.equal(f.current()?.executionOutcome, 'interrupted');
    assert.equal(f.current()?.schoolResult, null);
  });
}

test('an unknown report preserves its fixed diagnostic after normal execution failure', async () => {
  const f = fixture(); let reads = 0;
  await executeJob('synthetic-job', f.store, provider({
    play: async () => { throw new AppError(503, 'PLAYBACK_REPORT_UNKNOWN', 'synthetic uncertain report'); },
    playbackLearningStatus: async () => { reads++; return recognized; },
  }));
  assert.equal(reads, 0);
  assert.equal(f.current()?.status, 'needs_verification');
  assert.equal(f.current()?.errorCode, 'PLAYBACK_REPORT_UNKNOWN');
  assert.equal(f.current()?.schoolResult, null);
});

test('cancellation reads the school again only after disposal finishes', async () => {
  const f = fixture(); const disposing = deferred(); const cleaned = deferred(); let disposed = false; let reads = 0;
  const running = executeJob('synthetic-job', f.store, provider({
    preparePlayback: async () => prepared({ dispose: async () => {
      disposing.resolve(); await cleaned.promise; disposed = true;
    } }),
    play: async () => { f.mark('cancel_requested'); },
    playbackLearningStatus: async () => { assert.equal(disposed, true); reads++; return recognized; },
  }));
  await disposing.promise;
  assert.equal(f.current()?.status, 'cancel_requested'); assert.equal(reads, 0);
  cleaned.resolve(); await running;
  assert.equal(f.current()?.status, 'cancelled'); assert.equal(reads, 1);
});

test('an unrecognized school result never succeeds even when runtime playback ends normally', async () => {
  const f = fixture(); let disposed = false;
  await executeJob('synthetic-job', f.store, provider({
    preparePlayback: async () => prepared({ dispose: async () => { disposed = true; } }),
    playbackLearningStatus: async () => ({ ...recognized, recognized: null, progressPercent: null, attendance: 'unknown' }),
  }));
  assert.equal(disposed, true); assert.equal(f.current()?.status, 'completed');
  assert.equal(f.current()?.executionOutcome, 'ended'); assert.equal(f.current()?.schoolResult?.recognized, null);
  assert.equal(f.current()?.errorCode, null);
});

test('login generation changing during disposal invalidates an earlier recognized result', async () => {
  const f = fixture(); let generation = 1;
  await executeJob('synthetic-job', f.store, provider({
    preparePlayback: async () => prepared({ dispose: async () => { generation = 2; } }),
    validatePlayback: async (_prepared, signal) => {
      signal.throwIfAborted();
      if (generation !== 1) throw new AppError(401, 'AUTH_REQUIRED', 'synthetic login changed');
    },
  }));
  assert.equal(f.current()?.status, 'needs_reauthentication');
  assert.equal(f.current()?.schoolResult, null);
});

test('an already recognized activity skips playback but still disposes and rechecks school status', async () => {
  const f = fixture(); let plays = 0; let reads = 0; let disposals = 0;
  await executeJob('synthetic-job', f.store, provider({
    preparePlayback: async () => prepared({ alreadyRecognized: true, dispose: async () => { disposals++; } }),
    play: async () => { plays++; },
    playbackLearningStatus: async () => { reads++; return { ...recognized, recognized: null }; },
  }));
  assert.equal(plays, 0); assert.equal(reads, 1); assert.equal(disposals, 1);
  assert.equal(f.current()?.status, 'needs_verification');
});

test('an ordinary school result read failure is not mislabeled as worker interruption', async () => {
  const f = fixture(); let disposed = false;
  await executeJob('synthetic-job', f.store, provider({
    preparePlayback: async () => prepared({ dispose: async () => { disposed = true; } }),
    playbackLearningStatus: async () => { throw new Error('synthetic school unavailable'); },
  }));
  assert.equal(disposed, true);
  assert.equal(f.current()?.status, 'needs_verification');
  assert.equal(f.current()?.errorCode, 'SCHOOL_RESULT_UNKNOWN');
});

const shortLimits = { operationMs: 30, preparationMs: 30, resultMs: 30, cleanupMs: 40, finalizationMs: 100 };
const never = <T>() => new Promise<T>(() => {});

test('a hung claim is aborted before any school operation and executeJob returns', { timeout: 1000 }, async () => {
  const f = fixture(); let signal: AbortSignal | undefined; let preparations = 0;
  f.store.claimJob = async (_id, operation) => { signal = operation?.signal; return never(); };
  await executeJob('synthetic-job', f.store, provider({ preparePlayback: async () => { preparations++; return prepared(); } }), undefined, 2, shortLimits);
  assert.equal(signal?.aborted, true); assert.equal(preparations, 0); assert.equal(f.current()?.status, 'queued');
});

for (const blocked of ['read', 'heartbeat', 'generation'] as const) {
  test(`a hung ${blocked} inspection aborts playback immediately and cannot publish success`, { timeout: 1000 }, async () => {
    const f = fixture(); const started = deferred(); let playing = false; let stopped = false; let disposed = 0;
    let databaseSignal: AbortSignal | undefined;
    const originalRead = f.store.getWorkerJob.bind(f.store);
    if (blocked === 'read') f.store.getWorkerJob = async (id, operation) => {
      if (!playing) return originalRead(id, operation);
      databaseSignal = operation?.signal; return never();
    };
    if (blocked === 'heartbeat') f.store.heartbeat = async (_id, operation) => {
      if (playing) { databaseSignal = operation?.signal; return never(); } return true;
    };
    const running = executeJob('synthetic-job', f.store, provider({
      preparePlayback: async () => prepared({ dispose: async () => { disposed++; } }),
      play: async (_handle, signal) => { playing = true; started.resolve(); await aborted(signal); stopped = true; },
      validatePlayback: async (_handle, signal) => { if (playing && blocked === 'generation') { databaseSignal = signal; return never(); } },
      playbackLearningStatus: async () => { assert.fail('must not read success'); },
    }), undefined, 2, shortLimits);
    await started.promise; await running;
    assert.equal(stopped, true); assert.equal(disposed, 1); assert.equal(databaseSignal?.aborted, true);
    assert.notEqual(f.current()?.status, 'succeeded'); assert.equal(f.current()?.schoolResult, null);
  });
}

test('a hung preparation releases a late handle after the runner has already recorded uncertainty', { timeout: 1000 }, async () => {
  const f = fixture(); const ready = deferred(); let disposals = 0; let plays = 0;
  await executeJob('synthetic-job', f.store, provider({
    preparePlayback: async () => { await ready.promise; return prepared({ dispose: async () => { disposals++; } }); },
    play: async () => { plays++; },
  }), undefined, 2, shortLimits);
  assert.equal(f.current()?.status, 'needs_verification'); assert.equal(f.current()?.errorCode, 'PLAYBACK_CLEANUP_FAILED');
  ready.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(disposals, 1); assert.equal(plays, 0);
});

test('a cleanup that never resolves cannot publish an earlier recognized result', { timeout: 1000 }, async () => {
  const f = fixture();
  await executeJob('synthetic-job', f.store, provider({ preparePlayback: async () => prepared({ dispose: () => never() }) }), undefined, 2, shortLimits);
  assert.equal(f.current()?.status, 'needs_verification'); assert.equal(f.current()?.errorCode, 'PLAYBACK_CLEANUP_FAILED');
  assert.equal(f.current()?.schoolResult, null);
});

test('late reconciling CAS is aborted and cannot resume a school result read', { timeout: 1000 }, async () => {
  const f = fixture(); const released = deferred(); const original = f.store.transitionJob.bind(f.store);
  let signal: AbortSignal | undefined; let reads = 0;
  f.store.transitionJob = async (id, from, to, value, error, options, operation) => {
    if (to === 'reconciling') { signal = operation?.signal; await released.promise; operation?.signal?.throwIfAborted(); }
    return original(id, from, to, value, error, options, operation);
  };
  await executeJob('synthetic-job', f.store, provider({ playbackLearningStatus: async () => { reads++; return recognized; } }), undefined, 2, shortLimits);
  assert.equal(signal?.aborted, true); assert.equal(reads, 0); assert.equal(f.current()?.status, 'needs_verification');
  released.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.current()?.status, 'needs_verification');
});

test('shutdown while the final success CAS is pending aborts that write immediately', { timeout: 1000 }, async () => {
  const f = fixture(); const started = deferred(); const shutdown = new AbortController(); const original = f.store.transitionJob.bind(f.store);
  let signal: AbortSignal | undefined;
  f.store.transitionJob = async (id, from, to, value, error, options, operation) => {
    if (to === 'succeeded') { signal = operation?.signal; started.resolve(); await aborted(signal!); operation?.signal?.throwIfAborted(); }
    return original(id, from, to, value, error, options, operation);
  };
  const running = executeJob('synthetic-job', f.store, provider(), shutdown.signal, 2, shortLimits);
  await started.promise; shutdown.abort(); assert.equal(signal?.aborted, true); await running;
  assert.equal(f.current()?.status, 'reconciling'); assert.equal(f.current()?.schoolResult, null);
});

test('a hung cancellation result read has its own deadline and keeps the school result unknown', { timeout: 1000 }, async () => {
  const f = fixture(); let signal: AbortSignal | undefined;
  await executeJob('synthetic-job', f.store, provider({
    play: async () => { f.mark('cancel_requested'); },
    playbackLearningStatus: async (_prepared, value) => { signal = value; return never(); },
  }), undefined, 2, shortLimits);
  assert.equal(signal?.aborted, true); assert.equal(f.current()?.status, 'cancelled');
  assert.equal(f.current()?.schoolResult, null); assert.equal(f.current()?.errorCode, 'SCHOOL_RESULT_UNKNOWN');
});

test('queue stop aborts jobs and calls boss.stop before hung maintenance can finish', { timeout: 1000 }, async () => {
  const f = fixture(); const maintenance = deferred(); let calls = 0; let stops = 0;
  f.store.workerTransaction = async run => {
    calls++;
    if (calls === 1) return run((async () => ({ rows: [], rowCount: 0 })) as unknown as WorkerQuery);
    maintenance.resolve(); return never();
  };
  const boss = { async start() {}, async createQueue() {}, async work() {}, async stop() { stops++; } } as unknown as PgBoss;
  const stop = await startWorker(f.store, boss, provider(), new AbortController().signal, () => {}, { maintenanceMs: 2, operationMs: 20, stopMs: 30 });
  await maintenance.promise;
  const stopped = stop(); assert.equal(stopped, stop());
  await assert.rejects(stopped, /WORKER_OPERATION_TIMEOUT/);
  assert.equal(stops, 1);
});

test('a changed execution token during preparation cannot play or overwrite the replacement claim', async () => {
  const f=fixture();let plays=0,disposed=0;
  await executeJob('synthetic-job',f.store,provider({
    preparePlayback:async()=>{f.current()!.executionTokenHash='c'.repeat(64);return prepared({dispose:async()=>{disposed++;}});},
    play:async()=>{plays++;},
  }));
  assert.equal(plays,0);assert.equal(disposed,1);assert.equal(f.current()?.status,'running');
  assert.equal(f.current()?.executionTokenHash,'c'.repeat(64));assert.equal(f.current()?.schoolResult,null);
});
test('a false heartbeat result loses authority immediately even if the preceding job read succeeded', async () => {
  const f=fixture();let preparations=0;f.store.heartbeat=async()=>false;
  await executeJob('synthetic-job',f.store,provider({preparePlayback:async()=>{preparations++;return prepared();}}));
  assert.equal(preparations,0);assert.equal(f.current()?.status,'needs_verification');assert.equal(f.current()?.schoolResult,null);
});
test('a new claim winning immediately before final CAS cannot receive the old ended result', async () => {
  const f=fixture(),transition=f.store.transitionJob.bind(f.store);let late=0;
  f.store.transitionJob=async(claim,from,to,result,error,options,operation)=>{
    if(to==='completed'){late++;f.current()!.executionTokenHash='d'.repeat(64);}
    return transition(claim,from,to,result,error,options,operation);
  };
  await executeJob('synthetic-job',f.store,provider({playbackLearningStatus:async()=>({...recognized,recognized:null,attendance:'unknown'})}));
  assert.equal(late,1);assert.equal(f.current()?.status,'reconciling');assert.equal(f.current()?.schoolResult,null);
  assert.equal(f.current()?.executionOutcome,null);assert.equal(f.current()?.executionTokenHash,'d'.repeat(64));
});
test('worker never falls back to the browser learning-status reader when its prepared reader is missing', async () => {
  const f=fixture();let calls=0;const school=provider();delete school.playbackLearningStatus;
  school.learningStatus=async()=>{calls++;return recognized;};
  await executeJob('synthetic-job',f.store,school);
  assert.equal(calls,0);assert.equal(f.current()?.status,'failed');assert.equal(f.current()?.errorCode,'PLAYBACK_UNAVAILABLE');
});
test('an invalid prepared proof cannot pass periodic validation and start playback', async () => {
  const f=fixture();let plays=0;
  await executeJob('synthetic-job',f.store,provider({
    validatePlayback:async()=>({} as any),play:async()=>{plays++;},
  }));
  assert.equal(plays,0);assert.equal(f.current()?.status,'needs_verification');assert.equal(f.current()?.schoolResult,null);
});
