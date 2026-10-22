import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createSchoolPlayback } from '../src/school-playback.js';
import { videoReportDiagnostic, type workerVideoReportDiagnostic } from '../src/video-report-diagnostics.js';
import {
  createControlledPlaybackRuntime,
  createControlledPlaybackSource,
  ControlledPlaybackError,
  type ControlledPlaybackInput,
} from '../src/controlled-playback-runtime.js';
const failure = (code: string) => (error: unknown) => error instanceof ControlledPlaybackError && error.code === code;
const input = (): ControlledPlaybackInput => ({
  expectedDurationSeconds: 2,
  validate: async () => {},
  stream: async () => ({
    status: 200,
    contentLength: 4,
    body: Readable.from([Buffer.from('test')]),
  }),
  observe() {},
  report: async () => {},
});
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('source is opaque, snapshots callback references, and rejects unsupported shape and bounds', async () => {
  const raw = input(),
    source = createControlledPlaybackSource(raw);
  assert.deepEqual(JSON.parse(JSON.stringify(source)), {
    kind: 'private-controlled-playback-source',
  });
  assert.doesNotMatch(inspect(source), /function|validate|stream|report|position/);
  for (const extra of [
    { expectedDurationSeconds: 0 },
    { expectedDurationSeconds: Infinity },
    { expectedDurationSeconds: 14401 },
    { mediaUrl: 'https://private.invalid' },
    { timeouts: { startMs: 499 } },
    { timeouts: { anything: true } },
    { report: null },
  ])
    assert.throws(() => createControlledPlaybackSource({ ...input(), ...extra } as any), failure('SOURCE_INVALID'));
  raw.validate = async () => assert.fail('mutated callback');
  let launches = 0;
  const runtime = createControlledPlaybackRuntime({
    launch: async () => {
      launches++;
      throw Error('private raw');
    },
  });
  await assert.rejects(runtime.play(source, new AbortController().signal), failure('LAUNCH_FAILED'));
  assert.equal(launches, 1);
});

test('aborted, forged, disposed, and previously used sources cannot launch', async () => {
  let launches = 0;
  const runtime = createControlledPlaybackRuntime({
      launch: async () => {
        launches++;
        throw Error();
      },
    }),
    source = createControlledPlaybackSource(input()),
    abort = new AbortController();
  abort.abort();
  await assert.rejects(runtime.play(source, abort.signal), failure('ABORTED'));
  await assert.rejects(runtime.play(source, new AbortController().signal), failure('SOURCE_USED'));
  await assert.rejects(runtime.play({} as any, new AbortController().signal), failure('SOURCE_INVALID'));
  const disposed = createControlledPlaybackSource(input());
  await runtime.dispose(disposed);
  await runtime.dispose(disposed);
  await assert.rejects(runtime.play(disposed, new AbortController().signal), failure('SOURCE_USED'));
  assert.equal(launches, 0);
});

function fake(
  options: {
    hungClose?: boolean;
    killFails?: boolean;
    endAfter?: number;
    reportDelay?: number;
    modify?: (value: any) => void;
  } = {},
) {
  const child = {
    exitCode: null as number | null,
    signalCode: null as string | null,
  };
  let captured = 0,
    playing = false,
    url = '',
    contextClosed = 0,
    killed = 0,
    processClosed = 0,
    observed = 0,
    reports: string[] = [];
  let mediaDone: Promise<void> | undefined;
  const page = {
    goto: async (value: string) => {
      url = value;
    },
    waitForFunction: async () => {},
    frames: () => [{}],
    on() {},
    evaluate: async (fn: Function) => {
      if (!String(fn).includes('positionSeconds')) return;
      captured++;
      const position = playing ? Math.min((captured - 2) * 0.2, options.endAfter ?? 0.6) : 0;
      const ended = playing && position === (options.endAfter ?? 0.6);
      const value = {
        positionSeconds: position,
        durationSeconds: options.endAfter ?? 0.6,
        playbackRate: 1,
        paused: !playing || ended,
        ended,
        seeking: false,
        visible: true,
        connected: true,
        loop: false,
        src: url.replace('/player', '/media'),
        error: null,
        count: 1,
        playingCount: playing ? 1 : 0,
        endedCount: ended ? 1 : 0,
        seekCount: 0,
      };
      options.modify?.(value);
      return value;
    },
    locator: () => ({
      click: async () => {
        playing = true;
        mediaDone = fetch(url.replace('/player', '/media'))
          .then((r) => r.arrayBuffer())
          .then(() => {});
        await mediaDone;
      },
    }),
  };
  const context = {
    routeWebSocket: async () => {},
    route: async () => {},
    on() {},
    newPage: async () => page,
    close: async () => {
      contextClosed++;
      if (options.hungClose) await new Promise(() => {});
    },
  };
  const browser = {
    newContext: async () => context,
    isConnected: () => child.exitCode === null && child.signalCode === null,
    close: async () => {},
  };
  const server = {
    process: () => child,
    close: async () => {
      processClosed++;
      if (options.hungClose) await new Promise(() => {});
      child.exitCode = 0;
    },
    kill: async () => {
      killed++;
      if (options.killFails) throw Error('private');
      child.signalCode = 'SIGKILL';
    },
  };
  const source = () =>
    createControlledPlaybackSource({
      ...input(),
      expectedDurationSeconds: options.endAfter ?? 0.6,
      observe: () => {
        observed++;
      },
      report: async (event) => {
        reports.push(event);
        await delay(options.reportDelay ?? 1);
      },
    });
  return {
    launched: { browser, server } as any,
    source,
    child,
    reports,
    counts: () => ({
      captured,
      observed,
      contextClosed,
      killed,
      processClosed,
    }),
    page,
  };
}

test('normal observed playback reports once at start and end, sampling continues during slow report, and terminal ACK stops observations', async () => {
  const f = fake({ endAfter: 0.6, reportDelay: 700 }),
    runtime = createControlledPlaybackRuntime({
      launch: async () => f.launched,
    });
  const result = await runtime.play(f.source(), new AbortController().signal);
  assert.equal(result.ended, true);
  assert.deepEqual(f.reports, ['playing', 'ended']);
  assert.ok(f.counts().captured > f.counts().observed);
  assert.ok(f.counts().observed >= 5);
  assert.equal(f.child.exitCode, 0);
});

test('invalid real observation aborts the in-flight report signal and never reports success', async () => {
  let signal: AbortSignal | undefined,
    observed = 0;
  const f = fake({
      endAfter: 2,
      modify: (value) => {
        if (value.positionSeconds >= 0.4) value.playbackRate = 2;
      },
    }),
    runtime = createControlledPlaybackRuntime({
      launch: async () => f.launched,
    });
  const source = createControlledPlaybackSource({
    ...input(),
    observe: () => {
      observed++;
    },
    report: async (_event, current) => {
      signal = current;
      await new Promise(() => {});
    },
  });
  await assert.rejects(runtime.play(source, new AbortController().signal), failure('MEDIA_INVALID'));
  assert.equal(signal?.aborted, true);
  assert.equal(observed, 3);
  assert.equal(f.child.exitCode, 0);
});

test('guard failure ends playback while continuing sampling during the pending check', async () => {
  let checks = 0,
    reportSignal: AbortSignal | undefined;
  const f = fake({ endAfter: 4 }),
    runtime = createControlledPlaybackRuntime({
      launch: async () => f.launched,
    });
  const source = createControlledPlaybackSource({
    ...input(),
    expectedDurationSeconds: 4,
    validate: async () => {
      checks++;
      if (checks >= 5) {
        await delay(500);
        throw Error('private');
      }
    },
    report: async (_event, s) => {
      reportSignal = s;
    },
  });
  await assert.rejects(runtime.play(source, new AbortController().signal), failure('GUARD_FAILED'));
  assert.ok(f.counts().captured >= 7);
  assert.equal(reportSignal?.aborted, true);
  assert.equal(f.child.exitCode, 0);
});

test('cancel and hung close force only the owned process within the cleanup budget', async () => {
  const f = fake({ hungClose: true, endAfter: 5 }),
    runtime = createControlledPlaybackRuntime({
      launch: async () => f.launched,
    }),
    source = f.source(),
    abort = new AbortController();
  const result = runtime.play(source, abort.signal),
    rejected = assert.rejects(result, failure('ABORTED'));
  await delay(100);
  const start = performance.now();
  abort.abort();
  await runtime.dispose(source);
  await rejected;
  assert.ok(performance.now() - start < 7000);
  assert.equal(f.counts().killed, 1);
  assert.equal(f.child.signalCode, 'SIGKILL');
});

test('unconfirmed kill preserves a cleanup failure for future disposal', async () => {
  const f = fake({ hungClose: true, killFails: true, endAfter: 2 }),
    runtime = createControlledPlaybackRuntime({
      launch: async () => f.launched,
    }),
    source = f.source(),
    abort = new AbortController();
  const result = runtime.play(source, abort.signal),
    rejected = assert.rejects(result, failure('CLEANUP_FAILED'));
  await delay(100);
  abort.abort();
  await rejected;
  await assert.rejects(runtime.dispose(source), failure('CLEANUP_FAILED'));
});

test('cancel during launch waits for the late process exit before disposal succeeds', async () => {
  const f = fake();
  let release!: (v: any) => void, started!: () => void;
  const launched = new Promise<void>((r) => (started = r));
  const runtime = createControlledPlaybackRuntime({
      launch: () => {
        started();
        return new Promise((r) => (release = r));
      },
    }),
    source = f.source(),
    abort = new AbortController();
  const result = runtime.play(source, abort.signal);
  const rejected = assert.rejects(result, failure('ABORTED'));
  await launched;
  abort.abort();
  const disposed = runtime.dispose(source);
  release(f.launched);
  await disposed;
  await rejected;
  assert.equal(f.child.exitCode, 0);
  assert.equal(f.counts().captured, 0);
});

test('seek, hidden page, extra video, loop, and incorrect duration are rejected before reporting', async () => {
  for (const change of [
    { seekCount: 1 },
    { visible: false },
    { count: 2 },
    { loop: true },
    { durationSeconds: 99 },
    { positionSeconds: 0.1 },
  ]) {
    const f = fake({ modify: (value) => Object.assign(value, change) }),
      runtime = createControlledPlaybackRuntime({
        launch: async () => f.launched,
      });
    await assert.rejects(runtime.play(f.source(), new AbortController().signal), failure('MEDIA_INVALID'));
    assert.deepEqual(f.reports, []);
    assert.equal(f.child.exitCode, 0);
  }
});

test('late DOM result after abort cannot produce another observation or report', async () => {
  const f = fake({ endAfter: 2 });
  let release!: (v: any) => void, waiting!: () => void;
  const reached = new Promise<void>((r) => (waiting = r));
  let count = 0;
  const evaluate = f.page.evaluate;
  f.page.evaluate = async (fn) => {
    if (String(fn).includes('positionSeconds') && ++count === 2) {
      waiting();
      return await new Promise((r) => (release = r));
    }
    return evaluate(fn);
  };
  let observations = 0;
  const runtime = createControlledPlaybackRuntime({
      launch: async () => f.launched,
    }),
    abort = new AbortController(),
    source = createControlledPlaybackSource({
      ...input(),
      observe: () => {
        observations++;
      },
    });
  const result = runtime.play(source, abort.signal),
    rejected = assert.rejects(result, failure('ABORTED'));
  await reached;
  abort.abort();
  await rejected;
  const before = observations;
  release({ positionSeconds: 1 });
  await delay(20);
  assert.equal(observations, before);
  assert.deepEqual(f.reports, []);
});

test('periodic reporting waits 300 seconds from a delayed ACK instead of the request start', async (t) => {
  let now = 0,
    first!: () => void,
    done = false;
  const started = new Promise<void>((r) => (first = r)),
    sent: { event: string; at: number }[] = [];
  const f = fake({ endAfter: 314 }),
    runtime = createControlledPlaybackRuntime({
      launch: async () => f.launched,
    });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => now);
  const source = createControlledPlaybackSource({
    ...input(),
    expectedDurationSeconds: 314,
    report: async (event) => {
      sent.push({ event, at: now });
      if (event === 'playing') {
        first();
        await delay(10_000);
      }
    },
  });
  const result = runtime.play(source, new AbortController().signal);
  void result.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await started;
  for (let step = 0; step < 1700 && !done; step++) {
    now += 200;
    t.mock.timers.tick(200);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await result;
  assert.equal(done, true);
  assert.deepEqual(
    sent.map((v) => v.event),
    ['playing', 'update', 'ended'],
  );
  assert.ok(sent[1]!.at >= 310_000);
  assert.ok(sent[1]!.at < 312_000);
});

test('two periodic ACKs each start a new 300-second interval before the actual ended report', async (t) => {
  let now = 0, first!: () => void, done = false;
  const started = new Promise<void>(resolve => { first = resolve; });
  const sent: { event: string; at: number; acknowledgedAt?: number }[] = [];
  const f = fake({ endAfter: 700 });
  const runtime = createControlledPlaybackRuntime({ launch: async () => f.launched });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => now);
  const source = createControlledPlaybackSource({ ...input(), expectedDurationSeconds: 700,
    report: async event => {
      const entry = { event, at: now, acknowledgedAt: undefined as number | undefined };
      sent.push(entry);
      if (event === 'playing') first();
      await delay(event === 'playing' ? 10_000 : event === 'update' ? 4_000 : 1_000);
      entry.acknowledgedAt = now;
    } });
  const result = runtime.play(source, new AbortController().signal);
  void result.then(() => { done = true; }, () => { done = true; });
  await started;
  for (let step = 0; step < 3700 && !done; step++) {
    now += 200; t.mock.timers.tick(200);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(done, true); assert.equal((await result).ended, true);
  assert.deepEqual(sent.map(entry => entry.event), ['playing', 'update', 'update', 'ended']);
  for (const index of [1, 2]) {
    const interval = sent[index]!.at - sent[index - 1]!.acknowledgedAt!;
    assert.ok(interval >= 300_000 && interval <= 301_000, `ACK interval ${interval}`);
  }
  assert.ok(sent[3]!.at >= 700_000); assert.ok(sent.every(entry => entry.acknowledgedAt !== undefined));
  assert.equal(f.child.exitCode, 0); assert.equal(f.counts().killed, 0);
});

test('a third report failure after two ACKs stops without an ended report or automatic retransmission', async (t) => {
  let now = 0, first!: () => void, done = false;
  const started = new Promise<void>(resolve => { first = resolve; });
  const sent: string[] = [];
  const f = fake({ endAfter: 700 });
  const runtime = createControlledPlaybackRuntime({ launch: async () => f.launched });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => now);
  const source = createControlledPlaybackSource({ ...input(), expectedDurationSeconds: 700,
    report: async event => {
      sent.push(event); if (event === 'playing') first();
      if (sent.length === 3) throw new Error('private transport failure');
    } });
  const result = runtime.play(source, new AbortController().signal);
  const rejected = assert.rejects(result, failure('REPORT_FAILED'));
  void result.then(() => { done = true; }, () => { done = true; });
  await started;
  for (let step = 0; step < 3700 && !done; step++) {
    now += 200; t.mock.timers.tick(200);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  await rejected; assert.equal(done, true);
  assert.deepEqual(sent, ['playing', 'update', 'update']);
  const before = f.counts().captured;
  now += 600_000; t.mock.timers.tick(600_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.counts().captured, before); assert.equal(sent.length, 3);
  assert.equal(f.child.exitCode, 0);
  await assert.rejects(runtime.play(source, new AbortController().signal), failure('SOURCE_USED'));
  assert.equal(sent.length, 3);
});

test('cancellation during the third pending report aborts its signal and closes only the owned runtime', async (t) => {
  let now = 0, first!: () => void, done = false, pending: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { first = resolve; });
  const sent: string[] = [];
  const f = fake({ endAfter: 700 });
  const runtime = createControlledPlaybackRuntime({ launch: async () => f.launched });
  const abort = new AbortController();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => now);
  const source = createControlledPlaybackSource({ ...input(), expectedDurationSeconds: 700,
    report: async (event, supplied) => {
      sent.push(event); if (event === 'playing') first();
      if (sent.length === 3) { pending = supplied; await new Promise(() => {}); }
    } });
  const result = runtime.play(source, abort.signal);
  const rejected = assert.rejects(result, failure('ABORTED'));
  void result.then(() => { done = true; }, () => { done = true; });
  await started;
  for (let step = 0; step < 3700 && !pending; step++) {
    now += 200; t.mock.timers.tick(200);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(pending); assert.equal(pending.aborted, false);
  const before = f.counts().captured;
  for (let step = 0; step < 5; step++) {
    now += 200; t.mock.timers.tick(200);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(f.counts().captured > before);
  abort.abort(); await runtime.dispose(source); await rejected;
  assert.equal(done, true); assert.equal(pending.aborted, true);
  assert.deepEqual(sent, ['playing', 'update', 'update']);
  assert.equal(f.child.exitCode, 0); assert.equal(f.counts().killed, 0);
});

for (const mode of ['acknowledged', 'unknown', 'cas'] as const) {
  test(`controlled runtime and real SDK survive two periodic intervals with ${mode} third transport`, async (t) => {
    const { fixture: schoolFixture, context: scope } = await import('./helpers/school-video-fixture.js');
    const school = await schoolFixture({ durationSeconds: 670.67 });
    const f = fake({ endAfter: 670.67 });
    let now = 0, started!: () => void, done = false, released = 0, acquired = 0, renewed = 0;
    const playing = new Promise<void>(resolve => { started = resolve; });
    const events: string[] = [], diagnostics: ReturnType<typeof workerVideoReportDiagnostic>[] = [];
    const runtime = createControlledPlaybackRuntime({ launch: async () => f.launched });
    const claim = { jobId: randomUUID(), userId: scope.owner, courseId: scope.courseId, lectureId: scope.moduleItemId,
      acceptedGeneration: school.generation(), executionTokenHash: 'd'.repeat(64) };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(performance, 'now', () => now);
    school.onReturn(async () => {
      if (mode === 'unknown' && school.counts().reports === 2) school.setAck(false);
      if (mode === 'cas' && school.counts().reports === 3) school.setCas(false);
    });
    const adapter = createSchoolPlayback({ school: school.sessions,
      validateClaim: async (current, supplied) => { supplied.throwIfAborted(); assert.deepEqual(current, claim); },
      validateFinalClaim: async (current, supplied) => { supplied.throwIfAborted(); assert.deepEqual(current, claim); },
      createAdmission: () => ({}), createFinalProof: () => ({}),
      leases: { acquire: async (lease, proof) => {
        assert.equal(lease.kind, 'worker'); assert.equal(lease.generation, claim.acceptedGeneration);
        assert.equal(proof.encryptedSession, school.encrypted()); acquired++; return true;
      }, renew: async (lease, supplied) => { supplied.throwIfAborted(); assert.equal(lease.tokenHash, claim.executionTokenHash); renewed++; return true; },
      release: async () => { released++; } },
      stream: async (_owner, prepare, request) => {
        await request.validate(); await (await prepare(request.signal)).validate();
        return { status: 200, contentLength: 4, body: Readable.from([Buffer.from('test')]) };
      },
      runtime: { createSource: value => createControlledPlaybackSource({ ...value,
        report: async (event, supplied) => { events.push(event); if (event === 'playing') started(); await value.report(event, supplied); } }),
      play: runtime.play, dispose: runtime.dispose }, reportFailure: diagnostic => { diagnostics.push(diagnostic); },
    });
    const prepared = await adapter.preparePlayback({ userId: claim.userId, claim }, { courseId: claim.courseId, lectureId: claim.lectureId }, new AbortController().signal);
    const result = adapter.play(prepared, new AbortController().signal);
    const assertion = mode === 'acknowledged' ? result : assert.rejects(result, (error: unknown) => {
      assert.equal((error as { code: string }).code, 'PLAYBACK_REPORT_UNKNOWN');
      const diagnostic = videoReportDiagnostic(error);
      assert.equal(diagnostic.stage, 'post_report'); assert.equal(diagnostic.mayHaveWritten, true);
      assert.equal(diagnostic.code, mode === 'cas' ? 'SCHOOL_SESSION_CHANGED' : 'unknown'); return true;
    });
    void result.then(() => { done = true; }, () => { done = true; });
    await playing;
    for (let step = 0; step < 3700 && !done; step++) {
      now += 200; t.mock.timers.tick(200);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    await assertion; assert.equal(done, true); assert.equal(acquired, 1); assert.ok(renewed > 600);
    assert.equal(f.child.exitCode, 0); assert.equal(f.counts().killed, 0);
    assert.deepEqual(events, mode === 'acknowledged' ? ['playing', 'update', 'update', 'ended'] : ['playing', 'update', 'update']);
    assert.equal(school.counts().reports, mode === 'acknowledged' ? 4 : 3);
    assert.equal(released, mode === 'acknowledged' ? 1 : 0); assert.equal(diagnostics.length, mode === 'acknowledged' ? 0 : 1);
    const before = school.counts().reports;
    now += 600_000; t.mock.timers.tick(600_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(school.counts().reports, before);
    school.onReturn(async () => {}); school.setCas(true);
    const fresh = await adapter.playbackLearningStatus(prepared, new AbortController().signal);
    assert.equal(fresh.recognized, null); assert.equal(fresh.attendance, 'unknown'); assert.equal(fresh.evidence?.completed, false);
    if (mode === 'acknowledged') assert.equal(fresh.progressPercent, 100);
    else assert.ok(fresh.progressPercent !== null && fresh.progressPercent < 100);
    await prepared.dispose(); await assert.rejects(adapter.play(prepared, new AbortController().signal));
    assert.equal(school.counts().reports, before); assert.equal(released, mode === 'acknowledged' ? 1 : 0);
  });
}
