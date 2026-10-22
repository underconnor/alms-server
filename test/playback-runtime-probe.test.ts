import test from 'node:test';
import assert from 'node:assert/strict';
import { probeControlledPlaybackRuntime, ControlledPlaybackError } from '../src/controlled-playback-runtime.js';
const failure = (code: string) => (error: unknown) => error instanceof ControlledPlaybackError && error.code === code;
function fake(options: { invalidDom?: boolean; externalRequest?: boolean; hungClose?: boolean; killFails?: boolean; hangPage?: boolean } = {}) {
  const process = { exitCode: null as number | null, signalCode: null as string | null };
  const counts = { documents: 0, routesAborted: 0, closes: 0, kills: 0, contextCloses: 0 };
  let route: (value: any) => Promise<void> = async () => {};
  const events: Record<string, Function> = {};
  const page = {
    on: (name: string, fn: Function) => { events[name] = fn; },
    goto: async (url: string) => {
      if (options.externalRequest) await route({ request: () => ({ url: () => 'https://synthetic.invalid/', method: () => 'GET', resourceType: () => 'document' }), abort: async () => { counts.routesAborted++; } });
      else {
        const response = await fetch(url); assert.equal(response.status, 200);
        const html = await response.text(); assert.match(html, /<video/); assert.doesNotMatch(html, / src=|\/media/);
        counts.documents++; events.response?.({ url: () => url, status: () => 200 });
        assert.equal((await fetch(url.replace('/player', '/media'))).status, 404);
      }
    },
    evaluate: async () => !options.invalidDom,
    frames: () => [{}],
    close: async () => {},
  };
  const context = {
    route: async (_: string, fn: typeof route) => { route = fn; },
    routeWebSocket: async () => {}, on: () => {}, pages: () => [page],
    newPage: async () => { if (options.hangPage) await new Promise(() => {}); return page; },
    close: async () => { counts.contextCloses++; },
  };
  const server = {
    process: () => process,
    close: async () => { counts.closes++; if (options.hungClose) await new Promise(() => {}); process.exitCode = 0; },
    kill: async () => { counts.kills++; if (options.killFails) throw Error('raw-synthetic'); process.signalCode = 'SIGKILL'; },
  };
  const browser = {
    newContext: async (settings: any) => { assert.equal(settings.serviceWorkers, 'block'); assert.equal(settings.bypassCSP, false); assert.deepEqual(settings.permissions, []); return context; },
    isConnected: () => process.exitCode === null && process.signalCode === null, close: async () => {},
  };
  return { value: { browser, server } as any, counts, process };
}
test('readiness loads one real loopback document with no media route and waits for process exit', async () => {
  const f = fake(); await probeControlledPlaybackRuntime(new AbortController().signal, { launch: async () => f.value });
  assert.deepEqual(f.counts, { documents: 1, routesAborted: 0, closes: 1, kills: 0, contextCloses: 1 });
  assert.equal(f.process.exitCode, 0);
});
test('a cancelled readiness probe cannot launch', async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  await assert.rejects(probeControlledPlaybackRuntime(abort.signal, { launch: async () => { calls++; throw Error('raw'); } }), failure('ABORTED'));
  assert.equal(calls, 0);
});
test('a failed launch is normalized and never becomes ready', async () => {
  await assert.rejects(probeControlledPlaybackRuntime(new AbortController().signal, { launch: async () => { throw Error('raw-private'); } }), failure('LAUNCH_FAILED'));
});
test('invalid DOM and attempted outside navigation block readiness and close the browser', async () => {
  for (const options of [{ invalidDom: true }, { externalRequest: true }]) {
    const f = fake(options);
    await assert.rejects(probeControlledPlaybackRuntime(new AbortController().signal, { launch: async () => f.value }), failure(options.invalidDom ? 'MEDIA_INVALID' : 'ROUTE_BLOCKED'));
    assert.equal(f.process.exitCode, 0);
  }
});
test('cancellation during launch reaps the late browser without reporting readiness', async () => {
  const f = fake(), abort = new AbortController();
  const pending = probeControlledPlaybackRuntime(abort.signal, { launch: async () => { await new Promise(r => setTimeout(r, 60)); return f.value; } });
  setTimeout(() => abort.abort(), 10);
  await assert.rejects(pending, failure('ABORTED')); assert.equal(f.process.exitCode, 0); assert.equal(f.counts.documents, 0);
});
test('cancellation interrupts a stuck page operation and confirms browser exit', async () => {
  const f = fake({ hangPage: true }), abort = new AbortController();
  const pending = probeControlledPlaybackRuntime(abort.signal, { launch: async () => f.value });
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(pending, failure('ABORTED')); assert.equal(f.process.exitCode, 0);
});
test('a hung browser close is killed; unconfirmed process exit fails readiness', async () => {
  for (const killFails of [false, true]) {
    const f = fake({ hungClose: true, killFails });
    const pending = probeControlledPlaybackRuntime(new AbortController().signal, { launch: async () => f.value });
    if (killFails) await assert.rejects(pending, failure('CLEANUP_FAILED')); else await pending;
    assert.equal(f.counts.kills, 1);
  }
});
