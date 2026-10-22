import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { createPlaybackMediaProxy } from '../src/playback-media-proxy.js';
import { createVideoStreamer } from '../src/video-stream.js';
import { maxSchoolVideoBytes } from '../src/video-policy.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('private loopback proxy permits only its exact paths and never exposes an upstream location', async () => {
  let calls = 0,
    checks = 0,
    seen = 0;
  const proxy = await createPlaybackMediaProxy({
    signal: new AbortController().signal,
    validate: async () => {
      checks++;
    },
    onMedia: () => {
      seen++;
    },
    onFailure: () => assert.fail('unexpected failure'),
    stream: async (r) => {
      calls++;
      assert.equal(r.method, 'GET');
      assert.equal(r.range, 'bytes=0-3');
      return {
        status: 206,
        contentLength: 4,
        contentRange: 'bytes 0-3/4',
        body: Readable.from([Buffer.from('test')]),
      };
    },
  });
  try {
    assert.deepEqual(JSON.parse(JSON.stringify(proxy)), {
      kind: 'private-playback-media-proxy',
    });
    assert.doesNotMatch(inspect(proxy), /127\.0|http|[A-Za-z0-9_-]{40}/);
    const page = await fetch(proxy.playerUrl);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<video /);
    assert.match(page.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.doesNotMatch(html, /https:|cookie|token|canvas\.ssu/);
    for (const [url, init] of [
      [proxy.mediaUrl + '?x=1', {}],
      [proxy.mediaUrl, { method: 'POST' }],
      [proxy.mediaUrl, { headers: { Cookie: 'x=y' } }],
    ] as const) {
      const r = await fetch(url, init);
      assert.ok([403, 404].includes(r.status));
    }
    const wrongHost = await new Promise<number>((resolve) => {
      const req = request(proxy.mediaUrl, { headers: { host: 'localhost' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode!));
      });
      req.end();
    });
    assert.equal(wrongHost, 403);
    assert.equal(calls, 0);
    const media = await fetch(proxy.mediaUrl, {
      headers: { Range: 'bytes=0-3' },
    });
    assert.equal(media.status, 206);
    assert.equal(await media.text(), 'test');
    assert.equal(checks, 2);
    assert.equal(seen, 1);
    assert.equal(calls, 1);
  } finally {
    await proxy.close();
    await proxy.close();
  }
});

test('streaming above 32 MiB remains incremental and forwards HEAD without a body', async () => {
  const size = 40 * 1024 * 1024;
  let produced = 0;
  const proxy = await createPlaybackMediaProxy({
    signal: new AbortController().signal,
    validate: async () => {},
    onMedia: () => {},
    onFailure: () => assert.fail('unexpected failure'),
    stream: async (r) => ({
      status: 200,
      contentLength: size,
      body:
        r.method === 'HEAD'
          ? null
          : Readable.from(
              (async function* () {
                for (let i = 0; i < size / 65536; i++) {
                  produced++;
                  yield Buffer.alloc(65536, 7);
                }
              })(),
            ),
    }),
  });
  try {
    const head = await fetch(proxy.mediaUrl, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(produced, 0);
    const response = await fetch(proxy.mediaUrl);
    assert.equal(Number(response.headers.get('content-length')), size);
    assert.ok(produced < size / 65536, 'proxy does not buffer the complete media before returning headers');
    let count = 0;
    for await (const bytes of response.body!) count += bytes.length;
    assert.equal(count, size);
  } finally {
    await proxy.close();
  }
});

test('abort closes an outstanding handoff, and a late offered body is destroyed', async () => {
  let offer!: (value: any) => void, called!: () => void;
  const reached = new Promise<void>((r) => (called = r));
  const abort = new AbortController();
  let failures = 0,
    streamSignal: AbortSignal | undefined;
  const proxy = await createPlaybackMediaProxy({
    signal: abort.signal,
    validate: async () => {},
    onMedia: () => {},
    onFailure: () => {
      failures++;
    },
    stream: (r) => {
      streamSignal = r.signal;
      called();
      return new Promise((resolve) => (offer = resolve));
    },
  });
  const response = fetch(proxy.mediaUrl).catch(() => null);
  await reached;
  abort.abort();
  await proxy.close();
  await response;
  assert.equal(streamSignal?.aborted, true);
  const late = new Readable({ read() {} });
  offer({ status: 200, contentLength: 4, body: late });
  await tick();
  assert.equal(late.destroyed, true);
  assert.equal(failures, 0);
});

test('invalid stream metadata is normalized and cannot leak callback failure text', async () => {
  let failures = 0;
  const proxy = await createPlaybackMediaProxy({
    signal: new AbortController().signal,
    validate: async () => {},
    onMedia: () => assert.fail(),
    onFailure: () => {
      failures++;
      throw Error('private');
    },
    stream: async () => ({
      status: 200,
      contentLength: 0,
      body: Readable.from([Buffer.from('secret')]),
    }),
  });
  try {
    const response = await fetch(proxy.mediaUrl);
    assert.equal(response.status, 502);
    assert.equal(await response.text(), '');
    assert.equal(failures, 1);
  } finally {
    await proxy.close();
  }
});

test('an aborted scope never opens a listener', async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    createPlaybackMediaProxy({
      signal: abort.signal,
      validate: async () => {},
      stream: async () => {
        throw Error('must not call');
      },
      onMedia() {},
      onFailure() {},
    }),
  );
});

test('school stream and private proxy share the four-GiB boundary for HEAD and tiny large-offset Ranges', async () => {
  let size = 1_520_520_089, failures = 0, media = 0, upstreamBytes = 0;
  const stream = createVideoStreamer(async (_url, init) => {
    if (init?.method === 'HEAD') return new Response(null, {headers: {'Content-Type': 'video/mp4', 'Content-Length': String(size)}});
    const range = new Headers(init?.headers).get('range');
    const offset = range === 'bytes=0-0' ? 0 : size - 1;
    assert.equal(range, `bytes=${offset}-${offset}`);
    upstreamBytes++;
    return new Response(new Uint8Array([7]), {status: 206, headers: {'Content-Type': 'video/mp4', 'Content-Length': '1',
      'Content-Range': `bytes ${offset}-${offset}/${size}`}});
  });
  const proxy = await createPlaybackMediaProxy({
    signal: new AbortController().signal, validate: async () => {}, onMedia: () => {media++;}, onFailure: () => {failures++;},
    stream: r => stream('synthetic-owner', async () => ({contentId: 'synthetic',
      mediaUrl: 'https://ssuin-object.commonscdn.com/ssu-contents/contents/ssu1000001/synthetic/contents/media_files/video.mp4',
      validate: async () => {},
    }), r),
  });
  try {
    for (const total of [1_520_520_089, maxSchoolVideoBytes]) {
      size = total;
      const head = await fetch(proxy.mediaUrl, {method: 'HEAD'});
      assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), total);
      assert.equal((await head.arrayBuffer()).byteLength, 0);
      for (const offset of [0, total - 1]) {
        const response = await fetch(proxy.mediaUrl, {headers: {Range: `bytes=${offset}-${offset}`}});
        assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), `bytes ${offset}-${offset}/${total}`);
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([7]));
      }
    }
    assert.equal(media, 4); assert.equal(upstreamBytes, 4); assert.equal(failures, 0);
    size = maxSchoolVideoBytes + 1;
    for (const init of [{method: 'HEAD'}, {headers: {Range: 'bytes=0-0'}}]) {
      const response = await fetch(proxy.mediaUrl, init); assert.equal(response.status, 502);
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    }
    assert.equal(media, 4); assert.equal(failures, 2);
  } finally {await proxy.close();}
});

test('private proxy rejects a handoff length beyond the shared four-GiB ceiling before exposing a body', async () => {
  let size = maxSchoolVideoBytes, failures = 0;
  const proxy = await createPlaybackMediaProxy({
    signal: new AbortController().signal, validate: async () => {}, onMedia: () => assert.fail('HEAD must not play'),
    onFailure: () => {failures++;}, stream: async () => ({status: 200, contentLength: size, body: null}),
  });
  try {
    const exact = await fetch(proxy.mediaUrl, {method: 'HEAD'});
    assert.equal(exact.status, 200); assert.equal(Number(exact.headers.get('content-length')), maxSchoolVideoBytes);
    size++;
    const oversize = await fetch(proxy.mediaUrl, {method: 'HEAD'});
    assert.equal(oversize.status, 502); assert.equal((await oversize.arrayBuffer()).byteLength, 0);
    assert.equal(failures, 1);
  } finally {await proxy.close();}
});

test('private proxy rejects malformed, unsafe and oversized Range handoffs and destroys their tiny bodies', async () => {
  let range = '', offered: Readable | undefined, failures = 0, reads = 0;
  const proxy = await createPlaybackMediaProxy({
    signal: new AbortController().signal, validate: async () => {}, onMedia: () => assert.fail('invalid media must not play'),
    onFailure: () => {failures++;}, stream: async () => {
      offered = new Readable({read() {reads++; this.push(Buffer.from([7])); this.push(null);}});
      return {status: 206, contentLength: 1, contentRange: range, body: offered};
    },
  });
  const invalid = [`bytes 0-0/${maxSchoolVideoBytes + 1}`, 'bytes 0-0/9007199254740992',
    'bytes 9007199254740992-9007199254740992/9007199254740993', 'bytes 2-1/4',
    'bytes 4-4/4', 'bytes 0-2/4', 'bytes */4', 'bytes 0-0/0', 'bytes -1-0/4'];
  try {
    for (const value of invalid) {
      range = value;
      const response = await fetch(proxy.mediaUrl, {headers: {Range: 'bytes=0-0'}});
      assert.equal(response.status, 502); assert.equal((await response.arrayBuffer()).byteLength, 0);
      assert.equal(offered?.destroyed, true);
    }
    assert.equal(failures, invalid.length); assert.equal(reads, 0);
  } finally {await proxy.close();}
});
