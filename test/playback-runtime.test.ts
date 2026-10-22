import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createPlaybackSource, createPlaybackRuntime, isPlaybackRequestAllowed, PlaybackRuntimeError, type PlaybackSourceInput } from '../src/playback-runtime.js';

const launchUrl = 'https://commons.ssu.ac.kr/em/synthetic', mediaUrl = 'https://commons.ssu.ac.kr/contents/synthetic/movie.webm';
function input(): PlaybackSourceInput {
  return { launchUrl, mediaUrl, videoSelector: '#video', startSelector: '#start', requests: [
    { url: launchUrl, kind: 'document', methods: ['GET'] }, { url: mediaUrl, kind: 'media', methods: ['GET', 'HEAD'] },
  ] };
}
const failure = (code: string) => (error: unknown) => error instanceof PlaybackRuntimeError && error.code === code;

test('source is opaque in JSON and inspection and input mutation cannot alter the exact request policy', () => {
  const raw = input(), source = createPlaybackSource(raw);
  assert.deepEqual(JSON.parse(JSON.stringify(source)), { kind: 'private-playback-source' });
  assert.doesNotMatch(inspect(source), /commons|synthetic|video/);
  raw.requests[0]!.url = 'https://lms.ssu.ac.kr/private';
  assert.equal(isPlaybackRequestAllowed(source, launchUrl, 'document', 'GET'), true);
  for (const [url, kind, method] of [[launchUrl, 'document', 'POST'], [launchUrl + '?unexpected=1', 'document', 'GET'],
    [mediaUrl, 'script', 'GET'], [mediaUrl + '/other', 'media', 'GET']]) assert.equal(isPlaybackRequestAllowed(source, url!, kind!, method!), false);
});

test('source rejects arbitrary hosts, IPs, insecure URLs, credentials, ports and encoded path escapes', () => {
  for (const url of ['https://public.example/lecture', 'https://internal.example/lecture', 'https://localhost/lecture',
    'https://127.0.0.1/lecture', 'https://[::1]/lecture', 'http://commons.ssu.ac.kr/em/synthetic',
    'https://user:secret@commons.ssu.ac.kr/em/synthetic', 'https://commons.ssu.ac.kr:8443/em/synthetic',
    'https://commons.ssu.ac.kr/em/%252e%252e%252fprivate', 'https://commons.ssu.ac.kr/em/synthetic#fragment']) {
    const raw = input(); raw.launchUrl = url; raw.requests[0]!.url = url;
    assert.throws(() => createPlaybackSource(raw), failure('SOURCE_INVALID'));
  }
});

test('source requires exact launch, frame and media resources and refuses writes, duplicate rules and extra properties', () => {
  const tests: unknown[] = [ { ...input(), frameUrl: 'https://commons.ssu.ac.kr/frame/unobserved' },
    { ...input(), requests: input().requests.slice(0, 1) }, { ...input(), requests: [...input().requests, input().requests[0]] },
    { ...input(), requests: input().requests.map(rule => ({ ...rule, methods: ['POST'] })) }, { ...input(), allowAnyHost: true } ];
  for (const value of tests) assert.throws(() => createPlaybackSource(value as PlaybackSourceInput), failure('SOURCE_INVALID'));
});

test('cookies are exact-host secure scopes and the LearningX token cannot escape /learningx/', () => {
  const cookie = { name: 'xn_api_token', value: 'synthetic-private-value', domain: 'canvas.ssu.ac.kr', path: '/learningx/', secure: true as const, httpOnly: true, sameSite: 'Strict' as const };
  const raw = input(); raw.requests.push({ url: 'https://canvas.ssu.ac.kr/learningx/api/v1/synthetic', kind: 'xhr', methods: ['GET'] }); raw.cookies = [cookie];
  const source = createPlaybackSource(raw); assert.doesNotMatch(JSON.stringify(source) + inspect(source), /synthetic-private-value/);
  for (const changes of [{ path: '/' }, { domain: '.canvas.ssu.ac.kr' }, { domain: 'commons.ssu.ac.kr' },
    { secure: false }, { value: 'a\nsecret' }, { path: '/learningx/../' }]) {
    assert.throws(() => createPlaybackSource({ ...raw, cookies: [{ ...cookie, ...changes }] } as PlaybackSourceInput), failure('SOURCE_INVALID'));
  }
  assert.throws(() => createPlaybackSource({ ...raw, cookies: [cookie, cookie] }), failure('SOURCE_INVALID'));
});

test('source bounds selectors, timeouts and policy size before browser launch', () => {
  for (const value of [{ ...input(), videoSelector: '' }, { ...input(), timeouts: { totalMs: 999 } },
    { ...input(), timeouts: { stallMs: 100_000 } }, { ...input(), requests: Array.from({ length: 257 }, () => input().requests[0]) }]) {
    assert.throws(() => createPlaybackSource(value as PlaybackSourceInput), failure('SOURCE_INVALID'));
  }
});

test('aborted and forged sources cannot create a browser and a consumed source cannot be reused', async () => {
  let launches = 0;
  const runtime = createPlaybackRuntime({ launch: async () => { launches++; throw new Error('must not launch'); } });
  const source = createPlaybackSource(input()); const abort = new AbortController(); abort.abort();
  await assert.rejects(runtime.play(source, abort.signal), failure('ABORTED'));
  await assert.rejects(runtime.play(source, new AbortController().signal), failure('SOURCE_USED'));
  await assert.rejects(runtime.play({} as any, new AbortController().signal), failure('SOURCE_INVALID'));
  await runtime.dispose(source); assert.equal(launches, 0);
  const preparedButCancelled = createPlaybackSource(input()); await runtime.dispose(preparedButCancelled);
  await assert.rejects(runtime.play(preparedButCancelled, new AbortController().signal), failure('SOURCE_USED'));
  assert.equal(launches, 0);
});

function fakeBrowser(closeFailure = false, killFailure = false) {
  const observed = { contexts: 0, contextClosed: 0, serverClosed: 0, killed: 0, browserClosed: 0, options: undefined as unknown };
  const child = { exitCode: null as number | null, signalCode: null as string | null };
  const context = { routeWebSocket: async () => {}, route: async () => {}, addCookies: async () => {}, on: () => {},
    newPage: async () => ({ goto: async () => { throw new Error('https://private.invalid/secret?token=never-log'); } }),
    close: async () => { observed.contextClosed++; if (closeFailure) throw new Error('close failed'); },
  };
  const browser = { newContext: async (options: unknown) => { observed.contexts++; observed.options = options; return context; },
    isConnected: () => child.exitCode === null && child.signalCode === null,
    close: async () => { observed.browserClosed++; },
  };
  const server = { close: async () => { observed.serverClosed++; child.exitCode = 0; },
    kill: async () => { observed.killed++; if (killFailure) throw new Error('kill failed'); child.signalCode = 'SIGKILL'; }, process: () => child };
  return { observed, child, launched: { browser, server } as any };
}

test('a startup failure is normalized, closes the owned context/process, and keeps browser security enabled', async () => {
  const fake = fakeBrowser(); const runtime = createPlaybackRuntime({ launch: async () => fake.launched });
  const source = createPlaybackSource(input());
  await assert.rejects(runtime.play(source, new AbortController().signal), failure('START_TIMEOUT'));
  assert.equal(fake.observed.contextClosed, 1); assert.equal(fake.observed.serverClosed, 1); assert.equal(fake.child.exitCode, 0);
  assert.deepEqual(fake.observed.options, { serviceWorkers: 'block', acceptDownloads: false, ignoreHTTPSErrors: false, bypassCSP: false, permissions: [], viewport: { width: 1280, height: 720 } });
});

test('cleanup failure forces only the owned browser and reports an unconfirmed exit as cleanup failure', async () => {
  for (const killFails of [false, true]) {
    const fake = fakeBrowser(true, killFails), runtime = createPlaybackRuntime({ launch: async () => fake.launched });
    const source = createPlaybackSource(input());
    await assert.rejects(runtime.play(source, new AbortController().signal), failure(killFails ? 'CLEANUP_FAILED' : 'START_TIMEOUT'));
    assert.equal(fake.observed.killed, 1); assert.equal(fake.observed.serverClosed, 0);
    if (killFails) await assert.rejects(runtime.dispose(source), failure('CLEANUP_FAILED'));
    else await runtime.dispose(source);
  }
});

test('dispose during browser launch waits until that new process has actually exited', async () => {
  const fake = fakeBrowser(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = createPlaybackRuntime({ launch: async () => { await gate; return fake.launched; } }), source = createPlaybackSource(input());
  const result = runtime.play(source, new AbortController().signal); let disposed = false;
  const stopped = runtime.dispose(source).then(() => { disposed = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(disposed, false);
  release(); await assert.rejects(result, failure('ABORTED')); await stopped;
  assert.equal(fake.observed.contexts, 0); assert.equal(fake.child.exitCode, 0); assert.equal(disposed, true);
});

test('a failed launch cleanup remains a failure for later disposal', async () => {
  const runtime = createPlaybackRuntime({ launch: async () => { throw new PlaybackRuntimeError('CLEANUP_FAILED'); } });
  const source = createPlaybackSource(input());
  await assert.rejects(runtime.play(source, new AbortController().signal), failure('CLEANUP_FAILED'));
  await assert.rejects(runtime.dispose(source), failure('CLEANUP_FAILED'));
});

test('abort and total timeout reach the owned kill even when navigation and context close are both hung', { timeout: 16_000 }, async () => {
  for (const reason of ['abort', 'deadline']) {
    const fake = fakeBrowser(); let reached!: () => void; const navigating = new Promise<void>(resolve => { reached = resolve; });
    const never = new Promise<void>(() => {});
    fake.launched.browser.newContext = async () => ({ routeWebSocket: async () => {}, route: async () => {}, addCookies: async () => {}, on: () => {},
      newPage: async () => ({ goto: () => { reached(); return never; } }), close: () => never,
    });
    const runtime = createPlaybackRuntime({ launch: async () => fake.launched }), abort = new AbortController();
    const source = createPlaybackSource({ ...input(), timeouts: { startMs: 5000, stallMs: 1000, totalMs: reason === 'deadline' ? 1000 : 30_000 } });
    const result = runtime.play(source, abort.signal); const rejected = assert.rejects(result, failure(reason === 'abort' ? 'ABORTED' : 'EXECUTION_TIMEOUT'));
    await navigating; if (reason === 'abort') abort.abort(); await rejected;
    assert.equal(fake.observed.killed, 1); assert.equal(fake.child.signalCode, 'SIGKILL'); await runtime.dispose(source);
  }
});
