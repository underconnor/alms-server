import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { stat, readdir, readFile } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import {
  createControlledPlaybackRuntime,
  createControlledPlaybackSource,
  ControlledPlaybackError,
} from '../dist/controlled-playback-runtime.js';
import { createVideoStreamer } from '../dist/video-stream.js';

if (process.platform !== 'linux') throw Error('ISOLATED_LINUX_QA_REQUIRED');
const fixture = '/fixtures/large.mp4',
  size = (await stat(fixture)).size;
assert.ok(size > 32 * 1024 * 1024);
const processes = [],
  cases = [];
let signalShutdownElapsedMs = null;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const exited = (child) => child.exitCode !== null || child.signalCode !== null;
const errorCode = (error, code) => error instanceof ControlledPlaybackError && error.code === code;
// This runs only inside the isolated PID namespace; retain counts, never process arguments.
async function liveBrowserProcesses() {
  let count = 0;
  for (const pid of (await readdir('/proc')).filter((value) => /^\d+$/.test(value))) {
    try {
      const [command, state] = await Promise.all([
        readFile(`/proc/${pid}/cmdline`, 'utf8'),
        readFile(`/proc/${pid}/stat`, 'utf8'),
      ]);
      if (
        command.includes('/opt/playwright-browsers/') &&
        state.slice(state.lastIndexOf(')') + 2, state.lastIndexOf(')') + 3) !== 'Z'
      )
        count++;
    } catch {
      /* A process may exit between enumeration and read. */
    }
  }
  return count;
}
async function assertNoLiveBrowserProcesses() {
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await liveBrowserProcesses()) === 0) return;
    await delay(100);
  }
  assert.equal(await liveBrowserProcesses(), 0);
}
const syntheticUrl =
  'https://ssuin-object.commonscdn.com/ssu-contents/contents31/ssu1000001/synthetic/contents/media_files/mobile/large.mp4';
function transport(kind = 'normal') {
  let requests = 0,
    bytes = 0,
    active = 0,
    cancelled = 0;
  const signals = [];
  const fetcher = async (url, init) => {
    assert.equal(url, syntheticUrl);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).get('authorization'), null);
    assert.equal(new Headers(init.headers).get('cookie'), null);
    requests++;
    signals.push(init.signal);
    let start = 0,
      end = size - 1;
    const range = new Headers(init.headers).get('range');
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      assert.ok(match);
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
    }
    const headers = {
      'content-type': 'video/mp4',
      'content-length': String(end - start + 1),
      'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    };
    if (init.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
    active++;
    const stream = createReadStream(fixture, {
      start,
      end,
      highWaterMark: 65536,
    });
    let completed = false;
    const cancel = () => {
      cancelled++;
      stream.destroy();
    };
    init.signal.addEventListener('abort', cancel, { once: true });
    stream.on('end', () => {
      completed = true;
    });
    stream.on('close', () => {
      active--;
      init.signal.removeEventListener('abort', cancel);
    });
    const throttle = new Transform({
      transform(chunk, _encoding, next) {
        bytes += chunk.length;
        if (kind === 'slow') setTimeout(() => next(null, chunk), 300);
        else next(null, chunk);
      },
    });
    stream.on('error', (error) => throttle.destroy(error));
    throttle.on('close', () => {
      if (!completed) stream.destroy();
    });
    stream.pipe(throttle);
    return new Response(Readable.toWeb(throttle), {
      status: range ? 206 : 200,
      headers,
    });
  };
  const upstream = createVideoStreamer(fetcher, { idleMs: 1000, checkMs: 500 });
  return {
    stream: (request) =>
      upstream(
        'synthetic-owner',
        async () => ({
          contentId: 'synthetic',
          mediaUrl: syntheticUrl,
          validate: async () => {},
        }),
        request,
      ),
    counts: () => ({
      requests,
      bytes,
      active,
      cancelled,
      allSignalsAborted: signals.every((s) => s.aborted),
    }),
  };
}
function launching(kind = 'normal') {
  return async () => {
    const server = await chromium.launchServer({
      headless: true,
      chromiumSandbox: true,
      host: '127.0.0.1',
      timeout: 20_000,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
    processes.push(server.process());
    const browser = await chromium.connect(server.wsEndpoint(), {
      timeout: 5000,
    });
    if (kind !== 'normal') {
      const original = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const context = await original(options);
        await context.addInitScript((mode) => {
          document.addEventListener('DOMContentLoaded', () => {
            const v = document.querySelector('video');
            v?.addEventListener(
              'playing',
              () => {
                setTimeout(() => {
                  if (mode === 'rate') v.playbackRate = 2;
                  if (mode === 'seek') v.currentTime = 4;
                  if (mode === 'external') location.assign('https://not-allowed.invalid/never');
                  if (mode === 'gap') {
                    const until = performance.now() + 1800;
                    while (performance.now() < until) {}
                  }
                  if (mode === 'websocket') {
                    try {
                      new WebSocket('ws://not-allowed.invalid/never');
                    } catch {}
                  }
                }, 350);
              },
              { once: true },
            );
          });
        }, kind);
        return context;
      };
    }
    return { server, browser };
  };
}
function prepared(t, options = {}) {
  const observations = [],
    reports = [];
  let reportSignal,
    terminalStarted = false,
    lateObservation = false,
    activeReports = 0,
    maxReports = 0;
  const source = createControlledPlaybackSource({
    expectedDurationSeconds: 8,
    stream: t.stream,
    validate: options.validate ?? (async () => {}),
    observe: (value) => {
      if (terminalStarted) lateObservation = true;
      observations.push(value);
      options.observed?.(value);
    },
    report: async (event, signal) => {
      reportSignal = signal;
      reports.push(event);
      activeReports++;
      maxReports = Math.max(maxReports, activeReports);
      if (event === 'ended') terminalStarted = true;
      try {
        if (options.pendingReport) await new Promise(() => {});
        else await delay(options.reportDelay ?? 20);
      } finally {
        activeReports--;
      }
    },
    timeouts: { startMs: 10_000, stallMs: 1500, totalMs: 25_000 },
  });
  return {
    source,
    observations,
    reports,
    state: () => ({
      lateObservation,
      maxReports,
      signalAborted: reportSignal?.aborted,
    }),
  };
}
async function check(name, fn) {
  const begin = performance.now();
  try {
    await fn();
    await assertNoLiveBrowserProcesses();
    cases.push({
      name,
      passed: true,
      elapsedMs: Math.round(performance.now() - begin),
    });
  } catch (error) {
    cases.push({
      name,
      passed: false,
      code: error instanceof ControlledPlaybackError ? error.code : 'QA_ASSERTION',
      elapsedMs: Math.round(performance.now() - begin),
    });
  }
}

if (process.argv.includes('--signal-child')) {
  const t = transport(),
    p = prepared(t, {
      pendingReport: true,
      observed: (value) => {
        if (value.positionSeconds > 0.2 && !process.env.QA_READY) {
          process.env.QA_READY = '1';
          process.stdout.write('READY\n');
        }
      },
    });
  const runtime = createControlledPlaybackRuntime({ launch: launching() }),
    abort = new AbortController();
  process.on('SIGTERM', () => abort.abort());
  try {
    await runtime.play(p.source, abort.signal);
    process.exitCode = 3;
  } catch (error) {
    await runtime.dispose(p.source);
    if (!errorCode(error, 'ABORTED') || !p.state().signalAborted || !processes.every(exited)) process.exitCode = 4;
    else process.stdout.write('CLEAN\n');
  }
} else {
  await check('large-mp4-real-1x-ended-single-report-with-live-sampling', async () => {
    const t = transport(),
      p = prepared(t, { reportDelay: 1500 }),
      runtime = createControlledPlaybackRuntime({ launch: launching() });
    const evidence = await runtime.play(p.source, new AbortController().signal);
    assert.equal(evidence.ended, true);
    assert.ok(evidence.elapsedMs >= 8000);
    assert.equal(evidence.processExited, true);
    assert.deepEqual(p.reports, ['playing', 'ended']);
    assert.ok(p.observations.length > 30);
    assert.equal(p.observations[0].positionSeconds, 0);
    assert.equal(p.observations[0].paused, true);
    assert.ok(p.observations.every((v) => v.playbackRate === 1 && v.visible && !v.seeking));
    assert.equal(p.state().lateObservation, false);
    assert.equal(p.state().maxReports, 1);
    assert.ok(t.counts().bytes > 32 * 1024 * 1024);
    await delay(50);
    assert.equal(t.counts().active, 0);
  });
  for (const [kind, code] of [
    ['rate', 'MEDIA_INVALID'],
    ['seek', 'MEDIA_INVALID'],
    ['gap', 'MEDIA_INVALID'],
    ['external', 'ROUTE_BLOCKED'],
  ])
    await check(`reject-real-${kind}-change`, async () => {
      const t = transport(),
        p = prepared(t, { pendingReport: true }),
        runtime = createControlledPlaybackRuntime({ launch: launching(kind) });
      await assert.rejects(runtime.play(p.source, new AbortController().signal), (e) => errorCode(e, code));
      assert.equal(p.state().signalAborted, true);
      assert.ok(processes.every(exited));
    });
  await check('cancel-during-report-aborts-report-and-media-before-dispose', async () => {
    const t = transport(),
      abort = new AbortController(),
      p = prepared(t, {
        pendingReport: true,
        observed: (v) => {
          if (v.positionSeconds >= 0.5) abort.abort();
        },
      }),
      runtime = createControlledPlaybackRuntime({ launch: launching() });
    await assert.rejects(runtime.play(p.source, abort.signal), (e) => errorCode(e, 'ABORTED'));
    await runtime.dispose(p.source);
    assert.equal(p.state().signalAborted, true);
    assert.ok(processes.every(exited));
    await delay(50);
    assert.equal(t.counts().active, 0);
  });
  await check('slow-stream-cancel-does-not-buffer-entire-mp4', async () => {
    const t = transport('slow'),
      abort = new AbortController(),
      p = prepared(t),
      runtime = createControlledPlaybackRuntime({ launch: launching() });
    const timer = setTimeout(() => abort.abort(), 1500);
    try {
      await assert.rejects(runtime.play(p.source, abort.signal), (e) => errorCode(e, 'ABORTED'));
      await runtime.dispose(p.source);
    } finally {
      clearTimeout(timer);
    }
    await delay(350);
    assert.equal(t.counts().active, 0);
    assert.ok(t.counts().bytes < 32 * 1024 * 1024);
    assert.ok(processes.every(exited));
  });
  await check('SIGTERM-child-exits-with-report-aborted-and-browser-gone-under-35s', async () => {
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname, '--signal-child'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let output = '',
      sentAt = 0;
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes('READY') && !sentAt) {
        sentAt = performance.now();
        child.kill('SIGTERM');
      }
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const code = await new Promise((resolve) => child.once('exit', resolve));
    clearTimeout(timeout);
    assert.equal(code, 0);
    assert.ok(sentAt);
    signalShutdownElapsedMs = Math.round(performance.now() - sentAt);
    assert.ok(signalShutdownElapsedMs < 35_000);
    assert.ok(output.includes('CLEAN'));
  });
  const passed = cases.every((c) => c.passed) && processes.every(exited);
  process.stdout.write(
    JSON.stringify(
      {
        schema: 'controlled-playback-synthetic-qa-v1',
        passed,
        fixtureBytes: size,
        largerThan32MiB: true,
        actualSchoolRequests: 0,
        actualSchoolReports: 0,
        processCount: processes.length,
        allProcessesExited: processes.every(exited),
        liveBrowserProcesses: await liveBrowserProcesses(),
        signalShutdownElapsedMs,
        cases,
      },
      null,
      2,
    ) + '\n',
  );
  if (!passed) process.exitCode = 1;
}
