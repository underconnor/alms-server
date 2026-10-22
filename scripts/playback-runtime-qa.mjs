import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createPlaybackSource, createPlaybackRuntime, PlaybackRuntimeError } from '../dist/playback-runtime.js';

if (process.platform !== 'linux' || process.env.PLAYBACK_QA_FIXTURE !== '/fixtures/sample.webm') throw new Error('Run in the isolated playback-qa Docker image.');
const media = await readFile(process.env.PLAYBACK_QA_FIXTURE);
const origin = 'https://fixture.alms.invalid', launchUrl = `${origin}/player/main`, frameUrl = `${origin}/player/frame`, mediaUrl = `${origin}/media/sample.webm`;
const processes = [];
const launch = async () => {
  const server = await chromium.launchServer({ headless: true, chromiumSandbox: true, host: '127.0.0.1', timeout: 20_000,
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  processes.push(server.process());
  try { return { server, browser: await chromium.connect(server.wsEndpoint(), { timeout: 5000 }) }; }
  catch (error) { await server.kill(); throw error; }
};
const cases = [], extra = {};
function source(withFrame = false) { return createPlaybackSource({ launchUrl, ...(withFrame ? { frameUrl } : {}), mediaUrl, videoSelector: '#lecture', startSelector: '#start',
  requests: [{ url: launchUrl, kind: 'document', methods: ['GET'] }, { url: mediaUrl, kind: 'media', methods: ['GET', 'HEAD'] },
    ...(withFrame ? [{ url: frameUrl, kind: 'document', methods: ['GET'] }] : [])],
  cookies: [{ name: 'fixture_session', value: 'synthetic-cookie', domain: 'fixture.alms.invalid', path: '/player/', secure: true, httpOnly: true, sameSite: 'Strict' }],
  timeouts: { startMs: 1500, stallMs: 700, totalMs: 10_000 } }); }
function transport(kind = 'normal', onMedia) {
  const requests = []; let cookieSeen = false;
  const fetcher = async (url, options) => {
    const current = String(url); requests.push(current);
    assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    if (current === launchUrl || kind === 'delayed-frame' && current === frameUrl) {
      assert.equal(options.headers.cookie, 'fixture_session=synthetic-cookie'); cookieSeen = true;
      if (kind === 'delayed-frame' && current === launchUrl) return new Response(`<!doctype html><link rel="icon" href="data:,"><iframe src="${frameUrl}"></iframe>`, { headers: { 'content-type': 'text/html' } });
      if (kind === 'delayed-frame' && current === frameUrl) await new Promise(resolve => setTimeout(resolve, 300));
      if (kind === 'redirect') return new Response('', { status: 302, headers: { location: 'https://blocked.alms.test/secret' } });
      let script = '';
      if (kind === 'iframe') script = '<iframe src="https://blocked.alms.test/private"></iframe>';
      if (kind === 'websocket') script = '<script>new WebSocket("wss://blocked.alms.test/socket")</script>';
      if (kind === 'serviceworker') script = '<script>navigator.serviceWorker.register("/service-worker.js").catch(()=>{})</script>';
      const action = kind === 'no-start' ? '' : kind === 'pause' ? "v.play();setTimeout(()=>v.pause(),300)" : kind === 'rate' ? 'v.playbackRate=2;v.play()' : 'v.play()';
      const second = kind === 'multiple' ? `<video src="${mediaUrl}"></video>` : '';
      const html = `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><video id="lecture" muted ${kind === 'loop' ? 'loop' : ''} preload="metadata" src="${mediaUrl}"></video>${second}<button id="start" onclick="const v=document.querySelector('#lecture');${action}">Start</button>${script}`;
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    }
    assert.equal(current, mediaUrl, 'guard must reject unsupported paths before transport');
    assert.equal(options.headers.cookie, undefined, 'player cookie must never reach media path');
    onMedia?.();
    return new Response(media, { headers: { 'content-type': 'video/webm', 'content-length': String(media.length), 'accept-ranges': 'bytes' } });
  };
  return { fetcher, requests, seen: () => cookieSeen };
}
async function check(name, run) {
  const started = performance.now();
  try { await run(); cases.push({ name, passed: true, elapsedMs: Math.round(performance.now() - started) }); }
  catch (error) { cases.push({ name, passed: false, code: error instanceof PlaybackRuntimeError ? error.code : 'QA_ASSERTION', elapsedMs: Math.round(performance.now() - started) }); }
}

await check('normal-video-ended-with-real-progress-and-clean-process', async () => {
  const fake = transport(); const runtime = createPlaybackRuntime({ launch, fetch: fake.fetcher });
  const evidence = await runtime.play(source(), new AbortController().signal);
  assert.equal(evidence.ended, true); assert.equal(evidence.positionAdvanced, true); assert.ok(evidence.durationSeconds >= 1.8);
  assert.ok(evidence.elapsedMs >= 1800); assert.equal(evidence.processExited, true); assert.equal(fake.seen(), true);
  extra.normal = evidence;
});
await check('allowed-frame-waits-for-delayed-navigation-and-plays', async () => {
  const fake = transport('delayed-frame'), runtime = createPlaybackRuntime({ launch, fetch: fake.fetcher });
  const evidence = await runtime.play(source(true), new AbortController().signal);
  assert.equal(evidence.ended, true); assert.equal(evidence.positionAdvanced, true); assert.equal(evidence.processExited, true);
  assert.ok(fake.requests.includes(frameUrl)); assert.ok(fake.requests.every(url => [launchUrl, frameUrl, mediaUrl].includes(url)));
});
for (const [kind, code] of [['no-start', 'START_TIMEOUT'], ['pause', 'PAUSED'], ['loop', 'MEDIA_UNSUPPORTED'], ['multiple', 'MEDIA_UNSUPPORTED'], ['rate', 'MEDIA_UNSUPPORTED'], ['redirect', 'ROUTE_BLOCKED'], ['iframe', 'ROUTE_BLOCKED'], ['websocket', 'ROUTE_BLOCKED']]) {
  await check(kind, async () => {
    const fake = transport(kind), runtime = createPlaybackRuntime({ launch, fetch: fake.fetcher });
    await assert.rejects(runtime.play(source(), new AbortController().signal), error => error instanceof PlaybackRuntimeError && error.code === code);
    assert.ok(fake.requests.every(url => [launchUrl, mediaUrl].includes(url)));
  });
}
await check('serviceworker-registration-blocked-without-script-fetch', async () => {
  const fake = transport('serviceworker'), runtime = createPlaybackRuntime({ launch, fetch: fake.fetcher });
  await runtime.play(source(), new AbortController().signal);
  assert.ok(fake.requests.every(url => [launchUrl, mediaUrl].includes(url)));
});
await check('cancel-one-job-without-stopping-another-browser', async () => {
  const abort = new AbortController(); let timer;
  const left = transport('normal', () => { timer ??= setTimeout(() => abort.abort(), 400); }), right = transport();
  const cancelled = createPlaybackRuntime({ launch, fetch: left.fetcher }).play(source(), abort.signal);
  const completed = createPlaybackRuntime({ launch, fetch: right.fetcher }).play(source(), new AbortController().signal);
  const [leftResult, rightResult] = await Promise.allSettled([cancelled, completed]);
  assert.equal(leftResult.status, 'rejected'); assert.equal(leftResult.reason.code, 'ABORTED');
  assert.equal(rightResult.status, 'fulfilled'); assert.equal(rightResult.value.ended, true); clearTimeout(timer);
});
await check('explicit-dispose-waits-for-process-exit', async () => {
  let ready; const mediaReady = new Promise(resolve => { ready = resolve; });
  const fake = transport('normal', ready), runtime = createPlaybackRuntime({ launch, fetch: fake.fetcher }), prepared = source();
  const result = runtime.play(prepared, new AbortController().signal);
  await Promise.all([assert.rejects(result, error => error instanceof PlaybackRuntimeError && error.code === 'ABORTED'),
    (async () => { await Promise.race([mediaReady, result.catch(() => {})]); await runtime.dispose(prepared); })()]);
});
const allProcessesExited = processes.every(child => child.exitCode !== null || child.signalCode !== null);
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), runtime: 'playwright-1.63.0/chromium', syntheticMedia: true,
  schoolRequests: 0, sandboxEnabled: true, processCount: processes.length, allProcessesExited, cases, ...extra,
  result: cases.every(value => value.passed) && allProcessesExited ? 'passed' : 'failed' }));
if (!cases.every(value => value.passed) || !allProcessesExited) process.exitCode = 1;
