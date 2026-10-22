import test from 'node:test';
import assert from 'node:assert/strict';
import { createMaterialLoader, createMaterialByteCache } from '../src/material-cache.js';
import { AppError } from '../src/errors.js';

const viewer = 'https://commons.ssu.ac.kr/em/synthetic';
const root = 'https://commons.ssu.ac.kr/storage/synthetic/contents/web_files/';
const pdf = Buffer.from('%PDF-1.7\nsynthetic');
function fixture(overrides: Record<string, Response | (() => Response)> = {}) {
  const calls: string[] = [];
  const responses: Record<string, () => Response> = {
    [viewer]: () => new Response('<script>var contentUri = "/viewer/ssplayer/uniplayer_support/content.php?content_id=synthetic";</script>', { headers: { 'content-type': 'text/html' } }),
    'https://commons.ssu.ac.kr/viewer/ssplayer/uniplayer_support/content.php?content_id=synthetic': () => new Response(`<content><content_id>synthetic</content_id><content_type>sharedocs</content_type><content_uri>${root}</content_uri></content>`, { headers: { 'content-type': 'text/xml' } }),
    [root + 'slide_list.xml']: () => new Response('<slide_file_list><slide_file type="pdf">original.pdf</slide_file></slide_file_list>', { headers: { 'content-type': 'text/xml' } }),
    [root + 'original.pdf']: () => new Response(pdf, { headers: { 'content-type': 'application/pdf' } }),
  };
  const fetcher = (async (input, options) => {
    const url = String(input); calls.push(url);
    assert.equal(options?.method, 'GET'); assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'manual');
    assert.equal(options?.headers, undefined);
    const selected = overrides[url] ?? responses[url];
    assert.ok(selected, 'unexpected school URL');
    return typeof selected === 'function' ? selected() : selected;
  }) as typeof fetch;
  return { calls, loader: createMaterialLoader(fetcher) };
}
const unavailable = (error: unknown) => error instanceof AppError && error.code === 'MATERIAL_UNAVAILABLE';

test('PDF loader follows only the measured owned viewer and XML chain without viewer scripts or progress requests', async () => {
  const f = fixture(); assert.deepEqual(await f.loader(viewer), pdf);
  assert.deepEqual(f.calls, [viewer, 'https://commons.ssu.ac.kr/viewer/ssplayer/uniplayer_support/content.php?content_id=synthetic', root + 'slide_list.xml', root + 'original.pdf']);
});

test('PDF loader rejects arbitrary viewer URLs before network access', async () => {
  for (const url of ['http://commons.ssu.ac.kr/em/synthetic', viewer + '?token=private', viewer + '#x', 'https://commons.ssu.ac.kr.evil.test/em/synthetic', 'https://user:secret@commons.ssu.ac.kr/em/synthetic', 'https://127.0.0.1/em/synthetic']) {
    const f = fixture(); await assert.rejects(f.loader(url), unavailable); assert.equal(f.calls.length, 0);
  }
});

test('PDF loader rejects redirects and mismatched content IDs before reading a foreign manifest', async () => {
  for (const response of [new Response('', { status: 302, headers: { location: 'https://foreign.test' } }),
    new Response('<script>var contentUri = "/viewer/ssplayer/uniplayer_support/content.php?content_id=foreign";</script>', { headers: { 'content-type': 'text/html' } }),
    new Response('<script>var contentUri = "https://foreign.test/private";</script>', { headers: { 'content-type': 'text/html' } })]) {
    const f = fixture({ [viewer]: response }); await assert.rejects(f.loader(viewer), unavailable); assert.equal(f.calls.length, 1);
  }
});

test('PDF loader rejects XML entities, wrong identity and unsupported stories', async () => {
  const config = 'https://commons.ssu.ac.kr/viewer/ssplayer/uniplayer_support/content.php?content_id=synthetic';
  for (const body of ['<!DOCTYPE x [<!ENTITY y SYSTEM "file:///private">]><content/>',
    `<content><content_id>other</content_id><content_type>sharedocs</content_type><content_uri>${root}</content_uri></content>`,
    `<content><content_id>synthetic</content_id><content_type>sharedocs</content_type><content_uri>${root}</content_uri><story_list/></content>`]) {
    const f = fixture({ [config]: new Response(body, { headers: { 'content-type': 'text/xml' } }) });
    await assert.rejects(f.loader(viewer), unavailable); assert.equal(f.calls.length, 2);
  }
});

test('PDF loader rejects ambiguous files and any file that escapes the observed content root', async () => {
  for (const body of ['<slide_file type="pdf">a.pdf</slide_file><slide_file type="pdf">b.pdf</slide_file>',
    '<slide_file type="pdf">../private.pdf</slide_file>', '<slide_file type="pdf">https://foreign.test/private.pdf</slide_file>',
    '<slide_file type="pdf">original.pdf?private=token</slide_file>',
    '<slide_file type="pdf">%2e%2e%2fprivate.pdf</slide_file>', '<slide_file type="pdf">%252e%252e%252fprivate.pdf</slide_file>',
    '<slide_file type="pdf">..%5cprivate.pdf</slide_file>']) {
    const f = fixture({ [root + 'slide_list.xml']: new Response(body, { headers: { 'content-type': 'text/xml' } }) });
    await assert.rejects(f.loader(viewer), unavailable); assert.equal(f.calls.length, 3);
  }
});

test('PDF loader checks byte limits, MIME type and file magic rather than trusting school metadata', async () => {
  for (const response of [new Response(pdf, { headers: { 'content-type': 'application/pdf', 'content-length': String(20 * 1024 * 1024 + 1) } }),
    new Response(pdf, { headers: { 'content-type': 'text/html' } }),
    new Response('<html>login</html>', { headers: { 'content-type': 'application/pdf' } })]) {
    const f = fixture({ [root + 'original.pdf']: response }); await assert.rejects(f.loader(viewer), unavailable);
  }
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/pdf' } });
  await assert.rejects(fixture({ [root + 'original.pdf']: response }).loader(viewer), unavailable);
  assert.equal(cancelled, true);
});

test('private PDF cache coalesces requests, separates owners and login generations, and expires after five minutes', async t => {
  let calls = 0, now = Date.now(); t.mock.method(Date, 'now', () => now);
  const cache = createMaterialByteCache(async () => { calls++; return pdf; });
  await Promise.all([cache.read('a', 'g1', '10:30', viewer), cache.read('a', 'g1', '10:30', viewer)]);
  assert.equal(calls, 1);
  await cache.read('b', 'g1', '10:30', viewer); assert.equal(calls, 2);
  await cache.read('a', 'g2', '10:30', viewer); assert.equal(calls, 3);
  await cache.read('a', 'g2', '10:30', viewer); assert.equal(calls, 3);
  now += 300_001; await cache.read('a', 'g2', '10:30', viewer); assert.equal(calls, 4);
});

test('private PDF cache keeps foreground reads waiting ahead of speculative work and never remembers failed downloads', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
  const cache = createMaterialByteCache(async () => { calls++; await gate; return pdf; });
  const a = cache.read('a', 'g', '1', viewer, true), b = cache.read('b', 'g', '1', viewer, true);
  let completed = false;
  const clicked = cache.read('c', 'g', '1', viewer).then(bytes => { completed = true; return bytes; });
  await assert.rejects(cache.read('d', 'g', '1', viewer, true), unavailable);
  assert.equal(completed, false); assert.equal(calls, 2);
  release(); await Promise.all([a, b, clicked]); assert.equal(completed, true); assert.equal(calls, 3);
  await cache.read('c', 'g', '1', viewer); assert.equal(calls, 3);
  let failures = 0;
  const failed = createMaterialByteCache(async () => { failures++; throw new Error('synthetic'); });
  await assert.rejects(failed.read('a', 'g', '1', viewer)); await assert.rejects(failed.read('a', 'g', '1', viewer)); assert.equal(failures, 2);
});

test('private PDF cache evicts old bytes before exceeding its 128 MiB storage and download reservation budget', async () => {
  let calls = 0; const large = Buffer.alloc(20 * 1024 * 1024); large.write('%PDF-');
  const cache = createMaterialByteCache(async () => { calls++; return large; });
  for (let i = 0; i < 7; i++) await cache.read('a', 'g', String(i), viewer);
  assert.equal(calls, 7); await cache.read('a', 'g', '6', viewer); assert.equal(calls, 7);
  await cache.read('a', 'g', '0', viewer); assert.equal(calls, 8);
});

test('PDF loader rejects incomplete identity-encoded bodies but allows decoded compressed responses', async () => {
  for (const length of [pdf.length - 1, pdf.length + 1]) {
    const f = fixture({ [root + 'original.pdf']: new Response(pdf, { headers: { 'content-type': 'application/pdf', 'content-length': String(length) } }) });
    await assert.rejects(f.loader(viewer), unavailable);
  }
  const f = fixture({ [root + 'original.pdf']: new Response(pdf, { headers: { 'content-type': 'application/pdf', 'content-length': '5', 'content-encoding': 'gzip' } }) });
  assert.deepEqual(await f.loader(viewer), pdf);
});

test('PDF loader propagates caller cancellation and makes no network request when already cancelled', async () => {
  const controller = new AbortController(); controller.abort(new Error('synthetic cancellation'));
  const f = fixture(); await assert.rejects(f.loader(viewer, controller.signal), /synthetic cancellation/);
  assert.equal(f.calls.length, 0);
  let signal: AbortSignal | null | undefined;
  const loader = createMaterialLoader((async (_url, options) => {
    signal = options?.signal;
    return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }));
  }) as typeof fetch);
  const active = new AbortController(), read = loader(viewer, active.signal);
  const rejected = assert.rejects(read, /synthetic active cancellation/);
  active.abort(new Error('synthetic active cancellation')); await rejected;
  assert.equal(signal?.aborted, true);
});

test('PDF refresh invalidates only the same owner and resource across generations', async () => {
  let calls = 0;
  const cache = createMaterialByteCache(async () => Buffer.from(`%PDF-1.7\nsynthetic-${++calls}`));
  const old = await cache.read('a', 'g', '1', viewer);
  const otherResource = await cache.read('a', 'g', '2', viewer);
  const otherOwner = await cache.read('b', 'g', '1', viewer);
  cache.invalidate('a', '1');
  assert.equal(cache.isCurrent('a', 'g', '1', viewer, old), false);
  assert.equal(await cache.read('a', 'g', '2', viewer), otherResource);
  assert.equal(await cache.read('b', 'g', '1', viewer), otherOwner);
  const fresh = await cache.read('a', 'g', '1', viewer);
  assert.notDeepEqual(fresh, old); assert.equal(calls, 4);
});

test('an invalidated PDF download cannot publish late bytes or remove a replacement request', async () => {
  let releaseOld!: () => void, releaseNew!: () => void, calls = 0;
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  const newGate = new Promise<void>(resolve => { releaseNew = resolve; });
  let signal: AbortSignal | undefined;
  const cache = createMaterialByteCache(async (_url, current) => {
    const call = ++calls; if (call === 1) { signal = current; await oldGate; } else await newGate;
    return Buffer.from(`%PDF-1.7\nsynthetic-${call}`);
  });
  const old = cache.read('a', 'g', '1', viewer);
  const rejected = assert.rejects(old, error => error instanceof AppError && error.code === 'MATERIAL_REFRESHED');
  await new Promise(resolve => setImmediate(resolve)); cache.invalidate('a', '1');
  assert.equal(signal?.aborted, true);
  const fresh = cache.read('a', 'g', '1', viewer);
  await new Promise(resolve => setImmediate(resolve)); releaseOld(); await rejected;
  const joined = cache.read('a', 'g', '1', viewer); releaseNew();
  const [a, b] = await Promise.all([fresh, joined]); assert.equal(a, b); assert.equal(calls, 2);
  assert.equal(await cache.read('a', 'g', '1', viewer), a);
});

test('invalidating a queued PDF releases its queue slot without starting the cancelled download', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const cache = createMaterialByteCache(async url => { calls.push(url); await gate; return pdf; });
  const a = cache.read('a', 'g', '1', viewer), b = cache.read('b', 'g', '1', viewer);
  const queued = cache.read('c', 'g', '1', viewer + '-cancelled');
  const rejected = assert.rejects(queued, error => error instanceof AppError && error.code === 'MATERIAL_REFRESHED');
  await new Promise(resolve => setImmediate(resolve)); cache.invalidate('c', '1'); await rejected;
  const replacement = cache.read('c', 'g', '1', viewer + '-fresh'); release();
  await Promise.all([a, b, replacement]);
  assert.deepEqual(calls, [viewer, viewer, viewer + '-fresh']);
  await cache.read('d', 'g', '1', viewer); assert.equal(calls.length, 4);
});
