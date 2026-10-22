import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoStreamer, type VideoRequest, type PreparedVideoSource } from '../src/video-stream.js';
import { AppError } from '../src/errors.js';
import { maxSchoolVideoBytes } from '../src/video-policy.js';
import { getEventListeners } from 'node:events';

const mediaUrl = 'https://ssuin-object.commonscdn.com/ssu-contents/contents31/ssu1000001/synthetic/contents/media_files/mobile/video.mp4';
const source = (overrides: Partial<PreparedVideoSource> = {}): PreparedVideoSource => ({
  contentId: 'synthetic', mediaUrl, validate: async () => {}, ...overrides,
});
const request = (overrides: Partial<VideoRequest> = {}): VideoRequest => ({
  method: 'GET', signal: new AbortController().signal, validate: async () => {}, ...overrides,
});
const matches = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;
const bytes = async (body: NonNullable<Awaited<ReturnType<ReturnType<typeof createVideoStreamer>>>['body']>) => {
  const chunks: Buffer[] = []; for await (const part of body) chunks.push(Buffer.from(part)); return Buffer.concat(chunks);
};
function response(body = '1234', init: ResponseInit = {}) {
  return new Response(body, { ...init, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(body.length), ...init.headers } });
}
test('reference media streams bytes with anonymous transport, exact range and no reusable public URL', async () => {
  const calls: RequestInit[] = []; let validations = 0;
  const stream = createVideoStreamer(async (_url, init) => {
    calls.push(init!); return response('23', { status: 206, headers: { 'Content-Range': 'bytes 1-2/4' } });
  });
  const result = await stream('owner', async () => source({ validate: async () => { validations++; } }), request({ range: 'bytes=1-2' }));
  assert.equal(result.status, 206); assert.equal(result.contentRange, 'bytes 1-2/4');
  assert.equal((await bytes(result.body!)).toString(), '23'); assert.ok(validations >= 2);
  assert.deepEqual(calls[0]!.headers, { Accept: 'video/mp4', 'Accept-Encoding': 'identity', Range: 'bytes=1-2' });
  assert.equal(calls[0]!.credentials, 'omit'); assert.equal(calls[0]!.redirect, 'manual');
  assert.equal('mediaUrl' in result, false);
});
test('HEAD has the same authorization but no body and releases its stream reservation', async () => {
  let calls = 0, checks = 0;
  const stream = createVideoStreamer(async (_url, init) => {
    calls++; assert.equal(init!.method, 'HEAD');
    return new Response(null, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '619492057' } });
  });
  for (let i = 0; i < 3; i++) {
    const result = await stream('owner', async () => source(), request({ method: 'HEAD', validate: async () => { checks++; } }));
    assert.equal(result.body, null); assert.equal(result.contentLength, 619492057);
  }
  assert.equal(calls, 3); assert.ok(checks >= 9);
});
test('issued contents29 video1 media keeps anonymous HEAD and exact owned Range', async () => {
  const issued = mediaUrl.replace('/contents31/', '/contents29/');
  let calls = 0;
  const stream = createVideoStreamer(async (url, init) => {
    calls++; assert.equal(url, issued); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'manual');
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '4' } });
    assert.deepEqual(init?.headers, { Accept: 'video/mp4', 'Accept-Encoding': 'identity', Range: 'bytes=1-2' });
    return response('23', { status: 206, headers: { 'Content-Range': 'bytes 1-2/4' } });
  });
  const head = await stream('owner', async () => source({ mediaUrl: issued }), request({ method: 'HEAD' }));
  assert.equal(head.status, 200); assert.equal(head.body, null); assert.equal(head.contentLength, 4);
  const ranged = await stream('owner', async () => source({ mediaUrl: issued }), request({ range: 'bytes=1-2' }));
  assert.equal(ranged.status, 206); assert.equal((await bytes(ranged.body!)).toString(), '23'); assert.equal(calls, 2);
});
test('contents29 cannot widen CDN, school tenant, content, folder or volume before transport', async () => {
  const issued = mediaUrl.replace('/contents31/', '/contents29/');
  let calls = 0;
  const stream = createVideoStreamer(async () => { calls++; return response(); });
  for (const url of [issued.replace('ssuin-object.commonscdn.com', 'foreign.test'),
    issued.replace('/ssu1000001/', '/ssu1000002/'), issued.replace('/synthetic/', '/other/'),
    issued.replace('/contents29/', '/contents28/'), issued.replace('/mobile/', '/'),
    issued.replace('/video.mp4', '/nested/video.mp4'), issued.replace('/video.mp4', '/%76ideo.mp4'),
    issued + '?download=1', issued + '#fragment'])
    await assert.rejects(stream('owner', async () => source({ mediaUrl: url }), request()), matches('VIDEO_UNAVAILABLE'));
  assert.equal(calls, 0);
});
test('resolved single-story UPF media accepts the exact owned CDN path and anonymous Range', async () => {
  const upfUrl = 'https://ssuin-object.commonscdn.com/ssu-contents/contents/ssu1000001/synthetic/contents/media_files/issued-video.mp4';
  let calls = 0;
  const stream = createVideoStreamer(async (url, init) => {
    calls++; assert.equal(url, upfUrl); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'manual');
    assert.deepEqual(init?.headers, { Accept: 'video/mp4', 'Accept-Encoding': 'identity', Range: 'bytes=0-' });
    return response('1234', { status: 206, headers: { 'Content-Range': 'bytes 0-3/4' } });
  });
  const result = await stream('owner', async () => source({ mediaUrl: upfUrl }), request({ range: 'bytes=0-' }));
  assert.equal(result.status, 206); assert.equal((await bytes(result.body!)).toString(), '1234'); assert.equal(calls, 1);
});
test('UPF media rejects sibling content, tenant, layout, nesting and encoded filenames before transport', async () => {
  const upfUrl = 'https://ssuin-object.commonscdn.com/ssu-contents/contents/ssu1000001/synthetic/contents/media_files/issued-video.mp4';
  let calls = 0;
  const stream = createVideoStreamer(async () => { calls++; return response(); });
  for (const url of [upfUrl.replace('/synthetic/', '/other/'), upfUrl.replace('/ssu1000001/', '/ssu1000002/'),
    upfUrl.replace('/contents/ssu1000001/', '/contents15/ssu1000001/'), upfUrl.replace('/issued-video.mp4', '/mobile/issued-video.mp4'),
    upfUrl.replace('/issued-video.mp4', '/%69ssued-video.mp4'), upfUrl + '?download=1', upfUrl + '#fragment']) {
    await assert.rejects(stream('owner', async () => source({ mediaUrl: url }), request()), matches('VIDEO_UNAVAILABLE'));
  }
  assert.equal(calls, 0);
});
test('full and suffix responses validate exact length and bounded total resource size', async () => {
  const full = createVideoStreamer(async () => response());
  assert.equal((await bytes((await full('owner', async () => source(), request())).body!)).toString(), '1234');
  const suffix = createVideoStreamer(async () => response('34', { status: 206, headers: { 'Content-Range': 'bytes 2-3/4' } }));
  assert.equal((await bytes((await suffix('owner', async () => source(), request({ range: 'bytes=-2' }))).body!)).toString(), '34');
});
test('foreign/encoded/traversal/source-mismatched media URLs never reach fetch', async () => {
  let calls = 0;
  const stream = createVideoStreamer(async () => { calls++; return response(); });
  for (const url of [mediaUrl.replace('ssuin-object.commonscdn.com', 'foreign.test'), mediaUrl + '?token=secret',
    mediaUrl.replace('/synthetic/', '/other/'), mediaUrl.replace('/video.mp4', '/%2e%2e/video.mp4'),
    mediaUrl.replace('/video.mp4', '/../video.mp4'), mediaUrl.replace('https:', 'http:')]) {
    await assert.rejects(stream('owner', async () => source({ mediaUrl: url }), request()), matches('VIDEO_UNAVAILABLE'));
  }
  assert.equal(calls, 0);
});
test('invalid or multipart ranges fail before ownership or upstream requests', async () => {
  let prepares = 0;
  const stream = createVideoStreamer(async () => response());
  for (const range of ['bytes=0-1,2-3', 'bytes=-', 'bytes=-0', 'bytes=3-2', 'bytes=9007199254740992-', 'foo=0-1'])
    await assert.rejects(stream('owner', async () => { prepares++; return source(); }, request({ range })), matches('VIDEO_RANGE_INVALID'));
  assert.equal(prepares, 0);
});
test('redirect, wrong MIME, compression, missing length, oversize or ignored Range fail closed', async () => {
  for (const init of [
    { status: 302, headers: { Location: 'https://foreign.test/private' } },
    { headers: { 'Content-Type': 'text/html' } },
    { headers: { 'Content-Encoding': 'gzip' } },
    { headers: { 'Content-Length': '' } },
    { headers: { 'Content-Length': String(maxSchoolVideoBytes + 1) } },
    { status: 206, headers: { 'Content-Range': 'bytes 0-3/99999999999999' } },
    { status: 206, headers: { 'Content-Range': 'bytes 1-4/8' } },
    {},
  ]) {
    const stream = createVideoStreamer(async () => response('1234', init));
    await assert.rejects(stream('owner', async () => source(), request({ range: 'bytes=0-3' })), matches('VIDEO_UNAVAILABLE'));
  }
});
test('unsatisfiable upstream Range is normalized without returning its body or URL', async () => {
  const stream = createVideoStreamer(async () => response('secret', { status: 416 }));
  await assert.rejects(stream('owner', async () => source(), request({ range: 'bytes=100-' })), matches('VIDEO_RANGE_INVALID'));
});
test('a logout after source preparation prevents the media request', async () => {
  let active = true, fetched = false;
  const stream = createVideoStreamer(async () => { fetched = true; return response(); });
  await assert.rejects(stream('owner', async () => { active = false; return source(); }, request({ validate: async () => {
    if (!active) throw new AppError(401, 'AUTH_REQUIRED', 'expired');
  } })), matches('AUTH_REQUIRED'));
  assert.equal(fetched, false);
});
test('a generation change during response headers cancels upstream and withholds bytes', async () => {
  let valid = true, cancelled = false;
  const stream = createVideoStreamer(async () => {
    valid = false;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '4' } });
  });
  await assert.rejects(stream('owner', async () => source({ validate: async () => {
    if (!valid) throw new AppError(409, 'SCHOOL_SESSION_CHANGED', 'changed');
  } }), request()), matches('SCHOOL_SESSION_CHANGED'));
  assert.equal(cancelled, true);
});
test('session expiry while reading stops the stream and cancels upstream', { timeout: 2000 }, async () => {
  let valid = true, cancelled = false;
  const stream = createVideoStreamer(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '4' } }), { checkMs: 5 });
  const result = await stream('owner', async () => source(), request({ validate: async () => {
    if (!valid) throw new AppError(401, 'AUTH_REQUIRED', 'expired');
  } }));
  const reading = bytes(result.body!); valid = false;
  await assert.rejects(reading, matches('AUTH_REQUIRED')); assert.equal(cancelled, true);
});
test('a disconnected client cancels a stalled stream and releases owner concurrency', { timeout: 2000 }, async () => {
  let cancellations = 0;
  const stream = createVideoStreamer(async () => new Response(new ReadableStream({ cancel() { cancellations++; } }),
    { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '4' } }));
  const aborts = [new AbortController(), new AbortController()];
  const results = await Promise.all(aborts.map(controller => stream('owner', async () => source(), request({ signal: controller.signal }))));
  await assert.rejects(stream('owner', async () => source(), request()), matches('VIDEO_BUSY'));
  const reading = bytes(results[0]!.body!); aborts[0]!.abort();
  await assert.rejects(reading, matches('REQUEST_ABORTED'));
  results[1]!.body!.destroy();
  await new Promise(resolve => setImmediate(resolve));
  const result = await stream('owner', async () => source(), request({ method: 'HEAD' }));
  assert.equal(result.body, null); assert.equal(cancellations, 3);
});
test('truncated and overlong bodies reject instead of being treated as a complete media read', async () => {
  for (const length of ['2', '8']) {
    const stream = createVideoStreamer(async () => response('1234', { headers: { 'Content-Length': length } }));
    const result = await stream('owner', async () => source(), request());
    await assert.rejects(bytes(result.body!), matches('VIDEO_UNAVAILABLE'));
  }
});
test('setup and read idle timeouts reject even if an injected transport ignores abort', { timeout: 2000 }, async () => {
  const hanging = createVideoStreamer(async () => new Promise<Response>(() => {}), { setupMs: 10 });
  await assert.rejects(hanging('owner', async () => source(), request()), matches('VIDEO_UNAVAILABLE'));
  const idle = createVideoStreamer(async () => new Response(new ReadableStream(), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '4' } }), { idleMs: 10 });
  const result = await idle('owner', async () => source(), request());
  await assert.rejects(bytes(result.body!), matches('VIDEO_UNAVAILABLE'));
});

test('a hanging authorization check interrupts flowing bytes and returns the owner slot', { timeout: 2000 }, async () => {
  let checks = 0, cancelled = 0;
  const stream = createVideoStreamer(async () => new Response(new ReadableStream({
    async pull(controller) { await new Promise(resolve => setTimeout(resolve, 2)); controller.enqueue(new Uint8Array([1])); },
    cancel() { cancelled++; },
  }), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': '100000' } }), { checkMs: 5, validationMs: 20 });
  const stalled = request({ validate: async () => { if (++checks > 3) await new Promise<void>(() => {}); } });
  const result = await stream('owner', async () => source(), stalled);
  await assert.rejects(bytes(result.body!), matches('VIDEO_UNAVAILABLE'));
  assert.equal(cancelled, 1);
  // Two simultaneous new requests prove the stopped stream returned its reservation.
  const heads = await Promise.all([0, 1].map(() => stream('owner', async () => source(), request({ method: 'HEAD' }))));
  assert.equal(heads.every(result => result.body === null), true);
});

test('an issued video above one GiB permits HEAD and a one-byte Range without reading the complete file', async () => {
  const size = 1_520_520_089;
  let byteReads = 0, fetched = 0;
  const stream = createVideoStreamer(async (_url, init) => {
    fetched++; assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'manual');
    if (init?.method === 'HEAD') return new Response(null, {headers: {'Content-Type': 'video/mp4', 'Content-Length': String(size)}});
    assert.equal(new Headers(init?.headers).get('range'), 'bytes=0-0');
    return new Response(new ReadableStream<Uint8Array>({pull(controller) {
      byteReads++; controller.enqueue(new Uint8Array([7])); controller.close();
    }}), {status: 206, headers: {'Content-Type': 'video/mp4', 'Content-Length': '1', 'Content-Range': `bytes 0-0/${size}`}});
  });
  const head = await stream('owner', async () => source(), request({method: 'HEAD'}));
  assert.equal(head.contentLength, size); assert.equal(head.body, null); assert.equal(byteReads, 0);
  const ranged = await stream('owner', async () => source(), request({range: 'bytes=0-0'}));
  assert.equal(ranged.contentRange, `bytes 0-0/${size}`); assert.deepEqual(await bytes(ranged.body!), Buffer.from([7]));
  assert.equal(byteReads, 1); assert.equal(fetched, 2);
});

test('the exact four-GiB boundary preserves large offsets, clipped ends and suffix ranges', async () => {
  assert.equal(maxSchoolVideoBytes, 4 * 1024 ** 3);
  const size = maxSchoolVideoBytes, last = size - 1;
  for (const [range, start, end] of [
    [`bytes=${last}-${last}`, last, last],
    ['bytes=2147483648-2147483649', 2_147_483_648, 2_147_483_649],
    [`bytes=${last}-${size}`, last, last],
    [`bytes=${last}-`, last, last],
    ['bytes=-2', size - 2, last],
  ] as const) {
    const length = end - start + 1;
    const stream = createVideoStreamer(async (_url, init) => {
      if (init?.method === 'HEAD') return new Response(null, {headers: {'Content-Type': 'video/mp4', 'Content-Length': String(size)}});
      assert.equal(new Headers(init?.headers).get('range'), range);
      return response('x'.repeat(length), {status: 206, headers: {'Content-Range': `bytes ${start}-${end}/${size}`}});
    });
    const head = await stream('owner', async () => source(), request({method: 'HEAD'}));
    assert.equal(head.contentLength, size); assert.equal(head.body, null);
    const result = await stream('owner', async () => source(), request({range}));
    assert.equal(result.contentRange, `bytes ${start}-${end}/${size}`); assert.equal((await bytes(result.body!)).length, length);
  }
});

test('oversize resource lengths or range totals cancel upstream before yielding any bytes', async () => {
  for (const [method, range, length, contentRange] of [
    ['HEAD', undefined, maxSchoolVideoBytes + 1, undefined],
    ['HEAD', undefined, Number.MAX_SAFE_INTEGER + 1, undefined],
    ['GET', 'bytes=0-0', 1, `bytes 0-0/${maxSchoolVideoBytes + 1}`],
    ['GET', 'bytes=0-0', 1, `bytes 0-0/${Number.MAX_SAFE_INTEGER + 1}`],
  ] as const) {
    let cancelled = false;
    const stream = createVideoStreamer(async () => new Response(new ReadableStream<Uint8Array>({cancel() {cancelled = true;}}), {
      status: contentRange ? 206 : 200, headers: {'Content-Type': 'video/mp4', 'Content-Length': String(length),
        ...(contentRange ? {'Content-Range': contentRange} : {})},
    }));
    await assert.rejects(stream('owner', async () => source(), request({method, range})), matches('VIDEO_UNAVAILABLE'));
    assert.equal(cancelled, true);
  }
});

test('offsets and suffix lengths beyond the four-GiB policy fail before source or fetch', async () => {
  let prepares = 0, fetches = 0;
  const stream = createVideoStreamer(async () => {fetches++; return response();});
  for (const range of [`bytes=${maxSchoolVideoBytes + 1}-`, `bytes=0-${maxSchoolVideoBytes + 1}`,
    `bytes=-${maxSchoolVideoBytes + 1}`, 'bytes=9007199254740992-'])
    await assert.rejects(stream('owner', async () => {prepares++; return source();}, request({range})), matches('VIDEO_RANGE_INVALID'));
  assert.equal(prepares, 0); assert.equal(fetches, 0);
});

test('a large full response stays incremental and retains owner slots, cancellation and school authority', {timeout: 2000}, async () => {
  let cancellations = 0, pulls = 0, valid = true;
  const stream = createVideoStreamer(async (_url, init) => init?.method === 'HEAD'
    ? new Response(null, {headers: {'Content-Type': 'video/mp4', 'Content-Length': String(maxSchoolVideoBytes)}})
    : new Response(new ReadableStream<Uint8Array>({start(controller) {
      pulls++; controller.enqueue(new Uint8Array([1]));
    }, cancel() {cancellations++;}}), {headers: {'Content-Type': 'video/mp4', 'Content-Length': String(maxSchoolVideoBytes)}}), {checkMs: 5});
  const validate = async () => {if (!valid) throw new AppError(409, 'SCHOOL_SESSION_CHANGED', 'changed');};
  const first = await stream('owner', async () => source({validate}), request());
  const second = await stream('owner', async () => source({validate}), request());
  await assert.rejects(stream('owner', async () => source(), request()), matches('VIDEO_BUSY'));
  const other = await stream('other-owner', async () => source(), request({method: 'HEAD'}));
  assert.equal(other.contentLength, maxSchoolVideoBytes); assert.equal(other.body, null);
  const reading = first.body![Symbol.asyncIterator]();
  assert.equal((await reading.next()).value.length, 1); assert.equal(pulls, 2);
  const stopped = reading.next(); valid = false;
  await assert.rejects(stopped, matches('SCHOOL_SESSION_CHANGED'));
  second.body!.destroy(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellations, 2);
  const restored = await Promise.all([0, 1].map(() => stream('owner', async () => source(), request({method: 'HEAD'}))));
  assert.equal(restored.every(value => value.body === null), true);
});

test('the absolute four-GiB byte budget cancels an overlong stream without a complete-file allocation', {timeout: 10_000}, async () => {
  // Reuse one 1-MiB chunk; the consumer counts and discards it. No four-GiB Buffer is constructed.
  const chunk = new Uint8Array(1024 * 1024), count = maxSchoolVideoBytes / chunk.length;
  let produced = 0, cancelled = false, received = 0;
  const stream = createVideoStreamer(async () => new Response(new ReadableStream<Uint8Array>({pull(controller) {
    controller.enqueue(produced++ < count ? chunk : new Uint8Array([1]));
  }, cancel() {cancelled = true;}}), {headers: {'Content-Type': 'video/mp4', 'Content-Length': String(maxSchoolVideoBytes)}}));
  const result = await stream('owner', async () => source(), request());
  await assert.rejects(async () => {for await (const part of result.body!) received += part.length;}, matches('VIDEO_UNAVAILABLE'));
  assert.equal(received, maxSchoolVideoBytes); assert.equal(cancelled, true); assert.ok(produced >= count + 1);
  const head = await stream('owner', async () => source(), request({method: 'HEAD'})); assert.equal(head.body, null);
});

test('a large resource retains the read-idle timeout and cancels upstream', {timeout: 2000}, async () => {
  let cancelled = false;
  const stream = createVideoStreamer(async () => new Response(new ReadableStream<Uint8Array>({cancel() {cancelled = true;}}), {
    headers: {'Content-Type': 'video/mp4', 'Content-Length': String(maxSchoolVideoBytes)},
  }), {idleMs: 10});
  const result = await stream('owner', async () => source(), request());
  await assert.rejects(bytes(result.body!), matches('VIDEO_UNAVAILABLE')); assert.equal(cancelled, true);
});

for (const end of ['complete', 'upstream_error', 'cancel'] as const) {
  test(`chunk abort listeners stay bounded and are removed after ${end}`, { timeout: 2000 }, async () => {
    let transportSignal!: AbortSignal, produced = 0, controller!: ReadableStreamDefaultController<Uint8Array>;
    const count = 128;
    const stream = createVideoStreamer(async (_url, init) => {
      transportSignal = init!.signal as AbortSignal;
      return new Response(new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        pull(value) {
          if (produced++ < count) value.enqueue(new Uint8Array(1024));
          else if (end === 'complete') value.close();
        },
      }), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(count * 1024 + (end === 'complete' ? 0 : 1)) } });
    });
    const abort = new AbortController(), result = await stream('owner', async () => source(), request({ signal: abort.signal }));
    let received = 0, peak = 0;
    const reading = (async () => {
      for await (const part of result.body!) {
        received += part.byteLength;
        peak = Math.max(peak, getEventListeners(transportSignal, 'abort').length);
        if (received === count * 1024 && end === 'upstream_error') controller.error(new Error('private upstream failure'));
        if (received === count * 1024 && end === 'cancel') abort.abort();
      }
    })();
    if (end === 'complete') await reading;
    else await assert.rejects(reading, matches(end === 'cancel' ? 'REQUEST_ABORTED' : 'VIDEO_UNAVAILABLE'));
    assert.equal(received, count * 1024);
    assert.ok(peak <= 1, `overlapping per-chunk abort listeners: ${peak}`);
    assert.equal(getEventListeners(transportSignal, 'abort').length, 0);
    assert.equal(transportSignal.aborted, true);
    const heads = await Promise.all([0, 1].map(() => stream('owner', async () => source(), request({ method: 'HEAD' }))));
    assert.equal(heads.every(value => value.body === null), true);
  });
}
